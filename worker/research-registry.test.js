import assert from "node:assert/strict";
import test from "node:test";

import { researchContract } from "./research-contract.js";
import {
  beginCohort, canStartResearch, completeCohort, dispatchExpensiveFinalists,
  initializeResearch, markFinalists, pauseResearch, recordTrialScreen, registerTrial, researchReset, resumeResearch,
} from "./research-registry.js";

const hash = (value) => value.repeat(64).slice(0, 64);
const contract = (date = "2026-08-05", config = {}) => researchContract({ seed: 7, session_date: date, dataset_id: "D1", dataset_hash: hash("a"), config });
const proposal = (cohort, ordinal, overrides = {}) => ({
  cohort_id: cohort.cohort_id, ordinal, dna_hash: hash(String((ordinal % 9) + 1)), behavior_hash: hash(String((ordinal % 9) + 1)), dna: { ordinal }, ...overrides,
});

test("registry records invalid and duplicate attempts while suppressing expensive duplicate dispatch", () => {
  const state = {};
  const cohort = beginCohort(state, contract());
  const first = registerTrial(state, proposal(cohort, 0)).trial;
  const duplicate = registerTrial(state, proposal(cohort, 1, { dna_hash: first.dna_hash, behavior_hash: first.behavior_hash })).trial;
  const invalid = registerTrial(state, proposal(cohort, 2, { structural_validation: { valid: false, rejection_reason: "lookahead" } })).trial;
  assert.equal(state.research.total_trials, 3);
  assert.equal(duplicate.duplicate, true);
  assert.equal(invalid.valid, false);
  assert.deepEqual(markFinalists(state, { cohort_id: cohort.cohort_id, trial_ids: [first.trial_id, duplicate.trial_id, invalid.trial_id] }).map((trial) => trial.trial_id), [first.trial_id]);
  assert.equal(dispatchExpensiveFinalists(state, { cohort_id: cohort.cohort_id, trial_ids: [first.trial_id, duplicate.trial_id] }).length, 1);
  assert.equal(state.research.total_expensive_dispatches, 1);
});

test("deterministic retries are idempotent and conflicting retries are rejected", () => {
  const state = {};
  const cohort = beginCohort(state, contract());
  const first = registerTrial(state, proposal(cohort, 0));
  const retry = registerTrial(state, proposal(cohort, 0));
  assert.equal(first.created, true);
  assert.equal(retry.created, false);
  assert.equal(state.research.total_trials, 1);
  assert.throws(() => registerTrial(state, proposal(cohort, 0, { dna_hash: hash("f") })), /reused/);
});

test("daily sampled, challenger, finalist and validation quotas stop optional work and reset by date", () => {
  const state = {};
  const cohort = beginCohort(state, contract("2026-08-05", { sampled_genomes: 2, challengers: 1, finalists: 1, validation_slots: 1 }));
  registerTrial(state, proposal(cohort, 0));
  registerTrial(state, proposal(cohort, 1));
  assert.equal(canStartResearch(state, { kind: "sampled" }).reason, "sampled_ceiling");
  registerTrial(state, proposal(cohort, 2, { kind: "challenger" }));
  assert.equal(canStartResearch(state, { kind: "challenger" }).reason, "challenger_ceiling");
  const first = state.research.trials[Object.keys(state.research.trials)[0]];
  markFinalists(state, { cohort_id: cohort.cohort_id, trial_ids: [first.trial_id] });
  assert.equal(canStartResearch(state, { kind: "finalist" }).reason, "finalist_ceiling");
  dispatchExpensiveFinalists(state, { cohort_id: cohort.cohort_id, trial_ids: [first.trial_id], phase: "validation" });
  assert.equal(canStartResearch(state, { kind: "validation" }).reason, "validation_ceiling");
  initializeResearch(state, { session_date: "2026-08-06" });
  assert.equal(state.research.budget.sampled, 0);
  assert.equal(canStartResearch(state, { kind: "sampled" }).ok, true);
});

test("operator pause and stale/unavailable telemetry pause optional research without changing completed work", () => {
  const state = {};
  const cohort = beginCohort(state, contract());
  const trial = registerTrial(state, proposal(cohort, 0)).trial;
  pauseResearch(state, "manual inspection");
  assert.equal(canStartResearch(state, { kind: "sampled" }).reason, "manual inspection");
  resumeResearch(state);
  assert.equal(canStartResearch(state, { telemetry: { status: "stale" } }).reason, "budget_telemetry_unavailable");
  assert.equal(trial.status, "screening");
  assert.equal(canStartResearch(state, { telemetry: { status: "unavailable" } }).ok, false);
  assert.equal(canStartResearch(state, { telemetry: { status: "healthy" } }).ok, true);
});

test("runtime ceiling, archive retention, infrastructure errors, and reset retain safety semantics", () => {
  const state = {};
  const cohort = beginCohort(state, contract("2026-08-05", { max_runtime_ms: 100 }));
  const trial = registerTrial(state, proposal(cohort, 0, { duration_ms: 100 })).trial;
  assert.equal(canStartResearch(state, { kind: "sampled" }).reason, "runtime_ceiling");
  completeCohort(state, { cohort_id: cohort.cohort_id, infrastructure_error: "timeout" });
  assert.equal(cohort.status, "infrastructure_error");
  assert.equal(cohort.completed_at, null);
  assert.equal(state.research.last_completed_session, null);
  assert.equal(state.research.novelty_archive.dna_hashes.length, 0);
  const reopened = beginCohort(state, contract("2026-08-05", { max_runtime_ms: 100 }));
  assert.equal(reopened.status, "running");
  assert.equal(registerTrial(state, proposal(cohort, 0)).duplicate_retry, true);
  completeCohort(state, { cohort_id: cohort.cohort_id, archive_trial_ids: [trial.trial_id] });
  assert.equal(state.research.novelty_archive.dna_hashes.includes(trial.dna_hash), true);
  researchReset(state);
  assert.equal(state.research.total_trials, 0);
});

test("screen results update provenance and all selected finalists can dispatch exactly once", () => {
  const state = {};
  const cohort = beginCohort(state, contract("2026-08-05", { sampled_genomes: 3, finalists: 2 }));
  const first = registerTrial(state, proposal(cohort, 0, { behavior_hash: null })).trial;
  const second = registerTrial(state, proposal(cohort, 1, { behavior_hash: null })).trial;
  recordTrialScreen(state, { cohort_id: cohort.cohort_id, trial_id: first.trial_id,
    result: { status: "eligible", behavior_fingerprint: hash("b"), fitness: { sharpe_proxy: 1 }, constraint_failures: [], pareto_rank: 0 } });
  markFinalists(state, { cohort_id: cohort.cohort_id, trial_ids: [first.trial_id, second.trial_id] });
  const dispatched = dispatchExpensiveFinalists(state, { cohort_id: cohort.cohort_id,
    trial_ids: [first.trial_id, second.trial_id], phase: "development" });
  assert.equal(dispatched.length, 2);
  assert.equal(state.research.total_expensive_dispatches, 2);
  dispatchExpensiveFinalists(state, { cohort_id: cohort.cohort_id,
    trial_ids: [first.trial_id, second.trial_id], phase: "development" });
  assert.equal(state.research.total_expensive_dispatches, 2);
  assert.equal(state.research.trials[first.trial_id].behavior_hash, hash("b"));
});
