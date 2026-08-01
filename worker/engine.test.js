import assert from "node:assert/strict";
import test from "node:test";

import {
  advanceMarket,
  backtest,
  createDemoState,
  generateBatch,
  marketSeries,
  reproduce,
  reviewCandidates,
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
