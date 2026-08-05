import assert from "node:assert/strict";
import test from "node:test";

import { createDemoState } from "./engine.js";
import { commitEvolutionaryResearch, developmentOnlyDataset, prepareEvolutionaryResearch } from "./research.js";

const SYMBOLS = ["AAPL", "MSFT", "NVDA", "AMZN", "META", "SPY"];
function data() {
  return Object.fromEntries(SYMBOLS.map((symbol, seed) => {
    let price = 100 + seed;
    return [symbol, Array.from({ length: 180 }, (_, index) => {
      const open = price; price *= 1 + Math.sin((index + seed) / 8) * .004 + (index % 13 === 0 ? .008 : -.0005);
      return { t: new Date(Date.UTC(2026, 0, 5, 14, 30 + index * 5)).toISOString(), o: open,
        h: Math.max(open, price) * 1.001, l: Math.min(open, price) * .999, c: price, v: 1_000_000,
        interval_minutes: 5, data_health: "healthy", data_coverage: 1 };
    })];
  }));
}
function input(bars) {
  return { seed: 99, session_date: "2026-08-05", dataset_id: "development-fixture",
    dataset_hash: "c".repeat(64), dataset_scope: "development_only", bars_by_symbol: bars,
    config: { sampled_genomes: 12, challengers: 7, finalists: 4, minimum_symbols: 5 },
    minimum_fold_bars: 20, minimum_trades: 1, maximum_symbol_concentration: 1 };
}

test("the final quarter is physically removed from evolutionary input", () => {
  const full = data();
  const development = developmentOnlyDataset(full);
  for (const symbol of SYMBOLS) {
    assert.equal(development[symbol].length, 135);
    assert.equal(development[symbol].some((bar) => bar.t === full[symbol].at(-1).t), false);
  }
});

test("changing the withheld quarter cannot change proposals or development ranks", () => {
  const original = data();
  const changed = structuredClone(original);
  for (const symbol of SYMBOLS) {
    for (let index = 135; index < changed[symbol].length; index += 1) {
      changed[symbol][index].c *= 4;
      changed[symbol][index].h = Math.max(changed[symbol][index].h, changed[symbol][index].c);
    }
  }
  const originalDevelopment = developmentOnlyDataset(original);
  const changedDevelopment = developmentOnlyDataset(changed);
  assert.deepEqual(changedDevelopment, originalDevelopment);
  const first = prepareEvolutionaryResearch(createDemoState(), input(originalDevelopment));
  const second = prepareEvolutionaryResearch(createDemoState(), input(changedDevelopment));
  assert.deepEqual(first.screen.summary, second.screen.summary);
  assert.deepEqual(first.screen.finalists.map((item) => item.dna_hash), second.screen.finalists.map((item) => item.dna_hash));
});

test("same contract and development data produce identical trials, ranks, and finalists", () => {
  const bars = data();
  const left = createDemoState(); const right = createDemoState();
  const first = prepareEvolutionaryResearch(left, input(bars));
  const second = prepareEvolutionaryResearch(right, input(bars));
  assert.deepEqual(first.proposals, second.proposals);
  assert.deepEqual(first.screen.summary, second.screen.summary);
  assert.deepEqual(first.screen.finalists.map((item) => item.dna_hash), second.screen.finalists.map((item) => item.dna_hash));
});

test("artifact persistence precedes finalist lifecycle materialization and retry is idempotent", () => {
  const state = createDemoState();
  const prepared = prepareEvolutionaryResearch(state, input(data()));
  assert.equal(state.strategies.length, 0);
  const artifactIds = Object.fromEntries(prepared.trial_artifacts.map((item) => [item.trial_id, `artifact-${item.trial_id}`]));
  const result = commitEvolutionaryResearch(state, prepared, { artifact_ids: artifactIds });
  assert.equal(result.created.length, prepared.screen.finalists.length);
  assert.ok(result.created.every((strategy) => strategy.strategy_format === "dsl-v1" && strategy.trial_id));
  const retry = prepareEvolutionaryResearch(state, input(data()));
  assert.equal(retry.duplicate, true);
});

test("holdout-shaped inputs are rejected before trial registration", () => {
  const state = createDemoState();
  assert.throws(() => prepareEvolutionaryResearch(state, { ...input(data()), holdout_bars: {} }), /Holdout/);
  assert.equal(state.research.total_trials, 0);
});
