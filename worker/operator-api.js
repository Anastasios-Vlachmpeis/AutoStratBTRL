import { hashCanonical } from "./dsl.js";
import { costPublicSummary } from "./cost-controller.js";
import { operationalHealth } from "./observability.js";
import { publicRolloutState } from "./rollout.js";
import { publicFutureBoundary } from "./future-gates.js";

export const OPERATOR_READ_DTO_VERSION = "axiom.operator-read.v1";
export const OPERATOR_PAGE_DTO_VERSION = "axiom.operator-page.v1";
export const ADMIN_COMMAND_DTO_VERSION = "axiom.admin-command.v1";

export const OPERATOR_ERROR_VOCABULARY = Object.freeze({
  authentication_required: "An administrator token is required.",
  invalid_request: "The request does not match the versioned operator contract.",
  stale_evidence: "Evidence is stale; new risk remains blocked.",
  operational_blocked: "Infrastructure evidence is incomplete; quality is unchanged.",
  risk_blocked: "A safety control currently prevents new risk.",
  artifact_not_found: "The requested safe artifact is unavailable.",
  command_pending: "The command was accepted and awaits durable execution.",
});

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
const bool = (value) => String(value ?? "false").toLowerCase() === "true";
const sortedUnique = (values) => [...new Set(values.filter(Boolean).map(String))].sort();
const iso = (value) => {
  const date = new Date(value ?? 0);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

function globalMode(state, env) {
  const controls = state.orchestration?.controls ?? {};
  if (controls.kill_switch || controls.flatten_requested) return "kill_flatten";
  if (controls.global_paused || controls.execution_paused || controls.autonomy_paused) return "paused";
  const broker = String(env.ALPACA_BROKER_MODE ?? "shadow").toLowerCase();
  if (broker === "canary" && bool(env.ALPACA_CANARY_TRADING_ENABLED)) return "paper_canary";
  if (state.orchestration?.mode === "autonomous" && bool(env.ALPACA_TRADING_ENABLED)) return "autonomous_paper";
  if (broker === "shadow" || String(env.BACKTEST_ENGINE ?? "shadow") === "shadow") return "shadow";
  return "observation";
}

function riskReasons(state, env) {
  const reasons = [], controls = state.orchestration?.controls ?? {}, live = state.marketData?.live ?? {};
  if (controls.kill_switch) reasons.push("kill_switch");
  if (controls.flatten_requested) reasons.push("flatten_in_progress");
  if (controls.global_paused) reasons.push("global_pause");
  if (controls.execution_paused) reasons.push("execution_pause");
  if (controls.autonomy_paused) reasons.push("autonomy_pause");
  if (controls.entries_paused) reasons.push("entry_cutoff");
  if (state.alpaca?.risk_session?.halted) reasons.push("daily_loss_halt");
  if (!state.alpaca?.connected) reasons.push("alpaca_disconnected");
  if (live.status !== "healthy" || finite(live.coverage) < .9) reasons.push("market_data_unhealthy");
  if (!bool(env.ALPACA_TRADING_ENABLED)) reasons.push("paper_trading_disabled");
  if (!bool(env.ALPACA_LONG_TRADING_ENABLED) && !bool(env.ALPACA_SHORT_TRADING_ENABLED)) reasons.push("direction_switches_disabled");
  if (String(env.ORCHESTRATION_MODE ?? "observe") !== "autonomous") reasons.push("orchestration_not_autonomous");
  return sortedUnique(reasons);
}

function positionSummary(state) {
  const positions = state.alpaca?.positions ?? [];
  let gross = 0, net = 0, managedGross = 0;
  const managed = new Set(state.alpaca?.managed_symbols ?? []);
  for (const position of positions) {
    const signed = finite(position.market_value) * (String(position.side).toLowerCase() === "short" ? -1 : 1);
    gross += Math.abs(signed); net += signed;
    if (managed.has(position.symbol)) managedGross += Math.abs(signed);
  }
  return { position_count: positions.length, gross_exposure_usd: gross, net_exposure_usd: net,
    managed_gross_exposure_usd: managedGross };
}

function nextAction(state) {
  const clock = state.alpaca?.clock ?? {};
  if (clock.is_open) return { code: "canonical_five_minute_event", label: "Next finalized 5-minute bar" };
  if (clock.next_open) return { code: "market_open", label: "Next regular US market open", at: iso(clock.next_open) };
  return { code: "calendar_sync", label: "Awaiting authoritative NYSE calendar" };
}

function serviceSummary(state, env, architecture = {}) {
  const trials = Object.values(state.research?.trials ?? {});
  const activeBacktests = (state.strategies ?? []).filter((item) => ["generated", "rework", "validation"].includes(item.state)
    && ["queued", "running", "retry_wait"].includes(item.lifecycle?.operational?.state)).length;
  return {
    queue: { configured: Boolean(env.AXIOM_JOBS), status: architecture.bindings?.queue ? "configured" : "unavailable",
      research_pending: trials.filter((item) => ["queued", "running"].includes(item.status)).length },
    backtester: { mode: String(env.BACKTEST_ENGINE ?? "shadow"), configured: Boolean(env.BACKTEST_SERVICE_URL),
      active_runs: activeBacktests },
    broker: { mode: String(env.ALPACA_BROKER_MODE ?? "shadow"), connected: Boolean(state.alpaca?.connected),
      last_cycle_at: state.alpaca?.fetched_at ?? state.alpaca?.updated_at ?? null },
    storage: { mode: architecture.mode ?? String(env.CONTROL_PLANE_MODE ?? "legacy"),
      ready: Boolean(architecture.ready), normalized_cutover_available: Boolean(architecture.normalized_cutover_available) },
  };
}

function incidentRows(state) {
  const orchestration = (state.orchestration?.incidents ?? []).filter((item) => !item.resolved_at)
    .map((item, index) => ({ id: item.incident_id ?? item.command_id ?? `orchestration-${index}`,
      severity: item.severity ?? "critical", kind: item.kind ?? "orchestration", strategy_id: item.strategy_id ?? null,
      opened_at: item.opened_at ?? null, summary: item.reason ?? item.message ?? item.kind ?? "Operational incident" }));
  const strategies = (state.strategies ?? []).filter((item) => item.operational_status === "operational_blocked")
    .map((item) => ({ id: `strategy:${item.id}`, severity: "critical", kind: "strategy_operational_block",
      strategy_id: item.id, opened_at: item.health?.decision?.at ?? null,
      summary: item.health?.decision?.findings?.join(", ") ?? "Monitoring evidence is operationally blocked" }));
  return [...orchestration, ...strategies].slice(0, 100);
}

export function buildOperationsReadModel(state, env = {}, architecture = {}, now = new Date().toISOString()) {
  const reasons = riskReasons(state, env), mode = globalMode(state, env), positions = positionSummary(state);
  const account = state.alpaca?.account ?? {}, equity = finite(account.equity, 100_000);
  const allocationGross = finite(state.alpaca?.allocation?.gross_before_netting);
  const live = state.marketData?.live ?? {}, universe = state.marketData?.universe ?? {};
  const lossFraction = finite(state.alpaca?.risk_session?.loss_fraction);
  const incidents = incidentRows(state);
  const usage = state.marketData?.usage ?? {};
  const budgetSummary = costPublicSummary(state, env, now);
  const health = operationalHealth(state, now);
  const rollout = publicRolloutState(state);
  const futureBoundary = publicFutureBoundary(env);
  const attention = [...incidents.map((item) => ({ code: item.kind, severity: item.severity,
    strategy_id: item.strategy_id, summary: item.summary }))];
  if (String(universe.feed ?? env.ALPACA_DATA_FEED ?? "iex").toLowerCase() === "iex") attention.push({
    code: "iex_not_consolidated", severity: "info", summary: "IEX is not the consolidated SIP market feed." });
  for (const reason of reasons) attention.push({ code: reason, severity: reason.includes("disabled") ? "info" : "warning",
    summary: reason.replaceAll("_", " ") });
  for (const alert of health.alerts) attention.push({ code: alert.code, severity: alert.severity,
    summary: alert.summary, subsystem: alert.subsystem });
  return Object.freeze({ dto_version: OPERATOR_READ_DTO_VERSION, generated_at: iso(now), timezone: "America/New_York",
    mode: { code: mode, label: mode.replaceAll("_", " "), new_risk_possible: reasons.length === 0, blocked_reasons: reasons,
      orchestration: state.orchestration?.mode ?? String(env.ORCHESTRATION_MODE ?? "observe"),
      broker: String(env.ALPACA_BROKER_MODE ?? "shadow") },
    market: { session_status: state.alpaca?.clock?.is_open ? "open" : "closed",
      clock_at: iso(state.alpaca?.clock?.timestamp), next_action: nextAction(state),
      feed: String(universe.feed ?? env.ALPACA_DATA_FEED ?? "iex").toUpperCase(), consolidated_sip: false },
    account: { account_type: "alpaca_paper", connected: Boolean(state.alpaca?.connected),
      equity: finite(account.equity, 100_000), cash: finite(account.cash), buying_power: finite(account.buying_power), ...positions },
    risk: { daily_loss_fraction: lossFraction, daily_loss_limit: finite(env.ALPACA_DAILY_LOSS_HALT_PCT, .005),
      daily_loss_halted: Boolean(state.alpaca?.risk_session?.halted), portfolio_gross_usd: allocationGross,
      portfolio_gross_fraction: equity > 0 ? allocationGross / equity : 0,
      portfolio_gross_limit: finite(env.ALPACA_MAX_PORTFOLIO_PCT, .10), entries_paused: Boolean(state.orchestration?.controls?.entries_paused) },
    data: { status: live.status ?? "off", expected_symbols: finite(universe.symbol_count, 40),
      healthy_symbols: finite(live.healthy_symbols), coverage: finite(live.coverage),
      last_poll_at: iso(live.last_poll_at), last_event_at: iso(live.last_event_at),
      revision_events: finite(live.revision_events), source: "Alpaca IEX 5-minute regular-session bars" },
    services: serviceSummary(state, env, architecture),
    budget: { monthly_limit_usd: budgetSummary.monthly_limit_usd,
      estimated_monthly_usd: budgetSummary.projected_monthly_usd,
      month_to_date_usd: budgetSummary.month_to_date_usd, projected_ratio: budgetSummary.projected_ratio,
      level: budgetSummary.level, telemetry_status: budgetSummary.telemetry_status,
      estimate_status: budgetSummary.telemetry_status === "disabled" ? "disabled" : budgetSummary.observed_days ? "measured_projection" : "telemetry_unavailable",
      optional_research_allowed: budgetSummary.optional_research_allowed,
      usage: { alpaca_requests: finite(usage.alpaca_requests), queue_messages: finite(usage.queue_messages),
        d1_rows: finite(usage.d1_rows), r2_writes: finite(usage.r2_writes), worker_elapsed_ms: finite(usage.worker_elapsed_ms) } },
    research: { paused: Boolean(state.research?.paused), pause_reason: state.research?.pause_reason ?? null,
      population: state.research?.population?.length ?? 0, trials: Object.keys(state.research?.trials ?? {}).length,
      cohorts: state.research?.cohorts?.length ?? 0, novelty_archive: state.research?.novelty_archive?.dna_hashes?.length ?? 0 },
    incidents, attention: attention.slice(0, 100), observability: health, rollout, future_boundary: futureBoundary,
    controls: { ...clone(state.orchestration?.controls ?? {}), release_paused: Boolean(state.orchestration?.controls?.release_paused) } });
}

function encodeCursor(offset, fingerprint) {
  return btoa(JSON.stringify({ offset, fingerprint: fingerprint.slice(0, 16) }));
}

function decodeCursor(cursor, fingerprint) {
  if (!cursor) return 0;
  try {
    const value = JSON.parse(atob(cursor));
    if (!Number.isInteger(value.offset) || value.offset < 0 || value.fingerprint !== fingerprint.slice(0, 16)) throw new Error();
    return value.offset;
  } catch { throw new TypeError("Invalid or stale pagination cursor"); }
}

export function paginateOperatorItems(items, { cursor = null, limit = 50, kind = "items" } = {}) {
  const bounded = Math.max(1, Math.min(100, Math.trunc(Number(limit) || 50)));
  const fingerprint = hashCanonical({ kind, identities: items.map((item) => item.id) });
  const offset = decodeCursor(cursor, fingerprint), page = items.slice(offset, offset + bounded);
  return Object.freeze({ dto_version: OPERATOR_PAGE_DTO_VERSION, kind, items: clone(page), count: page.length,
    total: items.length, next_cursor: offset + page.length < items.length ? encodeCursor(offset + page.length, fingerprint) : null });
}

export function operatorLogs(state) {
  const structured = (state.observability?.events ?? []).map((item) => ({ id: item.event_id,
    at: iso(item.at), category: item.subsystem, severity: item.severity, title: item.code,
    detail: item.message, correlation_id: item.correlation_id ?? item.job_id ?? null,
    strategy_id: item.strategy_id ?? null }));
  const events = (state.events ?? []).map((item, index) => ({ id: item.id ?? `event:${index}:${item.kind}`,
    at: iso(item.at), category: String(item.kind ?? item.type ?? "system").toLowerCase(), severity: item.kind?.includes("ERROR") ? "critical" : "info",
    title: item.title ?? item.kind ?? "System event", detail: item.detail ?? "", correlation_id: item.correlation_id ?? null,
    strategy_id: item.strategy_id ?? null }));
  const lifecycle = (state.strategies ?? []).flatMap((strategy) => (strategy.lifecycle?.history ?? []).map((item) => ({
    id: item.transition_id, at: iso(item.timestamp), category: "lifecycle", severity: "info",
    title: `${strategy.name ?? strategy.id}: ${item.from} → ${item.target}`, detail: item.explanation,
    correlation_id: item.correlation_id, strategy_id: strategy.id })));
  const incidents = (state.orchestration?.incidents ?? []).map((item, index) => ({ id: item.incident_id ?? `incident:${index}`,
    at: iso(item.opened_at), category: "incident", severity: item.severity ?? "critical", title: item.kind ?? "Incident",
    detail: item.reason ?? item.message ?? "Operator attention required", correlation_id: item.command_id ?? null,
    strategy_id: item.strategy_id ?? null }));
  const unique = new Map();
  for (const item of [...structured, ...events, ...lifecycle, ...incidents]) if (!unique.has(item.id)) unique.set(item.id, item);
  return [...unique.values()].sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? "")) || a.id.localeCompare(b.id));
}

