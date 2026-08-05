import assert from "node:assert/strict";
import test from "node:test";

import { buildGeneratedStrategyDNA } from "./dsl-generation.js";
import { buildDevelopmentFolds, evaluateResearchTrial, paretoRank, screenResearchTrials, selectResearchFinalists } from "./research-fitness.js";

const SYMBOLS = ["AAPL", "MSFT", "NVDA", "AMZN", "META", "SPY"];
function bars(seed, count = 150) {
  let price = 100 + seed;
  return Array.from({ length: count }, (_, index) => {
    const movement = Math.sin((index + seed) / 7) * .003 + (index % 11 === 0 ? .006 : -.0003);
    const open = price; price *= 1 + movement;
    return { t: new Date(Date.UTC(2026, 0, 2, 14, 30 + index * 5)).toISOString(), o: open, h: Math.max(open, price) * 1.002,
      l: Math.min(open, price) * .998, c: price, v: 1_000_000, data_health: "healthy", data_coverage: 1 };
  });
}
const DATA = Object.fromEntries(SYMBOLS.map((symbol, index) => [symbol, bars(index)]));
function trial(family, seed) {
  const params = family === "Dual average trend" ? { fast: 4, slow: 12, threshold: .0001, position_size: 1 }
    : family === "Residual reversion" ? { lookback: 10, entry_z: .2, exit_z: .05, position_size: 1 }
      : family === "Range expansion" ? { lookback: 10, buffer: .0001, position_size: 1 }
        : { lookback: 10, threshold: .0001, vol_ceiling: 10, position_size: 1 };
  return { trial_id: `trial-${seed}`, dna: buildGeneratedStrategyDNA({ family, params, seed, trialId: `trial-${seed}`, symbols: SYMBOLS }).dna };
}

test("development folds are deterministic and exclude unused symbols", () => {
  assert.deepEqual(buildDevelopmentFolds(DATA), buildDevelopmentFolds({ ZZZ: bars(9), ...DATA }));
  const folds = buildDevelopmentFolds(DATA);
  assert.equal(folds.length, 3);
  assert.ok(folds.every((fold) => fold.train_end < fold.test_start && fold.test_start <= fold.test_end));
});

test("trial evaluation is deterministic and uses only scoped supplied development bars", () => {
  const value = trial("Dual average trend", 1);
  const first = evaluateResearchTrial(value, DATA, { minimum_trades: 1 });
  const second = evaluateResearchTrial(value, { ...DATA, UNUSED: bars(77).map((bar) => ({ ...bar, c: bar.c * 100 })) }, { minimum_trades: 1 });
  assert.equal(first.behavior_fingerprint, second.behavior_fingerprint);
  assert.deepEqual(first.fitness, second.fitness);
  assert.equal(first.dataset_scope, "development_only");
});

test("Pareto ranks and finalist selection are input-order invariant", () => {
  const records = ["Dual average trend", "Residual reversion", "Range expansion", "Quiet trend"].map((family, index) => evaluateResearchTrial(trial(family, index + 1), DATA, { minimum_trades: 1, maximum_symbol_concentration: 1 }));
  const left = paretoRank(records).map((record) => [record.dna_hash, record.pareto_rank]);
  const right = paretoRank([...records].reverse()).map((record) => [record.dna_hash, record.pareto_rank]);
  assert.deepEqual(left, right);
  assert.deepEqual(selectResearchFinalists(records, { finalists: 2 }).map((record) => record.dna_hash),
    selectResearchFinalists([...records].reverse(), { finalists: 2 }).map((record) => record.dna_hash));
});

test("DNA and behavior duplicates remain recorded but skip expensive evaluation", () => {
  const candidate = trial("Dual average trend", 20);
  const result = screenResearchTrials([candidate, { ...candidate, trial_id: "copy" }], DATA, { minimum_trades: 1, maximum_symbol_concentration: 1 });
  assert.equal(result.summary.attempted, 2);
  assert.equal(result.summary.duplicates, 1);
  assert.equal(result.records.find((record) => record.status === "duplicate").skip_expensive, true);
});

test("different DNA with identical target behavior is also skipped", () => {
  const first = trial("Dual average trend", 31);
  const second = trial("Dual average trend", 32); // lineage differs; graph and targets do not
  assert.notEqual(first.dna.dna_hash, second.dna.dna_hash);
  const result = screenResearchTrials([first, second], DATA, { minimum_trades: 1, maximum_symbol_concentration: 1 });
  const duplicate = result.records.find((record) => record.status === "duplicate");
  assert.equal(duplicate?.duplicate_kind, "behavior");
  assert.equal(duplicate?.skip_expensive, true);
});

test("finalists are capped and vector screen supports long, short, and flat target behavior", () => {
  const trials = Array.from({ length: 14 }, (_, index) => trial(["Dual average trend", "Residual reversion", "Range expansion", "Quiet trend"][index % 4], 100 + index));
  const result = screenResearchTrials(trials, DATA, { finalists: 12, minimum_trades: 1, maximum_symbol_concentration: 1, cluster_cap: 12 });
  assert.ok(result.finalists.length <= 12);
  const targets = result.records.flatMap((record) => record.behavior_series ?? []);
  assert.ok(targets.some((value) => value > 0));
  assert.ok(targets.some((value) => value < 0));
  assert.ok(targets.some((value) => value === 0));
});
