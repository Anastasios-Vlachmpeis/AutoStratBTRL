import { hashCanonical } from "./dsl.js";
import { deterministicDownsample, operatorLogs, paginateOperatorItems } from "./operator-api.js";

export const DASHBOARD_DTO_VERSION = "axiom.dashboard.v1";
export const STRATEGY_LIST_DTO_VERSION = "axiom.strategy-list.v1";
export const STRATEGY_DETAIL_DTO_VERSION = "axiom.strategy-detail.v1";

const PAPER_STATES = new Set(["released", "healthy"]);
const MARKET_STATES = new Set(["incubation", "release_blocked_short", "released", "healthy", "watch", "quarantined"]);
const RETIRED_STATES = new Set(["development_reject", "holdout_reject", "inconclusive", "incubation_reject", "retired", "dropped", "superseded"]);
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
const iso = (value) => { const date = new Date(value ?? 0); return Number.isNaN(date.getTime()) ? null : date.toISOString(); };

export function productStage(strategy = {}) {
  if (strategy.operational_status === "operational_blocked") return "watch";
  if (["generated", "rework"].includes(strategy.state)) return "testing";
  if (["validation", "capacity_wait"].includes(strategy.state)) return "validation";
  if (["incubation", "release_blocked_short"].includes(strategy.state)) return "incubation";
  if (PAPER_STATES.has(strategy.state)) return "paper_market";
  if (["watch", "quarantined"].includes(strategy.state)) return "watch";
  if (RETIRED_STATES.has(strategy.state)) return "retired";
  return "testing";
}

function statusLabel(strategy) {
  const stage = productStage(strategy);
  const labels = { testing: "Testing", validation: "Validation", incubation: "Incubation",
    paper_market: "Paper Market", watch: "Watch", retired: "Retired" };
  if (strategy.state === "release_blocked_short") return "Incubating - short release blocked";
  if (strategy.state === "quarantined") return "Watch - quarantined";
  if (strategy.operational_status === "operational_blocked") return "Watch - operational issue";
  return labels[stage];
}

function curveValues(strategy) {
  const source = strategy.metrics?.curve ?? strategy.validation?.curve ?? [];
  return source.map((item) => finite(typeof item === "object" ? item.value ?? item.y : item, NaN)).filter(Number.isFinite);
}

function safeCurve(strategy, threshold = 180) {
  const values = curveValues(strategy);
  if (values.length < 2) return [];
  return deterministicDownsample(values, threshold).map((point) => ({ x: point.x, value: point.y }));
}

function drawdown(points) {
  let peak = -Infinity, worst = 0;
  for (const point of points) {
    const value = finite(point.equity, NaN);
    if (!Number.isFinite(value)) continue;
    peak = Math.max(peak, value);
    if (peak > 0) worst = Math.max(worst, 1 - value / peak);
  }
  return worst;
}

function rollingSharpe(points, windowSize = 20) {
  const returns = [], output = [];
  for (let index = 1; index < points.length; index += 1) {
    const previous = finite(points[index - 1].equity, NaN), current = finite(points[index].equity, NaN);
    if (!(previous > 0) || !Number.isFinite(current)) continue;
    returns.push(current / previous - 1);
    const window = returns.slice(-windowSize);
    if (window.length < 5) continue;
    const average = window.reduce((sum, value) => sum + value, 0) / window.length;
    const variance = window.reduce((sum, value) => sum + (value - average) ** 2, 0) / window.length;
    const deviation = Math.sqrt(variance);
    output.push({ timestamp: iso(points[index].timestamp), value: deviation > 1e-9 ? average / deviation * Math.sqrt(252) : 0 });
  }
  return output;
}

