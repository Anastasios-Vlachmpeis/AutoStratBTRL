import assert from "node:assert/strict";
import test from "node:test";
import { autonomyRequest, buildDashboardReadModel, buildStrategyDetail, buildStrategyList,
  productStage } from "./product-api.js";
import { buildOperationsReadModel } from "./operator-api.js";

function curve(offset = 0, count = 260) {
  return Array.from({ length: count }, (_, index) => 1 + offset + index * .001 + Math.sin(index / 7) * .006);
}

function strategy(id, state, offset = 0) {
  return { id, name: `Strategy ${id}`, asset: id.endsWith("2") ? "QQQ" : "SPY", archetype: "momentum",
    state, strategy_format: "dsl-v1", dna_hash: id.padEnd(64, "a"), engine_family: "backtrader",
    params: { lookback: 12, threshold: .4 },
    strategy_dna: { strategy_id: id, dsl_version: "1", scope: { symbols: ["SPY"] },
      features: [{ kind: "return", bars: 3 }], entry: { operator: "gt", value: .4 },
      exit: { operator: "lt", value: 0 }, target: { size: .02 }, risk: { stop: .01 },
      session: { regular_hours_only: true }, warmup_bars: 52, lineage: { generation: 1 },
      private_holdout_bars: [{ close: 999 }] },
    metrics: { return: .08 + offset, sharpe: 1.2 + offset, drawdown: .04,
      score: 10 + offset, curve: curve(offset), regime_scores: { trend: .8, chop: .3 } },
    backtest_runs: { development: { artifact_id: `DEV-${id}`, engine_version: "bt-1",
      config_hash: "c".repeat(64), result_hash: "r".repeat(64), folds: [{}, {}, {}] } },
    lifecycle: { operational: { state: "ready" }, history: [{ transition_id: `T-${id}`,
      timestamp: "2026-08-05T15:00:00Z", from: "development", target: state,
      explanation: "Evidence moved the strategy forward", reason_code: "gate_pass" }] },
  };
}

function fixture() {
  const strategies = [strategy("S-1", "generated"), strategy("S-2", "validation", .01),
    strategy("S-3", "incubation", .02), strategy("S-4", "healthy", .03),
    strategy("S-5", "watch", -.01), strategy("S-6", "retired", -.03)];
  strategies[2].incubation = { valid_trading_days: 6, eligible_trades: 51 };
  strategies[3].health = { status: "healthy", summary: { return: .03 } };
  strategies[4].health = { status: "watch", decision: { findings: ["Drawdown widened"] } };
  return { strategies, events: [{ id: "E-1", kind: "VALIDATE", title: "Validation passed",
      detail: "Strategy S-3 entered incubation", at: "2026-08-06T15:00:00Z", strategy_id: "S-3" }],
    orchestration: { mode: "autonomous", controls: { autonomy_paused: false }, incidents: [] },
    marketData: { universe: { feed: "iex", symbol_count: 40 }, live: { status: "healthy",
      coverage: 1, healthy_symbols: 40, last_poll_at: "2026-08-06T15:00:00Z" } },
    alpaca: { connected: true, account: { equity: 101500, cash: 75000, buying_power: 150000 },
      clock: { is_open: true, timestamp: "2026-08-06T15:00:00Z" }, positions: [], managed_symbols: [],
      allocation: { gross_before_netting: 9000 }, risk_session: { loss_fraction: 0, halted: false },
      portfolio_history: { points: Array.from({ length: 40 }, (_, index) => ({
        timestamp: new Date(Date.UTC(2026, 5, 1 + index)).toISOString(), equity: 100000 + index * 40 + Math.sin(index) * 150,
        profit_loss: index * 40, profit_loss_pct: index * .0004 })) } },
    research: { trials: {}, cohorts: [], population: [], novelty_archive: { dna_hashes: [] } } };
}

const env = { ORCHESTRATION_MODE: "autonomous", ALPACA_TRADING_ENABLED: "true",
  ALPACA_LONG_TRADING_ENABLED: "true", ALPACA_BROKER_MODE: "paper", BACKTEST_ENGINE: "backtrader" };

function operations(state, overrides = {}) {
  const result = buildOperationsReadModel(state, { ...env, ...overrides }, { ready: true, mode: "dual_write" });
  return { ...result, attention: result.attention.filter((item) => !item.code.endsWith("_missing")) };
}