export function operatorTrials(state) {
  return Object.entries(state.research?.trials ?? {}).map(([id, item]) => ({ id: String(item.trial_id ?? id),
    cohort_id: item.cohort_id ?? null, status: item.status ?? "unknown", ordinal: item.ordinal ?? null,
    duplicate: Boolean(item.duplicate_of), rejection_codes: clone(item.constraint_failures ?? []),
    selected_for_expensive: Boolean(item.selected_for_expensive), selection_rank: item.selection_rank ?? null,
    pareto_rank: item.pareto_rank ?? null, created_at: iso(item.created_at), completed_at: iso(item.completed_at) }))
    .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")) || a.id.localeCompare(b.id));
}

export function operatorOrders(state) {
  const values = [...(state.alpaca?.open_orders ?? []), ...(state.alpaca?.submitted_orders ?? [])];
  const known = state.alpaca?.known_orders ?? {};
  const seen = new Set();
  return values.filter((item) => { const id = String(item.id ?? item.order_id ?? item.client_order_id); if (seen.has(id)) return false; seen.add(id); return true; })
    .map((item) => { const source = known[item.id] ?? known[item.order_id] ?? known[item.client_order_id] ?? item;
      return { id: String(item.id ?? item.order_id ?? item.client_order_id), symbol: item.symbol, side: item.side,
        type: item.type ?? item.order_type ?? "market", status: item.status, quantity: finite(item.qty ?? item.quantity),
        filled_quantity: finite(item.filled_qty), submitted_at: iso(item.submitted_at),
        strategy_ids: sortedUnique((source.allocations ?? []).map((allocation) => allocation.strategy_id)), source: source.allocations ? "axiom" : "unmanaged" }; })
    .sort((a, b) => String(b.submitted_at ?? "").localeCompare(String(a.submitted_at ?? "")) || a.id.localeCompare(b.id));
}

