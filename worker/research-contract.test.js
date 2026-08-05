import assert from "node:assert/strict";
import test from "node:test";

import {
  RESEARCH_LIMITS,
  authorizeSealedHoldout,
  bindSealedHoldoutDispatch,
  deterministicTrialId,
  emptyResearchState,
  holdoutAuthorizationJob,
  lineageIdentity,
  normalizeResearchConfig,
  publicResearchState,
  recordSealedHoldoutOutcome,
  recordSealedHoldoutServiceStatus,
  researchContract,
} from "./research-contract.js";

const DATASET_HASH = "a".repeat(64);

test("research contracts and trial IDs are deterministic and dataset-bound", () => {
  const input = { seed: 42, session_date: "2026-08-05", dataset_id: "dataset-1", dataset_hash: DATASET_HASH };
  const first = researchContract(input);
  const second = researchContract(input);
  assert.deepEqual(first, second);
  assert.match(first.cohort_id, /^COH-2026-08-05-[a-f0-9]{24}$/);
  assert.equal(deterministicTrialId(first.cohort_id, 0), deterministicTrialId(second.cohort_id, 0));
  assert.notEqual(first.contract_hash, researchContract({ ...input, dataset_hash: "b".repeat(64) }).contract_hash);
});

test("research configuration cannot exceed launch ceilings", () => {
  const config = normalizeResearchConfig({ sampled_genomes: 999, challengers: 999, finalists: 999,
    validation_slots: 999, behavior_clusters: 999, max_runtime_ms: 999999 });
  assert.equal(config.sampled_genomes, RESEARCH_LIMITS.sampled_genomes);
  assert.equal(config.challengers, RESEARCH_LIMITS.challengers);
  assert.equal(config.finalists, RESEARCH_LIMITS.finalists);
  assert.equal(config.validation_slots, RESEARCH_LIMITS.validation_slots);
  assert.equal(config.max_runtime_ms, RESEARCH_LIMITS.max_runtime_ms);
});

test("non-finite decimal configuration falls back to safe policy defaults", () => {
  const contract = researchContract({ seed: 1, session_date: "2026-08-05", dataset_id: "D",
    dataset_hash: "a".repeat(64), config: { maximum_symbol_concentration: "bad", near_duplicate_correlation: Infinity } });
  assert.equal(contract.config.maximum_symbol_concentration, .35);
  assert.equal(contract.config.near_duplicate_correlation, .995);
});

test("public research state contains summaries rather than trial DNA", () => {
  const state = emptyResearchState();
  state.trials.secret = { dna: { private: true } };
  state.cohorts.push({ cohort_id: "cohort", session_date: "2026-08-05", status: "complete",
    attempted: 160, valid: 120, duplicates: 10, finalists: [1, 2], completed_at: "now" });
  const value = publicResearchState(state);
  assert.equal(value.total_trials, 0);
  assert.equal(value.latest_cohort.finalists, 2);
  assert.equal("trials" in value, false);
});

test("sealed holdout burn ledger permits only one deterministic retry per lineage", () => {
  const state = { research: emptyResearchState() };
  const request = { lineage_id: "DSL1-root", dataset_id: "sealed-v2", dataset_hash: DATASET_HASH,
    dna_hash: "d".repeat(64), configuration_hash: "c".repeat(64) };
  const job_id = holdoutAuthorizationJob(request);
  const first = authorizeSealedHoldout(state, { ...request, job_id });
  const retry = authorizeSealedHoldout(state, { ...request, job_id });
  assert.equal(first.created, true);
  assert.equal(retry.retry, true);
  assert.equal(retry.authorization.authorization_id, first.authorization.authorization_id);
  bindSealedHoldoutDispatch(state, { lineage_id: request.lineage_id, jobs: [{ job_id: "bt-1", payload_hash: "p".repeat(64) }] });
  const restored = JSON.parse(JSON.stringify(state));
  bindSealedHoldoutDispatch(restored, { lineage_id: request.lineage_id, jobs: [{ job_id: "bt-1", payload_hash: "p".repeat(64) }] });
  assert.throws(() => bindSealedHoldoutDispatch(state, { lineage_id: request.lineage_id, jobs: [{ job_id: "bt-2", payload_hash: "p".repeat(64) }] }), /changed/);
  assert.throws(() => authorizeSealedHoldout(state, { ...request, job_id: "different-job" }), /already burned/);
  recordSealedHoldoutServiceStatus(state, { lineage_id: request.lineage_id, status: "error", error: "timeout" });
  assert.equal(state.research.holdout_burn_ledger.by_lineage[request.lineage_id].outcome, null);
  recordSealedHoldoutOutcome(state, { lineage_id: request.lineage_id, outcome: "inconclusive", result_hash: "r".repeat(64) });
  assert.throws(() => recordSealedHoldoutOutcome(state, { lineage_id: request.lineage_id, outcome: "incubation", result_hash: "x".repeat(64) }), /terminal outcome/);
  assert.throws(() => authorizeSealedHoldout(state, { ...request, job_id }), /terminal outcome/);
  const publicValue = publicResearchState(state.research);
  assert.equal(publicValue.holdout.total_burns, 1);
  assert.equal("holdout_burn_ledger" in publicValue, false);
});

test("lineage identity prefers a preserved root across rework children", () => {
  assert.equal(lineageIdentity({ id: "child", lineage_id: "root" }), "root");
  assert.equal(lineageIdentity({ id: "child", strategy_dna: { strategy_id: "DNA-child", lineage: { parent_strategy_id: "DNA-root" } } }), "DNA-root");
});
