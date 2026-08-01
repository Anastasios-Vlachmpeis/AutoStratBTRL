import assert from "node:assert/strict";
import test from "node:test";

import {
  applyAlpacaCycle,
  advanceMarket,
  backtest,
  createDemoState,
  generateBatch,
  marketSeries,
  reproduce,
  reviewCandidates,
  reviewCandidatesWithBars,
  snapshot,
} from "./engine.js";

test("demo state is deterministic and begins with a release book", () => {
  const first = snapshot(createDemoState());
  const second = snapshot(createDemoState());
  assert.deepEqual(first.strategies, second.strategies);
  assert.ok(first.summary.released >= 1);
  assert.ok(first.strategies.every((strategy) => strategy.backtests === 3));
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
  assert.ok(state.events.some((item) => item.detail.includes("Alpaca IEX data")));
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
