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
import { isAuthorized } from "./auth.js";
import {
  aggregateMetrics, buildBacktestPayload, buildBacktestPayloadShardsV2, comparison, engineMode, EXECUTION_CONFIG_V2, frozenDna,
  makeDataset, makeMultiSymbolDataset, normalizeMetrics, remoteEnabled, sha256,
} from "./backtest.js";
import { CONTROL_PLANE_WORKSPACE, createControlPlaneRuntime } from "./control-plane.js";
import { createRuntimeGateways } from "./gateways.js";
import { consumeArchitectureQueue } from "./jobs.js";
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
import { initialUniverseManifest } from "./universe.js";
import {
  commitEvolutionaryResearch,
  developmentOnlyDataset,
  failEvolutionaryResearch,
  prepareEvolutionaryResearch,
} from "./research.js";
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
import { applyOrchestrationCommand, createOrchestrationCommand, ensureOrchestrationState, executionAllowed, orchestrationMode } from "./orchestration.js";
import { OrchestrationStore } from "./orchestration-store.js";
import { planMarketEvent, planOrchestrationTick } from "./orchestration-schedule.js";
import { applyLifecycleCommand, bindLifecycleProvenance, initialLifecycle, transitionId } from "./lifecycle.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const SINGLETON_NAME = CONTROL_PLANE_WORKSPACE;

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: JSON_HEADERS });
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
  const cycle = await createRuntimeGateways(env).broker.buildCycle(appState, bucket, orderBucket);
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

