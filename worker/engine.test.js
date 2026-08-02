import assert from "node:assert/strict";
import test from "node:test";

import {
  applyAlpacaCycle,
  applyAlpacaOverview,
  advanceMarket,
  backtest,
  createDemoState,
  evaluateStrategyWindow,
  generateBatch,
  marketSeries,
  migrateState,
  reproduce,
  reworkCandidates,
  reviewCandidates,
  reviewCandidatesWithBars,
  snapshot,
  validateCandidates,
} from "./engine.js";

function addReworkStrategy(state, attempt = 0) {
  generateBatch(state, 1);
  const strategy = state.strategies[0];
  strategy.state = "rework";
  strategy.metrics = {
    score: 57, annualized: 0.05, sharpe: 0.48, drawdown: 0.19, trades: 28,
    profit_factor: 1.01, positive_regimes: 3, robustness: 0.62,
  };
  strategy.validation = { sharpe: -4, return: -0.8, drawdown: 0.9 };
  strategy.rework = { attempt, max_attempts: 3, diagnosis: "queued", source_stage: "validation", change: null, history: [] };
  return strategy;
}

function addReleasedStrategy(state) {
  generateBatch(state, 1);
  const strategy = state.strategies[0];
  strategy.state = "released";
  strategy.metrics = { score: 70, annualized: 0.12, sharpe: 1.1, drawdown: 0.08, trades: 30 };
  strategy.validation = { sharpe: 0.8, return: 0.06, drawdown: 0.07 };
  return strategy;
}

test("initial state is deterministic and completely empty", () => {
  const first = snapshot(createDemoState());
  const second = snapshot(createDemoState());
  assert.deepEqual(first, second);
  assert.deepEqual(first.strategies, []);
  assert.deepEqual(first.events, []);
  assert.equal(first.summary.released, 0);
  assert.equal(first.summary.capital, 100000);
  assert.equal(first.meta.cycle, 0);
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
  const parent = addReleasedStrategy(state);
  reproduce(state, parent.id);
  const child = state.strategies[0];
  assert.equal(child.parent, parent.id);
  assert.equal(child.generation, parent.generation + 1);
  assert.notDeepEqual(child.params, parent.params);
  assert.equal(child.state, "generated");
});

test("rework archives the parent and creates one audited DNA change", () => {
  const state = createDemoState();
  const parent = addReworkStrategy(state);
  const originalParams = structuredClone(parent.params);
  const [child] = reworkCandidates(state);
  assert.equal(parent.state, "superseded");
  assert.equal(child.parent, parent.id);
  assert.equal(child.state, "generated");
  assert.equal(child.rework.attempt, 1);
  assert.equal(child.rework.history.length, 1);
  assert.equal(child.validation, null);
  assert.equal(child.backtests, 0);
  const changed = Object.keys(child.params).filter((key) => child.params[key] !== originalParams[key]);
  assert.deepEqual(changed, [child.rework.change.parameter]);
  assert.ok(state.events.some((item) => item.detail.includes("attempt 1/3")));
});

test("rework mutation cannot inspect holdout results", () => {
  const first = createDemoState();
  const parent = addReworkStrategy(first);
  const second = structuredClone(first);
  second.strategies[0].validation = { sharpe: 20, return: 5, drawdown: 0 };
  reworkCandidates(first);
  reworkCandidates(second);
  assert.deepEqual(first.strategies[0].params, second.strategies[0].params);
  assert.deepEqual(first.strategies[0].rework.history[0].development, second.strategies[0].rework.history[0].development);
  assert.equal(parent.state, "superseded");
});

test("rework lineage is dropped after three attempts", () => {
  const state = createDemoState();
  const parent = addReworkStrategy(state, 3);
  assert.deepEqual(reworkCandidates(state), []);
  assert.equal(parent.state, "dropped");
  assert.ok(state.events.some((item) => item.title.includes("rework exhausted")));
});

test("supervisor automatically evaluates a fresh rework child", () => {
  const state = createDemoState();
  const parent = addReworkStrategy(state);
  reviewCandidates(state);
  const child = state.strategies.find((item) => item.parent === parent.id);
  assert.equal(parent.state, "superseded");
  assert.ok(child);
  assert.equal(child.backtests, 3);
  assert.notEqual(child.state, "generated");
});

test("no-signal backtests stay finite", () => {
  const strategy = { archetype: "Breakout", params: { lookback: 10000, buffer: 0.5, position_size: 0.5 } };
  const market = marketSeries(41);
  const result = backtest(strategy, market.prices, market.labels);
  assert.equal(result.trades, 0);
  assert.ok(Number.isFinite(result.sharpe));
  assert.ok(Number.isFinite(result.profit_factor));
});