export function operatorTrades(state) {
  const rows = [];
  for (const strategy of state.strategies ?? []) {
    for (const [source, trades] of [["incubation_shadow", strategy.incubation?.closed_trades], ["alpaca_paper", strategy.health?.closed_trades]]) {
      for (const item of trades ?? []) rows.push({ id: String(item.trade_id), strategy_id: strategy.id, source,
        symbol: item.symbol, direction: item.direction, entry_at: iso(item.entry_at), exit_at: iso(item.exit_at),
        pnl: finite(item.pnl), net_return: finite(item.net_return), cost: finite(item.cost), holding_bars: finite(item.holding_bars) });
    }
  }
  return rows.sort((a, b) => String(b.exit_at ?? "").localeCompare(String(a.exit_at ?? "")) || a.id.localeCompare(b.id));
}

export function operatorArtifacts(state) {
  const values = new Map();
  const add = (id, value = {}) => { if (!id || String(value.kind ?? value.phase).includes("holdout.raw")) return;
    values.set(String(id), { id: String(id), kind: value.kind ?? "backtest.result", phase: value.phase ?? null,
      strategy_id: value.strategy_id ?? null, dataset_id: value.dataset_id ?? null,
      content_hash: value.content_hash ?? value.result_hash ?? null, created_at: iso(value.created_at),
      download_path: `/api/v1/artifacts/${encodeURIComponent(String(id))}/download` }); };
  Object.entries(state.backtestArtifacts ?? {}).forEach(([id, item]) => add(id, item));
  Object.entries(state.healthArtifacts ?? {}).forEach(([id, item]) => add(id, { ...item, kind: "release.health-decision" }));
  for (const strategy of state.strategies ?? []) for (const run of Object.values(strategy.backtest_runs ?? {})) add(run?.artifact_id, {
    ...run, strategy_id: strategy.id });
  return [...values.values()].sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")) || a.id.localeCompare(b.id));
}