export function shouldRunPostCloseResearch(value = Date.now()) {
  const clock = newYorkClock(value);
  return !["Sat", "Sun"].includes(clock.weekday) && clock.hour === 17;
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

export class AxiomLab extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.controlPlane = createControlPlaneRuntime(ctx.storage, env, SINGLETON_NAME);
    this.gateways = createRuntimeGateways(env);
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

  record(state, type, title, detail) {
    const now = new Date();
    state.events.unshift({ id: `BT-${now.getTime()}-${Math.random().toString(36).slice(2, 7)}`,
      kind: type, type, title, detail, time: now.toISOString().slice(11, 16), at: now.toISOString() });
    state.events = state.events.slice(0, 28);
  }

  async executeOrchestrationActions(state, command, result) {
    const orchestration = ensureOrchestrationState(state, orchestrationMode(this.env));
    orchestration.executed_command_ids ??= [];
    if (orchestration.executed_command_ids.includes(command.command_id)) return { duplicate: true };
    for (const action of result.actions ?? []) {
      if (action.kind === "watchdog.repair" && this.orchestrationStore) {
        await this.orchestrationStore.repairExpiredLeases();
        await this.orchestrationStore.dispatchOutbox();
      } else if (action.kind === "broker.cancel_unsafe_orders") {
        if (!this.env.ALPACA_API_KEY || !this.env.ALPACA_API_SECRET) {
          orchestration.incidents.push({ kind: "broker_blocked", action: action.kind, command_id: command.command_id,
            reason: "alpaca_credentials_missing", opened_at: command.timestamp });
        } else {
          const cancellation = await this.gateways.broker.cancelManagedOpenOrders();
          this.record(state, "BROKER_SAFETY", "Managed open orders cancelled",
            `${cancellation.cancelled.length} framework orders cancelled; ${cancellation.skipped_manual_orders} manual orders untouched`);
        }
      } else if (action.kind === "broker.verify_flat") {
        if (!this.env.ALPACA_API_KEY || !this.env.ALPACA_API_SECRET) {
          orchestration.incidents.push({ kind: "broker_blocked", action: action.kind, command_id: command.command_id,
            reason: "alpaca_credentials_missing", opened_at: command.timestamp });
        } else {
          const overview = await this.gateways.broker.accountOverview();
          const managed = new Set(state.alpaca?.managed_symbols ?? []);
          const remaining = overview.positions.filter((position) => managed.has(position.symbol));
          if (remaining.length) orchestration.incidents.push({ kind: "broker_not_flat", action: action.kind,
            command_id: command.command_id, symbols: remaining.map((position) => position.symbol), opened_at: command.timestamp });
          else orchestration.controls.flatten_requested = false;
        }
      } else if (action.kind === "broker.flatten_all") {
        this.record(state, "BROKER_SAFETY", "Managed flatten requested", "The next reconciliation cycle targets every framework-managed position to zero.");
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
        const lifecycleTarget = action.kind === "strategy.pause" ? "operator_paused"
          : action.kind === "strategy.resume" ? strategy.lifecycle?.paused_from
            : action.kind === "strategy.quarantine" ? "quarantined" : "retired";
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
        } else if (action.kind === "strategy.resume") {
          strategy.state = strategy.operator_pause?.previous_state ?? "generated";
          strategy.operator_pause = null;
        } else strategy.state = action.kind === "strategy.quarantine" ? "watch" : "dropped";
        strategy.operator_action = { kind: action.kind, command_id: command.command_id, at: command.timestamp };
      } else if (action.kind === "approval.persist" && this.orchestrationStore) {
        const approval = action.approval;
        await this.orchestrationStore.recordConfigApproval({ approvalId: command.command_id,
          workspaceId: SINGLETON_NAME, configKey: approval.kind, configHash: approval.subject_hash,
          approvedBy: approval.actor });
      } else if (action.kind === "workspace.reset_nonproduction") {
        if (String(this.env.ENVIRONMENT ?? "development").toLowerCase() === "production") {
          throw new Error("Workspace reset is disabled in production");
        }
        await this.clearWorkspaceStorage();
        const fresh = createDemoState();
        ensureOrchestrationState(fresh, orchestrationMode(this.env));
        for (const key of Object.keys(state)) delete state[key];
        Object.assign(state, fresh);
        return { duplicate: false, reset: true };
      } else if (action.kind === "pipeline.validate") {
        await this.validateRemote(state, this.env, { advanceClock: false, silent: true });
      } else if (action.kind === "market.reconcile_session" && state.marketData?.calendar?.id) {
        const calendar = await this.marketDataRepository.loadCalendar(state.marketData.calendar.id);
        if (calendar) await this.reconcileLiveSession(state, new Date(command.timestamp), calendar);
      } else if (["pipeline.review", "research.run_cohort", "research.schedule"].includes(action.kind)) {
        // Plan 08 supplies the partition-streaming executor. Until then this is
        // an operational data block, never a strategy-quality outcome.
        orchestration.incidents.push({ kind: "data_blocked", action: action.kind, command_id: command.command_id,
          reason: "sealed_partition_executor_pending", opened_at: command.timestamp });
      }
    }
    orchestration.executed_command_ids.push(command.command_id);
    orchestration.executed_command_ids = orchestration.executed_command_ids.slice(-2048);
    return { duplicate: false };
  }

  async submitOrchestrationCommand(state, command, { forceDirect = false } = {}) {
    const current = ensureOrchestrationState(state, orchestrationMode(this.env));
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
    await this.executeOrchestrationActions(state, command, applied.result);
    return { ...applied.result, queued: false, idempotent: applied.idempotent };
  }

  async planAndSubmitOrchestration(state, timestamp, events = []) {
    const orchestration = ensureOrchestrationState(state, orchestrationMode(this.env));
    if (orchestration.controls.ingestion_paused) return [];
    const intents = [];
    for (const event of events) intents.push(...planMarketEvent(event, { completed_intent_ids: orchestration.completed_intent_ids }));
    const calendar = state.marketData?.calendar?.id
      ? await this.marketDataRepository.loadCalendar(state.marketData.calendar.id) : null;
    if (calendar) intents.push(...planOrchestrationTick({ calendar, now: timestamp,
      completed_intent_ids: orchestration.completed_intent_ids }).intents);
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
    const universe = await initialUniverseManifest();
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
        const universe = await initialUniverseManifest();
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
      const universe = await initialUniverseManifest();
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
    const universe = await initialUniverseManifest();
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
    const universe = await initialUniverseManifest();
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
    const artifactId = `artifact-${artifact.job_id}-${artifact.strategy_id}`;
    await this.controlPlane.artifacts.putArtifact(artifactId, { ...artifact, result }, {
      phase: artifact.phase, strategy_id: artifact.strategy_id, dataset_id: artifact.dataset?.id,
    });
    state.backtestArtifacts ??= {};
    state.backtestArtifacts[artifactId] = { id: artifactId, phase: artifact.phase, strategy_id: artifact.strategy_id, created_at: artifact.created_at, engine: artifact.engine, dataset: artifact.dataset };
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
    const universe = await initialUniverseManifest();
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

  async invokeBacktrader(state, phase, strategies, dataset, options = {}) {
    const bars = await this.controlPlane.artifacts.getDatasetSlice(dataset.id, phase === "holdout" ? "holdout" : "development");
    if (!(Array.isArray(bars) ? bars.length : Object.keys(bars ?? {}).length)) throw new Error(`Sealed ${phase} dataset is unavailable`);
    if (dataset.schema_version === 2) {
      const sealed = { ...dataset, [phase === "holdout" ? "holdout" : "development"]: bars };
      const shards = await buildBacktestPayloadShardsV2(phase, strategies, sealed);
      if (options.beforeDispatch) await options.beforeDispatch(shards.map((shard) => ({ job_id: shard.job_id, payload: shard.payload })));
      const responses = [];
      for (const shard of shards) {
        const response = await this.gateways.research.run(shard.payload);
        if (response.job_id !== shard.job_id || response.phase !== phase) throw new Error("Backtest service provenance does not match the v2 request");
        if (response.schema_version !== "backtest-artifact-v2" || response.dataset?.sha256 !== shard.slice_hash
            || response.engine?.name !== "backtrader"
            || (response.engine?.configuration_hash ?? response.engine?.config_hash) !== shard.config_hash) {
          throw new Error("Backtest service returned an unexpected v2 dataset or execution configuration");
        }
        responses.push({ response, shard });
      }
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

  async reviewRemote(state, env, barsByFormat) {
    reworkCandidates(state);
    const candidates = state.strategies.filter((item) => item.state === "generated" || (item.state === "rework" && item.rework?.source_stage === "data"));
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
        const authorized = this.authorizeResearchDispatch(state, strategies, "development");
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
        const run = await this.invokeBacktrader(state, "development", authorized, dataset);
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
          const artifactId = await this.persistArtifact(state, { job_id: run.job_id, strategy_id: strategy.id, phase: "development", created_at: new Date().toISOString(), engine: run.response.engine ?? { name: "backtrader" }, dataset, strategy_format: strategy.strategy_format, strategy_dna: strategy.strategy_dna ?? strategy.legacy_dna, dna_hash: strategy.dna_hash, config_hash: run.config_hash,
            input_hash: run.response.input_hash, service_result_hash: run.response.result_hash,
            warnings: run.response.warnings ?? [] }, { strategy: strategyResult, metrics, supervision: supervisionArtifact });
          strategy.backtest_runs ??= {}; strategy.backtest_runs.development = { artifact_id: artifactId, dataset_id: dataset.id, dna_hash: strategy.dna_hash, config_hash: run.config_hash, engine: run.response.engine ?? { name: "backtrader" }, input_hash: run.response.input_hash,
            service_result_hash: run.response.result_hash, result_hash: await sha256({ results, metrics }),
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
    const candidates = state.strategies.filter((item) => item.state === "validation"
      && ((item.engine_family ?? "legacy") === "backtrader"
        || (options.includeShadow && item.backtest_runs?.shadow)));
    if (!candidates.length) {
      if (!options.silent) this.record(state, "VALIDATE", "No strategies awaiting validation", "Supervisor approval is required before holdout testing.");
      return;
    }
    const groups = new Map();
    for (const strategy of candidates) { const dataset = state.datasets?.[strategy.dataset_id]; if (!dataset) { this.record(state, "BACKTEST_ERROR", `${strategy.name} validation deferred`, "sealed dataset missing"); continue; } const groupKey = `${strategy.strategy_format ?? "legacy-archetype-v0"}:${dataset.id}`; const group = groups.get(groupKey) ?? { dataset, strategies: [] }; group.strategies.push(strategy); groups.set(groupKey, group); }
    for (const { dataset, strategies } of groups.values()) try {
      const authorized = this.authorizeResearchDispatch(state, strategies, "holdout");
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
      const run = await this.invokeBacktrader(state, "holdout", authorized, dataset, {
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
        const artifactId = await this.persistArtifact(state, { job_id: run.job_id, strategy_id: strategy.id, phase: "holdout", created_at: new Date().toISOString(), engine: run.response.engine ?? { name: "backtrader" }, dataset, strategy_format: strategy.strategy_format, strategy_dna: strategy.strategy_dna ?? strategy.legacy_dna, dna_hash: strategy.dna_hash, config_hash: run.config_hash,
          input_hash: run.response.input_hash, service_result_hash: run.response.result_hash,
          warnings: run.response.warnings ?? [] }, { strategy: strategyResult, metrics: validation,
          holdout_decision: { policy_hash, ...holdoutDecision } });
        strategy.backtest_runs ??= {}; strategy.backtest_runs.holdout = { artifact_id: artifactId, dataset_id: dataset.id, dna_hash: strategy.dna_hash, config_hash: run.config_hash, engine: run.response.engine ?? { name: "backtrader" }, input_hash: run.response.input_hash,
          service_result_hash: run.response.result_hash, result_hash: await sha256({ result, validation, policy_hash, holdoutDecision }),
          policy_hash, decision: holdoutDecision, completed_at: new Date().toISOString() };
        strategy.validation = validation; strategy.backtests = (strategy.backtests ?? 0) + 1;
        const authorization = strategy.holdout_authorization;
        recordSealedHoldoutOutcome(state, { lineage_id: lineageIdentity(strategy), authorization_id: authorization?.authorization_id,
          outcome, result_hash: strategy.backtest_runs.holdout.result_hash, artifact_id: artifactId });
        strategy.holdout_outcome = outcome;
        strategy.state = outcome;
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
      if (request.method === "GET" && url.pathname === "/api/state") return json(snapshot(state));
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
        await this.clearWorkspaceStorage();
        return this.save(createDemoState());
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
        return artifact ? json(artifact) : json({ error: "Artifact not found" }, 404);
      }
      if (request.method === "GET" && url.pathname.startsWith("/api/research-artifacts/")) {
        const parts = url.pathname.slice("/api/research-artifacts/".length).split("/").map(decodeURIComponent);
        if (parts.length !== 2 || !parts.every(Boolean)) return json({ error: "Cohort and trial IDs are required" }, 400);
        const artifact = await this.controlPlane.artifacts.getResearchTrial(parts[0], parts[1]);
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
        const results = await this.planAndSubmitOrchestration(state, timestamp, body.events ?? state.marketData?.live?.latest_events ?? []);
        await this.controlPlane.saveState(state);
        return json({ ok: true, results });
      }
      if (request.method === "POST" && url.pathname === "/api/orchestration/command") {
        const body = await request.json();
        const command = createOrchestrationCommand({ kind: body.kind, intent_id: body.intent_id ?? null,
          strategy_id: body.strategy_id ?? null, actor: "operator:admin", timestamp: new Date().toISOString(),
          correlation_id: body.correlation_id ?? `operator:${body.kind}:${Date.now()}`, payload: body.payload ?? {} });
        const result = await this.submitOrchestrationCommand(state, command);
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
          return await runEvolutionWithAlpaca(env, stub, { finalists: body.count });
        }
        if (request.method === "POST" && url.pathname === "/api/review") {
          return await reviewWithAlpaca(env, stub);
        }
        if (request.method === "POST" && url.pathname === "/api/validate") {
          return await validateWithAlpaca(env, stub);
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
    if (controller.cron === "0 * * * *" && orchestrationMode(env) !== "autonomous" && hasBrokerCredentials) {
      const bucket = new Date(controller.scheduledTime).toISOString().slice(0, 13);
      work.push((async () => {
        await synchronizeAlpaca(env, stub, bucket);
        if (String(env.RESEARCH_AUTORUN_ENABLED ?? "true").toLowerCase() === "true"
            && shouldRunPostCloseResearch(controller.scheduledTime)) {
          const current = await stateFrom(stub);
          const sessionDate = newYorkClock(controller.scheduledTime).date;
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
        if (!hasBrokerCredentials) return;
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