test("live monitoring measures signed short exposure", () => {
  const strategy = { archetype: "Momentum", params: { fast: 3, slow: 10, threshold: .001, position_size: .5 } };
  const prices = Array.from({ length: 90 }, (_, index) => 200 * (.99 ** index));
  const result = evaluateStrategyWindow(strategy, prices, 21);
  assert.equal(result.signal, -1);
  assert.ok(result.returns.reduce((sum, value) => sum + value, 0) > 0);
});

test("market advance records monitoring evidence", () => {
  const state = createDemoState();
  addReleasedStrategy(state);
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
  state.cycle = 14;
  state.nextId = 38;
  generateBatch(state, 8);
  reviewCandidates(state);
  const awaiting = state.strategies.filter((strategy) => strategy.state === "validation");
  assert.ok(awaiting.length > 0);
  assert.ok(awaiting.every((strategy) => strategy.validation === null));
  validateCandidates(state);
  assert.equal(state.strategies.filter((strategy) => strategy.state === "validation").length, 0);
});

test("legacy preloaded state is migrated to an empty workspace", () => {
  const state = createDemoState();
  addReleasedStrategy(state);
  state.schemaVersion = 2;
  const migrated = migrateState(state);
  assert.equal(migrated.schemaVersion, 5);
  assert.deepEqual(migrated.strategies, []);
  assert.deepEqual(migrated.events, []);
});

test("schema 3 migration preserves user strategies and adds backtest provenance metadata", () => {
  const state = createDemoState();
  generateBatch(state, 1);
  delete state.strategies[0].rework;
  state.schemaVersion = 3;
  const migrated = migrateState(state);
  assert.equal(migrated.schemaVersion, 5);
  assert.equal(migrated.strategies.length, 1);
  assert.equal(migrated.strategies[0].rework.attempt, 0);
  assert.equal(migrated.strategies[0].engine_family, null);
  assert.deepEqual(migrated.strategies[0].backtest_runs, {});
});

test("schema 4 migration preserves strategies while upgrading to sealed-backtest state", () => {
  const state = createDemoState();
  generateBatch(state, 1);
  const id = state.strategies[0].id;
  state.schemaVersion = 4;
  delete state.strategies[0].backtest_runs;
  delete state.datasets;
  const migrated = migrateState(state);
  assert.equal(migrated.schemaVersion, 5);
  assert.equal(migrated.strategies[0].id, id);
  assert.deepEqual(migrated.strategies[0].backtest_runs, {});
  assert.deepEqual(migrated.datasets, {});
});

test("Alpaca cycles are idempotent and record managed symbols", () => {
  const state = createDemoState();
  const active = addReleasedStrategy(state);
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

test("an accepted Axiom short marks the symbol as managed for later covers", () => {
  const state = createDemoState();
  const active = addReleasedStrategy(state);
  const cycle = {
    scheduled_bucket: "2026-08-03T18", fetched_at: "2026-08-03T18:05:00Z", feed: "iex",
    trading_enabled: true, short_trading_enabled: true, can_trade_now: true,
    account: { equity: 100000 }, positions: [], open_orders: [], clock: { is_open: true },
    proposed_orders: [], order_errors: [], safety_reasons: [],
    submitted_orders: [{ symbol: active.asset, side: "sell", status: "accepted", client_order_id: "axiom-test-short" }],
    evaluations: {},
  };
  applyAlpacaCycle(state, cycle);
  assert.ok(state.alpaca.managed_symbols.includes(active.asset));
});

test("read-only Alpaca overview refresh preserves strategy ownership state", () => {
  const state = createDemoState();
  state.alpaca.managed_symbols = ["SPY"];
  applyAlpacaOverview(state, {
    connected: true,
    fetched_at: "2026-08-03T16:00:00Z",
    account: { equity: 100250, last_equity: 100000, cash: 80000, buying_power: 160000, portfolio_value: 100250 },
    positions: [{ symbol: "SPY", qty: 2, market_value: 1000, unrealized_pl: 25, unrealized_plpc: 0.025 }],
    open_orders: [{ id: "manual-1", client_order_id: "manual-1", symbol: "QQQ", status: "new" }],
    portfolio_history: { period: "3M", timeframe: "1D", points: [{ timestamp: "2026-08-01T00:00:00Z", equity: 100250, profit_loss: 250, profit_loss_pct: 0.0025 }] },
    clock: { is_open: true },
  });
  assert.equal(state.alpaca.connected, true);
  assert.equal(state.alpaca.positions[0].symbol, "SPY");
  assert.equal(state.alpaca.open_orders[0].symbol, "QQQ");
  assert.equal(state.alpaca.portfolio_history.points[0].profit_loss, 250);
  assert.deepEqual(state.alpaca.managed_symbols, ["SPY"]);
  assert.equal(snapshot(state).summary.capital, 100250);
  assert.ok(state.events.some((item) => item.title === "Alpaca portfolio refreshed"));
});
