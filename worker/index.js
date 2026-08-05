import { DurableObject } from "cloudflare:workers";
import {
  applyAlpacaCycle,
  applyAlpacaOverview,
  advanceMarket,
  createDemoState,
  CURRENT_SCHEMA_VERSION,
  migrateState,
  reproduce,
  reworkCandidates,
  reviewCandidates,
  reviewCandidatesWithBars,
  snapshot,
  validateCandidates,
  validateCandidatesWithBars,
} from "./engine.js";
import { isAuthorized, isStrictlyAuthorized } from "./auth.js";
import {
  aggregateMetrics, buildBacktestPayload, buildBacktestPayloadShardsV2, comparison, engineMode, EXECUTION_CONFIG, EXECUTION_CONFIG_V2, frozenDna,
  makeDataset, makeMultiSymbolDataset, normalizeMetrics, remoteEnabled, sha256,
} from "./backtest.js";
import { CONTROL_PLANE_WORKSPACE, createControlPlaneRuntime } from "./control-plane.js";
import { evaluateCostPolicy, recordCostUsage } from "./cost-controller.js";
import { createIncubationPolicy, evaluateIncubationGate, finalizeIncubationSession,
  recordIncubationEvent, startIncubation } from "./incubation.js";
import { IncubationStore } from "./incubation-store.js";
import { championReplacementAssessment, createHealthPolicy, finalizeHealthSession,
  healthMultiplier, portfolioRiskOverlays, recordHealthObservation, startReleaseMonitoring } from "./monitoring.js";
import { HealthStore } from "./health-store.js";
import { createRuntimeGateways } from "./gateways.js";
import { BrokerStore } from "./broker-store.js";
import { canReleaseStrategyToPaper } from "./alpaca.js";
import { consumeArchitectureQueue } from "./jobs.js";
import { combineQueuedBacktest, planQueuedBacktest, recordQueuedBacktestReceipt, strategyScopeSymbols } from "./backtest-queue.js";
import {
  MarketDataRepository,
  applyLiveMinutePoll,
  auditFiveMinuteBars,
  backfillDateBounds,
  buildBackfillJobs,
  buildCalendarManifest,
  buildDatasetManifest,
  buildHistoricalPartitions,
  buildSessionReconciliation,
  describeMarketDataError,
  ensureMarketDataState,
  livePollBounds,
  marketDataMode,
  marketScheduleAction,
  publicMarketDataState,
  recordMarketDataUsage,
} from "./market-data.js";
import { runtimeUniverseManifest } from "./universe.js";
import {
  developmentOnlyDataset,
  finalizeEvolutionaryResearch,
  generateEvolutionaryResearch,
  prepareEvolutionaryResearch,
} from "./research.js";
import { evaluateResearchTrial } from "./research-fitness.js";
import { planResearchJobs, verifyResearchJob } from "./research-jobs.js";
import { dispatchExpensiveFinalists, pauseResearch, resumeResearch } from "./research-registry.js";
import {
  authorizeSealedHoldout,
  bindSealedHoldoutDispatch,
  holdoutAuthorizationJob,
  lineageIdentity,
  recordSealedHoldoutOutcome,
  recordSealedHoldoutServiceStatus,
} from "./research-contract.js";
import { createEvaluationPolicy, decideHoldout, evaluationPolicyHash, replaySupervisorDecision, selectValidationCapacity, superviseDevelopment } from "./evaluation-policy.js";
import { applyOrchestrationCommand, claimOperatorIdempotency, createOrchestrationCommand, ensureOrchestrationState, executeOrchestrationActionBatch, executionAllowed, orchestrationCommandDisposition, orchestrationMode, pipelineFollowups } from "./orchestration.js";
import { OrchestrationStore } from "./orchestration-store.js";
import { planOrchestrationWork } from "./orchestration-schedule.js";
import { applyLifecycleCommand, bindLifecycleProvenance, initialLifecycle, transitionId } from "./lifecycle.js";
import { ADMIN_COMMAND_DTO_VERSION, buildOperationsReadModel, operatorArtifacts, operatorLogs,
  operatorOrders, operatorTrades, operatorTrials, paginateOperatorItems, strategyEvidenceDto } from "./operator-api.js";
import { incrementOperationalMetric, operationalHealth, recordHeartbeat, recordOperationalEvent, structuredLogLine } from "./observability.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const SINGLETON_NAME = CONTROL_PLANE_WORKSPACE;

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: JSON_HEADERS });
}

function eventSubsystem(type) {
  const value = String(type ?? "").toUpperCase();
  if (value.includes("MARKET_DATA")) return "market_data";
  if (value.includes("BROKER") || value.includes("ORDER") || value.includes("RISK")) return "broker";
  if (value.includes("BACKTEST") || value.includes("VALIDATE") || value.includes("SUPERVISOR")) return "backtester";
  if (value.includes("COST")) return "cost_telemetry";
  if (value.includes("ARTIFACT") || value.includes("WORKSPACE") || value === "AUDIT") return "storage";
  if (value.includes("QUEUE") || value.includes("EVOLVE")) return "queue";
  return "scheduler";
}

function eventSeverity(type) {
  const value = String(type ?? "").toUpperCase();
  if (value.includes("QUARANTINE") || value.includes("DAILY_LOSS") || value.includes("POSITION_DIVERGENCE")) return "critical_risk";
  if (value.includes("BLOCK") || value.includes("ORDER_ERROR")) return "execution_blocked";
  if (value.includes("ERROR") || value.includes("PAUSED")) return "research_degraded";
  return "info";
}

// Plan 06 policy seam: the numerical evaluator may be replaced by the
// versioned evaluation-policy module without changing burn-ledger semantics.
function sealedHoldoutOutcome(strategy, validation, policy = createEvaluationPolicy()) {
  const folds = strategy.backtest_runs?.development?.folds ?? [strategy.metrics ?? {}];
  const decision = decideHoldout({ development_folds: folds, holdout: {
    metrics: validation, per_symbol: Object.values(validation.per_symbol ?? {}),
  }, policy });
  return [decision.decision, decision.reasons.join(", ") || "sealed holdout evaluated against precommitted development bounds", decision];
}

function diverseHoldoutCandidates(candidates, policy = createEvaluationPolicy()) {
  const capacity = selectValidationCapacity(candidates.map((strategy) => ({ strategy_id: strategy.id,
    behavior_cluster: strategy.behavior_cluster ?? strategy.behavior_hash ?? `unclustered:${strategy.id}`,
    decision: "supervisor_approved", evidence: { normalized: { robustness: strategy.metrics?.robustness ?? 0 } },
  })), { policy });
  return new Set(capacity.selected.map((item) => item.strategy_id));
}

function applyHoldoutCapacity(state, policy = createEvaluationPolicy()) {
  const pool = state.strategies.filter((item) => item.state === "validation" || item.state === "capacity_wait");
  const selected = diverseHoldoutCandidates(pool, policy);
  for (const strategy of pool) {
    if (selected.has(strategy.id)) {
      strategy.state = "validation";
      strategy.capacity_wait = null;
      if (["supervisor_approved", "capacity_wait"].includes(strategy.lifecycle?.quality?.state)) {
        transitionStrategyLifecycle(strategy, "sealed_validation", { trigger: "validation_capacity",
          artifact_id: strategy.backtest_runs?.development?.artifact_id ?? "artifact:development",
          event_id: `capacity:${strategy.cohort_id ?? "uncohorted"}`, reason_code: "validation_capacity_selected",
          explanation: "Frozen candidate admitted to the bounded sealed-validation pool." });
      }
    } else {
      strategy.state = "capacity_wait";
      strategy.capacity_wait = { reason: "bounded sealed-holdout pool", at: strategy.capacity_wait?.at ?? new Date().toISOString() };
      if (strategy.lifecycle?.quality?.state === "supervisor_approved") {
        transitionStrategyLifecycle(strategy, "capacity_wait", { trigger: "validation_capacity",
          artifact_id: strategy.backtest_runs?.development?.artifact_id ?? "artifact:development",
          event_id: `capacity:${strategy.cohort_id ?? "uncohorted"}`, reason_code: "validation_capacity_wait",
          explanation: "Candidate remains frozen while waiting for sealed-validation capacity." });
      }
    }
  }
  return { selected, waiting: new Set(pool.filter((item) => !selected.has(item.id)).map((item) => item.id)) };
}

function developmentPolicyEvidence(state, strategy, strategyResult, foldResults, metrics, candidateFoldScores = null) {
  const supplied = strategyResult?.windows?.findLast?.((window) => window.development_evidence)?.development_evidence
    ?? [...(strategyResult?.windows ?? [])].reverse().find((window) => window.development_evidence)?.development_evidence
    ?? strategyResult?.development_evidence ?? {};
  const objectValues = (value) => Array.isArray(value) ? value : Object.values(value ?? {});
  const folds = foldResults.map((result) => ({ metrics: result.metrics ?? result }));
  const per_symbol = objectValues(supplied.per_symbol ?? supplied.base?.per_symbol ?? metrics.per_symbol);
  const regimes = objectValues(supplied.regimes ?? supplied.base?.metrics?.regimes ?? supplied.base?.regimes ?? metrics.regimes);
  const perturbations = [...(supplied.parameter_perturbations ?? []), ...(supplied.execution_target_sensitivity ?? [])]
    .map((item) => item.result ?? item);
  const nulls = [supplied.null_baseline, supplied.permuted_return_null].filter(Boolean);
  const behavior = { target_series: foldResults.flatMap((result) => result.targets ?? result.exposure_curve ?? []),
    closed_trades: foldResults.flatMap((result) => result.closed_trades ?? []) };
  const archive_members = state.strategies.filter((item) => item.id !== strategy.id && ((item.backtests ?? 0) > 0 || item.metrics))
    .map((item) => ({ strategy_id: item.id, target_series: item.metrics?.exposure_curve ?? [], trades: item.metrics?.trade_events ?? [] }));
  return {
    strategy_id: strategy.id, folds, stress: supplied.stress ? [supplied.stress] : foldResults.map((result) => ({ metrics: result.metrics ?? result })),
    per_symbol, regimes, perturbations, nulls, behavior, archive_members, coverage: supplied.coverage ?? 0,
    critical_faults: supplied.critical_faults ?? [],
    concentration: supplied.concentration ?? supplied.base?.metrics?.concentration
      ?? supplied.base?.metrics?.symbol_concentration_hhi ?? metrics.concentration ?? 0,
    complexity: supplied.complexity ?? Math.min(1, (strategy.strategy_dna?.features?.length ?? 1) / 64),
    closed_trades: supplied.closed_trades ?? supplied.base?.activity?.closed_trades ?? metrics.trades,
    candidate_fold_scores: supplied.candidate_fold_scores ?? candidateFoldScores
      ?? { [strategy.id]: folds.map((fold) => Number(fold.metrics.bar_sharpe ?? fold.metrics.sharpe ?? 0)) },
    protocol: supplied.protocol ?? null, protocol_hash: supplied.hash ?? null,
    trial_registry_count: state.research?.total_trials ?? 0,
  };
}

const ZERO_HASH = "0".repeat(64);

function lifecycleProvenance(strategy, dataset, configHash, policyHash) {
  return { dna_hash: /^[a-f0-9]{64}$/.test(strategy.dna_hash ?? "") ? strategy.dna_hash : ZERO_HASH,
    dataset_hash: dataset?.sha256 ?? dataset?.development_hash ?? ZERO_HASH,
    configuration_hash: configHash ?? ZERO_HASH, policy_hash: policyHash };
}

function ensureLifecycleForEvaluation(strategy, dataset, configHash, policyHash, timestamp = new Date().toISOString()) {
  const provenance = lifecycleProvenance(strategy, dataset, configHash, policyHash);
  strategy.lifecycle ??= structuredClone(initialLifecycle({ strategy_id: strategy.id, ...provenance, timestamp }));
  if (["proposed", "compiled", "screened"].includes(strategy.lifecycle.quality.state)) {
    strategy.lifecycle = structuredClone(bindLifecycleProvenance(strategy.lifecycle, provenance, timestamp));
  }
  return strategy.lifecycle;
}

function transitionStrategyLifecycle(strategy, target, { kind = "quality", artifact_id = "artifact:none",
  event_id = "event:none", trigger = "system", reason_code = target, explanation = target,
  correlation_id = `${strategy.id}:${target}`, timestamp = new Date().toISOString(), actor = "system" } = {}) {
  const lifecycle = strategy.lifecycle;
  if (!lifecycle) throw new Error(`Lifecycle provenance is not bound for ${strategy.id}`);
  const branch = lifecycle[kind];
  const value = { schema_version: 1, strategy_id: strategy.id, kind,
    expected: kind === "quality" ? { quality_state: branch.state, version: branch.version }
      : { operational_state: branch.state, version: branch.version }, target, trigger, artifact_id, event_id,
    policy_hash: lifecycle.provenance.policy_hash, actor, timestamp, reason_code, explanation, correlation_id,
    provenance: { dna_hash: lifecycle.provenance.dna_hash, dataset_hash: lifecycle.provenance.dataset_hash,
      configuration_hash: lifecycle.provenance.configuration_hash } };
  value.transition_id = transitionId(value);
  const applied = applyLifecycleCommand(lifecycle, value);
  if (applied.status !== "applied") throw new Error(`Lifecycle transition rejected for ${strategy.id}: ${applied.code}`);
  strategy.lifecycle = structuredClone(applied.state);
  return applied.transition;
}

function labStub(env) {
  return env.AXIOM_LAB.get(env.AXIOM_LAB.idFromName(SINGLETON_NAME));
}

function nextIsoDate(date) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

async function sendQueueMessages(queue, messages) {
  for (let index = 0; index < messages.length; index += 100) {
    const batch = messages.slice(index, index + 100);
    if (typeof queue.sendBatch === "function") {
      await queue.sendBatch(batch.map((body) => ({ body, contentType: "json" })));
    } else {
      for (const body of batch) await queue.send(body, { contentType: "json" });
    }
  }
}

async function tickMarketData(env, stub, scheduledTime = Date.now()) {
  return stub.fetch(new Request("https://axiom.internal/internal/market-data/tick", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scheduled_at: new Date(scheduledTime).toISOString() }),
  }));
}

async function tickOrchestration(stub, scheduledTime = Date.now()) {
  return stub.fetch(new Request("https://axiom.internal/internal/orchestration/tick", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ scheduled_at: new Date(scheduledTime).toISOString() }),
  }));
}

async function stateFrom(stub) {
  const response = await stub.fetch(new Request("https://axiom.internal/api/state"));
  if (!response.ok) throw new Error("Unable to load supervisor state");
  return response.json();
}

async function synchronizeAlpaca(env, stub, bucket, orderBucket = bucket) {
  const appState = await stateFrom(stub);
  const forceFlatten = Boolean(appState.orchestration?.controls?.flatten_requested);
  if (!executionAllowed(appState) && !forceFlatten) return Response.json({ ok: true, skipped: true, reason: appState.orchestration?.controls?.kill_switch ? "kill_switch" : "execution_paused" });
  const broker = createRuntimeGateways(env).broker;
  const plan = await broker.planCycle(appState, bucket, orderBucket, { scope: "released" });
  if (!env.AXIOM_DB && ((plan.order_plans?.length ?? 0) || (plan.cancel_plans?.length ?? 0))) {
    throw new Error("AXIOM_DB is required before any broker order can be submitted");
  }
  const store = env.AXIOM_DB ? new BrokerStore(env.AXIOM_DB) : null;
  if (store) await store.persistPlan({ workspaceId: SINGLETON_NAME, plan });
  const cycle = await broker.executePlan(plan);
  if (store) {
    const journal = await store.persistExecution({ workspaceId: SINGLETON_NAME, execution: cycle });
    for (const fill of cycle.fills ?? []) if (!(fill.allocations?.length)
        && journal.recovered_allocations?.[fill.broker_fill_id]) {
      fill.allocations = journal.recovered_allocations[fill.broker_fill_id];
    }
  }
  return stub.fetch(new Request("https://axiom.internal/internal/alpaca-cycle", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(cycle),
  }));
}

async function refreshAlpacaPortfolio(env, stub) {
  const overview = await createRuntimeGateways(env).broker.accountOverview();
  return stub.fetch(new Request("https://axiom.internal/internal/alpaca-overview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(overview),
  }));
}

async function reviewWithAlpaca(env, stub) {
  const appState = await stateFrom(stub);
  const candidates = appState.strategies.filter((strategy) => ["generated", "rework"].includes(strategy.state));
  const dslSymbols = [...new Set(candidates.filter((strategy) => strategy.strategy_format === "dsl-v1")
    .flatMap((strategy) => strategy.strategy_dna?.scope?.symbols ?? [strategy.asset]))].sort();
  const legacySymbols = [...new Set(candidates.filter((strategy) => strategy.strategy_format !== "dsl-v1").map((strategy) => strategy.asset))];
  const gateway = createRuntimeGateways(env).marketData;
  const [dslBars, legacyBars] = await Promise.all([
    dslSymbols.length ? gateway.dslResearchBars(dslSymbols) : {},
    legacySymbols.length ? gateway.researchBars(legacySymbols) : {},
  ]);
  return stub.fetch(new Request("https://axiom.internal/internal/review-live", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ legacy_bars: legacyBars, dsl_bars: dslBars }),
  }));
}

async function validateWithAlpaca(env, stub) {
  // A sealed remote validation must never fetch a new bar set. The DO owns the
  // immutable holdout captured during review.
  const appState = await stateFrom(stub);
  const validation = appState.strategies.filter((strategy) => strategy.state === "validation");
  const needsLegacyBars = engineMode(env) === "legacy"
    || validation.some((strategy) => (strategy.engine_family ?? "legacy") === "legacy" && !strategy.dataset_id);
  if (!needsLegacyBars) {
    return stub.fetch(new Request("https://axiom.internal/internal/validate-live", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
    }));
  }
  const localValidation = validation.filter((strategy) => engineMode(env) === "legacy"
    || (strategy.engine_family ?? "legacy") === "legacy");
  const dslSymbols = [...new Set(localValidation.filter((strategy) => strategy.strategy_format === "dsl-v1").map((strategy) => strategy.asset))];
  const legacySymbols = [...new Set(localValidation.filter((strategy) => strategy.strategy_format !== "dsl-v1").map((strategy) => strategy.asset))];
  const gateway = createRuntimeGateways(env).marketData;
  const [dslBars, legacyBars] = await Promise.all([
    dslSymbols.length ? gateway.dslResearchBars(dslSymbols) : {},
    legacySymbols.length ? gateway.researchBars(legacySymbols) : {},
  ]);
  return stub.fetch(new Request("https://axiom.internal/internal/validate-live", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ legacy_bars: legacyBars, dsl_bars: dslBars }),
  }));
}

const RESEARCH_PROBE_SYMBOLS = Object.freeze([
  "SPY", "QQQ", "IWM", "TLT", "AAPL", "MSFT", "NVDA", "AMZN", "JPM", "XOM", "JNJ", "WMT",
]);

function newYorkClock(value = Date.now()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(value)).filter((part) => part.type !== "literal")
    .map((part) => [part.type, part.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: parts.weekday,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

export function shouldRunPostCloseResearch(value = Date.now(), calendarSessions = null) {
  const clock = newYorkClock(value);
  if (clock.hour !== 17) return false;
  if (Array.isArray(calendarSessions)) {
    return calendarSessions.some((session) => String(session.date) === clock.date);
  }
  return !["Sat", "Sun"].includes(clock.weekday);
}

function boundedInt(value, fallback, low, high) {
  const parsed = Number(value);
  return Math.max(low, Math.min(high, Number.isFinite(parsed) ? Math.trunc(parsed) : fallback));
}

async function runEvolutionWithAlpaca(env, stub, options = {}) {
  const current = await stateFrom(stub);
  if (current.research?.paused) throw new Error(`Research is paused: ${current.research.pause_reason ?? "operator_paused"}`);
  const raw = await createRuntimeGateways(env).marketData.dslResearchBars(RESEARCH_PROBE_SYMBOLS);
  const development = developmentOnlyDataset(raw, .75);
  const usableSymbols = Object.keys(development).filter((symbol) => development[symbol]?.length >= 120);
  if (usableSymbols.length < 5) throw new Error("At least five symbols with sufficient 5-minute history are required");
  const barsBySymbol = Object.fromEntries(usableSymbols.sort().map((symbol) => [symbol, development[symbol]]));
  const datasetHash = await sha256(barsBySymbol);
  const clock = newYorkClock(options.scheduled_at ?? Date.now());
  const finalists = boundedInt(options.finalists, 6, 1, 12);
  const sampled = boundedInt(options.sampled_genomes ?? env.RESEARCH_SAMPLED_GENOMES,
    Math.max(16, finalists * 4), 1, 128);
  const challengers = boundedInt(options.challengers ?? env.RESEARCH_CHALLENGERS,
    Math.min(32, Math.max(4, finalists * 2)), 0, 32);
  const seed = (Number(current.meta?.seed ?? 0) ^ Number(clock.date.replaceAll("-", ""))) >>> 0;
  return stub.fetch(new Request("https://axiom.internal/internal/research/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      seed,
      session_date: clock.date,
      dataset_id: `alpaca-iex-5min-development-${datasetHash.slice(0, 24)}`,
      dataset_hash: datasetHash,
      dataset_scope: "development_only",
      bars_by_symbol: barsBySymbol,
      telemetry: { status: String(env.RESEARCH_BUDGET_STATUS ?? "healthy"), at: new Date().toISOString() },
      config: { sampled_genomes: sampled, challengers, finalists, validation_slots: 3,
        minimum_symbols: 5, maximum_symbol_concentration: .35 },
    }),
  }));
}

async function submitOperatorPipelineCommand(stub, kind, payload = {}) {
  return stub.fetch(new Request("https://axiom.internal/api/orchestration/command", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind, correlation_id: `operator:${kind}:${Date.now()}`, payload }),
  }));
}