export function strategyEvidenceDto(strategy) {
  if (!strategy) return null;
  const development = strategy.backtest_runs?.development ?? null, holdout = strategy.backtest_runs?.holdout ?? null;
  const context = strategy.state === "generated" ? "hypothetical_vector_screen"
    : ["validation", "capacity_wait"].includes(strategy.state) ? "sealed_validation_pending"
      : strategy.incubation ? "live_shadow" : strategy.health ? "alpaca_paper_monitoring" : "exact_historical_backtest";
  return Object.freeze({ dto_version: OPERATOR_READ_DTO_VERSION, strategy_id: strategy.id, state: strategy.state,
    language: strategy.strategy_format === "dsl-v1" ? "typed_strategy_dsl" : "legacy_adapter",
    evidence_context: context, release_label: ["released", "healthy", "watch", "quarantined"].includes(strategy.state) ? "released_paper" : null,
    provenance: { dna_hash: strategy.dna_hash ?? null, engine_family: strategy.engine_family ?? null,
      development: development ? { engine_version: development.engine_version ?? null, config_hash: development.config_hash ?? null,
        result_hash: development.result_hash ?? null, artifact_id: development.artifact_id ?? null, folds: development.folds?.length ?? 3,
        execution: "next_bar_open" } : null,
      validation: holdout ? { sealed: true, raw_bars_exposed: false, engine_version: holdout.engine_version ?? null,
        config_hash: holdout.config_hash ?? null, result_hash: holdout.result_hash ?? null, artifact_id: holdout.artifact_id ?? null,
        access_status: strategy.holdout_authorization?.status ?? "consumed" } : { sealed: true, raw_bars_exposed: false, access_status: "not_consumed" } },
    decisions: { supervisor: strategy.supervision ? { outcome: strategy.supervision.decision ?? strategy.state,
      policy_hash: strategy.supervision.policy_hash ?? null, artifact_id: development?.artifact_id ?? null,
      reasons: clone(strategy.supervision.reasons ?? []) } : null,
      validation: strategy.validation ? { outcome: strategy.validation.decision ?? strategy.state,
        artifact_id: holdout?.artifact_id ?? null, reasons: clone(strategy.validation.reasons ?? []) } : null,
      incubation: strategy.incubation?.decision ? { outcome: strategy.incubation.decision.outcome,
        artifact_id: strategy.incubation.decision_artifact_id ?? null, findings: clone(strategy.incubation.decision.findings ?? []) } : null,
      health: strategy.health?.decision ? { outcome: strategy.health.decision.outcome,
        policy_hash: strategy.health.policy_hash ?? null, artifact_id: strategy.health.decision_artifact_id ?? null,
        findings: clone(strategy.health.decision.findings ?? []) } : null },
    incubation: strategy.incubation ? { valid_days: finite(strategy.incubation.valid_trading_days), required_days: 10,
      eligible_trades: finite(strategy.incubation.eligible_trades), required_trades: 67,
      exclusions: clone(strategy.incubation.exclusions ?? []), blocked_reason: strategy.release_blocked_reason ?? null } : null,
    market: strategy.health ? { quality: strategy.health.status, operational: strategy.operational_status ?? "ready",
      risk_overlay: clone(strategy.risk_overlay ?? null), summary: clone(strategy.health.summary ?? {}) } : null });
}