function pipelineCounts(strategies) {
  return {
    generation: strategies.filter((item) => ["generated", "rework"].includes(item.state)).length,
    backtesting: strategies.filter((item) => ["generated", "rework"].includes(item.state)
      && ["queued", "running", "retry_wait"].includes(item.lifecycle?.operational?.state)).length,
    validation: strategies.filter((item) => ["validation", "capacity_wait"].includes(item.state)).length,
    incubation: strategies.filter((item) => ["incubation", "release_blocked_short"].includes(item.state)).length,
    paper_market: strategies.filter((item) => ["released", "healthy", "watch", "quarantined"].includes(item.state)).length,
  };
}

function systemStatus(state, env, operations) {
  const controls = state.orchestration?.controls ?? {};
  const mode = String(env.ORCHESTRATION_MODE ?? state.orchestration?.mode ?? "observe").toLowerCase();
  if (controls.kill_switch || controls.flatten_requested) return { code: "safety_stop", label: "SAFETY STOP",
    detail: controls.kill_switch ? "The kill switch is active." : "Managed paper positions are being flattened.", can_pause: false, can_resume: false };
  if (mode !== "autonomous") return { code: "setup_required", label: "SETUP REQUIRED",
    detail: "Autonomous scheduling is not enabled in this deployment.", can_pause: false, can_resume: false };
  if (controls.autonomy_paused || controls.global_paused) return { code: "paused", label: "PAUSED",
    detail: controls.global_paused ? "A system-wide pause is active."
      : "New research, releases and increased exposure are paused; safety supervision continues.",
    can_pause: false, can_resume: Boolean(controls.autonomy_paused) && !controls.execution_paused && !controls.global_paused };
  const critical = (operations.attention ?? []).some((item) => ["critical", "critical_risk", "execution_blocked"].includes(item.severity));
  const unhealthyData = !["healthy", "ready"].includes(String(operations.data?.status ?? "unknown").toLowerCase());
  const granularPause = controls.execution_paused || controls.research_paused || controls.release_paused || controls.ingestion_paused;
  if (critical || unhealthyData || granularPause) return { code: "degraded", label: "DEGRADED",
    detail: granularPause ? "A subsystem pause is active; unaffected safety supervision continues."
      : "Automation is running with an issue that needs attention.", can_pause: true, can_resume: false };
  return { code: "running", label: "RUNNING", detail: "The autonomous paper pipeline is supervising itself.", can_pause: true, can_resume: false };
}

function currentWork(state, strategies, operations) {
  const activeOps = strategies.filter((item) => ["queued", "running", "retry_wait"].includes(item.lifecycle?.operational?.state));
  const validating = strategies.filter((item) => ["validation", "capacity_wait"].includes(item.state));
  const generated = strategies.filter((item) => ["generated", "rework"].includes(item.state));
  const cohort = state.research?.latest_cohort ?? {};
  let kind = "idle", title = "Waiting for the next scheduled event", detail = operations.market?.next_action?.label ?? "No work is currently running", items = [];
  if (activeOps.length) {
    items = activeOps; kind = validating.some((item) => activeOps.includes(item)) ? "validation" : "backtesting";
    title = kind === "validation" ? "Validating unseen data" : "Backtesting strategy evidence";
    detail = `${activeOps.length} strateg${activeOps.length === 1 ? "y" : "ies"} queued or running`;
  } else if (validating.length) {
    items = validating; kind = "validation"; title = "Validation queue"; detail = `${validating.length} strategies awaiting sealed validation`;
  } else if (generated.length) {
    items = generated; kind = "backtesting"; title = "Development review queue"; detail = `${generated.length} strategies awaiting supervisor evidence`;
  } else if (cohort.status && !["complete", "completed", "failed"].includes(String(cohort.status).toLowerCase())) {
    kind = "generation"; title = "Generating strategy DNA"; detail = String(cohort.status).replaceAll("_", " ");
  }
  return { kind, title, detail, count: items.length };
}

