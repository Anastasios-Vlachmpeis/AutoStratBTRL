import assert from "node:assert/strict";
import test from "node:test";
import { behaviorSimilarity, buildFoldManifest, calibrateShadowPolicy, createEvaluationPolicy, decideHoldout, evaluationPolicyHash, normalizeDevelopmentEvidence, replaySupervisorDecision, selectValidationCapacity, selectionInstability, superviseDevelopment, trialAwareConfidence } from "./evaluation-policy.js";

const policy = createEvaluationPolicy({ development: { min_closed_trades: 2, min_symbols: 2, min_folds: 3, min_coverage: .9, min_stressed_sharpe: .1, min_novelty: .05, max_drawdown: .2, max_concentration: .35, max_complexity: .85 }, holdout: { min_closed_trades: 1, min_symbols: 1 } });
const evidence = {
  strategy_id: "s-1", coverage: .95, closed_trades: 30, concentration: .2, complexity: .2, novelty: .4,
  folds: [{ metrics: { bar_sharpe: 1, net_return: .03, max_drawdown: .04 } }, { metrics: { bar_sharpe: .8, net_return: .02, max_drawdown: .05 } }, { metrics: { bar_sharpe: .7, net_return: .01, max_drawdown: .06 } }],
  stress: [{ metrics: { bar_sharpe: .5 } }], per_symbol: [{ metrics: { bar_sharpe: .5 } }, { metrics: { bar_sharpe: .4 } }],
  regimes: [{ score: .4 }], perturbations: [{ metrics: { bar_sharpe: .4 } }], nulls: [{ metrics: { bar_sharpe: -.1 } }],
  candidate_fold_scores: { "s-1": [1, .8, .7], "s-2": [.1, .1, .1] },
};

test("fold manifest is anchored, rolling, and purges DSL warmup + overlap", () => {
  const manifest = buildFoldManifest({ bar_count: 5000, warmup_bars: 40, position_overlap_bars: 3, policy });
  assert.equal(manifest.folds.length, 6);
  assert.equal(manifest.purge_bars, 51);
  for (const fold of manifest.folds) assert.ok(fold.train.end <= fold.purge.start && fold.purge.end === fold.test.start && fold.test.end <= fold.embargo.start);
});

test("invalid and duplicate cohort attempts reduce trial-aware confidence", () => {
  const short = trialAwareConfidence({ sharpe: 1, trial_registry: [{ status: "valid" }], selection_instability: .1, policy });
  const allAttempts = trialAwareConfidence({ sharpe: 1, trial_registry: [{ status: "valid" }, { status: "invalid" }, { status: "duplicate" }, { status: "rejected" }], selection_instability: .1, policy });
  assert.equal(allAttempts.attempts, 4); assert.ok(allAttempts.confidence < short.confidence);
});

test("normalization is deterministic and development decisions are exact", () => {
  const first = normalizeDevelopmentEvidence(evidence, { policy, trial_registry: [{}, {}] });
  const second = normalizeDevelopmentEvidence(JSON.parse(JSON.stringify(evidence)), { policy, trial_registry: [{}, {}] });
  assert.deepEqual(first, second);
  assert.equal(superviseDevelopment({ evidence, policy, trial_registry: [{}, {}] }).decision, "supervisor_approved");
  assert.equal(superviseDevelopment({ evidence: { ...evidence, coverage: .2 }, policy }).decision, "development_reject");
  assert.equal(superviseDevelopment({ evidence: { ...evidence, critical_faults: ["non_finite_equity"] }, policy }).decision, "development_reject");
  assert.equal(superviseDevelopment({ evidence: { ...evidence, novelty: 0 }, policy }).decision, "development_rework");
  assert.equal(superviseDevelopment({ evidence, policy, status: "infrastructure_error" }).decision, null);
});

