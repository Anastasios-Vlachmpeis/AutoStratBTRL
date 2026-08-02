import assert from "node:assert/strict";
import test from "node:test";

import {
  applyAlpacaCycle,
  advanceMarket,
  backtest,
  createDemoState,
  generateBatch,
  marketSeries,
  migrateState,
  reproduce,
  reviewCandidates,
  reviewCandidatesWithBars,
  snapshot,
  validateCandidates,
} from "./engine.js";

test("demo state is deterministic and begins with a release book", () => {
  const first = snapshot(createDemoState());
  const second = snapshot(createDemoState());
  assert.deepEqual(first.strategies, second.strategies);
  assert.ok(first.summary.released >= 1);
  assert.ok(first.strategies.every((strategy) => strategy.backtests >= 3));
});

test("cohorts wait for evidence before supervisor review", () => {
  const state = createDemoState();
  const before = state.strategies.length;
  generateBatch(state, 4);
  assert.equal(state.strategies.length, before + 4);
  assert.equal(snapshot(state).summary.generated, 4);
  reviewCandidates(state);
  assert.equal(snapshot(state).summary.generated, 0);
  assert.ok(state.strategies.slice(0, 4).every((strategy) => strategy.backtests === 3));
});

test("reproduction preserves lineage and mutates DNA", () => {
  const state = createDemoState();
  const parent = state.strategies.find((strategy) => ["released", "healthy", "watch", "adjusted"].includes(strategy.state));
  reproduce(state, parent.id);
  const child = state.strategies[0];
  assert.equal(child.parent, parent.id);
  assert.equal(child.generation, parent.generation + 1);
  assert.notDeepEqual(child.params, parent.params);
  assert.equal(child.state, "generated");
});

test("no-signal backtests stay finite", () => {
  const strategy = { archetype: "Breakout", params: { lookback: 10000, buffer: 0.5, position_size: 0.5 } };
  const market = marketSeries(41);
  const result = backtest(strategy, market.prices, market.labels);
  assert.equal(result.trades, 0);
  assert.ok(Number.isFinite(result.sharpe));
  assert.ok(Number.isFinite(result.profit_factor));
});

test("market advance records monitoring evidence", () => {
  const state = createDemoState();
  const active = state.strategies.filter((strategy) => ["released", "healthy", "watch", "adjusted"].includes(strategy.state));
  advanceMarket(state);
  for (const prior of active) {
    const current = state.strategies.find((strategy) => strategy.id === prior.id);
    assert.ok(current.monitor.returns.length >= 21);
    assert.notEqual(current.monitor.sharpe, null);
  }
});

test("live-data review consumes Alpaca bars", () => {
  const state = createDemoState();
  generateBatch(state, 2);
  const bars = Object.fromEntries(["SPY", "QQQ", "IWM", "TLT"].map((symbol) => [symbol,
    Array.from({ length: 620 }, (_, index) => ({ c: 100 + index * 0.08 + Math.sin(index / 8) }))
  ]));
  reviewCandidatesWithBars(state, bars);
  assert.equal(snapshot(state).summary.generated, 0);
  assert.ok(state.strategies.slice(0, 2).every((strategy) => strategy.backtests === 3));
  assert.ok(state.events.some((item) => item.detail.includes("development data only")));
});

test("supervisor cannot see the untouched final quarter", () => {
  const strategyTemplate = {
    id: "AX-99-001", name: "Holdout Canary", state: "generated", asset: "SPY", archetype: "Momentum",
    params: { fast: 5, slow: 24, threshold: 0.001, position_size: 0.7 }, generation: 1,
    parent: null, backtests: 0, metrics: null, validation: null,
    monitor: { returns: [], streak: 0, adjustments: 0, sharpe: null, drawdown: null, ratio: null },
  };
  const development = Array.from({ length: 450 }, (_, index) => ({ c: 100 * (1.002 ** index) }));
  const quietHoldout = Array.from({ length: 150 }, () => ({ c: development.at(-1).c }));
  const violentHoldout = Array.from({ length: 150 }, (_, index) => ({ c: development.at(-1).c * (index % 2 ? 1.4 : 0.6) }));
  const makeState = () => ({ seed: 1, cycle: 99, marketClock: 0, nextId: 2, strategies: [structuredClone(strategyTemplate)], events: [], alpaca: { connected: false } });
  const quietState = makeState();
  const violentState = makeState();
  reviewCandidatesWithBars(quietState, { SPY: [...development, ...quietHoldout] });
  reviewCandidatesWithBars(violentState, { SPY: [...development, ...violentHoldout] });
  assert.deepEqual(quietState.strategies[0].metrics, violentState.strategies[0].metrics);
  assert.equal(quietState.strategies[0].state, violentState.strategies[0].state);
});

test("supervisor approval enters validation before release", () => {
  const state = createDemoState();
  generateBatch(state, 12);
  reviewCandidates(state);
  const awaiting = state.strategies.filter((strategy) => strategy.state === "validation");
  assert.ok(awaiting.length > 0);
  assert.ok(awaiting.every((strategy) => strategy.validation === null));
  validateCandidates(state);
  assert.equal(state.strategies.filter((strategy) => strategy.state === "validation").length, 0);
});

test("legacy releases are migrated behind the validation gate", () => {
  const state = createDemoState();
  state.schemaVersion = 1;
  const active = state.strategies.find((strategy) => ["released", "healthy", "watch", "adjusted"].includes(strategy.state));
  active.validation = null;
  migrateState(state);
  assert.equal(state.schemaVersion, 2);
  assert.equal(active.state, "validation");
  assert.ok(state.events.some((item) => item.title.includes("migration")));
});

test("Alpaca cycles are idempotent and record managed symbols", () => {
  const state = createDemoState();
  const active = state.strategies.find((strategy) => ["released", "healthy", "watch", "adjusted"].includes(strategy.state));
  const cycle = {
    scheduled_bucket: "2026-08-03T15",
    fetched_at: "2026-08-03T15:05:00Z",
    feed: "iex",
    trading_enabled: true,
    can_trade_now: true,
    account: { equity: 100000 },
    positions: [], open_orders: [],
    clock: { is_open: true },
    proposed_orders: [],
    submitted_orders: [{ symbol: active.asset, side: "buy", status: "accepted", client_order_id: "axiom-test" }],
    order_errors: [],
    evaluations: { [active.id]: { signal: 1, latest_price: 500, bar_time: "2026-08-03T15:00:00Z", returns: [0.001, 0.002] } },
  };
  assert.equal(applyAlpacaCycle(state, cycle), true);
  assert.equal(applyAlpacaCycle(state, cycle), false);
  assert.ok(state.alpaca.managed_symbols.includes(active.asset));
  assert.equal(snapshot(state).summary.capital, 100000);
});