function accountSummary(state) {
  const account = state.alpaca?.account ?? {};
  const points = (state.alpaca?.portfolio_history?.points ?? []).map((point) => ({ timestamp: iso(point.timestamp),
    equity: finite(point.equity), pnl: finite(point.profit_loss), pnl_fraction: finite(point.profit_loss_pct) }))
    .filter((point) => point.timestamp);
  const sharpe = rollingSharpe(points);
  return { account_class: "alpaca_paper", connected: Boolean(state.alpaca?.connected), equity: finite(account.equity, 100_000),
    cash: finite(account.cash), buying_power: finite(account.buying_power), pnl: points.at(-1)?.pnl ?? 0,
    pnl_fraction: points.at(-1)?.pnl_fraction ?? 0, rolling_sharpe: sharpe.at(-1)?.value ?? null,
    max_drawdown: drawdown(points), gross_exposure_usd: finite(state.alpaca?.allocation?.gross_before_netting),
    net_exposure_usd: (state.alpaca?.positions ?? []).reduce((sum, position) => sum + finite(position.market_value)
      * (String(position.side).toLowerCase() === "short" ? -1 : 1), 0),
    history: deterministicDownsample(points.map((point, index) => ({ x: index, y: point.equity,
      timestamp: point.timestamp, pnl: point.pnl, pnl_fraction: point.pnl_fraction })), 180)
      .map((point) => ({ timestamp: point.timestamp, equity: point.y, pnl: point.pnl, pnl_fraction: point.pnl_fraction })),
    sharpe_history: deterministicDownsample(sharpe.map((point, index) => ({ x: index, y: point.value,
      timestamp: point.timestamp })), 180).map((point) => ({ timestamp: point.timestamp, value: point.y })) };
}

function actionableAttention(operations) {
  const seen = new Set();
  return (operations.attention ?? []).filter((item) => !["info"].includes(String(item.severity).toLowerCase()))
    .filter((item) => { const key = `${item.code}:${item.strategy_id ?? ""}`; if (seen.has(key)) return false; seen.add(key); return true; })
    .slice(0, 20).map((item) => ({ code: item.code ?? "attention", severity: item.severity ?? "warning",
      summary: item.summary ?? "Operator attention is required",
      strategy_id: item.strategy_id ?? null }));
}

export function strategySummary(strategy) {
  const metrics = strategy.metrics ?? {};
  const incubation = strategy.incubation ? { valid_days: finite(strategy.incubation.valid_trading_days), required_days: 10,
    eligible_trades: finite(strategy.incubation.eligible_trades), required_trades: 67 } : null;
  return { id: String(strategy.id), name: strategy.name ?? strategy.id, asset: strategy.asset ?? null,
    archetype: strategy.archetype ?? null, stage: productStage(strategy), status: statusLabel(strategy),
    state: strategy.state ?? "generated",
    paused: strategy.lifecycle?.operational?.state === "operator_paused", needs_attention: productStage(strategy) === "watch",
    metrics: { return: metrics.return ?? metrics.annualized ?? null, sharpe: metrics.sharpe ?? null,
      drawdown: metrics.drawdown ?? null, score: metrics.score ?? null }, incubation,
    last_decision: strategy.health?.decision?.findings?.join(", ") ?? strategy.validation?.reason
      ?? strategy.supervision?.reasons?.join(", ") ?? strategy.rework?.reason ?? null,
    curve: safeCurve(strategy) };
}