test("archive novelty compares every member and ignores archive order", () => {
  const candidate = { target_series: [1, 0, -1, 1], trades: [{ t: "a", side: "buy" }, { t: "b", side: "sell" }] };
  const archive = [{ strategy_id: "far", target_series: [0, 0, 0, 0] }, { strategy_id: "near", target_series: [1, 0, -1, 1], trades: [{ t: "a", side: "buy" }, { t: "b", side: "sell" }] }];
  const one = behaviorSimilarity(candidate, archive); const two = behaviorSimilarity(candidate, [...archive].reverse());
  assert.deepEqual(one, two); assert.equal(one.max_similarity, 1); assert.deepEqual(one.nearest_ids, ["near"]); assert.equal(one.novelty, 0);
  const normalized = normalizeDevelopmentEvidence({ ...evidence, per_symbol: { SPY: evidence.per_symbol[0], QQQ: evidence.per_symbol[1] }, regimes: { expansion: evidence.regimes[0] }, behavior: candidate, archive_members: archive }, { policy, trial_registry: [{}] });
  assert.equal(normalized.normalized.novelty, 0); assert.equal(normalized.normalized.symbol_count, 2);
});

test("shadow calibration is development-only and rejects holdout-shaped records", () => {
  const records = Array.from({ length: 8 }, (_, index) => ({ strategy_id: `s-${index}`, development: { stressed_sharpe: .2 + index / 100, novelty: .1, max_drawdown: .1, concentration: .2, activity: 30 }, known_outcome: "paper-positive" }));
  const basePolicy = createEvaluationPolicy({ development: { max_complexity: .42 } });
  const one = calibrateShadowPolicy({ policy: basePolicy, records }); const two = calibrateShadowPolicy({ policy: basePolicy, records: [...records].reverse() });
  assert.equal(one.calibration.status, "calibrated_shadow_only"); assert.equal(one.calibration.sample_count, 8); assert.equal(one.calibration.source_hash, two.calibration.source_hash);
  assert.equal(one.development.max_complexity, .42);
  assert.equal(one.development.min_closed_trades >= 24, true);
  assert.throws(() => calibrateShadowPolicy({ policy: basePolicy, records: [{ development: {}, holdout_metrics: {} }] }), /holdout-shaped/);
});

test("selection instability and capacity selection are deterministic and cluster diverse", () => {
  assert.equal(selectionInstability({ a: [1, 1, 1], b: [.2, .2, .2] }), 0);
  const approved = ["a", "b", "c", "d"].map((strategy_id, index) => ({ strategy_id, decision: "supervisor_approved", behavior_cluster: index < 2 ? "same" : `cluster-${index}`, evidence: { normalized: { robustness: 10 - index } } }));
  const selection = selectValidationCapacity(approved, { policy });
  assert.equal(selection.selected.length, 3); assert.equal(selection.selected[0].strategy_id, "a"); assert.equal(selection.waiting[0].decision, "capacity_wait");
});

test("holdout uses development-distribution degradation bounds and replay is stable", () => {
  const approved = superviseDevelopment({ evidence, policy, trial_registry: [{}] });
  const passingHoldout = { metrics: { net_return: .01, bar_sharpe: .4, max_drawdown: .08, closed_trades: 5,
    regimes: { expansion: { score: .2 }, stress: { score: .1 } } }, per_symbol: [{ net_return: .01 }, { net_return: .02 }] };
  const decision = decideHoldout({ development_folds: evidence.folds, holdout: passingHoldout, policy });
  assert.equal(decision.decision, "incubation");
  const rejected = decideHoldout({ development_folds: evidence.folds, holdout: { metrics: { net_return: -.2, bar_sharpe: -1, max_drawdown: .5, closed_trades: 5 }, per_symbol: [{ net_return: -.2 }, { net_return: -.1 }] }, policy });
  assert.equal(rejected.decision, "holdout_reject");
  const unstable = decideHoldout({ development_folds: evidence.folds, holdout: { ...passingHoldout,
    per_symbol: [{ net_return: -.01 }, { net_return: -.02 }] }, policy });
  assert.equal(unstable.decision, "inconclusive"); assert.ok(unstable.reasons.includes("symbol_stability"));
  const artifacts = { evidence, trial_registry: [{}], candidate: { strategy_id: "s-1", ...approved }, holdout: passingHoldout };
  const one = replaySupervisorDecision({ policy, policy_hash: evaluationPolicyHash(policy), artifacts });
  const two = replaySupervisorDecision({ policy, policy_hash: evaluationPolicyHash(policy), artifacts: JSON.parse(JSON.stringify(artifacts)) });
  assert.deepEqual(one, two);
  assert.throws(() => replaySupervisorDecision({ policy, policy_hash: "bad", artifacts }), /hash mismatch/);
});
