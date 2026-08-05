import assert from "node:assert/strict";
import test from "node:test";

import {
  RESEARCH_LIMITS,
  deterministicTrialId,
  emptyResearchState,
  normalizeResearchConfig,
  publicResearchState,
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