export class AxiomLab extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.controlPlane = createControlPlaneRuntime(ctx.storage, env, SINGLETON_NAME);
    this.gateways = createRuntimeGateways(env);
    this.brokerStore = env.AXIOM_DB ? new BrokerStore(env.AXIOM_DB) : null;
    this.incubationStore = env.AXIOM_DB && String(env.NORMALIZED_STORAGE_ENABLED ?? "false").toLowerCase() === "true"
      ? new IncubationStore(env.AXIOM_DB) : null;
    this.healthStore = env.AXIOM_DB && String(env.NORMALIZED_STORAGE_ENABLED ?? "false").toLowerCase() === "true"
      ? new HealthStore(env.AXIOM_DB) : null;
    this.marketDataRepository = new MarketDataRepository(ctx.storage, env, SINGLETON_NAME);
    this.orchestrationStore = env.AXIOM_DB ? new OrchestrationStore(env.AXIOM_DB, {
      queue: env.AXIOM_JOBS, artifacts: env.AXIOM_ARTIFACTS,
    }) : null;
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const existing = await this.controlPlane.loadState();
      if (!existing) {
        const initial = createDemoState();
        ensureOrchestrationState(initial, orchestrationMode(env));
        initial.schemaVersion = CURRENT_SCHEMA_VERSION; initial.datasets = {}; initial.backtestArtifacts = {};
        const universe = await ensureMarketDataState(initial, env);
        await this.marketDataRepository.saveUniverse(universe);
        await this.controlPlane.saveState(initial);
      }
      else {
        const migrated = (existing.schemaVersion ?? 1) < CURRENT_SCHEMA_VERSION ? migrateState(existing) : existing;
        if ((migrated.schemaVersion ?? 1) < CURRENT_SCHEMA_VERSION) {
          migrated.schemaVersion = CURRENT_SCHEMA_VERSION;
          migrated.datasets ??= {};
          migrated.backtestArtifacts ??= {};
        }
        const universe = await ensureMarketDataState(migrated, env);
        ensureOrchestrationState(migrated, orchestrationMode(env));
        await this.marketDataRepository.saveUniverse(universe);
        await this.controlPlane.saveState(migrated);
      }
      if (orchestrationMode(env) === "autonomous" && this.ctx.storage.setAlarm) {
        await this.ctx.storage.setAlarm(Date.now() + 60_000);
      }
    });
  }

  async load() {
    await this.ready;
    const state = await this.controlPlane.loadState();
    if (state && this.orchestrationStore) {
      const authoritative = await this.orchestrationStore.loadLifecycle(SINGLETON_NAME, "__workspace__");
      if (authoritative && authoritative.version > Number(state.orchestration?.version ?? -1)) {
        state.orchestration = authoritative.snapshot;
        ensureOrchestrationState(state, orchestrationMode(this.env));
        await this.controlPlane.saveState(state);
      }
    }
    return state;
  }

  async save(state) {
    state.schemaVersion = Math.max(state.schemaVersion ?? 1, CURRENT_SCHEMA_VERSION);
    state.datasets ??= {};
    state.backtestArtifacts ??= {};
    ensureOrchestrationState(state, orchestrationMode(this.env));
    await ensureMarketDataState(state, this.env);
    await this.controlPlane.saveState(state);
    return json(snapshot(state));
  }

  record(state, type, title, detail, metadata = {}) {
    const now = new Date();
    const operational = recordOperationalEvent(state, { at: now, subsystem: eventSubsystem(type),
      severity: eventSeverity(type), code: type, message: `${title}: ${detail}`,
      correlation_id: metadata.correlation_id, job_id: metadata.job_id, transition_id: metadata.transition_id,
      broker_intent_id: metadata.broker_intent_id, order_id: metadata.order_id, strategy_id: metadata.strategy_id });
    if (operational.severity !== "info") {
      recordHeartbeat(state, operational.subsystem, { status: operational.severity === "critical_risk" ? "blocked" : "degraded",
        at: now, correlation_id: operational.correlation_id, detail: { code: operational.code } });
      incrementOperationalMetric(state, operational.subsystem, "failures", 1, now);
    }
    console.log(structuredLogLine(operational));
    state.events.unshift({ id: operational.event_id,
      kind: type, type, title, detail: operational.message.replace(`${title}: `, ""), time: now.toISOString().slice(11, 16), at: now.toISOString(),
      correlation_id: metadata.correlation_id ?? null, command_id: metadata.command_id ?? null,
      strategy_id: metadata.strategy_id ?? null });
    state.events = state.events.slice(0, 2048);
  }

  registerPartitionedDataset(state, loaded) {
    const source = loaded.manifest;
    state.datasets ??= {};
    state.datasets[source.id] ??= {
      id: source.id, schema_version: 2, storage_family: "partitioned-v1",
      partition_dataset_id: source.id, timeframe: source.timeframe, sha256: source.sha256,
      development_hash: loaded.dataset_hash, holdout_hash: null,
      manifest: { schema_version: 2, timeframe: source.timeframe, feed: source.feed,
        adjustment: source.adjustment, session: source.session,
        universe: { id: source.universe_id, sha256: source.universe_hash },
        calendar: { id: source.calendar_id, sha256: source.calendar_hash },
        universe_id: source.universe_id, universe_sha256: source.universe_hash,
        calendar_id: source.calendar_id, calendar_sha256: source.calendar_hash,
        symbols: [...new Set(source.partitions.map((item) => item.symbol))].sort(),
        source_dataset_hash: source.sha256 },
      symbol_count: source.symbol_count, start: source.start, end: source.end,
    };
    return state.datasets[source.id];
  }

  async runSealedResearchCohort(state, command) {
    const costPolicy = evaluateCostPolicy(state, this.env, command.timestamp);
    if (!costPolicy.optional_research_allowed) {
      const orchestration = ensureOrchestrationState(state, orchestrationMode(this.env));
      orchestration.incidents.push({ kind: "optional_research_budget_block", severity: "research_degraded",
        action: "research.run_cohort", command_id: command.command_id, reason: costPolicy.reason,
        projected_ratio: costPolicy.projected_ratio, opened_at: command.timestamp });
      orchestration.incidents = orchestration.incidents.slice(-512);
      this.record(state, "COST_CONTROL", "Optional evolutionary research paused",
        `${costPolicy.level} · projected ${(costPolicy.projected_ratio * 100).toFixed(1)}% of monthly limit`,
        { correlation_id: command.correlation_id, command_id: command.command_id });
      return { paused: true, reason: costPolicy.reason };
    }
    const datasetId = state.marketData?.backfill?.dataset_id;
    if (!datasetId) throw new Error("Three-year sealed market dataset is not complete");
    const contentStore = this.controlPlane.artifacts.contentStore;
    if (contentStore) {
      const quota = await contentStore.quotaStatus({ workspaceId: SINGLETON_NAME,
        quotaBytes: Math.max(1, Number(this.env.ARTIFACT_QUOTA_BYTES ?? 8_000_000_000)), researchPauseRatio: .9 });
      if (quota.pause_optional_research) {
        pauseResearch(state, "storage_quota_pressure");
        ensureOrchestrationState(state, orchestrationMode(this.env)).incidents.push({ kind: "storage_quota_pressure",
          action: "research.run_cohort", command_id: command.command_id, used_bytes: quota.used_bytes,
          quota_bytes: quota.quota_bytes, opened_at: command.timestamp });
        return { paused: true, reason: "storage_quota_pressure" };
      }
    }
    const manifest = await this.marketDataRepository.loadDatasetManifest(datasetId);
    if (!manifest || new Set(manifest.partitions.map((item) => item.symbol)).size < 5) {
      throw new Error("Sealed development dataset has fewer than five symbols");
    }
    const developmentHash = await sha256({ schema_version: 1, dataset_root_hash: manifest.sha256,
      scope: "development_only", split_ratio: .75 });
    const dataset = this.registerPartitionedDataset(state, { manifest, dataset_hash: developmentHash });
    const sessionDate = command.payload?.session_date ?? newYorkClock(command.timestamp).date;
    const finalists = boundedInt(command.payload?.finalists ?? this.env.RESEARCH_AUTORUN_FINALISTS, 6, 1, 12);
    const quotaMultiplier = Math.max(.01, Number(costPolicy.quota_multiplier ?? 1));
    const configuredSampled = boundedInt(this.env.RESEARCH_AUTORUN_SAMPLED_GENOMES, Math.max(16, finalists * 4), 1, 128);
    const configuredChallengers = boundedInt(this.env.RESEARCH_AUTORUN_CHALLENGERS, Math.min(32, Math.max(4, finalists * 2)), 0, 32);
    const generated = generateEvolutionaryResearch(state, {
      seed: (Number(state.seed ?? 0) ^ Number(sessionDate.replaceAll("-", ""))) >>> 0,
      session_date: sessionDate, dataset_id: dataset.id, dataset_hash: developmentHash,
      dataset_scope: "development_only",
      telemetry: { status: costPolicy.level === "constrained" ? "constrained" : "healthy", at: command.timestamp },
      config: { sampled_genomes: Math.max(1, Math.floor(configuredSampled * quotaMultiplier)),
        challengers: Math.max(0, Math.floor(configuredChallengers * quotaMultiplier)),
        finalists: Math.max(1, Math.floor(finalists * quotaMultiplier)), validation_slots: 3, minimum_symbols: 5, maximum_symbols: 5,
        maximum_symbol_concentration: .35 },
    });
    recordCostUsage(state, { research_trials: generated.proposals.length }, command.timestamp);
    if (generated.duplicate) return { duplicate: true, completed: true, cohort_id: generated.cohort.cohort_id };
    const jobs = planResearchJobs(generated, { workspace_id: SINGLETON_NAME, actor: command.actor });
    generated.cohort.screen_receipts ??= {};
    generated.cohort.screen_jobs = jobs.screens.map((item) => item.job_id);
    generated.cohort.finalize_job = jobs.finalize.job_id;
    generated.cohort.finalize_job_payload = jobs.finalize;
    await this.controlPlane.saveState(state);
    await sendQueueMessages(this.env.AXIOM_JOBS, jobs.all);
    recordHeartbeat(state, "queue", { status: "healthy", at: command.timestamp,
      correlation_id: command.command_id, detail: { messages: jobs.all.length, kind: "research" } });
    recordMarketDataUsage(state, { queue_messages: jobs.all.length });
    this.record(state, "EVOLVE", `${generated.proposals.length} evolutionary trials queued`,
      "One bounded development-only screen per trial · final selection waits for every receipt");
    return { duplicate: false, completed: false, queued: true, cohort_id: generated.cohort.cohort_id,
      screen_jobs: jobs.screens.length };
  }

  async screenQueuedResearchTrial(state, job) {
    const cohort = state.research?.cohorts?.find((item) => item.cohort_id === job.cohort_id);
    verifyResearchJob(job, cohort);
    const trial = state.research?.trials?.[job.trial_id];
    if (!trial || trial.cohort_id !== cohort.cohort_id || trial.ordinal !== job.ordinal) {
      throw new Error("Research screen job references an unknown trial");
    }
    const symbols = [...new Set(trial.dna?.scope?.symbols ?? [])].sort();
    if (JSON.stringify(symbols) !== JSON.stringify(job.symbols)
        || symbols.length > cohort.contract.config.maximum_symbols) {
      throw new Error("Research screen job changed the frozen symbol scope");
    }
    cohort.screen_receipts ??= {};
    const prior = cohort.screen_receipts[trial.trial_id];
    if (prior) {
      if (prior.job_id !== job.job_id) throw new Error("Trial screen already has a different job identity");
      await this.queueResearchFinalizerWhenReady(state, cohort);
      return { duplicate: true, receipt: prior };
    }
    const loaded = await this.marketDataRepository.loadSealedDataset(job.dataset_id, {
      scope: "development_only", symbols,
    });
    if (loaded.dataset_scope !== "development_only" || loaded.manifest.id !== job.dataset_id) {
      throw new Error("Research screen did not receive its sealed development slice");
    }
    const screen = evaluateResearchTrial(trial, loaded.bars_by_symbol, {
      trial_count: cohort.contract.config.total_trials,
      minimum_symbols: cohort.contract.config.minimum_symbols,
      maximum_symbol_concentration: cohort.contract.config.maximum_symbol_concentration,
      minimum_fold_bars: 40, minimum_trades: 8, maximum_turnover: 20,
    });
    const resultHash = await sha256(screen);
    const artifact = { schema_version: 2, job_id: job.job_id, cohort_id: cohort.cohort_id,
      trial_id: trial.trial_id, contract_hash: cohort.contract_hash, dataset_id: job.dataset_id,
      dataset_hash: job.dataset_hash, dataset_scope: "development_only",
      partition_ids: loaded.partition_ids, proposal: { ...trial }, screen, result_hash: resultHash };
    const stored = await this.controlPlane.artifacts.putResearchTrial(cohort.cohort_id, trial.trial_id, artifact, {
      dataset_id: job.dataset_id, contract_hash: cohort.contract_hash, job_id: job.job_id,
    });
    const receipt = { job_id: job.job_id, result_hash: resultHash,
      artifact_id: stored.mirror?.artifact_id ?? `${cohort.cohort_id}:${trial.trial_id}` };
    cohort.screen_receipts[trial.trial_id] = receipt;
    await this.controlPlane.saveState(state);
    await this.queueResearchFinalizerWhenReady(state, cohort);
    return { duplicate: false, receipt };
  }

  async queueResearchFinalizerWhenReady(state, cohort) {
    const receipts = Object.keys(cohort.screen_receipts ?? {}).length;
    if (receipts !== cohort.screen_jobs?.length || cohort.finalize_queued) return false;
    if (!cohort.finalize_job_payload || cohort.finalize_job_payload.job_id !== cohort.finalize_job) {
      throw new Error("Research cohort is missing its frozen finalizer job");
    }
    await sendQueueMessages(this.env.AXIOM_JOBS, [cohort.finalize_job_payload]);
    cohort.finalize_queued = true;
    cohort.finalize_queued_at = new Date().toISOString();
    await this.controlPlane.saveState(state);
    return true;
  }

  async finalizeQueuedResearchCohort(state, job) {
    const cohort = state.research?.cohorts?.find((item) => item.cohort_id === job.cohort_id);
    verifyResearchJob(job, cohort);
    const duplicate = cohort.status === "complete";
    let finalistCount = cohort.finalists?.length ?? 0;
    if (!duplicate) {
      const expected = [...job.trial_ids].sort();
      const receipts = cohort.screen_receipts ?? {};
      if (expected.some((trialId) => !receipts[trialId])) {
        const error = new Error(`Research screens are incomplete: ${Object.keys(receipts).length}/${expected.length}`);
        error.status = 409; throw error;
      }
      const artifacts = await Promise.all(expected.map((trialId) => this.controlPlane.artifacts
        .getResearchTrial(cohort.cohort_id, trialId)));
      const records = []; const artifactIds = {};
      for (let index = 0; index < expected.length; index += 1) {
        const trialId = expected[index], artifact = artifacts[index], receipt = receipts[trialId];
        if (!artifact || artifact.job_id !== receipt.job_id || artifact.result_hash !== receipt.result_hash
            || await sha256(artifact.screen) !== receipt.result_hash) {
          throw new Error(`Research screen artifact verification failed for ${trialId}`);
        }
        records.push(artifact.screen); artifactIds[trialId] = receipt.artifact_id;
      }
      const committed = finalizeEvolutionaryResearch(state, { cohort_id: cohort.cohort_id, records, artifact_ids: artifactIds });
      for (const strategy of committed.created) strategy.dataset_id = cohort.contract.dataset_id;
      finalistCount = committed.created.length;
      recordCostUsage(state, { research_finalists: finalistCount }, cohort.completed_at ?? new Date());
      this.record(state, "EVOLVE", `${finalistCount} evolutionary finalists registered`,
        `${records.length} bounded screens · deterministic cohort-wide selection`);
      await this.controlPlane.saveState(state);
    }
    if (!cohort.review_dispatched) {
      const followup = createOrchestrationCommand({ kind: "pipeline_review", actor: job.actor,
        timestamp: cohort.completed_at ?? new Date().toISOString(), correlation_id: job.job_id,
        intent_id: `pipeline:development:${cohort.cohort_id}`,
        payload: { cohort_id: cohort.cohort_id } });
      await this.submitOrchestrationCommand(state, followup);
      cohort.review_dispatched = true;
      cohort.review_command_id = followup.command_id;
      await this.controlPlane.saveState(state);
    }
    return { duplicate, cohort_id: cohort.cohort_id, finalists: finalistCount };
  }

  async buildWorkspaceResetSnapshot() {
    const [artifactManifest, d1Targets, market, orchestration, compatibility, durableObjects] = await Promise.all([
      this.controlPlane.artifacts.contentStore
        ? this.controlPlane.artifacts.contentStore.buildResetManifest(SINGLETON_NAME) : null,
      this.controlPlane.normalized
        ? this.controlPlane.normalized.enumerateWorkspaceResetTargets(SINGLETON_NAME) : [],
      this.marketDataRepository.resetInventory(),
      this.orchestrationStore ? this.orchestrationStore.resetInventory(SINGLETON_NAME)
        : { d1_targets: [], object_keys: [] },
      this.controlPlane.compatibilityResetInventory(),
      this.ctx.storage.list(),
    ]);
    const identity = {
      workspace_id: SINGLETON_NAME,
      artifact_inventory_hash: artifactManifest ? await sha256({ artifact_ids: artifactManifest.artifact_ids,
        object_keys: artifactManifest.object_keys }) : null,
      normalized_d1_targets: d1Targets.map((item) => item.targetId).sort(),
      market_d1_targets: market.d1_targets,
      market_object_keys: market.object_keys,
      orchestration_d1_targets: orchestration.d1_targets,
      orchestration_object_keys: orchestration.object_keys,
      compatibility_d1_targets: compatibility.d1_targets,
      compatibility_object_keys: compatibility.object_keys,
      durable_object_keys: [...durableObjects.keys()].sort(),
    };
    return { manifest_hash: await sha256(identity), identity, artifact_manifest: artifactManifest,
      counts: { d1: d1Targets.length + market.d1_targets.length + orchestration.d1_targets.length
          + compatibility.d1_targets.length,
        r2: (artifactManifest?.artifact_count ?? 0) + market.object_keys.length
          + orchestration.object_keys.length + compatibility.object_keys.length,
        durable_object: durableObjects.size } };
  }

  async persistWorkspaceResetManifest(prepared, command) {
    if (!this.env.AXIOM_ARTIFACTS) throw new Error("AXIOM_ARTIFACTS is required to prepare a recoverable reset");
    const workspaceHash = await sha256(SINGLETON_NAME);
    const objectKey = `workspaces/${workspaceHash}/reset-manifests/${prepared.manifest_hash}.json`;
    const record = { schema_version: 1, workspace_id: SINGLETON_NAME, manifest_hash: prepared.manifest_hash,
      identity: prepared.identity, artifact_manifest: prepared.artifact_manifest, counts: prepared.counts,
      requested_by: command.actor, prepared_at: command.timestamp };
    const contentHash = await sha256(record);
    await this.env.AXIOM_ARTIFACTS.put(objectKey, JSON.stringify(record), { customMetadata: {
      kind: "workspace-reset-manifest", workspace_id: SINGLETON_NAME,
      manifest_hash: prepared.manifest_hash, content_hash: contentHash,
    } });
    const stored = await this.env.AXIOM_ARTIFACTS.get(objectKey);
    if (!stored) throw new Error("Prepared reset manifest could not be read back");
    const decoded = JSON.parse(new TextDecoder().decode(await stored.arrayBuffer()));
    if (await sha256(decoded) !== contentHash || await sha256(decoded.identity) !== prepared.manifest_hash) {
      throw new Error("Prepared reset manifest failed read-after-write verification");
    }
    return { object_key: objectKey, content_hash: contentHash };
  }

  async verifyWorkspaceResetManifest(pending) {
    const stored = await this.env.AXIOM_ARTIFACTS?.get(pending.manifest_object_key);
    if (!stored) throw new Error("Prepared reset manifest is missing");
    const decoded = JSON.parse(new TextDecoder().decode(await stored.arrayBuffer()));
    if (await sha256(decoded) !== pending.manifest_content_hash
        || decoded.manifest_hash !== pending.manifest_hash
        || await sha256(decoded.identity) !== pending.manifest_hash) {
      throw new Error("Prepared reset manifest is corrupt");
    }
    return decoded;
  }

  async runBrokerCycle(state, bucket, orderBucket, options = {}) {
    const startedAt = Date.now();
    const plan = await this.gateways.broker.planCycle(state, bucket, orderBucket, options);
    if (options.scope === "incubation") {
      recordHeartbeat(state, "broker", { status: "healthy", at: plan.clock?.timestamp ?? new Date(),
        correlation_id: bucket, detail: { mode: "incubation_shadow", safety_reasons: plan.safety_reasons?.length ?? 0 } });
      incrementOperationalMetric(state, "broker", "plan_latency_ms", Date.now() - startedAt);
      return plan;
    }
    if (this.brokerStore) {
      await this.brokerStore.persistPlan({ workspaceId: SINGLETON_NAME, plan });
    } else {
      const activation = plan.activation ?? {};
      const canExecute = plan.force_flatten || activation.canary_enabled
        || activation.long_enabled || activation.short_enabled;
      if (canExecute && ((plan.order_plans?.length ?? 0) || (plan.cancel_plans?.length ?? 0))) {
        throw new Error("AXIOM_DB is required before any broker order can be submitted");
      }
    }
    const execution = await this.gateways.broker.executePlan(plan);
    if (this.brokerStore) {
      const journal = await this.brokerStore.persistExecution({ workspaceId: SINGLETON_NAME, execution });
      for (const fill of execution.fills ?? []) {
        if (!(fill.allocations?.length) && journal.recovered_allocations?.[fill.broker_fill_id]) {
          fill.allocations = journal.recovered_allocations[fill.broker_fill_id];
        }
      }
      for (const item of journal.unattributed) execution.safety_reasons.push({
        reason: item.reason, broker_fill_id: item.broker_fill_id, severity: "critical",
      });
    }
    const incidents = state.orchestration?.incidents;
    if (incidents) for (const safety of execution.safety_reasons.filter((item) => item.severity === "critical")) {
      const incidentId = `broker:${bucket}:${safety.symbol ?? safety.broker_fill_id ?? "portfolio"}:${safety.reason}`;
      if (!incidents.some((item) => item.incident_id === incidentId)) incidents.push({
        incident_id: incidentId, kind: "broker_safety", severity: "critical",
        strategy_id: safety.strategy_id ?? null, reason: safety.reason,
        symbol: safety.symbol ?? null, broker_fill_id: safety.broker_fill_id ?? null,
        opened_at: execution.clock?.timestamp ?? new Date().toISOString(),
      });
    }
    const critical = execution.safety_reasons.some((item) => item.severity === "critical");
    recordHeartbeat(state, "broker", { status: critical ? "blocked" : "healthy",
      at: execution.clock?.timestamp ?? new Date(), correlation_id: bucket,
      detail: { order_count: execution.submitted_orders?.length ?? 0, critical_safety_reasons: critical ? 1 : 0 } });
    incrementOperationalMetric(state, "broker", "cycle_latency_ms", Date.now() - startedAt);
    incrementOperationalMetric(state, "broker", "orders_submitted", execution.submitted_orders?.length ?? 0);
    return execution;
  }

  async persistIncubationDecisionArtifact(state, strategy, decision, timestamp) {
    if (strategy.incubation?.decision_artifact_id
        && strategy.incubation?.artifact_decision_id === decision.decision_id) {
      return strategy.incubation.decision_artifact_id;
    }
    const legacyId = `incubation-${decision.decision_id}`;
    const policyVersionId = this.incubationStore?.policyVersionId(strategy.incubation) ?? null;
    const content = { schema_version: 1, kind: "incubation.release-decision",
      strategy_id: strategy.id, decision, evidence: strategy.incubation,
      frozen_provenance: strategy.incubation.provenance, created_at: timestamp };
    const resultHash = await sha256(content);
    const stored = await this.controlPlane.artifacts.putArtifact(legacyId, content, {
      phase: "incubation", strategy_id: strategy.id, decision_id: decision.decision_id,
    }, this.controlPlane.artifacts.contentStore ? {
      strategyId: strategy.id, policyVersionId, resultHash, redactionClass: "private",
    } : {});
    const artifactId = stored.mirror?.artifact_id ?? legacyId;
    strategy.incubation.decision_artifact_id = artifactId;
    strategy.incubation.artifact_decision_id = decision.decision_id;
    state.incubationArtifacts ??= {};
    state.incubationArtifacts[artifactId] = { id: artifactId, strategy_id: strategy.id,
      decision_id: decision.decision_id, outcome: decision.outcome, created_at: timestamp };
    return artifactId;
  }

  async applyIncubationDecision(state, strategy, decision, command) {
    strategy.incubation.status = decision.outcome;
    if (["incubation_continue", "incubation_blocked"].includes(decision.outcome)) {
      if (this.incubationStore) await this.incubationStore.persistEvidence({ workspaceId: SINGLETON_NAME, strategy });
      return decision.outcome;
    }
    const artifactId = await this.persistIncubationDecisionArtifact(state, strategy, decision, command.timestamp);
    if (decision.outcome === "incubation_rework" || decision.outcome === "incubation_reject") {
      const rework = decision.outcome === "incubation_rework";
      strategy.state = rework ? "rework" : "incubation_reject";
      strategy.release_ready = null;
      strategy.rework = rework ? { ...(strategy.rework ?? {}), source_stage: "incubation",
        diagnosis: "Forward incubation exhausted 20 valid sessions without a releasable 67-trade evidence set.",
        consumed_incubation: { started_at: strategy.incubation.started_at, ended_at: command.timestamp,
          decision_id: decision.decision_id,
          event_set_hash: await sha256(strategy.incubation.processed_event_ids) },
        history: strategy.rework?.history ?? [] } : strategy.rework;
      if (strategy.lifecycle?.quality?.state === "incubation") transitionStrategyLifecycle(strategy,
        rework ? "development" : "development_reject", { trigger: "incubation_decision",
          artifact_id: artifactId, event_id: command.command_id,
          reason_code: decision.outcome, explanation: decision.findings.join(", ") || decision.outcome,
          correlation_id: decision.decision_id, timestamp: command.timestamp });
      if (this.incubationStore) await this.incubationStore.persistEvidence({ workspaceId: SINGLETON_NAME, strategy });
      this.record(state, rework ? "INCUBATION_REWORK" : "INCUBATION_REJECT",
        `${strategy.name} ${rework ? "returned to development" : "failed incubation"}`,
        decision.findings.join(", ") || decision.outcome);
      return decision.outcome;
    }
    strategy.release_ready = { at: command.timestamp, decision_id: decision.decision_id,
      artifact_id: artifactId, valid_trading_days: decision.summary.valid_trading_days,
      eligible_trades: decision.summary.eligible_trades };
    if (state.orchestration?.controls?.release_paused) {
      strategy.state = "incubation"; strategy.incubation.status = "incubation_blocked";
      strategy.release_blocked_reason = "release_paused";
      if (this.incubationStore) await this.incubationStore.persistEvidence({ workspaceId: SINGLETON_NAME, strategy });
      this.record(state, "RELEASE_PAUSED", `${strategy.name} passed incubation`,
        "Evidence is frozen; paper release waits for the operator release control to resume.");
      return "incubation_blocked";
    }
    if (!canReleaseStrategyToPaper(this.env, strategy)) {
      strategy.state = "release_blocked_short"; strategy.incubation.status = "release_blocked_short";
      strategy.release_blocked_reason = "short_execution_not_enabled";
      if (strategy.lifecycle?.quality?.state === "incubation") transitionStrategyLifecycle(strategy,
        "release_blocked_short", { trigger: "incubation_evidence", artifact_id: artifactId,
          event_id: command.command_id, reason_code: "release_blocked_short",
          explanation: "Incubation passed; independent paper-short execution remains disabled.",
          correlation_id: decision.decision_id, timestamp: command.timestamp });
      if (this.incubationStore) await this.incubationStore.persistEvidence({ workspaceId: SINGLETON_NAME, strategy });
      this.record(state, "RELEASE_BLOCKED", `${strategy.name} passed incubation`,
        "Evidence is frozen; paper release waits only for the independent short-execution switch.");
      return "release_blocked_short";
    }
    strategy.state = "released"; strategy.released_at ??= command.timestamp;
    strategy.incubation.status = "released_paper";
    strategy.release_blocked_reason = null;
    if (this.incubationStore) {
      await this.incubationStore.persistEvidence({ workspaceId: SINGLETON_NAME, strategy });
      const release = await this.incubationStore.persistRelease({ workspaceId: SINGLETON_NAME,
        strategy, decisionArtifactId: artifactId, releasedAt: command.timestamp });
      strategy.release_id = release.releaseId;
    }
    if (["incubation", "release_blocked_short"].includes(strategy.lifecycle?.quality?.state)) {
      transitionStrategyLifecycle(strategy, "released_paper", { trigger: "incubation_evidence",
        artifact_id: artifactId, event_id: command.command_id, reason_code: "incubation_passed",
        explanation: `${decision.summary.valid_trading_days} valid days and ${decision.summary.eligible_trades} eligible trades`,
        correlation_id: decision.decision_id, timestamp: command.timestamp });
    }
    startReleaseMonitoring(strategy, { releaseId: strategy.release_id,
      startedAt: command.timestamp, policy: createHealthPolicy() });
    if (this.healthStore) await this.healthStore.persistPolicy({ workspaceId: SINGLETON_NAME,
      evidence: strategy.health });
    if (strategy.health_challenger?.champion_id) {
      const champion = state.strategies.find((item) => item.id === strategy.health_challenger.champion_id);
      const replacement = championReplacementAssessment(strategy, champion);
      strategy.health_challenger.replacement_assessment = replacement;
      if (replacement.eligible && champion) {
        champion.state = "retired"; champion.retired_at = command.timestamp;
        champion.replaced_by = strategy.id;
        champion.risk_overlay = { health_multiplier: 0, portfolio_multiplier: 0,
          effective_multiplier: 0, reason_codes: ["champion_replaced"], updated_at: command.timestamp };
        if (champion.health) champion.health.status = "retired";
        if (champion.lifecycle?.quality?.state !== "retired") transitionStrategyLifecycle(champion,
          "retired", { trigger: "champion_replacement", artifact_id: artifactId,
            event_id: command.command_id, reason_code: "superior_challenger_released",
            explanation: `${strategy.id} passed every gate and improved frozen portfolio evidence`,
            correlation_id: decision.decision_id, timestamp: command.timestamp });
        if (this.healthStore) await this.healthStore.persistRetirement({ workspaceId: SINGLETON_NAME,
          strategy: champion, reason: "superior_challenger_released", endedAt: command.timestamp });
      } else {
        strategy.state = "retired"; strategy.retired_at = command.timestamp;
        strategy.health.status = "retired";
        strategy.risk_overlay = { health_multiplier: 0, portfolio_multiplier: 0,
          effective_multiplier: 0, reason_codes: ["challenger_not_selected", ...replacement.reason_codes],
          updated_at: command.timestamp };
        if (strategy.lifecycle?.quality?.state !== "retired") transitionStrategyLifecycle(strategy,
          "retired", { trigger: "challenger_assessment", artifact_id: artifactId,
            event_id: command.command_id, reason_code: "challenger_not_selected",
            explanation: replacement.reason_codes.join(", ") || "Challenger did not improve portfolio evidence",
            correlation_id: decision.decision_id, timestamp: command.timestamp });
        state.research?.novelty_archive?.dna_hashes?.push(strategy.dna_hash);
        if (state.research?.novelty_archive?.dna_hashes) {
          state.research.novelty_archive.dna_hashes = [...new Set(state.research.novelty_archive.dna_hashes)].sort();
        }
        if (this.healthStore) await this.healthStore.persistRetirement({ workspaceId: SINGLETON_NAME,
          strategy, reason: "challenger_not_selected", endedAt: command.timestamp });
        this.record(state, "CHALLENGER_REJECT", `${strategy.name} kept out of paper allocation`,
          replacement.reason_codes.join(", ") || "Portfolio evidence did not improve.");
        return "challenger_not_selected";
      }
    }
    this.record(state, "RELEASE", `${strategy.name} released to paper`,
      "Frozen live-incubation evidence passed; risk becomes eligible on the next safe canonical bar.");
    return "released_paper";
  }

  async persistHealthDecisionArtifact(state, strategy, decision, timestamp) {
    if (strategy.health?.decision_artifact_id
        && strategy.health?.artifact_decision_id === decision.decision_id) {
      return strategy.health.decision_artifact_id;
    }
    const legacyId = `health-${decision.decision_id}`;
    const content = { schema_version: 1, kind: "release.health-decision", strategy_id: strategy.id,
      release_id: strategy.health.release_id, decision, evidence: strategy.health,
      created_at: timestamp };
    const resultHash = await sha256(content);
    const stored = await this.controlPlane.artifacts.putArtifact(legacyId, content, {
      phase: "release_monitoring", strategy_id: strategy.id, decision_id: decision.decision_id,
    }, this.controlPlane.artifacts.contentStore ? {
      strategyId: strategy.id, policyVersionId: this.healthStore?.policyVersionId(strategy.health) ?? null,
      resultHash, redactionClass: "private",
    } : {});
    const artifactId = stored.mirror?.artifact_id ?? legacyId;
    strategy.health.decision_artifact_id = artifactId;
    strategy.health.artifact_decision_id = decision.decision_id;
    state.healthArtifacts ??= {};
    state.healthArtifacts[artifactId] = { id: artifactId, strategy_id: strategy.id,
      release_id: strategy.health.release_id, decision_id: decision.decision_id,
      outcome: decision.outcome, created_at: timestamp };
    return artifactId;
  }

  async applyHealthDecision(state, strategy, decision, command) {
    const priorQuality = strategy.health.status;
    if (this.healthStore) await this.healthStore.persistPolicy({ workspaceId: SINGLETON_NAME,
      evidence: strategy.health });
    const artifactId = await this.persistHealthDecisionArtifact(state, strategy, decision, command.timestamp);
    const quality = decision.quality_outcome;
    const operational = decision.operational_outcome;
    if (operational === "operational_blocked") {
      strategy.operational_status = "operational_blocked";
      strategy.health.operational_status = "operational_blocked";
      if (strategy.lifecycle?.operational?.state !== "operational_blocked") {
        transitionStrategyLifecycle(strategy, "operational_blocked", { kind: "operational",
          trigger: "release_health", artifact_id: artifactId, event_id: command.command_id,
          reason_code: decision.findings[0] ?? "operational_blocked",
          explanation: decision.findings.join(", ") || "Monitoring evidence is operationally blocked",
          correlation_id: decision.decision_id, timestamp: command.timestamp, actor: command.actor });
      }
    } else {
      if (strategy.lifecycle?.operational?.state === "operational_blocked") {
        transitionStrategyLifecycle(strategy, "ready", { kind: "operational",
          trigger: "release_health_recovery", artifact_id: artifactId, event_id: command.command_id,
          reason_code: "operational_recovered", explanation: "A complete fault-free health session restored monitoring",
          correlation_id: decision.decision_id, timestamp: command.timestamp, actor: command.actor });
      }
      strategy.operational_status = "ready"; strategy.health.operational_status = "ready";
    }
    if (["healthy", "watch", "quarantined", "retired"].includes(quality)) {
      strategy.health.status = quality;
      if (quality !== priorQuality && strategy.lifecycle?.quality?.state !== quality) {
        transitionStrategyLifecycle(strategy, quality, { trigger: "release_health",
          artifact_id: artifactId, event_id: command.command_id,
          reason_code: decision.findings[0] ?? quality,
          explanation: decision.findings.join(", ") || `Release health changed to ${quality}`,
          correlation_id: decision.decision_id, timestamp: command.timestamp, actor: command.actor });
      }
      strategy.state = quality;
    }
    const healthValue = healthMultiplier(decision, strategy.health.policy);
    const portfolioValue = Number(strategy.risk_overlay?.portfolio_multiplier ?? 1);
    strategy.risk_overlay = { health_multiplier: healthValue, portfolio_multiplier: portfolioValue,
      effective_multiplier: healthValue * portfolioValue, reason_codes: [...decision.findings],
      updated_at: command.timestamp, decision_id: decision.decision_id };
    const summary = decision.summary ?? {};
    strategy.monitor ??= { returns: [], streak: 0, adjustments: 0 };
    Object.assign(strategy.monitor, { sharpe: summary.daily_sharpe ?? null,
      drawdown: summary.drawdown ?? null, ratio: summary.expectancy ?? null,
      adjustments: strategy.health.risk_overlay_history?.length ?? 0 });
    strategy.health.risk_overlay_history.push({ at: command.timestamp,
      multiplier: strategy.risk_overlay.effective_multiplier, reason_codes: decision.findings,
      decision_id: decision.decision_id });
    if (quality === "quarantined" && priorQuality !== "quarantined") {
      strategy.health.quarantine_count = Number(strategy.health.quarantine_count ?? 0) + 1;
      if (strategy.strategy_format === "dsl-v1" && !strategy.health_challenger_id) {
        const child = reproduce(state, strategy.id);
        child.health_challenger = { champion_id: strategy.id, source_release_id: strategy.health.release_id,
          source_decision_id: decision.decision_id, diagnostics: [...decision.findings],
          created_at: command.timestamp };
        strategy.health_challenger_id = child.id;
      }
    }
    if (quality === "retired") {
      strategy.retired_at = command.timestamp;
      state.research?.novelty_archive?.dna_hashes?.push(strategy.dna_hash);
      if (state.research?.novelty_archive?.dna_hashes) {
        state.research.novelty_archive.dna_hashes = [...new Set(state.research.novelty_archive.dna_hashes)].sort();
      }
      if (this.healthStore) await this.healthStore.persistRetirement({ workspaceId: SINGLETON_NAME,
        strategy, reason: decision.findings[0] ?? "persistent_degradation", endedAt: command.timestamp,
        actor: command.actor });
    }
    if (this.healthStore) await this.healthStore.persistDecision({ workspaceId: SINGLETON_NAME,
      strategy, decision, artifactId, observedAt: command.timestamp, actor: command.actor });
    if (this.healthStore && operational === "ready") await this.healthStore.resolveOperationalIncidents({
      workspaceId: SINGLETON_NAME, strategy, resolvedAt: command.timestamp });
    this.record(state, operational === "operational_blocked" ? "OPERATIONAL_BLOCK"
      : quality === "retired" ? "RETIRE" : quality === "quarantined" ? "QUARANTINE"
        : quality === "watch" ? "WATCH" : "HEALTHY",
    `${strategy.name} · ${operational === "operational_blocked" ? "risk paused" : quality}`,
    decision.findings.join(", ") || "Frozen release-health policy evaluated");
    return decision.outcome;
  }

  async applyPortfolioHealthOverlays(state, command) {
    const strategies = state.strategies.filter((item) => ["released", "healthy", "watch", "quarantined"].includes(item.state));
    const overlays = portfolioRiskOverlays(strategies, state.alpaca?.allocation ?? {}, createHealthPolicy());
    for (const strategy of strategies) {
      const overlay = overlays[strategy.id] ?? { multiplier: 1, reason_codes: [] };
      strategy.risk_overlay ??= { health_multiplier: 1 };
      strategy.risk_overlay.portfolio_multiplier = overlay.multiplier;
      strategy.risk_overlay.effective_multiplier = Number(strategy.risk_overlay.health_multiplier ?? 1) * overlay.multiplier;
      strategy.risk_overlay.reason_codes = [...new Set([...(strategy.risk_overlay.reason_codes ?? []), ...overlay.reason_codes])];
      strategy.risk_overlay.updated_at = command.timestamp;
      if (this.healthStore) await this.healthStore.persistPortfolioOverlay({ workspaceId: SINGLETON_NAME,
        strategy, sessionDate: command.payload?.session_date ?? command.timestamp.slice(0, 10),
        overlay, decidedAt: command.timestamp });
    }
    state.portfolio_health = { evaluated_at: command.timestamp,
      overlays: Object.fromEntries(Object.entries(overlays).map(([id, value]) => [id, value])),
      gross_before_netting: state.alpaca?.allocation?.gross_before_netting ?? 0 };
  }

  async executeOrchestrationActions(state, command, result) {
    const orchestration = ensureOrchestrationState(state, orchestrationMode(this.env));
    const followups = [];
    orchestration.executed_command_ids ??= [];
    if (orchestration.executed_command_ids.includes(command.command_id)) return { duplicate: true };
    try {
      await executeOrchestrationActionBatch(result.actions, async (action) => {
      if (action.kind === "watchdog.repair" && this.orchestrationStore) {
        await this.orchestrationStore.repairExpiredLeases();
        await this.orchestrationStore.dispatchOutbox();
      } else if (action.kind === "broker.cancel_unsafe_orders") {
        if (!this.env.ALPACA_API_KEY || !this.env.ALPACA_API_SECRET) {
          throw new Error("Broker order cancellation requires configured Alpaca paper credentials");
        } else {
          const cancellation = await this.gateways.broker.cancelManagedOpenOrders();
          if (this.brokerStore) await this.brokerStore.persistCancellations({
            workspaceId: SINGLETON_NAME, cancelled: cancellation.cancelled,
          });
          this.record(state, "BROKER_SAFETY", "Managed open orders cancelled",
            `${cancellation.cancelled.length} framework orders cancelled; ${cancellation.skipped_manual_orders} manual orders untouched`);
        }
      } else if (action.kind === "broker.verify_flat") {
        if (!this.env.ALPACA_API_KEY || !this.env.ALPACA_API_SECRET) {
          throw new Error("Flat-position verification requires configured Alpaca paper credentials");
        } else {
          const overview = await this.gateways.broker.accountOverview();
          const managed = new Set(state.alpaca?.managed_symbols ?? []);
          const remaining = overview.positions.filter((position) => managed.has(position.symbol));
          if (remaining.length) orchestration.incidents.push({ kind: "broker_not_flat", action: action.kind,
            command_id: command.command_id, symbols: remaining.map((position) => position.symbol), opened_at: command.timestamp });
          else orchestration.controls.flatten_requested = false;
        }
      } else if (action.kind === "broker.flatten_all") {
        if (!this.env.ALPACA_API_KEY || !this.env.ALPACA_API_SECRET) {
          throw new Error("Managed flatten requires configured Alpaca paper credentials");
        }
        const bucket = `flatten:${command.command_id}`;
        const cycle = await this.runBrokerCycle(state, bucket, command.timestamp, {
          scope: "released", tradingEnabled: true, safetyFlatten: true,
        });
        applyAlpacaCycle(state, cycle);
        if (cycle.order_errors?.length) {
          throw new Error(`Managed flatten order failed: ${cycle.order_errors.map((item) => `${item.symbol}: ${item.message}`).join(", ")}`);
        }
        const managed = new Set(state.alpaca?.managed_symbols ?? []);
        const exposed = (cycle.positions ?? []).filter((position) => managed.has(position.symbol));
        const closePending = new Set((cycle.safety_reasons ?? [])
          .filter((item) => item.reason === "open_order_pending").map((item) => item.symbol));
        if (exposed.some((position) => !closePending.has(position.symbol)) && !cycle.can_trade_now) {
          throw new Error("Managed flatten could not submit because the paper account or market is unavailable");
        }
        this.record(state, "BROKER_SAFETY", "Managed flatten reconciled",
          `${cycle.submitted_orders?.length ?? 0} close orders submitted; ${closePending.size} symbols already had an open order`);
      } else if (action.kind === "risk.reset_daily_halt") {
        if (!this.env.ALPACA_API_KEY || !this.env.ALPACA_API_SECRET) {
          throw new Error("Daily-loss reset requires configured Alpaca paper credentials");
        }
        const overview = await this.gateways.broker.accountOverview();
        applyAlpacaOverview(state, overview);
        state.alpaca.risk_session = { session_date: newYorkClock(overview.clock.timestamp).date,
          baseline_equity: overview.account.equity, current_equity: overview.account.equity,
          loss_fraction: 0, halted: false, reason: null, triggered_at: null,
          reset_at: command.timestamp, reset_by: command.actor };
        this.record(state, "RISK_RESET", "Daily loss halt reset",
          `New paper baseline $${overview.account.equity.toFixed(2)} set by ${command.actor}`);
      } else if (action.kind === "broker.run_canary") {
        const bucket = `canary:${command.command_id}`;
        const cycle = await this.runBrokerCycle(state, bucket, command.timestamp, {
          scope: "released", tradingEnabled: true, canary: action.payload,
        });
        applyAlpacaCycle(state, cycle);
        if (cycle.order_errors?.length || !(cycle.submitted_orders?.length)) {
          throw new Error(cycle.order_errors?.[0]?.message ?? "Broker canary did not submit");
        }
        this.record(state, "BROKER_CANARY", `${action.payload.side.toUpperCase()} canary submitted`,
          `${action.payload.symbol} · $${action.payload.notional}`);
      } else if (action.kind === "operational.retry") {
        const strategy = state.strategies.find((item) => item.id === action.strategy_id);
        if (!strategy?.lifecycle) throw new Error(`Unknown lifecycle strategy ${action.strategy_id}`);
        if (["retry_wait", "service_unavailable", "data_blocked", "broker_blocked", "dead_lettered"].includes(strategy.lifecycle.operational.state)) {
          transitionStrategyLifecycle(strategy, "queued", { kind: "operational", trigger: "operator_retry",
            artifact_id: `operator-command:${command.command_id}`, event_id: command.command_id,
            reason_code: "operator_retry", explanation: command.payload?.reason ?? "Operational work retried by operator.",
            correlation_id: command.correlation_id, timestamp: command.timestamp, actor: command.actor });
        }
      } else if (["strategy.pause", "strategy.resume", "strategy.quarantine", "strategy.retire"].includes(action.kind)) {
        const strategy = state.strategies.find((item) => item.id === action.strategy_id);
        if (!strategy) throw new Error(`Unknown strategy ${action.strategy_id}`);
        if (["strategy.quarantine", "strategy.retire"].includes(action.kind)) {
          if (!["released", "healthy", "watch", "quarantined"].includes(strategy.state)) {
            throw new Error(`Strategy ${strategy.id} is not an active immutable paper release`);
          }
          startReleaseMonitoring(strategy, { releaseId: strategy.release_id,
            startedAt: strategy.released_at ?? command.timestamp, policy: createHealthPolicy() });
          const quality = action.kind === "strategy.quarantine" ? "quarantined" : "retired";
          const decision = { schema_version: 1, decision_id: `health-operator-${command.command_id}`,
            release_id: strategy.health.release_id, policy_hash: strategy.health.policy_hash,
            provenance_hash: strategy.health.provenance_hash, outcome: quality, quality_outcome: quality,
            operational_outcome: "ready", findings: [action.kind],
            summary: { operator_decision: true }, evidence_event_id: command.command_id };
          strategy.health.decision = decision;
          if (!strategy.health.decision_history.some((item) => item.decision_id === decision.decision_id)) {
            strategy.health.decision_history.push(decision);
          }
          await this.applyHealthDecision(state, strategy, decision, command);
          strategy.operator_action = { kind: action.kind, command_id: command.command_id, at: command.timestamp };
          return;
        }
        const lifecycleTarget = action.kind === "strategy.pause" ? "operator_paused"
          : strategy.lifecycle?.paused_from;
        if (!lifecycleTarget) throw new Error(`Strategy ${strategy.id} has no paused lifecycle to resume`);
        if (strategy.lifecycle && strategy.lifecycle.quality.state !== lifecycleTarget) {
          transitionStrategyLifecycle(strategy, lifecycleTarget, { trigger: "operator_command",
            artifact_id: `operator-command:${command.command_id}`, event_id: command.command_id,
            reason_code: action.kind, explanation: command.payload?.reason ?? `${lifecycleTarget} by operator`,
            correlation_id: command.correlation_id, timestamp: command.timestamp, actor: command.actor });
        }
        if (action.kind === "strategy.pause") {
          strategy.operator_pause = { previous_state: strategy.state, command_id: command.command_id, at: command.timestamp };
          strategy.state = "operator_paused";
        } else {
          strategy.state = strategy.operator_pause?.previous_state ?? "generated";
          strategy.operator_pause = null;
        }
        strategy.operator_action = { kind: action.kind, command_id: command.command_id, at: command.timestamp };
      } else if (action.kind === "approval.persist" && this.orchestrationStore) {
        const approval = action.approval;
        await this.orchestrationStore.recordConfigApproval({ approvalId: command.command_id,
          workspaceId: SINGLETON_NAME, configKey: approval.kind, configHash: approval.subject_hash,
          approvedBy: approval.actor });
      } else if (action.kind === "workspace.prepare_reset") {
        if (String(this.env.ENVIRONMENT ?? "development").toLowerCase() === "production") {
          throw new Error("Workspace reset is disabled in production");
        }
        const prepared = await this.buildWorkspaceResetSnapshot();
        const persisted = await this.persistWorkspaceResetManifest(prepared, command);
        orchestration.pending_reset = { schema_version: 1, manifest_hash: prepared.manifest_hash,
          identity: prepared.identity, artifact_manifest: prepared.artifact_manifest, counts: prepared.counts,
          manifest_object_key: persisted.object_key, manifest_content_hash: persisted.content_hash,
          requested_by: command.actor, prepared_at: command.timestamp };
        if (this.controlPlane.normalized) await this.controlPlane.normalized.prepareWorkspaceReset({
          workspaceId: SINGLETON_NAME, requestedBy: command.actor,
          environment: String(this.env.ENVIRONMENT ?? "development"),
          manifestObjectKey: persisted.object_key, manifestHash: prepared.manifest_hash,
        });
        this.record(state, "WORKSPACE_RESET", "Workspace reset prepared",
          `${prepared.counts.d1} D1, ${prepared.counts.r2} R2, and ${prepared.counts.durable_object} Durable Object targets enumerated`);
      } else if (action.kind === "workspace.execute_reset") {
        if (String(this.env.ENVIRONMENT ?? "development").toLowerCase() === "production") {
          throw new Error("Workspace reset is disabled in production");
        }
        const pending = orchestration.pending_reset;
        if (!pending || pending.manifest_hash !== action.payload.manifest_hash) throw new Error("Prepared reset manifest does not match");
        await this.verifyWorkspaceResetManifest(pending);
        const current = await this.buildWorkspaceResetSnapshot();
        if (current.manifest_hash !== pending.manifest_hash) throw new Error("Workspace changed after reset preparation");
        if (this.controlPlane.normalized) await this.controlPlane.normalized.clearWorkspaceData(SINGLETON_NAME);
        if (this.controlPlane.artifacts.contentStore && pending.artifact_manifest) {
          await this.controlPlane.artifacts.contentStore.executeReset({ workspaceId: SINGLETON_NAME,
            manifest: pending.artifact_manifest });
        }
        await this.marketDataRepository.clear();
        await this.controlPlane.artifacts.clear();
        if (this.orchestrationStore) await this.orchestrationStore.clearWorkspace(SINGLETON_NAME);
        if (pending.identity.compatibility_object_keys.length && this.env.AXIOM_ARTIFACTS) {
          await this.env.AXIOM_ARTIFACTS.delete(pending.identity.compatibility_object_keys);
        }
        await this.controlPlane.clearCompatibilityMetadata();
        for (let start = 0; start < pending.identity.durable_object_keys.length; start += 128) {
          await this.ctx.storage.delete(pending.identity.durable_object_keys.slice(start, start + 128));
        }
        const fresh = createDemoState();
        ensureOrchestrationState(fresh, orchestrationMode(this.env));
        for (const key of Object.keys(state)) delete state[key];
        Object.assign(state, fresh);
        return { duplicate: false, reset: true };
      } else if (action.kind === "pipeline.validate") {
        const pending = new Set(state.strategies.filter((item) => item.state === "validation").map((item) => item.id));
        await this.validateRemote(state, this.env, { advanceClock: false, silent: true });
        const failed = state.strategies.find((item) => pending.has(item.id)
          && item.service_status?.phase === "holdout" && item.service_status.status === "infrastructure_error");
        if (failed) throw new Error(`Validation remains retryable for ${failed.id}: ${failed.service_status.error}`);
      } else if (action.kind === "pipeline.review") {
        const pending = new Set(state.strategies.filter((item) => ["generated", "rework"].includes(item.state)).map((item) => item.id));
        await this.reviewRemote(state, this.env, { dsl: {}, legacy: {} });
        const failed = state.strategies.find((item) => pending.has(item.id)
          && item.service_status?.phase === "development" && item.service_status.status === "infrastructure_error");
        if (failed) throw new Error(`Development review remains retryable for ${failed.id}: ${failed.service_status.error}`);
        followups.push(...pipelineFollowups(action.kind, {
          hasValidation: state.strategies.some((item) => item.state === "validation"),
        }));
      } else if (action.kind === "research.schedule") {
        if (!state.marketData?.backfill?.dataset_id) throw new Error("Sealed market dataset is not ready for research");
      } else if (action.kind === "research.run_cohort") {
        const cohort = await this.runSealedResearchCohort(state, command);
        if (cohort.completed) followups.push(...pipelineFollowups(action.kind, {
          paused: cohort.paused, cohortId: cohort.cohort_id,
        }));
      } else if (action.kind === "market.reconcile_session" && state.marketData?.calendar?.id) {
        const calendar = await this.marketDataRepository.loadCalendar(state.marketData.calendar.id);
        if (calendar) await this.reconcileLiveSession(state, new Date(command.timestamp), calendar);
      } else if (action.kind === "broker.stop_entries") {
        this.record(state, "BROKER_SAFETY", "New entries stopped",
          `Entry generation paused for session ${action.payload?.session_date ?? command.timestamp.slice(0, 10)}`);
      } else if (action.kind === "pipeline.compute_targets") {
        if (!this.env.ALPACA_API_KEY || !this.env.ALPACA_API_SECRET) {
          throw new Error("Target computation requires configured Alpaca paper credentials");
        }
        const bucket = String(action.payload?.event_id ?? action.payload?.bucket_close ?? command.command_id);
        const cycle = await this.runBrokerCycle(state, bucket, action.payload?.bucket_close ?? bucket,
          { scope: action.scope, tradingEnabled: action.scope === "released",
            blockNewRisk: Boolean(action.block_new_risk) });
        if (action.scope === "released") {
          applyAlpacaCycle(state, cycle);
          const sessionDate = action.payload?.session_date
            ?? newYorkClock(action.payload?.bucket_close ?? command.timestamp).date;
          const monitored = state.strategies.filter((item) =>
            ["released", "healthy", "watch", "quarantined"].includes(item.state));
          for (const strategy of monitored) {
            if (!cycle.evaluations?.[strategy.id]) continue;
            startReleaseMonitoring(strategy, { releaseId: strategy.release_id,
              startedAt: strategy.released_at ?? command.timestamp, policy: createHealthPolicy() });
            const recorded = recordHealthObservation(strategy, cycle, {
              eventId: action.payload?.event_id ?? bucket, sessionDate,
              observedAt: action.payload?.bucket_close ?? command.timestamp });
            if (!recorded.duplicate && this.healthStore) await this.healthStore.persistObservation({
              workspaceId: SINGLETON_NAME, strategy, observation: recorded.observation });
            if (recorded.decision) await this.applyHealthDecision(state, strategy, recorded.decision, command);
          }
        } else {
          if ((cycle.submitted_orders ?? []).length) throw new Error("Incubation must never submit broker orders");
          orchestration.latest_targets ??= {};
          orchestration.latest_targets.incubation = { bucket, computed_at: command.timestamp,
            evaluations: cycle.evaluations ?? {}, proposed_orders: cycle.proposed_orders ?? [] };
          const sessionDate = action.payload?.session_date ?? newYorkClock(action.payload?.bucket_close ?? command.timestamp).date;
          for (const strategy of state.strategies.filter((item) => item.state === "incubation")) {
            const evaluation = cycle.evaluations?.[strategy.id];
            if (!evaluation) continue;
            const allocated = Object.fromEntries((cycle.allocation?.contributions ?? [])
              .filter((item) => item.strategy_id === strategy.id)
              .map((item) => [item.symbol, Number(item.notional)]));
            const shadowEvaluation = { ...evaluation, symbols: Object.fromEntries(
              Object.entries(evaluation.symbols ?? {}).map(([symbol, item]) => [symbol,
                { ...item, shadow_target_notional: allocated[symbol] ?? 0 }])) };
            const operationalFaults = (cycle.safety_reasons ?? []).filter((item) =>
              item.severity === "critical" && (!item.strategy_id || item.strategy_id === strategy.id))
              .map((item) => item.reason);
            const recorded = recordIncubationEvent(strategy, shadowEvaluation, {
              eventId: action.payload?.event_id ?? bucket, sessionDate,
              bucketClose: action.payload?.bucket_close ?? command.timestamp,
              forceFlatten: cycle.force_flatten, operationalFaults, actualFeed: cycle.feed,
            });
            if (!recorded.duplicate && recorded.closed_trades > 0) {
              const peers = state.strategies.filter((item) => item.id !== strategy.id
                && ["released", "healthy", "watch", "quarantined"].includes(item.state))
                .map((item) => item.behavior_hash ?? item.research?.behavior_hash).filter(Boolean);
              const decision = evaluateIncubationGate(strategy.incubation, { releasedBehaviorHashes: peers });
              await this.applyIncubationDecision(state, strategy, decision, command);
            }
          }
        }
      } else if (action.kind === "pipeline.monitor") {
        const bucket = String(action.payload?.event_id ?? action.payload?.bucket_close ?? "");
        if (bucket && state.alpaca?.last_cycle_bucket !== bucket) {
          throw new Error(`Monitoring evidence is unavailable until target cycle ${bucket} completes`);
        }
        orchestration.latest_monitoring_at = command.timestamp;
        if (!bucket && action.payload?.session_date) {
          const open = action.payload?.session_open, close = action.payload?.session_close;
          const minutes = (value) => { const [hour, minute] = String(value ?? "").split(":").map(Number);
            return Number.isFinite(hour + minute) ? hour * 60 + minute : null; };
          const expectedEvents = minutes(open) !== null && minutes(close) !== null
            ? Math.max(1, Math.floor((minutes(close) - minutes(open)) / 5)) : 78;
          for (const strategy of state.strategies.filter((item) =>
            ["released", "healthy", "watch", "quarantined"].includes(item.state))) {
            startReleaseMonitoring(strategy, { releaseId: strategy.release_id,
              startedAt: strategy.released_at ?? command.timestamp, policy: createHealthPolicy() });
            const operationalFaults = orchestration.incidents.filter((item) => !item.resolved_at
              && item.strategy_id === strategy.id && item.severity === "critical").map((item) => item.kind);
            const healthDecision = finalizeHealthSession(strategy, action.payload.session_date,
              { expectedEvents, operationalFaults });
            await this.applyHealthDecision(state, strategy, healthDecision, command);
          }
          await this.applyPortfolioHealthOverlays(state, command);
        }
      } else if (action.kind === "pipeline.incubation") {
        const candidates = state.strategies.filter((strategy) => strategy.state === "incubation");
        const sessionDate = action.payload?.session_date ?? newYorkClock(command.timestamp).date;
        const open = action.payload?.session_open, close = action.payload?.session_close;
        const toMinutes = (value) => { const [hours, minutes] = String(value ?? "").split(":").map(Number);
          return Number.isFinite(hours + minutes) ? hours * 60 + minutes : null; };
        const expectedBars = toMinutes(open) !== null && toMinutes(close) !== null
          ? Math.max(1, Math.floor((toMinutes(close) - toMinutes(open)) / 5)) : 78;
        for (const strategy of candidates) {
          const decision = finalizeIncubationSession(strategy, sessionDate, { expectedBars,
            marketDataCriticalFault: state.marketData?.live?.status === "critical", sessionOpen: open,
            operationalFaults: orchestration.incidents.filter((item) => !item.resolved_at
              && item.strategy_id === strategy.id && item.severity === "critical").map((item) => item.kind) });
          await this.applyIncubationDecision(state, strategy, decision, command);
        }
      } else if (action.kind === "pipeline.release") {
        for (const strategy of state.strategies.filter((item) => item.release_ready
          && ((item.state === "incubation" && item.release_blocked_reason === "release_paused")
            || (item.state === "release_blocked_short" && canReleaseStrategyToPaper(this.env, item))))) {
          const peers = state.strategies.filter((item) => item.id !== strategy.id
            && ["released", "healthy", "watch", "quarantined"].includes(item.state))
            .map((item) => item.behavior_hash ?? item.research?.behavior_hash).filter(Boolean);
          const decision = evaluateIncubationGate(strategy.incubation, { releasedBehaviorHashes: peers });
          if (decision.outcome !== "released_paper") throw new Error(`Frozen incubation replay changed for ${strategy.id}`);
          await this.applyIncubationDecision(state, strategy, decision, command);
        }
      } else if (action.kind === "report.generate_daily") {
        state.operational_reports ??= { daily: {}, weekly: {} };
        const date = action.payload?.session_date ?? command.timestamp.slice(0, 10);
        state.operational_reports.daily[date] = { generated_at: command.timestamp,
          strategies: state.strategies.length,
          active: state.strategies.filter((item) => ["released", "healthy", "watch", "quarantined"].includes(item.state)).length,
          incidents: orchestration.incidents.filter((item) => !item.resolved_at).length,
          market_data_status: state.marketData?.live?.status ?? "unknown" };
      } else if (action.kind === "review.weekly") {
        state.operational_reports ??= { daily: {}, weekly: {} };
        const week = action.payload?.week_start ?? action.payload?.session_date ?? command.timestamp.slice(0, 10);
        const byArchetype = {};
        for (const strategy of state.strategies) {
          const key = strategy.archetype ?? strategy.strategy_format ?? "unknown";
          byArchetype[key] = (byArchetype[key] ?? 0) + 1;
        }
        state.operational_reports.weekly[week] = { generated_at: command.timestamp,
          strategy_count: state.strategies.length, by_archetype: byArchetype };
      } else {
        throw new Error(`Unhandled orchestration action: ${action.kind}`);
      }
      });
    } catch (error) {
      orchestration.incidents.push({ kind: "orchestration_action_failed", command_id: command.command_id,
        command_kind: command.kind, reason: error instanceof Error ? error.message : String(error),
        opened_at: new Date().toISOString() });
      orchestration.incidents = orchestration.incidents.slice(-512);
      state.orchestration = orchestration;
      await this.controlPlane.saveState(state);
      throw error;
    }
    orchestration.executed_command_ids.push(command.command_id);
    orchestration.executed_command_ids = orchestration.executed_command_ids.slice(-2048);
    return { duplicate: false, followups };
  }

  async submitOrchestrationCommand(state, command, { forceDirect = false } = {}) {
    const current = ensureOrchestrationState(state, orchestrationMode(this.env));
    if (orchestrationCommandDisposition(current.mode, command.actor) === "observe") {
      return { schema_version: command.schema_version, command_id: command.command_id,
        intent_id: command.intent_id, status: "observed", actions: [], reason: "observe_mode",
        completed_at: command.timestamp, queued: false, idempotent: false };
    }
    const applied = applyOrchestrationCommand(current, command);
    if (applied.blocked) return { ...applied.result, queued: false, idempotent: false };
    if (!applied.idempotent) {
      if (!forceDirect && orchestrationMode(this.env) === "autonomous" && this.orchestrationStore && this.env.AXIOM_JOBS) {
        await this.orchestrationStore.persistLifecycle({ workspaceId: SINGLETON_NAME,
          strategyId: "__workspace__", expectedVersion: current.version,
          state: applied.result.status, snapshot: applied.state,
          command: { id: command.command_id, idempotencyKey: command.command_id, kind: command.kind, payload: command },
          transition: { id: `OTR-${command.command_id.slice(4)}`, details: { actor: command.actor, correlation_id: command.correlation_id } },
          fromState: current.latest_command_id ? "active" : "ready",
          outbox: { kind: "orchestration.command.v1", payload: { workspace_id: SINGLETON_NAME, command } },
        });
        state.orchestration = applied.state;
        await this.controlPlane.saveState(state);
        await this.orchestrationStore.dispatchOutbox();
        return { ...applied.result, queued: true };
      }
      state.orchestration = applied.state;
    }
    const executed = await this.executeOrchestrationActions(state, command, applied.result);
    const followupResults = [];
    if (executed.followups?.length) await this.controlPlane.saveState(state);
    for (const followup of executed.followups ?? []) {
      const next = createOrchestrationCommand({ kind: followup.kind,
        intent_id: `${command.intent_id ?? command.command_id}:${followup.suffix}`,
        actor: command.actor, timestamp: command.timestamp,
        correlation_id: command.correlation_id, payload: { parent_command_id: command.command_id } });
      followupResults.push(await this.submitOrchestrationCommand(state, next));
    }
    return { ...applied.result, queued: false, idempotent: applied.idempotent,
      ...(followupResults.length ? { followups: followupResults } : {}) };
  }

  async planAndSubmitOrchestration(state, timestamp, events = []) {
    const orchestration = ensureOrchestrationState(state, orchestrationMode(this.env));
    const calendar = state.marketData?.calendar?.id
      ? await this.marketDataRepository.loadCalendar(state.marketData.calendar.id) : null;
    const intents = planOrchestrationWork({ events, calendar, now: timestamp,
      completed_intent_ids: orchestration.completed_intent_ids,
      ingestion_paused: orchestration.controls.ingestion_paused });
    const results = [];
    for (const intent of intents) {
      const command = createOrchestrationCommand({ kind: intent.kind, intent_id: intent.id, actor: "system",
        timestamp: new Date(timestamp).toISOString(), correlation_id: intent.id, payload: intent.data });
      results.push(await this.submitOrchestrationCommand(state, command));
    }
    return results;
  }

  async alarm() {
    const state = await this.load();
    const timestamp = new Date().toISOString();
    await this.planAndSubmitOrchestration(state, timestamp, []);
    if (this.orchestrationStore) {
      await this.orchestrationStore.repairExpiredLeases();
      if (this.env.AXIOM_JOBS) await this.orchestrationStore.dispatchOutbox();
    }
    await this.controlPlane.saveState(state);
    if (orchestrationMode(this.env) === "autonomous" && this.ctx.storage.setAlarm) await this.ctx.storage.setAlarm(Date.now() + 60_000);
  }

  async clearWorkspaceStorage() {
    await this.marketDataRepository.clear();
    await this.controlPlane.artifacts.clear();
  }

  async ensureMarketCalendar(state, start, end, force = false) {
    const existing = state.marketData?.calendar;
    if (!force && existing?.requested_start <= start && existing?.requested_end >= end) {
      const stored = await this.marketDataRepository.loadCalendar(existing.id);
      if (stored) return stored;
    }
    const rows = await this.gateways.marketData.calendar(start, end);
    const manifest = await buildCalendarManifest(rows, start, end);
    await this.marketDataRepository.saveCalendar(manifest);
    recordMarketDataUsage(state, {
      alpaca_requests: rows.__alpaca_request_count ?? 1, d1_rows: 1, r2_writes: 1,
    });
    state.marketData.calendar = {
      id: manifest.id, sha256: manifest.sha256, source: manifest.source,
      timezone: manifest.timezone, first_session: manifest.first_session,
      last_session: manifest.last_session, session_count: manifest.session_count,
      requested_start: manifest.requested_start, requested_end: manifest.requested_end,
    };
    return manifest;
  }

  async startMarketBackfill(state, body = {}) {
    if (marketDataMode(this.env) !== "shadow") throw new Error("MARKET_DATA_MODE must be shadow to start a backfill");
    const costPolicy = evaluateCostPolicy(state, this.env, new Date());
    if (!costPolicy.optional_backfills_allowed) {
      const error = new Error(`Optional historical backfill is paused: ${costPolicy.reason}`);
      error.status = 429; throw error;
    }
    this.marketDataRepository.assertPersistentReady();
    const asOf = body.as_of ? new Date(`${body.as_of}T12:00:00Z`) : new Date();
    if (Number.isNaN(asOf.getTime())) throw new Error("Invalid backfill as_of date");
    const defaults = backfillDateBounds(asOf);
    const start = String(body.start ?? defaults.start);
    const end = String(body.end ?? defaults.end);
    const durationDays = (new Date(`${end}T00:00:00Z`) - new Date(`${start}T00:00:00Z`)) / 86400000;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)
        || start > end || durationDays < 1090 || durationDays > 1105) {
      throw new Error("Historical backfill must cover one bounded three-year period");
    }
    const universe = await runtimeUniverseManifest(this.env);
    const assets = await this.gateways.marketData.assets(universe.symbols);
    recordMarketDataUsage(state, { alpaca_requests: assets.__alpaca_request_count ?? universe.symbols.length });
    const unavailable = universe.symbols.filter((symbol) => assets[symbol]?.status !== "active" || !assets[symbol]?.tradable);
    if (unavailable.length) throw new Error(`Initial universe contains unavailable assets: ${unavailable.join(", ")}`);
    await this.marketDataRepository.saveUniverse(universe);
    const calendar = await this.ensureMarketCalendar(state, start, end, true);
    const jobs = await buildBackfillJobs({ universe, calendar, start, end });
    const backfillHash = await sha256({ universe_id: universe.id, universe_hash: universe.sha256,
      calendar_id: calendar.id, start, end, jobs: jobs.map((job) => job.id) });
    const backfillId = `backfill-${backfillHash.slice(0, 32)}`;
    await this.marketDataRepository.createBackfillJobs(backfillId, jobs);
    const progress = await this.marketDataRepository.backfillProgress(backfillId);
    state.marketData.backfill = {
      id: backfillId, status: progress.complete ? "running" : "queued", start, end, total_jobs: progress.total,
      completed_jobs: progress.complete, failed_jobs: progress.failed,
      dataset_id: state.marketData.backfill?.id === backfillId ? state.marketData.backfill.dataset_id : null,
      calendar_id: calendar.id,
      universe_id: universe.id, started_at: new Date().toISOString(), completed_at: null,
    };
    this.record(state, "MARKET_DATA", "Three-year IEX backfill queued",
      `${universe.symbols.length} symbols · ${jobs.length} resumable monthly partitions`);
    // Persist the immutable backfill identity before messages can reach the DO.
    // If queue submission fails, restarting the same command safely re-enqueues
    // every deterministic job and completed partitions are skipped.
    await this.controlPlane.saveState(state);
    await sendQueueMessages(this.env.AXIOM_JOBS, jobs.map((job) => ({
      kind: "market-data.backfill-partition.v1", workspace_id: SINGLETON_NAME, backfill_id: backfillId, job,
    })));
    recordHeartbeat(state, "queue", { status: "healthy", correlation_id: backfillId,
      detail: { messages: jobs.length, kind: "market_backfill" } });
    recordMarketDataUsage(state, { queue_messages: jobs.length, d1_rows: jobs.length });
  }

  async syncBackfillProgress(state, backfillId) {
    const progress = await this.marketDataRepository.backfillProgress(backfillId);
    if (state.marketData?.backfill?.id === backfillId) {
      state.marketData.backfill.total_jobs = progress.total;
      state.marketData.backfill.completed_jobs = progress.complete;
      state.marketData.backfill.failed_jobs = progress.failed;
      state.marketData.backfill.status = progress.complete === progress.total && progress.total > 0
        ? "complete" : progress.failed ? "degraded" : "running";
    }
    return progress;
  }

  async finalizeBackfillDataset(state, backfillId, universe, calendar, start, end) {
    if (state.marketData?.backfill?.dataset_id) return state.marketData.backfill.dataset_id;
    const rows = await this.marketDataRepository.listPartitions(backfillId);
    const partitions = rows.map((row) => ({
      id: row.partition_id, universe_id: row.universe_id, calendar_id: row.calendar_id,
      feed: row.feed, timeframe: row.timeframe, adjustment: row.adjustment, symbol: row.symbol,
      month: row.partition_month, start: row.range_start, end: row.range_end, row_count: row.row_count,
      expected_bars: row.expected_bars, missing_bars: row.missing_bars, coverage: row.coverage,
      adjustment_discontinuities: row.adjustment_discontinuities,
      content_hash: row.content_hash, sha256: row.manifest_hash, object_key: row.object_key,
      byte_length: row.byte_length,
    }));
    const manifest = await buildDatasetManifest({ universe, calendar, start, end, partitions });
    await this.marketDataRepository.saveDatasetManifest(manifest);
    state.marketData.backfill.dataset_id = manifest.id;
    state.marketData.backfill.dataset_hash = manifest.sha256;
    state.marketData.backfill.row_count = manifest.row_count;
    state.marketData.backfill.missing_bars = manifest.missing_bars;
    state.marketData.backfill.completed_at = new Date().toISOString();
    this.record(state, "MARKET_DATA", "Three-year IEX dataset sealed",
      `${manifest.row_count} five-minute bars · root ${manifest.sha256.slice(0, 12)}`);
    return manifest.id;
  }

  async processMarketBackfillPartition(state, body) {
    const startedAt = Date.now();
    const job = body?.job;
    const backfillId = String(body?.backfill_id ?? "");
    if (!job?.id || !backfillId || job.universe_id !== state.marketData?.backfill?.universe_id) {
      throw new Error("Market-data backfill job does not match the active immutable backfill");
    }
    const existing = await this.marketDataRepository.backfillJobStatus(job.id);
    if (existing?.status === "complete") {
      const progress = await this.syncBackfillProgress(state, backfillId);
      if (progress.complete === progress.total && progress.total > 0 && !state.marketData.backfill.dataset_id) {
        const universe = await runtimeUniverseManifest(this.env);
        const calendar = await this.marketDataRepository.loadCalendar(job.calendar_id);
        if (!calendar) throw new Error("Sealed backfill calendar is unavailable for dataset finalization");
        await this.finalizeBackfillDataset(state, backfillId, universe, calendar,
          state.marketData.backfill.start, state.marketData.backfill.end);
      }
      return { duplicate: true, partition_id: existing.partition_id };
    }
    try {
      await this.marketDataRepository.markBackfillJob(job.id, "running");
      const calendar = await this.marketDataRepository.loadCalendar(job.calendar_id);
      if (!calendar || calendar.sha256 !== state.marketData.calendar?.sha256) {
        // The active live calendar may differ; accept the exact sealed backfill
        // calendar by ID and verify its own hash through the stored manifest.
        if (!calendar?.sha256) throw new Error("Sealed backfill calendar is unavailable");
      }
      const universe = await runtimeUniverseManifest(this.env);
      if (job.universe_hash !== universe.sha256) throw new Error("Backfill universe hash mismatch");
      const response = await this.gateways.marketData.fiveMinuteHistory(job.symbol, {
        start: `${job.start}T00:00:00Z`, end: `${nextIsoDate(job.end)}T00:00:00Z`,
      });
      recordMarketDataUsage(state, { alpaca_requests: response.__alpaca_request_count ?? 1 });
      const audit = auditFiveMinuteBars(job.symbol, response[job.symbol] ?? [], calendar.sessions,
        { start: job.start, end: job.end });
      if (!audit.bars.length) throw new Error(`${job.symbol} returned no regular-session bars for ${job.partition}`);
      const partitions = await buildHistoricalPartitions({ universe, calendar, symbol: job.symbol, audit, job });
      if (partitions.length !== 1 || partitions[0].month !== job.partition) {
        throw new Error(`Backfill job ${job.id} did not produce its single expected monthly partition`);
      }
      const saved = await this.marketDataRepository.savePartition(partitions[0], audit);
      await this.marketDataRepository.markBackfillJob(job.id, "complete", { partition_id: saved.id });
      recordMarketDataUsage(state, { d1_rows: 3, r2_writes: 1, worker_elapsed_ms: Date.now() - startedAt });
      const progress = await this.syncBackfillProgress(state, backfillId);
      if (progress.complete === progress.total && progress.total > 0) {
        await this.finalizeBackfillDataset(state, backfillId, universe, calendar,
          state.marketData.backfill.start, state.marketData.backfill.end);
      }
      return { duplicate: false, partition_id: saved.id };
    } catch (error) {
      await this.marketDataRepository.markBackfillJob(job.id, "failed", { error: describeMarketDataError(error) });
      recordMarketDataUsage(state, { d1_rows: 2, worker_elapsed_ms: Date.now() - startedAt });
      await this.syncBackfillProgress(state, backfillId);
      this.record(state, "MARKET_DATA_ERROR", `${job.symbol} backfill deferred`, describeMarketDataError(error));
      await this.controlPlane.saveState(state);
      throw error;
    }
  }

  async ensureLiveCalendar(state, now) {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(now).filter((part) => part.type !== "literal");
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const date = `${values.year}-${values.month}-${values.day}`;
    const startDate = new Date(`${date}T00:00:00Z`); startDate.setUTCDate(startDate.getUTCDate() - 14);
    const endDate = new Date(`${date}T00:00:00Z`); endDate.setUTCDate(endDate.getUTCDate() + 45);
    return this.ensureMarketCalendar(state, startDate.toISOString().slice(0, 10), endDate.toISOString().slice(0, 10));
  }

  async pollLiveMarketData(state, now, calendar) {
    const startedAt = Date.now();
    const bounds = livePollBounds(now);
    const universe = await runtimeUniverseManifest(this.env);
    const bars = await this.gateways.marketData.recentMinuteBars(universe.symbols, bounds);
    const book = await this.marketDataRepository.loadLiveBook();
    const result = await applyLiveMinutePoll(book, bars, calendar.sessions, {
      feed: universe.feed, now, receivedAt: new Date().toISOString(), expectedSymbols: universe.symbols,
    });
    await this.marketDataRepository.saveLiveResult(result);
    recordMarketDataUsage(state, {
      alpaca_requests: bars.__alpaca_request_count ?? 1,
      d1_rows: result.source_revisions.length + result.events.length + 1,
      worker_elapsed_ms: Date.now() - startedAt,
    }, now);
    const previousStatus = state.marketData.live?.status;
    state.marketData.live = {
      ...state.marketData.live,
      status: result.health.status,
      last_poll_at: result.book.last_poll_at,
      last_event_at: result.events.at(-1)?.finalized_at ?? state.marketData.live?.last_event_at ?? null,
      healthy_symbols: result.health.healthy_symbols,
      symbol_count: result.health.symbol_count,
      coverage: result.health.coverage,
      revision_events: Number(state.marketData.live?.revision_events ?? 0)
        + result.events.filter((event) => event.retroactive).length,
      latest_event_count: result.events.length,
      latest_events: result.events.map((event) => ({ id: event.id, event_id: event.id,
        bucket_close: event.bucket_close, actionable: event.actionable, retroactive: event.retroactive,
        content_hash: event.content_hash })).slice(-80),
    };
    const latestClose = result.events.at(-1)?.bucket_close;
    const ingestionLag = latestClose ? Math.max(0, now.getTime() - new Date(latestClose).getTime()) : 0;
    recordHeartbeat(state, "market_data", { status: result.health.status === "healthy" ? "healthy" : "degraded",
      at: now, correlation_id: result.events.at(-1)?.id ?? null,
      detail: { healthy_symbols: result.health.healthy_symbols, symbol_count: result.health.symbol_count,
        coverage: result.health.coverage, ingestion_lag_ms: ingestionLag } });
    incrementOperationalMetric(state, "market_data", "ingestion_lag_ms", ingestionLag, now);
    incrementOperationalMetric(state, "market_data", "gap_symbols", Math.max(0, result.health.symbol_count - result.health.healthy_symbols), now);
    incrementOperationalMetric(state, "market_data", "bar_revisions", result.events.filter((event) => event.retroactive).length, now);
    if (previousStatus && previousStatus !== result.health.status) {
      this.record(state, result.health.status === "healthy" ? "MARKET_DATA" : "MARKET_DATA_ERROR",
        `Live IEX data ${result.health.status}`, `${result.health.healthy_symbols}/${result.health.symbol_count} symbols healthy`);
    }
    return result;
  }

  async reconcileLiveSession(state, now, calendar) {
    const startedAt = Date.now();
    const dateParts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(now).filter((part) => part.type !== "literal");
    const values = Object.fromEntries(dateParts.map((part) => [part.type, part.value]));
    const sessionDate = `${values.year}-${values.month}-${values.day}`;
    if (state.marketData.live?.last_reconciliation?.session_date === sessionDate) return { duplicate: true };
    const universe = await runtimeUniverseManifest(this.env);
    const response = await this.gateways.marketData.fiveMinuteBars(universe.symbols, {
      start: `${sessionDate}T00:00:00Z`, end: `${nextIsoDate(sessionDate)}T00:00:00Z`,
    });
    const session = calendar.sessions.filter((item) => item.date === sessionDate);
    const audits = Object.fromEntries(universe.symbols.map((symbol) => [symbol,
      auditFiveMinuteBars(symbol, response[symbol] ?? [], session, { start: sessionDate, end: sessionDate })]));
    const liveEvents = await this.marketDataRepository.liveEventsForSession(sessionDate, universe.feed);
    const reconciliation = await buildSessionReconciliation({ universe, calendar, sessionDate, audits, liveEvents });
    await this.marketDataRepository.saveSessionReconciliation(reconciliation);
    recordMarketDataUsage(state, {
      alpaca_requests: response.__alpaca_request_count ?? 1, d1_rows: 1, r2_writes: 1,
      worker_elapsed_ms: Date.now() - startedAt,
    }, now);
    state.marketData.live.last_reconciliation = {
      id: reconciliation.id, session_date: sessionDate, status: reconciliation.status,
      matched_bars: reconciliation.summary.matched, mismatched_bars: reconciliation.summary.mismatched,
      missing_live_bars: reconciliation.summary.missing_live, sha256: reconciliation.sha256,
    };
    this.record(state, reconciliation.status === "healthy" ? "MARKET_DATA" : "MARKET_DATA_ERROR",
      `IEX session reconciliation ${reconciliation.status}`,
      `${reconciliation.summary.matched} matched · ${reconciliation.summary.mismatched} mismatched · ${reconciliation.summary.missing_live} missing live`);
    return reconciliation;
  }

  async runMarketDataTick(state, scheduledAt) {
    if (marketDataMode(this.env) !== "shadow") return { skipped: true, reason: "market_data_off" };
    if (ensureOrchestrationState(state, orchestrationMode(this.env)).controls.ingestion_paused) {
      return { skipped: true, reason: "ingestion_paused", changed: false };
    }
    const now = new Date(scheduledAt);
    if (Number.isNaN(now.getTime())) throw new Error("Invalid market-data schedule timestamp");
    const bucket = now.toISOString().slice(0, 16);
    if (state.marketData.last_tick_bucket === bucket) return { duplicate: true, changed: false };
    const priorCalendarId = state.marketData.calendar?.id ?? null;
    const calendar = await this.ensureLiveCalendar(state, now);
    const action = marketScheduleAction(now, calendar.sessions);
    let result = { skipped: true, reason: "outside_session" };
    if (action === "poll") result = await this.pollLiveMarketData(state, now, calendar);
    else if (action === "reconcile") result = await this.reconcileLiveSession(state, now, calendar);
    const changed = action !== "idle" || priorCalendarId !== calendar.id;
    if (action !== "idle") state.marketData.last_tick_bucket = bucket;
    return { action, result, changed };
  }

  async persistArtifact(state, artifact, result) {
    const legacyId = `artifact-${artifact.job_id}-${artifact.strategy_id}`;
    let provenance = {};
    if (this.controlPlane.normalized) {
      const policy = artifact.policy ?? result.supervision?.policy;
      const policyHash = artifact.policy_hash ?? result.supervision?.policy_hash
        ?? result.holdout_decision?.policy_hash;
      const configuration = artifact.dataset?.schema_version === 2 ? EXECUTION_CONFIG_V2 : EXECUTION_CONFIG;
      const datasetHash = artifact.dataset_slice_hash ?? (artifact.phase === "holdout"
        ? artifact.dataset?.holdout_hash : artifact.dataset?.development_hash);
      provenance = await this.controlPlane.normalized.ensureArtifactProvenance({ workspaceId: SINGLETON_NAME,
        strategyId: artifact.strategy_id, dnaHash: artifact.dna_hash,
        datasetId: artifact.dataset?.id, datasetHash,
        datasetRangeStart: artifact.dataset_slice_start, datasetRangeEnd: artifact.dataset_slice_end,
        phase: artifact.phase,
        policyHash, policy, engine: artifact.engine,
        compiler: artifact.engine?.dsl_compiler ?? artifact.strategy_dna?.compiler ?? {},
        configHash: artifact.config_hash, config: configuration });
      provenance = { ...provenance, inputHash: artifact.input_hash,
        resultHash: artifact.service_result_hash, redactionClass: "private" };
    }
    const stored = await this.controlPlane.artifacts.putArtifact(legacyId, { ...artifact, result }, {
      phase: artifact.phase, strategy_id: artifact.strategy_id, dataset_id: artifact.dataset?.id,
    }, provenance);
    const artifactId = stored.mirror?.artifact_id ?? legacyId;
    state.backtestArtifacts ??= {};
    state.backtestArtifacts[artifactId] = { id: artifactId, phase: artifact.phase,
      strategy_id: artifact.strategy_id, dataset_id: artifact.dataset?.id,
      timeframe: artifact.dataset?.timeframe ?? artifact.dataset?.manifest?.timeframe ?? null,
      content_hash: stored.mirror?.content_hash ?? null, object_key: stored.mirror?.object_key ?? null,
      created_at: artifact.created_at, engine: artifact.engine, dataset: artifact.dataset };
    return artifactId;
  }

  async sealDataset(state, symbol, bars, options = {}) {
    const dataset = await makeDataset(symbol, bars, options);
    if (dataset.development.length < 300 || dataset.holdout.length < 100) throw new Error(`${symbol} has insufficient history for sealed backtesting`);
    state.datasets ??= {};
    if (!state.datasets[dataset.id]) {
      await this.controlPlane.artifacts.putDatasetSlice(dataset.id, "development", dataset.development, {
        symbol: dataset.symbol, timeframe: dataset.timeframe,
      });
      await this.controlPlane.artifacts.putDatasetSlice(dataset.id, "holdout", dataset.holdout, {
        symbol: dataset.symbol, timeframe: dataset.timeframe,
      });
      state.datasets[dataset.id] = { id: dataset.id, symbol: dataset.symbol, timeframe: dataset.timeframe, bar_count: dataset.bar_count, split_index: dataset.split_index, start: dataset.start, end: dataset.end, sha256: dataset.sha256 };
    }
    return state.datasets[dataset.id];
  }

  async sealMultiDataset(state, barsBySymbol, options = {}) {
    const available = Object.fromEntries(Object.entries(barsBySymbol ?? {})
      .filter(([, bars]) => Array.isArray(bars) && bars.length >= 400));
    const universe = await runtimeUniverseManifest(this.env);
    const calendar = state.marketData?.calendar ?? {};
    const dataset = await makeMultiSymbolDataset(available, {
      timeframe: "5Min",
      // Three regular-session years are roughly 59k five-minute bars per
      // symbol. Keep the complete immutable snapshot; do not silently turn it
      // into a recent-history sample before the 75/25 seal.
      max_bars: options.max_bars ?? 60_000,
      development_ratio: .75,
      metadata: {
        universe: { id: universe.id, sha256: universe.sha256 },
        calendar: { id: calendar.id ?? "nyse-regular-unversioned",
          sha256: calendar.sha256 ?? "0".repeat(64), revision: calendar.last_session ?? "unversioned" },
        feed: { name: String(this.env.ALPACA_DATA_FEED ?? "iex"), revision: "alpaca-adjusted-v1" },
        adjustment: "all", session: "regular", data_revision: "canonical-five-minute-v1",
      },
    });
    const shortHistory = dataset.manifest.symbols.filter((item) => {
      const span = new Date(item.end).getTime() - new Date(item.start).getTime();
      return !Number.isFinite(span) || span < 1090 * 24 * 60 * 60 * 1000;
    }).map((item) => item.symbol);
    if (shortHistory.length) throw new Error(`Plan 06 requires the sealed three-year snapshot; incomplete symbols: ${shortHistory.join(", ")}`);
    const insufficient = dataset.manifest.symbols.filter((item) => item.split_index < 300
      || item.bar_count - item.split_index < 100).map((item) => item.symbol);
    if (insufficient.length) throw new Error(`Insufficient sealed five-minute history: ${insufficient.join(", ")}`);
    state.datasets ??= {};
    if (!state.datasets[dataset.id]) {
      await this.controlPlane.artifacts.putDatasetSlice(dataset.id, "development", dataset.development, {
        schema_version: 2, timeframe: "5Min", symbols: dataset.manifest.symbols.length,
      });
      await this.controlPlane.artifacts.putDatasetSlice(dataset.id, "holdout", dataset.holdout, {
        schema_version: 2, timeframe: "5Min", symbols: dataset.manifest.symbols.length,
      });
      state.datasets[dataset.id] = {
        id: dataset.id, schema_version: 2, timeframe: "5Min", sha256: dataset.sha256,
        manifest: dataset.manifest, development_hash: dataset.development_hash,
        holdout_hash: dataset.holdout_hash, symbol_count: dataset.manifest.symbols.length,
        start: dataset.manifest.symbols.map((item) => item.start).filter(Boolean).sort().at(0) ?? null,
        end: dataset.manifest.symbols.map((item) => item.end).filter(Boolean).sort().at(-1) ?? null,
      };
    }
    return state.datasets[dataset.id];
  }

  async validateLegacyStrategies(state, fallbackBars = {}, fallbackDslBars = fallbackBars) {
    const candidates = state.strategies.filter((item) => item.state === "validation"
      && (item.engine_family ?? "legacy") === "legacy");
    for (const strategy of candidates) {
      let bars = (strategy.strategy_format === "dsl-v1" ? fallbackDslBars : fallbackBars)[strategy.asset] ?? [];
      if (strategy.dataset_id) {
        const [development, holdout] = await Promise.all([
          this.controlPlane.artifacts.getDatasetSlice(strategy.dataset_id, "development"),
          this.controlPlane.artifacts.getDatasetSlice(strategy.dataset_id, "holdout"),
        ]);
        const developmentBars = Array.isArray(development) ? development : development?.[strategy.asset];
        const holdoutBars = Array.isArray(holdout) ? holdout : holdout?.[strategy.asset];
        if (developmentBars?.length && holdoutBars?.length) bars = [...developmentBars, ...holdoutBars];
        else this.record(state, "BACKTEST_ERROR", `${strategy.name} validation deferred`, "sealed legacy comparison dataset is missing");
      }
      validateCandidatesWithBars(state, { [strategy.asset]: bars }, {
        family: "legacy", strategyIds: [strategy.id], advanceClock: false, silent: true,
      });
    }
    return candidates.length > 0;
  }

  async enqueueBacktestRun(state, phase, strategies, dataset) {
    if (!this.env.AXIOM_JOBS) throw new Error("AXIOM_JOBS binding is required for partitioned Backtrader runs");
    state.backtest_queue ??= { runs: {} };
    const planned = await planQueuedBacktest({ phase, dataset, strategies });
    const run = state.backtest_queue.runs[planned.run_id] ?? planned;
    state.backtest_queue.runs[run.run_id] ??= run;
    await this.controlPlane.saveState(state);
    const pending = run.shards.filter((shard) => !run.receipts?.[shard.shard_id]).map((shard) => ({
      kind: "backtest.run-shard.v1", workspace_id: SINGLETON_NAME, run_id: run.run_id, shard_id: shard.shard_id,
    }));
    if (pending.length) {
      await sendQueueMessages(this.env.AXIOM_JOBS, pending);
      recordHeartbeat(state, "queue", { status: "healthy", correlation_id: run.run_id,
        detail: { messages: pending.length, kind: "backtest" } });
      recordCostUsage(state, { queue_operations: pending.length });
    }
    else await this.env.AXIOM_JOBS.send({ kind: "backtest.finalize-run.v1", workspace_id: SINGLETON_NAME,
      run_id: run.run_id }, { contentType: "json" });
    return run;
  }

  async processQueuedBacktestShard(state, body) {
    const run = state.backtest_queue?.runs?.[String(body.run_id)];
    const shard = run?.shards?.find((item) => item.shard_id === String(body.shard_id));
    if (!run || !shard) throw new Error("Unknown queued Backtrader shard");
    if (run.status === "finalized") return { duplicate: true, finalized: true };
    if (!run.receipts?.[shard.shard_id]) {
      const dataset = state.datasets?.[run.dataset_id];
      const strategies = shard.strategy_ids.map((id) => state.strategies.find((item) => String(item.id) === id));
      if (!dataset || strategies.some((item) => !item)) throw new Error("Queued Backtrader shard inputs are unavailable");
      for (const frozen of run.strategies.filter((item) => shard.strategy_ids.includes(item.id))) {
        const strategy = strategies.find((item) => String(item.id) === frozen.id);
        if (String(strategy.dna_hash) !== frozen.dna_hash) throw new Error("Queued Backtrader strategy DNA changed");
      }
      const result = await this.invokeBacktrader(state, run.phase, strategies, dataset, {
        beforeDispatch: run.phase === "holdout" ? async (jobs) => {
          const wire = await Promise.all(jobs.map(async (job) => ({ job_id: job.job_id,
            payload_hash: await sha256(job.payload), strategy_ids: (job.payload?.strategies ?? []).map((item) => String(item.id)) })));
          for (const strategy of strategies) bindSealedHoldoutDispatch(state, { lineage_id: lineageIdentity(strategy),
            authorization_id: strategy.holdout_authorization?.authorization_id,
            jobs: wire.filter((job) => job.strategy_ids.includes(String(strategy.id))) });
          await this.controlPlane.saveState(state);
        } : null,
      });
      const contentHash = await sha256(result.response);
      const legacyId = `queued-backtest-${run.run_id}-${shard.shard_id}`;
      const stored = await this.controlPlane.artifacts.putArtifact(legacyId, result.response, {
        phase: run.phase, run_id: run.run_id, shard_id: shard.shard_id, dataset_id: run.dataset_id,
      });
      if (stored.mirror?.content_hash && stored.mirror.content_hash !== contentHash) throw new Error("Queued Backtrader artifact hash mismatch");
      recordQueuedBacktestReceipt(run, { run_id: run.run_id, shard_id: shard.shard_id,
        artifact_id: stored.mirror?.artifact_id ?? legacyId, content_hash: contentHash,
        job_id: result.job_id, result_hash: result.response.result_hash, config_hash: result.config_hash, dna: result.dna });
      run.status = Object.keys(run.receipts).length === run.shards.length ? "ready_to_finalize" : "running";
      await this.controlPlane.saveState(state);
    }
    if (Object.keys(run.receipts ?? {}).length === run.shards.length) {
      await this.env.AXIOM_JOBS.send({ kind: "backtest.finalize-run.v1", workspace_id: SINGLETON_NAME,
        run_id: run.run_id }, { contentType: "json" });
      run.finalize_queued = true;
      await this.controlPlane.saveState(state);
    }
    return { duplicate: Boolean(run.receipts?.[shard.shard_id]), status: run.status };
  }

  async finalizeQueuedBacktest(state, body) {
    const run = state.backtest_queue?.runs?.[String(body.run_id)];
    if (!run) throw new Error("Unknown queued Backtrader run");
    if (run.status === "finalized") return { duplicate: true, finalized: true };
    if (Object.keys(run.receipts ?? {}).length !== run.shards.length) {
      const error = new Error("Queued Backtrader run is incomplete"); error.status = 409; throw error;
    }
    const artifacts = {};
    for (const shard of run.shards) {
      const receipt = run.receipts[shard.shard_id];
      const response = await this.controlPlane.artifacts.getArtifact(receipt.artifact_id);
      if (!response || await sha256(response) !== receipt.content_hash) throw new Error("Queued Backtrader artifact content changed");
      artifacts[shard.shard_id] = response;
    }
    const combined = await combineQueuedBacktest(run, artifacts);
    combined.dataset = state.datasets?.[run.dataset_id];
    if (run.phase === "development") await this.reviewRemote(state, this.env, { dsl: {}, legacy: {} }, { queuedRun: { run, result: combined } });
    else await this.validateRemote(state, this.env, { advanceClock: false, silent: true, queuedRun: { run, result: combined } });
    run.status = "finalized"; run.finalized_at = new Date().toISOString();
    await this.controlPlane.saveState(state);
    return { finalized: true, run_id: run.run_id };
  }

  async invokeBacktrader(state, phase, strategies, dataset, options = {}) {
    let bars;
    if (dataset.storage_family === "partitioned-v1") {
      const loaded = await this.marketDataRepository.loadSealedDataset(dataset.partition_dataset_id ?? dataset.id, {
        symbols: strategyScopeSymbols(strategies),
        scope: phase === "holdout" ? "holdout_only" : "development_only",
        access: phase === "holdout" ? { purpose: "sealed_validation", actor: "system",
          strategyId: strategies.length === 1 ? strategies[0].id : null,
          decisionId: await sha256(strategies.map((item) => item.holdout_authorization?.authorization_id ?? item.id).sort()) } : null,
      });
      bars = loaded.bars_by_symbol;
      if (phase === "holdout") dataset.holdout_hash = loaded.dataset_hash;
      else dataset.development_hash = loaded.dataset_hash;
    } else {
      bars = await this.controlPlane.artifacts.getDatasetSlice(dataset.id, phase === "holdout" ? "holdout" : "development");
    }
    if (!(Array.isArray(bars) ? bars.length : Object.keys(bars ?? {}).length)) throw new Error(`Sealed ${phase} dataset is unavailable`);
    if (dataset.schema_version === 2) {
      const sealed = { ...dataset, [phase === "holdout" ? "holdout" : "development"]: bars };
      const shards = await buildBacktestPayloadShardsV2(phase, strategies, sealed);
      if (options.beforeDispatch) await options.beforeDispatch(shards.map((shard) => ({ job_id: shard.job_id, payload: shard.payload })));
      const responses = await Promise.all(shards.map(async (shard) => {
        const response = await this.gateways.research.run(shard.payload);
        const transport = response._transport_telemetry ?? {};
        recordCostUsage(state, { cloud_run_invocations: Number(transport.invocation_count ?? 1),
          cloud_run_vcpu_seconds: Number(transport.elapsed_ms ?? 0) / 1000,
          cloud_run_gib_seconds: Number(transport.elapsed_ms ?? 0) / 1000 * Number(transport.memory_gib ?? .5) });
        recordHeartbeat(state, "backtester", { status: "healthy", correlation_id: shard.job_id,
          detail: { phase, elapsed_ms: Number(transport.elapsed_ms ?? 0), engine: response.engine?.version ?? null } });
        incrementOperationalMetric(state, "backtester", "job_latency_ms", Number(transport.elapsed_ms ?? 0));
        incrementOperationalMetric(state, "backtester", "job_success", 1);
        if (response.job_id !== shard.job_id || response.phase !== phase) throw new Error("Backtest service provenance does not match the v2 request");
        if (response.schema_version !== "backtest-artifact-v2" || response.dataset?.sha256 !== shard.slice_hash
            || response.engine?.name !== "backtrader"
            || (response.engine?.configuration_hash ?? response.engine?.config_hash) !== shard.config_hash) {
          throw new Error("Backtest service returned an unexpected v2 dataset or execution configuration");
        }
        return { response, shard };
      }));
      return {
        response: {
          schema_version: "backtest-artifact-v2", job_id: await sha256(responses.map((item) => item.shard.job_id)), phase,
          engine: responses[0]?.response.engine, dataset: responses[0]?.response.dataset,
          input_hash: await sha256(responses.map((item) => item.response.input_hash)),
          result_hash: await sha256(responses.map((item) => item.response.result_hash)),
          results: responses.flatMap((item) => item.response.results ?? []),
          warnings: responses.flatMap((item) => item.response.warnings ?? []),
          shards: responses.map((item) => ({ index: item.shard.shard_index, job_id: item.shard.job_id,
            input_hash: item.response.input_hash, result_hash: item.response.result_hash })),
        },
        job_id: await sha256(responses.map((item) => item.shard.job_id)),
        config_hash: responses[0]?.shard.config_hash,
        dna: responses.flatMap((item) => item.shard.dna),
        dataset,
      };
    }
    const built = await buildBacktestPayload(phase, strategies, dataset, bars);
    const { payload, config_hash, dna, slice_hash: sliceHash } = built;
    if (options.beforeDispatch) await options.beforeDispatch([{ job_id: payload.job_id, payload }]);
    const job_id = payload.job_id;
    const response = await this.gateways.research.run(payload);
    const transport = response._transport_telemetry ?? {};
    recordCostUsage(state, { cloud_run_invocations: Number(transport.invocation_count ?? 1),
      cloud_run_vcpu_seconds: Number(transport.elapsed_ms ?? 0) / 1000,
      cloud_run_gib_seconds: Number(transport.elapsed_ms ?? 0) / 1000 * Number(transport.memory_gib ?? .5) });
    recordHeartbeat(state, "backtester", { status: "healthy", correlation_id: job_id,
      detail: { phase, elapsed_ms: Number(transport.elapsed_ms ?? 0), engine: response.engine?.version ?? null } });
    incrementOperationalMetric(state, "backtester", "job_latency_ms", Number(transport.elapsed_ms ?? 0));
    incrementOperationalMetric(state, "backtester", "job_success", 1);
    if (response.job_id !== job_id || response.phase !== phase) throw new Error("Backtest service provenance does not match the request");
    if (response.dataset?.sha256 !== sliceHash || response.engine?.name !== "backtrader"
      || response.engine?.config_hash !== config_hash) {
      throw new Error("Backtest service returned an unexpected dataset or execution configuration");
    }
    return { response, job_id, config_hash, dna, dataset };
  }

  authorizeResearchDispatch(state, strategies, phase) {
    const allowed = new Set(strategies.filter((strategy) => !strategy.trial_id).map((strategy) => strategy.id));
    const byCohort = new Map();
    for (const strategy of strategies.filter((item) => item.trial_id && item.cohort_id)) {
      const group = byCohort.get(strategy.cohort_id) ?? [];
      group.push(strategy);
      byCohort.set(strategy.cohort_id, group);
    }
    for (const [cohortId, cohortStrategies] of byCohort) {
      try {
        const dispatched = dispatchExpensiveFinalists(state, {
          cohort_id: cohortId,
          trial_ids: cohortStrategies.map((strategy) => strategy.trial_id),
          phase: phase === "holdout" ? "validation" : "development",
        });
        const trialIds = new Set(dispatched.map((trial) => trial.trial_id));
        cohortStrategies.filter((strategy) => trialIds.has(strategy.trial_id))
          .forEach((strategy) => allowed.add(strategy.id));
        cohortStrategies.filter((strategy) => !trialIds.has(strategy.trial_id)).forEach((strategy) => {
          this.record(state, "BACKTEST_ERROR", `${strategy.name} ${phase} deferred`, "Research dispatch quota or provenance record is unavailable");
        });
      } catch (error) {
        cohortStrategies.forEach((strategy) => this.record(state, "BACKTEST_ERROR", `${strategy.name} ${phase} deferred`,
          error instanceof Error ? error.message : String(error)));
      }
    }
    if (phase === "holdout") {
      for (const strategy of strategies.filter((item) => allowed.has(item.id))) {
        try {
          const dataset = state.datasets?.[strategy.dataset_id];
          if (!dataset) throw new Error("sealed dataset is missing");
          const lineage_id = lineageIdentity(strategy);
          const policy_hash = evaluationPolicyHash(strategy.supervision?.policy ?? createEvaluationPolicy());
          const job_id = holdoutAuthorizationJob({ lineage_id, dataset_id: dataset.id,
            dataset_hash: dataset.holdout_hash ?? dataset.sha256, dna_hash: strategy.dna_hash,
            configuration_hash: policy_hash });
          const { authorization, retry } = authorizeSealedHoldout(state, {
            lineage_id, job_id, dataset_id: dataset.id, dataset_hash: dataset.holdout_hash ?? dataset.sha256,
            dna_hash: strategy.dna_hash, configuration_hash: policy_hash,
          });
          strategy.holdout_authorization = { authorization_id: authorization.authorization_id, job_id,
            lineage_id, policy_hash, retry, authorized_at: authorization.authorized_at };
          recordSealedHoldoutServiceStatus(state, { lineage_id, authorization_id: authorization.authorization_id, status: "dispatched" });
        } catch (error) {
          allowed.delete(strategy.id);
          this.record(state, "BACKTEST_ERROR", `${strategy.name} holdout blocked`, error instanceof Error ? error.message : String(error));
        }
      }
    }
    return strategies.filter((strategy) => allowed.has(strategy.id));
  }

  async reviewRemote(state, env, barsByFormat, options = {}) {
    if (!options.queuedRun) reworkCandidates(state);
    const queuedIds = new Set(options.queuedRun?.run?.strategies?.map((item) => item.id) ?? []);
    const candidates = state.strategies.filter((item) => queuedIds.size ? queuedIds.has(String(item.id))
      : item.state === "generated" || (item.state === "rework" && item.rework?.source_stage === "data"));
    if (!candidates.length) {
      applyHoldoutCapacity(state);
      return this.record(state, "REVIEW", "No candidates waiting", "Generate a new cohort or reproduce a released strategy first.");
    }
    const byDataset = new Map();
    let multiDataset;
    for (const strategy of candidates) {
      try {
        const isDsl = strategy.strategy_format === "dsl-v1";
        const barsBySymbol = isDsl ? barsByFormat.dsl : barsByFormat.legacy;
        const dataset = isDsl
          ? (strategy.dataset_id ? state.datasets?.[strategy.dataset_id]
            : (multiDataset ??= await this.sealMultiDataset(state, barsBySymbol, { max_bars: 60_000 })))
          : await this.sealDataset(state, strategy.asset, barsBySymbol[strategy.asset] ?? [],
            { timeframe: "1Day", max_bars: 600 });
        if (!dataset) throw new Error("sealed strategy dataset is unavailable");
        strategy.dna_hash ??= await frozenDna(strategy);
        strategy.engine_family ??= "backtrader";
        strategy.dataset_id ??= dataset.id;
        if (strategy.dataset_id !== dataset.id) throw new Error("strategy dataset is immutable");
        const groupKey = `${isDsl ? "dsl-v2" : strategy.strategy_format ?? "legacy-archetype-v0"}:${dataset.id}`;
        const group = byDataset.get(groupKey) ?? { dataset, strategies: [] };
        group.strategies.push(strategy); byDataset.set(groupKey, group);
      } catch (error) {
        strategy.service_status = { phase: "development", status: "data_error", error: error.message, at: new Date().toISOString() };
        if (strategy.lifecycle?.operational?.state === "ready") transitionStrategyLifecycle(strategy, "data_blocked", {
          kind: "operational", trigger: "development_data", artifact_id: "artifact:data-unavailable",
          event_id: `data-error:${strategy.id}`, reason_code: "data_blocked", explanation: error.message });
        this.record(state, "BACKTEST_ERROR", `${strategy.name} data unavailable`, error.message);
      }
    }
    for (const { dataset, strategies } of byDataset.values()) {
      try {
        const authorized = options.queuedRun ? strategies : this.authorizeResearchDispatch(state, strategies, "development");
        if (!authorized.length) continue;
        const policyHash = evaluationPolicyHash(createEvaluationPolicy());
        const configurationHash = await sha256(EXECUTION_CONFIG_V2);
        for (const strategy of authorized) {
          ensureLifecycleForEvaluation(strategy, dataset, configurationHash, policyHash);
          if (strategy.lifecycle.quality.state === "screened") transitionStrategyLifecycle(strategy, "development", {
            trigger: "development_dispatch", artifact_id: `dataset:${dataset.id}`, event_id: `dispatch:${strategy.id}`,
            reason_code: "development_started", explanation: "Frozen DNA entered development evaluation." });
          if (["ready", "retry_wait", "service_unavailable", "data_blocked"].includes(strategy.lifecycle.operational.state)) {
            transitionStrategyLifecycle(strategy, "queued", { kind: "operational", trigger: "development_dispatch",
              artifact_id: `dataset:${dataset.id}`, event_id: `dispatch:${strategy.id}`, reason_code: "backtest_queued",
              explanation: "Development backtest queued." });
          }
          if (strategy.lifecycle.operational.state === "queued") transitionStrategyLifecycle(strategy, "running", {
            kind: "operational", trigger: "development_dispatch", artifact_id: `dataset:${dataset.id}`,
            event_id: `dispatch:${strategy.id}`, reason_code: "backtest_running", explanation: "Development backtest is running." });
        }
        if (!options.queuedRun && dataset.storage_family === "partitioned-v1" && dataset.schema_version === 2) {
          await this.enqueueBacktestRun(state, "development", authorized, dataset);
          continue;
        }
        const run = options.queuedRun?.result ?? await this.invokeBacktrader(state, "development", authorized, dataset);
        const candidateFoldScores = Object.fromEntries((run.response.results ?? []).map((candidate) => [
          String(candidate.strategy_id ?? candidate.id), (candidate.windows ?? [candidate]).map((window) => {
            const result = window.stress ?? window.ideal ?? window;
            return Number(result?.metrics?.bar_sharpe ?? result?.metrics?.sharpe ?? 0);
          }),
        ]));
        for (const strategy of authorized) {
          const strategyResult = run.response.results.find((item) => String(item.strategy_id ?? item.id) === strategy.id);
          if (strategyResult?.dna_hash !== strategy.dna_hash) throw new Error(`service returned mismatched DNA for ${strategy.id}`);
          if (strategy.strategy_format === "dsl-v1"
              && (strategyResult?.strategy_format !== "dsl-v1"
                || strategyResult?.compiler?.schema_sha256 !== strategy.strategy_dna.compiler.schema_sha256
                || strategyResult?.compiler?.semantic_sha256 !== strategy.strategy_dna.compiler.semantic_sha256)) {
            throw new Error(`service returned mismatched DSL compiler for ${strategy.id}`);
          }
          const windows = strategyResult?.windows ?? (strategyResult ? [strategyResult] : []);
          const results = windows.map((window) => window.stress ?? window.ideal ?? window);
          if (!results.length) throw new Error(`service returned no result for ${strategy.id}`);
          const metrics = aggregateMetrics(results);
          const policy = createEvaluationPolicy(); const policy_hash = evaluationPolicyHash(policy);
          const evidence = developmentPolicyEvidence(state, strategy, strategyResult, results, metrics, candidateFoldScores);
          const trial_registry = Number(state.research?.total_trials ?? 0);
          const supervision = superviseDevelopment({ evidence, trial_registry, policy });
          const replay = replaySupervisorDecision({ policy, policy_hash, artifacts: { evidence, trial_registry, status: supervision.status } });
          const supervisionArtifact = { policy, policy_hash, evidence, decision: supervision.decision, reasons: supervision.reasons,
            status: supervision.status, replay: { evidence_protocol_hash: evidence.protocol_hash,
              replay_hash: replay.replay_hash, decision: replay.supervision.decision } };
          const runShard = run.response.shards?.find((item) => item.strategy_ids?.includes(String(strategy.id)));
          const serviceDataset = runShard?.dataset ?? run.response.dataset;
          const sliceBounds = (serviceDataset?.symbols ?? []).flatMap((item) => [item.start, item.end]).filter(Boolean).sort();
          const artifactId = await this.persistArtifact(state, { job_id: runShard?.job_id ?? run.job_id, strategy_id: strategy.id, phase: "development", created_at: new Date().toISOString(), engine: runShard?.engine ?? run.response.engine ?? { name: "backtrader" }, dataset, dataset_slice_hash: serviceDataset?.sha256, dataset_slice_start: sliceBounds.at(0), dataset_slice_end: sliceBounds.at(-1), strategy_format: strategy.strategy_format, strategy_dna: strategy.strategy_dna ?? strategy.legacy_dna, dna_hash: strategy.dna_hash, config_hash: run.config_hash,
            input_hash: runShard?.input_hash ?? run.response.input_hash, service_result_hash: runShard?.result_hash ?? run.response.result_hash,
            warnings: runShard?.warnings ?? run.response.warnings ?? [] }, { strategy: strategyResult, metrics, supervision: supervisionArtifact });
          strategy.backtest_runs ??= {}; strategy.backtest_runs.development = { artifact_id: artifactId, dataset_id: dataset.id, dna_hash: strategy.dna_hash, config_hash: run.config_hash, engine: runShard?.engine ?? run.response.engine ?? { name: "backtrader" }, input_hash: runShard?.input_hash ?? run.response.input_hash,
            service_result_hash: runShard?.result_hash ?? run.response.result_hash, result_hash: await sha256({ results, metrics }),
            folds: windows.map((window, index) => ({ window_id: window.window_id ?? `fold-${index + 1}`,
              fold_manifest: window.fold_manifest ?? null, metrics: (window.stress ?? window.ideal ?? window).metrics ?? {} })),
            completed_at: new Date().toISOString() };
          strategy.metrics = metrics; strategy.backtests = (strategy.backtests ?? 0) + results.length;
          strategy.supervision = supervisionArtifact;
          strategy.backtest_runs.development.supervision = strategy.supervision;
          const [next, reason] = supervision.decision === "supervisor_approved" ? ["validation", "frozen development policy approved"]
            : supervision.decision === "development_reject" ? ["development_reject", `development policy rejected: ${supervision.reasons.join(", ")}`]
              : supervision.decision === "development_rework" ? ["rework", `development policy requires rework: ${supervision.reasons.join(", ")}`]
                : [strategy.state, `development service status: ${supervision.status}`];
          strategy.state = next;
          strategy.service_status = { phase: "development", status: supervision.status, at: new Date().toISOString() };
          if (strategy.lifecycle?.operational?.state === "running") transitionStrategyLifecycle(strategy, "ready", {
            kind: "operational", trigger: "development_result", artifact_id: artifactId,
            event_id: run.job_id, reason_code: "backtest_complete", explanation: "Development artifact verified and persisted." });
          if (strategy.lifecycle?.quality?.state === "development") {
            const lifecycleTarget = supervision.decision === "supervisor_approved" ? "supervisor_approved"
              : supervision.decision === "development_reject" ? "development_reject" : "superseded";
            transitionStrategyLifecycle(strategy, lifecycleTarget, { trigger: "supervisor_decision", artifact_id: artifactId,
              event_id: run.job_id, reason_code: supervision.decision,
              explanation: reason, correlation_id: `${strategy.id}:${policy_hash}:${artifactId}` });
          }
          if (next === "rework") strategy.rework = { ...(strategy.rework ?? {}), source_stage: "development", diagnosis: reason, attempt: strategy.rework?.attempt ?? 0, max_attempts: 3, history: strategy.rework?.history ?? [] };
          this.record(state, next === "validation" ? "SUPERVISOR_APPROVED" : next === "development_reject" ? "DEVELOPMENT_REJECT" : "DEVELOPMENT_REWORK", `${strategy.name} → ${next}`, reason);
        }
      } catch (error) {
        for (const strategy of strategies) {
          strategy.service_status = { phase: "development", status: "infrastructure_error", error: error.message, at: new Date().toISOString() };
          if (strategy.lifecycle?.operational?.state === "running") transitionStrategyLifecycle(strategy, "retry_wait", {
            kind: "operational", trigger: "development_error", artifact_id: `dataset:${dataset.id}`,
            event_id: `error:${strategy.id}`, reason_code: "service_unavailable", explanation: error.message });
          this.record(state, "BACKTEST_ERROR", `${strategy.name} review deferred`, error.message);
        }
      }
    }
    applyHoldoutCapacity(state);
    state.marketClock += 8;
  }

  async validateRemote(state, env, options = {}) {
    const queuedIds = new Set(options.queuedRun?.run?.strategies?.map((item) => item.id) ?? []);
    const candidates = state.strategies.filter((item) => (queuedIds.size ? queuedIds.has(String(item.id)) : item.state === "validation")
      && ((item.engine_family ?? "legacy") === "backtrader"
        || (options.includeShadow && item.backtest_runs?.shadow)));
    if (!candidates.length) {
      if (!options.silent) this.record(state, "VALIDATE", "No strategies awaiting validation", "Supervisor approval is required before holdout testing.");
      return;
    }
    const groups = new Map();
    for (const strategy of candidates) { const dataset = state.datasets?.[strategy.dataset_id]; if (!dataset) { this.record(state, "BACKTEST_ERROR", `${strategy.name} validation deferred`, "sealed dataset missing"); continue; } const groupKey = `${strategy.strategy_format ?? "legacy-archetype-v0"}:${dataset.id}`; const group = groups.get(groupKey) ?? { dataset, strategies: [] }; group.strategies.push(strategy); groups.set(groupKey, group); }
    for (const { dataset, strategies } of groups.values()) try {
      const authorized = options.queuedRun ? strategies : this.authorizeResearchDispatch(state, strategies, "holdout");
      if (!authorized.length) continue;
      for (const strategy of authorized) {
        if (["ready", "retry_wait", "service_unavailable", "data_blocked"].includes(strategy.lifecycle?.operational?.state)) {
          transitionStrategyLifecycle(strategy, "queued", { kind: "operational", trigger: "sealed_validation_dispatch",
            artifact_id: strategy.backtest_runs?.development?.artifact_id ?? `dataset:${dataset.id}`,
            event_id: `holdout:${strategy.id}`, reason_code: "holdout_queued", explanation: "Sealed validation queued." });
        }
        if (strategy.lifecycle?.operational?.state === "queued") transitionStrategyLifecycle(strategy, "running", {
          kind: "operational", trigger: "sealed_validation_dispatch", artifact_id: `dataset:${dataset.id}`,
          event_id: `holdout:${strategy.id}`, reason_code: "holdout_running", explanation: "Sealed validation is running." });
      }
      // First durable checkpoint: the lineage is burned before the sealed
      // slice is read. A process restart can only retry this reservation.
      await this.controlPlane.saveState(state);
      if (!options.queuedRun && dataset.storage_family === "partitioned-v1" && dataset.schema_version === 2) {
        await this.enqueueBacktestRun(state, "holdout", authorized, dataset);
        continue;
      }
      const run = options.queuedRun?.result ?? await this.invokeBacktrader(state, "holdout", authorized, dataset, {
        beforeDispatch: async (jobs) => {
          const wire = await Promise.all(jobs.map(async (job) => ({ job_id: job.job_id,
            payload_hash: await sha256(job.payload), strategy_ids: (job.payload?.strategies ?? []).map((item) => String(item.id)) })));
          for (const strategy of authorized) {
            const strategyJobs = wire.filter((job) => !job.strategy_ids.length || job.strategy_ids.includes(String(strategy.id)))
              .map(({ job_id, payload_hash }) => ({ job_id, payload_hash }));
            bindSealedHoldoutDispatch(state, { lineage_id: lineageIdentity(strategy),
              authorization_id: strategy.holdout_authorization?.authorization_id, jobs: strategyJobs });
          }
          // Second durable checkpoint: exact shard payloads are now frozen,
          // immediately before the first outbound service request.
          await this.controlPlane.saveState(state);
        },
      });
      for (const strategy of authorized) {
        const strategyResult = run.response.results.find((item) => String(item.strategy_id ?? item.id) === strategy.id);
        if (strategyResult?.dna_hash !== strategy.dna_hash) throw new Error(`service returned mismatched DNA for ${strategy.id}`);
        if (strategy.strategy_format === "dsl-v1"
            && (strategyResult?.strategy_format !== "dsl-v1"
              || strategyResult?.compiler?.schema_sha256 !== strategy.strategy_dna.compiler.schema_sha256
              || strategyResult?.compiler?.semantic_sha256 !== strategy.strategy_dna.compiler.semantic_sha256)) {
          throw new Error(`service returned mismatched DSL compiler for ${strategy.id}`);
        }
        const window = strategyResult?.windows?.[0] ?? strategyResult;
        const result = window?.stress ?? window?.ideal ?? window;
        if (!result) throw new Error(`service returned no result for ${strategy.id}`);
        const validation = normalizeMetrics(result);
        const policy = strategy.supervision?.policy ?? createEvaluationPolicy();
        const policy_hash = evaluationPolicyHash(policy);
        if (strategy.holdout_authorization?.policy_hash !== policy_hash) throw new Error(`sealed policy changed for ${strategy.id}`);
        const [outcome, reason, holdoutDecision] = sealedHoldoutOutcome(strategy, validation, policy);
        const runShard = run.response.shards?.find((item) => item.strategy_ids?.includes(String(strategy.id)));
        const serviceDataset = runShard?.dataset ?? run.response.dataset;
        const sliceBounds = (serviceDataset?.symbols ?? []).flatMap((item) => [item.start, item.end]).filter(Boolean).sort();
        const artifactId = await this.persistArtifact(state, { job_id: runShard?.job_id ?? run.job_id, strategy_id: strategy.id, phase: "holdout", created_at: new Date().toISOString(), engine: runShard?.engine ?? run.response.engine ?? { name: "backtrader" }, dataset, dataset_slice_hash: serviceDataset?.sha256, dataset_slice_start: sliceBounds.at(0), dataset_slice_end: sliceBounds.at(-1), strategy_format: strategy.strategy_format, strategy_dna: strategy.strategy_dna ?? strategy.legacy_dna, dna_hash: strategy.dna_hash, config_hash: run.config_hash, policy, policy_hash,
          input_hash: runShard?.input_hash ?? run.response.input_hash, service_result_hash: runShard?.result_hash ?? run.response.result_hash,
          warnings: runShard?.warnings ?? run.response.warnings ?? [] }, { strategy: strategyResult, metrics: validation,
          holdout_decision: { policy_hash, ...holdoutDecision } });
        const completedAt = new Date().toISOString();
        strategy.backtest_runs ??= {}; strategy.backtest_runs.holdout = { artifact_id: artifactId, dataset_id: dataset.id, dna_hash: strategy.dna_hash, config_hash: run.config_hash, engine: runShard?.engine ?? run.response.engine ?? { name: "backtrader" }, input_hash: runShard?.input_hash ?? run.response.input_hash,
          service_result_hash: runShard?.result_hash ?? run.response.result_hash, result_hash: await sha256({ result, validation, policy_hash, holdoutDecision }),
          policy_hash, decision: holdoutDecision, completed_at: completedAt };
        strategy.validation = validation; strategy.backtests = (strategy.backtests ?? 0) + 1;
        const authorization = strategy.holdout_authorization;
        recordSealedHoldoutOutcome(state, { lineage_id: lineageIdentity(strategy), authorization_id: authorization?.authorization_id,
          outcome, result_hash: strategy.backtest_runs.holdout.result_hash, artifact_id: artifactId });
        strategy.holdout_outcome = outcome;
        strategy.state = outcome;
        if (outcome === "incubation") {
          startIncubation(strategy, { policy: createIncubationPolicy(), startedAt: completedAt,
            feed: this.env.ALPACA_DATA_FEED ?? "iex" });
          if (this.incubationStore) await this.incubationStore.persistEvidence({
            workspaceId: SINGLETON_NAME, strategy,
          });
        }
        strategy.service_status = { phase: "holdout", status: "ok", at: new Date().toISOString() };
        if (strategy.lifecycle?.operational?.state === "running") transitionStrategyLifecycle(strategy, "ready", {
          kind: "operational", trigger: "holdout_result", artifact_id: artifactId, event_id: run.job_id,
          reason_code: "holdout_complete", explanation: "Sealed holdout artifact verified and persisted." });
        if (strategy.lifecycle?.quality?.state === "sealed_validation") transitionStrategyLifecycle(strategy, outcome, {
          trigger: "holdout_decision", artifact_id: artifactId, event_id: run.job_id,
          reason_code: outcome, explanation: reason, correlation_id: `${strategy.id}:${policy_hash}:${artifactId}` });
        this.record(state, outcome === "incubation" ? "INCUBATE" : outcome === "holdout_reject" ? "HOLDOUT_REJECT" : "INCONCLUSIVE", `${strategy.name} → ${outcome}`, reason);
      }
    } catch (error) {
      for (const strategy of strategies) {
        const ledgerRecord = state.research?.holdout_burn_ledger?.by_lineage?.[lineageIdentity(strategy)];
        if (ledgerRecord?.outcome) continue;
        if (strategy.holdout_authorization && !ledgerRecord?.outcome) recordSealedHoldoutServiceStatus(state, {
          lineage_id: lineageIdentity(strategy), authorization_id: strategy.holdout_authorization.authorization_id,
          status: "error", error: error.message,
        });
        // Preserve validation/capacity state: service trouble is not quality evidence.
        strategy.service_status = { phase: "holdout", status: "infrastructure_error", error: error.message, at: new Date().toISOString() };
        if (strategy.lifecycle?.operational?.state === "running") transitionStrategyLifecycle(strategy, "retry_wait", {
          kind: "operational", trigger: "holdout_error", artifact_id: `dataset:${dataset.id}`,
          event_id: `holdout-error:${strategy.id}`, reason_code: "service_unavailable", explanation: error.message });
        this.record(state, "BACKTEST_ERROR", `${strategy.name} validation deferred`, error.message);
      }
    }
    applyHoldoutCapacity(state);
    if (options.advanceClock !== false) state.marketClock += 5;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const state = await this.load();

    try {
      if (request.method === "GET" && url.pathname === "/api/v1/operations") {
        let architecture = {};
        try { architecture = await this.controlPlane.health(true); } catch (error) {
          architecture = { ready: false, error: error instanceof Error ? error.message : String(error) };
        }
        return json(buildOperationsReadModel(state, this.env, architecture));
      }
      if (request.method === "GET" && ["/api/v1/logs", "/api/v1/trials", "/api/v1/orders",
        "/api/v1/trades", "/api/v1/artifacts"].includes(url.pathname)) {
        const sources = { "/api/v1/logs": ["logs", operatorLogs], "/api/v1/trials": ["trials", operatorTrials],
          "/api/v1/orders": ["orders", operatorOrders], "/api/v1/trades": ["trades", operatorTrades],
          "/api/v1/artifacts": ["artifacts", operatorArtifacts] };
        const [kind, factory] = sources[url.pathname];
        let items = factory(state);
        const category = url.searchParams.get("category"), strategyId = url.searchParams.get("strategy_id");
        if (category) items = items.filter((item) => item.category === category || item.status === category || item.phase === category);
        if (strategyId) items = items.filter((item) => item.strategy_id === strategyId || item.strategy_ids?.includes(strategyId));
        try { return json(paginateOperatorItems(items, { kind, cursor: url.searchParams.get("cursor"),
          limit: url.searchParams.get("limit") })); } catch (error) { return json({ error: error.message, code: "invalid_request" }, 400); }
      }
      if (request.method === "GET" && url.pathname.startsWith("/api/v1/strategies/")
          && url.pathname.endsWith("/evidence")) {
        const id = decodeURIComponent(url.pathname.slice("/api/v1/strategies/".length, -"/evidence".length));
        const evidence = strategyEvidenceDto(state.strategies.find((item) => item.id === id));
        return evidence ? json(evidence) : json({ error: "Strategy not found", code: "artifact_not_found" }, 404);
      }
      if (request.method === "GET" && url.pathname.startsWith("/api/v1/commands/")) {
        const id = decodeURIComponent(url.pathname.slice("/api/v1/commands/".length));
        const result = state.orchestration?.command_results?.[id];
        return result ? json({ dto_version: ADMIN_COMMAND_DTO_VERSION, command_id: id,
          status: result.status, outcome: result, terminal: ["applied", "blocked", "failed"].includes(result.status) })
          : json({ dto_version: ADMIN_COMMAND_DTO_VERSION, command_id: id, status: "pending", terminal: false }, 202);
      }
      if (request.method === "GET" && url.pathname.startsWith("/api/v1/artifacts/")
          && url.pathname.endsWith("/download")) {
        const id = decodeURIComponent(url.pathname.slice("/api/v1/artifacts/".length, -"/download".length));
        const listed = operatorArtifacts(state).some((item) => item.id === id);
        if (!listed) return json({ error: "Safe artifact not found", code: "artifact_not_found" }, 404);
        const artifact = await this.controlPlane.artifacts.getArtifact(id);
        if (!artifact) return json({ error: "Safe artifact not found", code: "artifact_not_found" }, 404);
        this.record(state, "AUDIT", "Private operator artifact downloaded", `Authenticated read of ${id}`);
        await this.controlPlane.saveState(state);
        return new Response(JSON.stringify(artifact), { headers: { "content-type": "application/json",
          "content-disposition": `attachment; filename="${id.replace(/[^A-Za-z0-9._-]/g, "_")}.json"`,
          "cache-control": "no-store", "x-content-type-options": "nosniff" } });
      }
      if (request.method === "POST" && url.pathname === "/api/v1/admin/commands") {
        const body = await request.json().catch(() => ({}));
        const idempotencyKey = String(request.headers.get("idempotency-key") ?? body.idempotency_key ?? "");
        if (!/^[A-Za-z0-9._:-]{8,160}$/.test(idempotencyKey)) {
          return json({ error: "A valid 8-160 character idempotency key is required", code: "invalid_request" }, 400);
        }
        const command = createOrchestrationCommand({ kind: body.kind, strategy_id: body.strategy_id ?? null,
          actor: "operator:admin", timestamp: new Date().toISOString(), correlation_id: body.correlation_id ?? idempotencyKey,
          payload: body.payload ?? {} });
        try { claimOperatorIdempotency(state, idempotencyKey, command.command_id); }
        catch (error) { return json({ error: error.message, code: "idempotency_conflict" }, 409); }
        const result = await this.submitOrchestrationCommand(state, command, {
          forceDirect: ["prepare_workspace_reset", "execute_workspace_reset", "kill_switch", "flatten_all", "cancel_open_orders"].includes(body.kind),
        });
        this.record(state, "OPERATOR_COMMAND", `${body.kind} · ${result.queued ? "accepted" : result.status}`,
          `Command ${command.command_id} ${result.queued ? "queued for durable execution" : "reached a terminal outcome"}`,
          { correlation_id: command.correlation_id, command_id: command.command_id, strategy_id: body.strategy_id ?? null });
        await this.controlPlane.saveState(state);
        const resetManifest = body.kind === "prepare_workspace_reset" && state.orchestration?.pending_reset
          ? { manifest_hash: state.orchestration.pending_reset.manifest_hash,
            counts: state.orchestration.pending_reset.counts ?? null,
            prepared_at: state.orchestration.pending_reset.prepared_at }
          : null;
        return json({ dto_version: ADMIN_COMMAND_DTO_VERSION, command_id: command.command_id,
          correlation_id: command.correlation_id, idempotency_key: idempotencyKey,
          status: result.queued ? "accepted" : result.status, terminal: !result.queued,
          outcome: result.queued ? null : result, ...(resetManifest ? { reset_manifest: resetManifest } : {}) }, result.queued ? 202 : 200);
      }
      if (request.method === "GET" && url.pathname === "/api/state") {
        if (String(this.env.NORMALIZED_READ_ENABLED ?? "false").toLowerCase() === "true") {
          const cutover = this.controlPlane.normalized
            ? await this.controlPlane.normalized.checkCutoverHealth(SINGLETON_NAME, { requireMigrationComplete: true }) : null;
          if (!cutover?.ready) {
            return json({ error: "Normalized read model is not cutover-ready", reasons: cutover?.reasons ?? ["normalized_storage_disabled"] }, 503);
          }
          return json(cutover.readModel.response);
        }
        return json(snapshot(state));
      }
      if (request.method === "GET" && url.pathname === "/api/architecture") {
        return json(await this.controlPlane.health(true));
      }
      if (request.method === "GET" && url.pathname === "/api/market-data") {
        return json(publicMarketDataState(state));
      }

      if (request.method === "POST" && url.pathname === "/api/market-data/backfill/start") {
        const body = await request.json().catch(() => ({}));
        await this.startMarketBackfill(state, body);
        return this.save(state);
      }
      if (request.method === "POST" && url.pathname === "/api/market-data/poll") {
        const body = await request.json().catch(() => ({}));
        await this.runMarketDataTick(state, body.scheduled_at ?? new Date().toISOString());
        return this.save(state);
      }

      if (request.method === "POST" && url.pathname === "/api/generate") {
        return json({ error: "Generation requires a sealed development-only market dataset" }, 409);
      }
      if (request.method === "POST" && url.pathname === "/api/research/pause") {
        const body = await request.json().catch(() => ({}));
        pauseResearch(state, body.reason ?? "operator_paused");
        this.record(state, "RESEARCH", "Evolutionary research paused", state.research.pause_reason);
        return this.save(state);
      }
      if (request.method === "POST" && url.pathname === "/api/research/resume") {
        resumeResearch(state);
        this.record(state, "RESEARCH", "Evolutionary research resumed", "New cohorts may run within the daily budget.");
        return this.save(state);
      }
      if (request.method === "POST" && url.pathname === "/api/review") {
        reviewCandidates(state);
        return this.save(state);
      }
      if (request.method === "POST" && url.pathname === "/api/validate") {
        validateCandidates(state);
        return this.save(state);
      }
      if (request.method === "POST" && url.pathname === "/api/advance") {
        const body = await request.json();
        advanceMarket(state, Math.max(1, Math.min(Number(body.periods ?? 1), 4)));
        return this.save(state);
      }
      if (request.method === "POST" && url.pathname === "/api/reproduce") {
        const body = await request.json();
        reproduce(state, String(body.id));
        return this.save(state);
      }
      if (request.method === "POST" && url.pathname === "/api/reset") {
        return json({ error: "Use prepare_workspace_reset, then execute_workspace_reset with the returned manifest hash" }, 409);
      }
      if (request.method === "POST" && url.pathname === "/internal/market-data/backfill-partition") {
        const body = await request.json();
        const result = await this.processMarketBackfillPartition(state, body);
        await this.controlPlane.saveState(state);
        return json({ ok: true, ...result });
      }
      if (request.method === "POST" && url.pathname === "/internal/market-data/tick") {
        const body = await request.json();
        const result = await this.runMarketDataTick(state, body.scheduled_at);
        if (result.changed) await this.controlPlane.saveState(state);
        return json({ ok: true, ...result });
      }
      if (request.method === "POST" && url.pathname === "/internal/research/run") {
        const body = await request.json();
        let prepared;
        try {
          prepared = prepareEvolutionaryResearch(state, body);
          if (prepared.duplicate) return json(snapshot(state));
          const artifactIds = {};
          for (const artifact of prepared.trial_artifacts) {
            const artifactId = `${artifact.cohort_id}:${artifact.trial_id}`;
            await this.controlPlane.artifacts.putResearchTrial(artifact.cohort_id, artifact.trial_id, artifact, {
              dataset_id: artifact.dataset_id, contract_hash: artifact.contract_hash,
            });
            artifactIds[artifact.trial_id] = artifactId;
          }
          const committed = commitEvolutionaryResearch(state, prepared, { artifact_ids: artifactIds });
          this.record(state, "EVOLVE", `${committed.created.length} evolutionary finalists registered`,
            `${prepared.screen.summary.attempted} attempts · ${prepared.screen.summary.eligible} eligible · development data only`);
          return this.save(state);
        } catch (error) {
          if (prepared) failEvolutionaryResearch(state, prepared, error);
          this.record(state, "BACKTEST_ERROR", "Evolutionary cohort deferred",
            error instanceof Error ? error.message : String(error));
          await this.controlPlane.saveState(state);
          return json({ error: error instanceof Error ? error.message : "Evolutionary research failed" }, 503);
        }
      }
      if (request.method === "POST" && url.pathname === "/internal/review-live") {
        const body = await request.json();
        const legacyBars = body.legacy_bars ?? body.bars ?? {};
        const dslBars = body.dsl_bars ?? body.bars ?? {};
        const barsByFormat = { legacy: legacyBars, dsl: dslBars };
        if (!remoteEnabled(this.env)) {
          const deferred = state.strategies.filter((item) => ["generated", "rework"].includes(item.state)
            && item.engine_family === "backtrader").map((item) => [item, item.state]);
          deferred.forEach(([item]) => { item.state = "engine-deferred"; });
          state.strategies.filter((item) => ["generated", "rework"].includes(item.state)).forEach((item) => { item.engine_family ??= "legacy"; });
          reviewCandidatesWithBars(state, legacyBars, dslBars);
          deferred.forEach(([item, priorState]) => {
            item.state = priorState;
            this.record(state, "BACKTEST_ERROR", `${item.name} review deferred`, "Backtrader engine is unavailable; engine family was not changed");
          });
          state.strategies.filter((item) => item.metrics && !item.engine_family).forEach((item) => { item.engine_family = "legacy"; });
        }
        else if (engineMode(this.env) === "backtrader") await this.reviewRemote(state, this.env, barsByFormat);
        else {
          // Shadow runs write provenance only; lifecycle decisions remain legacy.
          const shadow = structuredClone(state);
          await this.reviewRemote(shadow, this.env, barsByFormat);
          state.datasets = shadow.datasets;
          state.backtestArtifacts = shadow.backtestArtifacts;
          state.research = shadow.research;
          const backtraderDeferred = state.strategies.filter((item) => ["generated", "rework"].includes(item.state)
            && item.engine_family === "backtrader").map((item) => [item, item.state]);
          backtraderDeferred.forEach(([item]) => { item.state = "engine-deferred"; });
          state.strategies.filter((item) => ["generated", "rework"].includes(item.state)).forEach((item) => { item.engine_family ??= "legacy"; });
          reviewCandidatesWithBars(state, legacyBars, dslBars);
          backtraderDeferred.forEach(([item, priorState]) => { item.state = priorState; });
          for (const remote of shadow.strategies) {
            if (remote.engine_family === "backtrader" && !state.strategies.some((item) => item.id === remote.id)) {
              state.strategies.unshift(remote);
            }
          }
          state.nextId = Math.max(state.nextId, shadow.nextId);
          state.strategies.filter((item) => item.metrics && !item.engine_family).forEach((item) => { item.engine_family = "legacy"; });
          for (const strategy of state.strategies) {
            const remote = shadow.strategies.find((item) => item.id === strategy.id);
            if (strategy.engine_family === "backtrader" && remote) {
              strategy.state = remote.state;
              strategy.rework = remote.rework;
            }
            if (!remote?.backtest_runs?.development) continue;
            strategy.dna_hash ??= remote.dna_hash; strategy.dataset_id ??= remote.dataset_id;
            if (strategy.engine_family === "backtrader") {
              strategy.metrics = remote.metrics;
              strategy.backtests = remote.backtests;
              strategy.backtest_runs = { ...(strategy.backtest_runs ?? {}), development: remote.backtest_runs.development };
              continue;
            }
            strategy.backtest_runs ??= {};
            strategy.backtest_runs.shadow = { ...remote.backtest_runs.development, phase: "development",
              remote_metrics: remote.metrics, comparison: comparison(strategy.metrics, remote.metrics) };
          }
          shadow.events.filter((item) => item.kind === "BACKTEST_ERROR").forEach((item) => {
            if (!state.events.some((event) => event.title === item.title && event.detail === item.detail)) {
              this.record(state, "BACKTEST_ERROR", item.title, item.detail);
            }
          });
        }
        return this.save(state);
      }
      if (request.method === "POST" && url.pathname === "/internal/validate-live") {
        const body = await request.json();
        const legacyBars = body.legacy_bars ?? body.bars ?? {};
        const dslBars = body.dsl_bars ?? body.bars ?? {};
        if (!remoteEnabled(this.env)) {
          const awaiting = state.strategies.filter((item) => item.state === "validation");
          const hasLegacy = await this.validateLegacyStrategies(state, legacyBars, dslBars);
          awaiting.filter((item) => item.engine_family === "backtrader").forEach((item) => {
            this.record(state, "BACKTEST_ERROR", `${item.name} validation deferred`, "Backtrader engine is unavailable; holdout was not run by another engine");
          });
          if (hasLegacy) state.marketClock += 5;
          if (!awaiting.length) this.record(state, "VALIDATE", "No strategies awaiting validation", "Supervisor approval is required before holdout testing.");
        }
        else if (engineMode(this.env) === "backtrader") {
          const awaiting = state.strategies.filter((item) => item.state === "validation");
          const hasLegacy = awaiting.some((item) => (item.engine_family ?? "legacy") === "legacy");
          const hasRemote = awaiting.some((item) => item.engine_family === "backtrader");
          if (!awaiting.length) this.record(state, "VALIDATE", "No strategies awaiting validation", "Supervisor approval is required before holdout testing.");
          if (hasLegacy) await this.validateLegacyStrategies(state, legacyBars, dslBars);
          if (hasRemote) await this.validateRemote(state, this.env, { advanceClock: false, silent: true });
          if (hasLegacy || hasRemote) state.marketClock += 5;
        }
        else {
          const shadow = structuredClone(state);
          const awaiting = state.strategies.some((item) => item.state === "validation");
          await this.validateRemote(shadow, this.env, { includeShadow: true, advanceClock: false });
          state.backtestArtifacts = shadow.backtestArtifacts;
          state.research = shadow.research;
          for (const strategy of state.strategies) {
            const remote = shadow.strategies.find((item) => item.id === strategy.id);
            if (!remote?.backtest_runs?.holdout) continue;
            if (strategy.engine_family === "backtrader") {
              strategy.validation = remote.validation;
              strategy.state = remote.state;
              strategy.backtests = remote.backtests;
              strategy.rework = remote.rework;
              strategy.backtest_runs = { ...(strategy.backtest_runs ?? {}), holdout: remote.backtest_runs.holdout };
              continue;
            }
            strategy.backtest_runs ??= {};
            strategy.backtest_runs.shadow_validation = { ...remote.backtest_runs.holdout, phase: "holdout", remote_metrics: remote.validation, comparison: comparison(strategy.validation, remote.validation) };
          }
          await this.validateLegacyStrategies(state, legacyBars, dslBars);
          if (awaiting) state.marketClock += 5;
          state.strategies.forEach((strategy) => {
            if (strategy.backtest_runs?.shadow_validation) strategy.backtest_runs.shadow_validation.comparison = comparison(strategy.validation, strategy.backtest_runs.shadow_validation.remote_metrics);
          });
          shadow.events.filter((item) => item.kind === "BACKTEST_ERROR").forEach((item) => {
            if (!state.events.some((event) => event.title === item.title && event.detail === item.detail)) {
              this.record(state, "BACKTEST_ERROR", item.title, item.detail);
            }
          });
        }
        return this.save(state);
      }
      if (request.method === "GET" && url.pathname.startsWith("/api/backtest-artifacts/")) {
        const id = decodeURIComponent(url.pathname.slice("/api/backtest-artifacts/".length));
        const artifact = await this.controlPlane.artifacts.getArtifact(id);
        if (artifact) {
          this.record(state, "AUDIT", "Private backtest artifact read", `Authenticated read of ${id}`);
          if (this.controlPlane.normalized) await this.controlPlane.normalized.recordAuditEvent({ workspaceId: SINGLETON_NAME,
            actor: "admin", action: "artifact.read", subjectKind: "backtest_artifact", subjectId: id,
            requestId: request.headers.get("cf-ray"), details: { route: "backtest-artifacts" } });
          await this.controlPlane.saveState(state);
        }
        return artifact ? json(artifact) : json({ error: "Artifact not found" }, 404);
      }
      if (request.method === "GET" && url.pathname.startsWith("/api/research-artifacts/")) {
        const parts = url.pathname.slice("/api/research-artifacts/".length).split("/").map(decodeURIComponent);
        if (parts.length !== 2 || !parts.every(Boolean)) return json({ error: "Cohort and trial IDs are required" }, 400);
        const artifact = await this.controlPlane.artifacts.getResearchTrial(parts[0], parts[1]);
        if (artifact) {
          const id = `${parts[0]}:${parts[1]}`;
          this.record(state, "AUDIT", "Private research artifact read", `Authenticated read of ${id}`);
          if (this.controlPlane.normalized) await this.controlPlane.normalized.recordAuditEvent({ workspaceId: SINGLETON_NAME,
            actor: "admin", action: "artifact.read", subjectKind: "research_artifact", subjectId: id,
            requestId: request.headers.get("cf-ray"), details: { route: "research-artifacts" } });
          await this.controlPlane.saveState(state);
        }
        return artifact ? json(artifact) : json({ error: "Research artifact not found" }, 404);
      }
      if (request.method === "POST" && url.pathname === "/internal/alpaca-cycle") {
        const cycle = await request.json();
        const changed = applyAlpacaCycle(state, cycle);
        return changed ? this.save(state) : json(snapshot(state));
      }
      if (request.method === "POST" && url.pathname === "/internal/alpaca-overview") {
        const overview = await request.json();
        applyAlpacaOverview(state, overview);
        return this.save(state);
      }
      if (request.method === "POST" && url.pathname === "/internal/research/screen-trial") {
        const result = await this.screenQueuedResearchTrial(state, await request.json());
        return json({ ok: true, result });
      }
      if (request.method === "POST" && url.pathname === "/internal/research/finalize-cohort") {
        try {
          const result = await this.finalizeQueuedResearchCohort(state, await request.json());
          return json({ ok: true, result });
        } catch (error) {
          if (error?.status === 409) return json({ error: error.message }, 409);
          throw error;
        }
      }
      if (request.method === "POST" && url.pathname === "/internal/backtest/run-shard") {
        const result = await this.processQueuedBacktestShard(state, await request.json());
        return json({ ok: true, result });
      }
      if (request.method === "POST" && url.pathname === "/internal/backtest/finalize-run") {
        try {
          const result = await this.finalizeQueuedBacktest(state, await request.json());
          return json({ ok: true, result });
        } catch (error) {
          if (error?.status === 409) return json({ error: error.message }, 409);
          throw error;
        }
      }
      if (request.method === "POST" && url.pathname === "/internal/orchestration/command") {
        const body = await request.json();
        const command = body.command;
        const result = await this.submitOrchestrationCommand(state, command, { forceDirect: true });
        await this.controlPlane.saveState(state);
        return json({ ok: true, result, orchestration: state.orchestration });
      }
      if (request.method === "POST" && url.pathname === "/internal/orchestration/tick") {
        const body = await request.json().catch(() => ({}));
        const timestamp = body.scheduled_at ?? new Date().toISOString();
        recordCostUsage(state, { worker_requests: 1, durable_object_requests: 1 }, timestamp);
        const costPolicy = evaluateCostPolicy(state, this.env, timestamp);
        recordHeartbeat(state, "scheduler", { status: "healthy", at: timestamp,
          correlation_id: `tick:${timestamp}`, detail: { mode: orchestrationMode(this.env) } });
        recordHeartbeat(state, "cost_telemetry", { status: ["telemetry_unavailable", "hard_stop"].includes(costPolicy.level) ? "blocked"
          : ["optional_paused", "constrained"].includes(costPolicy.level) ? "degraded" : "healthy", at: timestamp,
          correlation_id: `cost:${costPolicy.estimate.month}`, detail: { level: costPolicy.level,
            projected_ratio: costPolicy.projected_ratio } });
        const results = await this.planAndSubmitOrchestration(state, timestamp, body.events ?? state.marketData?.live?.latest_events ?? []);
        await this.controlPlane.saveState(state);
        return json({ ok: true, results });
      }
      if (request.method === "POST" && url.pathname === "/api/orchestration/command") {
        const body = await request.json();
        const command = createOrchestrationCommand({ kind: body.kind, intent_id: body.intent_id ?? null,
          strategy_id: body.strategy_id ?? null, actor: "operator:admin", timestamp: new Date().toISOString(),
          correlation_id: body.correlation_id ?? `operator:${body.kind}:${Date.now()}`, payload: body.payload ?? {} });
        const result = await this.submitOrchestrationCommand(state, command, {
          forceDirect: ["prepare_workspace_reset", "execute_workspace_reset"].includes(body.kind),
        });
        return this.save(state).then(async (response) => json({ ...(await response.json()), command_result: result }));
      }
      if (request.method === "POST" && url.pathname === "/internal/scheduled") {
        const scheduledBucket = request.headers.get("x-axiom-scheduled-bucket");
        if (!scheduledBucket) return json({ error: "Missing schedule bucket" }, 400);
        if (state.lastScheduledBucket === scheduledBucket) return json({ ok: true, duplicate: true });
        state.lastScheduledBucket = scheduledBucket;
        advanceMarket(state, 1);
        await this.controlPlane.saveState(state);
        return json({ ok: true, duplicate: false, bucket: scheduledBucket });
      }
      return json({ error: "Unknown endpoint" }, 404);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Invalid request" }, 400);
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      if (["/api/backtest-artifacts/", "/api/research-artifacts/", "/api/v1/artifacts/"].some((prefix) => url.pathname.startsWith(prefix))
          && !isStrictlyAuthorized(request, env)) {
        return json({ error: "Configured admin token required for private artifacts" }, 401);
      }
      if (!isAuthorized(request, env)) {
        return json({ error: "Admin token required" }, 401);
      }
      const stub = labStub(env);
      try {
        if (request.method === "POST" && url.pathname === "/api/alpaca/sync") {
          const hour = new Date().toISOString().slice(0, 13);
          return await synchronizeAlpaca(env, stub, `manual-${Date.now()}`, hour);
        }
        if (request.method === "POST" && url.pathname === "/api/alpaca/portfolio") {
          return await refreshAlpacaPortfolio(env, stub);
        }
        if (request.method === "POST" && url.pathname === "/api/generate") {
          const body = await request.json().catch(() => ({}));
          return orchestrationMode(env) === "legacy"
            ? await runEvolutionWithAlpaca(env, stub, { finalists: body.count })
            : await submitOperatorPipelineCommand(stub, "run_daily_cohort", {
              finalists: boundedInt(body.count, 6, 1, 12), session_date: newYorkClock().date });
        }
        if (request.method === "POST" && url.pathname === "/api/review") {
          return orchestrationMode(env) === "legacy" ? await reviewWithAlpaca(env, stub)
            : await submitOperatorPipelineCommand(stub, "pipeline_review");
        }
        if (request.method === "POST" && url.pathname === "/api/validate") {
          return orchestrationMode(env) === "legacy" ? await validateWithAlpaca(env, stub)
            : await submitOperatorPipelineCommand(stub, "pipeline_validate");
        }
        return stub.fetch(request);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "Alpaca request failed" }, 502);
      }
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(controller, env, ctx) {
    const stub = labStub(env);
    const work = [];
    const hasBrokerCredentials = Boolean(env.ALPACA_API_KEY && env.ALPACA_API_SECRET);
    // The old hourly path is opt-in only. Observe mode must never mutate the
    // broker, research registry, or lifecycle merely because credentials exist.
    if (controller.cron === "0 * * * *" && orchestrationMode(env) === "legacy" && hasBrokerCredentials) {
      const bucket = new Date(controller.scheduledTime).toISOString().slice(0, 13);
      work.push((async () => {
        await synchronizeAlpaca(env, stub, bucket);
        const sessionDate = newYorkClock(controller.scheduledTime).date;
        const calendar = await createRuntimeGateways(env).marketData.calendar(sessionDate, sessionDate);
        if (String(env.RESEARCH_AUTORUN_ENABLED ?? "true").toLowerCase() === "true"
            && shouldRunPostCloseResearch(controller.scheduledTime, calendar)) {
          const current = await stateFrom(stub);
          if (!current.research?.paused && current.research?.last_completed_session !== sessionDate) {
            const generated = await runEvolutionWithAlpaca(env, stub, {
              scheduled_at: controller.scheduledTime,
              finalists: 12,
              sampled_genomes: env.RESEARCH_AUTORUN_SAMPLED_GENOMES ?? 32,
              challengers: env.RESEARCH_AUTORUN_CHALLENGERS ?? 8,
            });
            if (!generated.ok) throw new Error(`Scheduled research failed: ${generated.status}`);
            const reviewed = await reviewWithAlpaca(env, stub);
            if (!reviewed.ok) throw new Error(`Scheduled finalist review failed: ${reviewed.status}`);
          }
        }
      })());
    }
    if (controller.cron === "* * * * *") {
      work.push((async () => {
        if (marketDataMode(env) === "shadow") await tickMarketData(env, stub, controller.scheduledTime);
        await tickOrchestration(stub, controller.scheduledTime);
        // Autonomous target computation is owned by queued orchestration
        // actions. Only the explicit legacy mode retains this direct sync.
        if (!hasBrokerCredentials || orchestrationMode(env) !== "legacy") return;
        const current = await stateFrom(stub);
        const latest = [...(current.market_data?.live?.latest_events ?? [])]
          .filter((event) => event.actionable && !event.retroactive)
          .sort((left, right) => String(left.bucket_close).localeCompare(String(right.bucket_close))).at(-1);
        if (latest) await synchronizeAlpaca(env, stub, `event:${latest.event_id ?? latest.id}`, latest.bucket_close);
      })());
    }
    if (work.length) ctx.waitUntil(Promise.all(work));
  },

  async queue(batch, env) {
    await consumeArchitectureQueue(batch, env);
  },
};
