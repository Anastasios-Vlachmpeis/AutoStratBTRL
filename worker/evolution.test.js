import assert from "node:assert/strict";
import test from "node:test";

import { validateStrategyDNA } from "./dsl.js";
import { buildGeneratedStrategyDNA } from "./dsl-generation.js";
import { CHALLENGER_OPERATORS, proposePopulation } from "./evolution.js";
import { researchContract } from "./research-contract.js";

function contract(config = {}) {
  return researchContract({ seed: 917, session_date: "2026-08-05", dataset_id: "five-minute-probe",
    dataset_hash: "b".repeat(64), config: { sampled_genomes: 10, challengers: 14, ...config } });
}

test("proposal population is deterministic, ordered, quota-bound, and DSL-only", () => {
  const frozen = contract();
  const first = proposePopulation(frozen); const second = proposePopulation(frozen);
  assert.deepEqual(first, second);
  assert.equal(first.length, frozen.config.total_trials);
  assert.deepEqual(first.map((item) => item.ordinal), Array.from({ length: first.length }, (_, index) => index));
  assert.equal(first.filter((item) => item.proposal_kind === "sample").length, frozen.config.sampled_genomes);
  assert.equal(first.filter((item) => item.proposal_kind === "challenger").length, frozen.config.challengers);
  for (const record of first.filter((item) => item.structural_status === "valid")) {
    assert.equal(record.after_hash, record.dna_hash);
    assert.equal(record.dna.strategy_id, `DSL1-${record.dna_hash.slice(0, 24)}`);
    assert.doesNotThrow(() => validateStrategyDNA(record.dna));
    assert.equal(record.dna.scope.allow_long, true);
    assert.equal(record.dna.scope.allow_short, true);
  }
});

test("challenger schedule covers every audited operator and parent ordering is irrelevant", () => {
  const parentA = buildGeneratedStrategyDNA({ family: "Dual average trend", params: { fast: 8, slow: 28, threshold: .002, position_size: .6 }, seed: 1, trialId: "parent-a" }).dna;
  const parentB = buildGeneratedStrategyDNA({ family: "Residual reversion", params: { lookback: 20, entry_z: 1.5, exit_z: .2, position_size: .5 }, seed: 2, trialId: "parent-b" }).dna;
  const frozen = contract({ sampled_genomes: 2, challengers: 14 });
  const forward = proposePopulation(frozen, { parents: [parentA, parentB] });
  const reverse = proposePopulation(frozen, { parents: [parentB, parentA] });
  assert.deepEqual(forward, reverse);
  const used = new Set(forward.filter((item) => item.proposal_kind === "challenger").map((item) => item.operator));
  for (const operator of CHALLENGER_OPERATORS) assert.equal(used.has(operator), true);
  for (const record of forward.filter((item) => item.proposal_kind === "challenger")) assert.deepEqual(record.parent_hashes, [...record.parent_hashes].sort());
});

test("archive and within-cohort DNA duplicates are visible but never accepted", () => {
  const frozen = contract({ sampled_genomes: 1, challengers: 0 });
  const original = proposePopulation(frozen)[0];
  const repeated = proposePopulation(frozen, { archiveDnaHashes: [original.dna_hash] })[0];
  assert.equal(repeated.structural_status, "duplicate");
  assert.equal(repeated.rejection_reason, "DNA_HASH_ALREADY_SEEN");
  assert.equal(repeated.dna_hash, original.dna_hash);
});

test("every registry record is data-only, including any structural rejection", () => {
  const frozen = contract({ sampled_genomes: 0, challengers: 3 });
  const records = proposePopulation(frozen);
  // Research config intentionally enforces one grammar seed even when a caller
  // requests zero, so challengers always have an auditable parent pool.
  assert.equal(records.length, frozen.config.total_trials);
  for (const record of records) {
    assert.equal("code" in record, false);
    assert.equal("source" in record, false);
    if (record.structural_status === "invalid") {
      assert.match(record.rejection_reason, /STRUCTURAL_INVALID/);
      assert.equal(record.dna, null);
    }
  }
});