test("dashboard leads with account evidence and only incubation/paper strategy curves", () => {
  const state = fixture(), dashboard = buildDashboardReadModel(state, env, operations(state));
  assert.equal(dashboard.system.label, "RUNNING");
  assert.equal(dashboard.system.paper_only, true);
  assert.equal(dashboard.account.equity, 101500);
  assert.ok(dashboard.account.history.length > 10);
  assert.ok(dashboard.account.sharpe_history.length > 0);
  assert.deepEqual(dashboard.strategy_book.curves.map((item) => item.strategy_id), ["S-3", "S-4", "S-5"]);
  assert.ok(dashboard.strategy_book.curves.every((item) => item.curve.length <= 180));
  assert.equal(JSON.stringify(dashboard).includes("private_holdout_bars"), false);
});

test("dashboard emits the five explicit product states", () => {
  const state = fixture();
  assert.equal(buildDashboardReadModel(state, { ...env, ORCHESTRATION_MODE: "observe" }, operations(state)).system.label, "SETUP REQUIRED");
  state.orchestration.controls.autonomy_paused = true;
  assert.equal(buildDashboardReadModel(state, env, operations(state)).system.label, "PAUSED");
  state.orchestration.controls.autonomy_paused = false; state.orchestration.controls.kill_switch = true;
  assert.equal(buildDashboardReadModel(state, env, operations(state)).system.label, "SAFETY STOP");
  state.orchestration.controls.kill_switch = false; state.marketData.live.status = "degraded";
  assert.equal(buildDashboardReadModel(state, env, operations(state)).system.label, "DEGRADED");
});

test("legacy and granular pauses cannot be misreported as fully running", () => {
  const state = fixture(); state.orchestration.controls.global_paused = true;
  let status = buildDashboardReadModel(state, env, operations(state)).system;
  assert.equal(status.label, "PAUSED"); assert.equal(status.can_resume, false);
  state.orchestration.controls.global_paused = false; state.orchestration.controls.release_paused = true;
  status = buildDashboardReadModel(state, env, operations(state)).system;
  assert.equal(status.label, "DEGRADED"); assert.match(status.detail, /subsystem pause/);
});

test("strategy lists hide retired work by default and paginate stable stage filters", () => {
  const state = fixture(), active = buildStrategyList(state, { stage: "active", limit: 2 });
  assert.equal(active.total, 5); assert.equal(active.count, 2); assert.ok(active.next_cursor);
  const retired = buildStrategyList(state, { stage: "retired" });
  assert.deepEqual(retired.items.map((item) => item.id), ["S-6"]);
  assert.equal(buildStrategyList(state, { stage: "paper_market" }).items[0].id, "S-4");
  assert.equal(productStage(state.strategies[4]), "watch");
});

test("strategy detail is intentionally small and never exposes research internals or secrets", () => {
  const state = fixture(); state.strategies[2].params.private_holdout_bars = [{ close: 123 }];
  state.strategies[2].params.api_secret = "never-return";
  const detail = buildStrategyDetail(state, "S-3"), serialized = JSON.stringify(detail);
  assert.equal(detail.incubation.required_days, 10); assert.equal(detail.incubation.required_trades, 67);
  assert.equal(detail.lifecycle[0].reason_code, "gate_pass");
  assert.equal("research" in detail, false); assert.equal("evidence" in detail, false);
  assert.equal(serialized.includes("private_holdout_bars"), false);
  assert.equal(serialized.includes("never-return"), false);
  assert.equal(serialized.includes("API_SECRET"), false);
  assert.equal(buildStrategyDetail(state, "missing"), null);
});

test("current work stays text-only instead of shipping decorative chart data", () => {
  const state = fixture(); state.strategies = Array.from({ length: 20 }, (_, index) => {
    const item = strategy(`Q-${index}`, "generated", index / 1000);
    item.lifecycle.operational.state = "running"; return item;
  });
  const dashboard = buildDashboardReadModel(state, env, operations(state));
  assert.equal(dashboard.current_work.kind, "backtesting");
  assert.equal(dashboard.current_work.count, 20);
  assert.equal("curves" in dashboard.current_work, false);
});

test("legacy strategies with missing presentation fields still produce a hashable dashboard", () => {
  const state = fixture(); delete state.strategies[2].name; delete state.strategies[2].asset;
  state.events.push({ kind: "RELEASE", at: "2026-08-06T16:00:00Z" });
  const dashboard = buildDashboardReadModel(state, env, operations(state));
  assert.match(dashboard.response_hash, /^[a-f0-9]{64}$/);
  assert.equal(dashboard.strategy_book.curves.find((item) => item.strategy_id === "S-3").asset, null);
});

test("autonomy endpoint vocabulary is intentionally tiny", () => {
  assert.deepEqual(autonomyRequest({ desired_state: "paused" }), { desired_state: "paused", command_kind: "pause_autonomy" });
  assert.deepEqual(autonomyRequest({ desired_state: "running" }), { desired_state: "running", command_kind: "resume_autonomy" });
  assert.throws(() => autonomyRequest({ desired_state: "stopped" }), /running or paused/);
});