/** Largest-triangle-three-buckets display sampling. Stored evidence is untouched. */
export function deterministicDownsample(values, threshold = 240) {
  const points = values.map((value, index) => typeof value === "object" ? { ...value, x: finite(value.x, index), y: finite(value.y ?? value.value) }
    : { x: index, y: finite(value) });
  if (threshold >= points.length || threshold < 3) return clone(points);
  const sampled = [points[0]], every = (points.length - 2) / (threshold - 2); let anchor = 0;
  for (let bucket = 0; bucket < threshold - 2; bucket += 1) {
    const avgStart = Math.floor((bucket + 1) * every) + 1;
    const avgEnd = Math.min(Math.floor((bucket + 2) * every) + 1, points.length);
    const average = points.slice(avgStart, avgEnd);
    const avgX = average.length ? average.reduce((sum, item) => sum + item.x, 0) / average.length : points.at(-1).x;
    const avgY = average.length ? average.reduce((sum, item) => sum + item.y, 0) / average.length : points.at(-1).y;
    const rangeStart = Math.floor(bucket * every) + 1;
    const rangeEnd = Math.min(Math.floor((bucket + 1) * every) + 1, points.length - 1);
    const a = points[anchor]; let best = points[rangeStart], bestArea = -1, bestIndex = rangeStart;
    for (let index = rangeStart; index < rangeEnd; index += 1) {
      const candidate = points[index];
      const area = Math.abs((a.x - avgX) * (candidate.y - a.y) - (a.x - candidate.x) * (avgY - a.y));
      if (area > bestArea) { bestArea = area; best = candidate; bestIndex = index; }
    }
    sampled.push(best); anchor = bestIndex;
  }
  sampled.push(points.at(-1)); return sampled;
}