export function buildDashboardReadModel(state, env, operations, now = new Date().toISOString()) {
  const strategies = state.strategies ?? [];
  const market = strategies.filter((item) => MARKET_STATES.has(item.state));
  const activity = operatorLogs(state).filter((item) => item.category === "lifecycle"
    || /RELEASE|VALID|REVIEW|GENERAT|REWORK|RETIRE|DROP/i.test(`${item.title} ${item.category}`)).slice(0, 5)
    .map((item, index) => ({ id: String(item.id ?? `activity:${index}`), at: item.at ?? null,
      title: item.title ?? "Lifecycle decision", detail: item.detail ?? "Decision recorded",
      severity: item.severity ?? "info", strategy_id: item.strategy_id ?? null }));
  const core = { dto_version: DASHBOARD_DTO_VERSION, generated_at: iso(now),
    system: { ...systemStatus(state, env, operations), orchestration_mode: String(env.ORCHESTRATION_MODE ?? "observe"),
      next_action: clone(operations.market?.next_action ?? null), paper_only: true, feed: "IEX" },
    account: accountSummary(state), pipeline: pipelineCounts(strategies),
    strategy_book: { total: market.length, incubation: market.filter((item) => productStage(item) === "incubation").length,
      paper_market: market.filter((item) => productStage(item) === "paper_market").length,
      watch: market.filter((item) => productStage(item) === "watch").length,
      curves: market.map((strategy) => ({ strategy_id: String(strategy.id), name: strategy.name ?? strategy.id,
        asset: strategy.asset ?? null,
        stage: productStage(strategy), status: statusLabel(strategy), curve: safeCurve(strategy) })).filter((item) => item.curve.length >= 2) },
    current_work: currentWork(state, strategies, operations), alerts: actionableAttention(operations), recent_activity: activity };
  return Object.freeze({ ...core, response_hash: hashCanonical(core) });
}

const STAGE_FILTERS = new Set(["active", "testing", "validation", "incubation", "paper_market", "watch", "retired", "all"]);
export function buildStrategyList(state, { stage = "active", cursor = null, limit = 50 } = {}) {
  const selected = STAGE_FILTERS.has(stage) ? stage : "active";
  let values = (state.strategies ?? []).map(strategySummary);
  if (selected === "active") values = values.filter((item) => item.stage !== "retired");
  else if (selected !== "all") values = values.filter((item) => item.stage === selected);
  values.sort((left, right) => Number(right.needs_attention) - Number(left.needs_attention)
    || finite(right.metrics.score, -Infinity) - finite(left.metrics.score, -Infinity) || left.id.localeCompare(right.id));
  const page = paginateOperatorItems(values, { cursor, limit, kind: `product-strategies:${selected}` });
  return Object.freeze({ ...page, dto_version: STRATEGY_LIST_DTO_VERSION, stage: selected });
}

function strategyExplanation(strategy) {
  if (strategy.operational_status === "operational_blocked") return "An infrastructure issue is blocking new risk; strategy quality was not changed.";
  if (strategy.state === "release_blocked_short") return "Forward evidence is collecting, but new paper shorts remain disabled.";
  if (strategy.state === "watch") return (strategy.health?.decision?.findings ?? ["Recent paper evidence weakened."]).join(" - ");
  if (strategy.state === "quarantined") return "The strategy is quarantined and cannot increase paper exposure.";
  if (productStage(strategy) === "incubation") return "The strategy is collecting genuinely forward evidence before paper release.";
  if (productStage(strategy) === "validation") return "Development passed; sealed unseen data is being evaluated.";
  if (productStage(strategy) === "paper_market") return "The strategy passed research, validation and incubation and is monitored in the paper market.";
  if (productStage(strategy) === "retired") return strategy.rework?.reason ?? "The strategy no longer satisfies its evidence policy.";
  return "The strategy is being tested automatically on historical development data.";
}

export function buildStrategyDetail(state, strategyId) {
  const strategy = (state.strategies ?? []).find((item) => item.id === strategyId);
  if (!strategy) return null;
  const summary = strategySummary(strategy);
  return Object.freeze({ dto_version: STRATEGY_DETAIL_DTO_VERSION, ...summary,
    explanation: strategyExplanation(strategy),
    lifecycle: (strategy.lifecycle?.history ?? []).slice(-10).map((item) => ({ id: item.transition_id,
      at: iso(item.timestamp), from: item.from, to: item.target, explanation: item.explanation,
      reason_code: item.reason_code ?? null })) });
}

export function autonomyRequest(value) {
  if (!value || !["running", "paused"].includes(value.desired_state)) throw new TypeError("desired_state must be running or paused");
  return { desired_state: value.desired_state, command_kind: value.desired_state === "paused" ? "pause_autonomy" : "resume_autonomy" };
}
