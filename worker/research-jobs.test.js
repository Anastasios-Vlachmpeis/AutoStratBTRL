import assert from "node:assert/strict";
import test from "node:test";
import { buildGeneratedStrategyDNA } from "./dsl-generation.js";
import { planResearchJobs, verifyResearchJob } from "./research-jobs.js";

function generated() {
  const proposals = Array.from({ length: 4 }, (_, ordinal) => ({ ordinal, trial_id: `trial-${ordinal}`,
    dna: buildGeneratedStrategyDNA({ family: "Dual average trend",
      params: { fast: 5, slow: 20, threshold: .001, position_size: .5 }, seed: ordinal,
      trialId: `trial-${ordinal}`, symbols: ["AAPL", "AMD", "AMZN", "MSFT", "SPY"] }).dna }));
  const contract = { contract_hash: "a".repeat(64), dataset_id: "dataset", dataset_hash: "b".repeat(64),
    config: { minimum_symbols: 5, maximum_symbols: 10 } };
  return { contract, cohort: { cohort_id: "cohort", contract_hash: contract.contract_hash, contract }, proposals };
}

test("research jobs are deterministic, bounded, and independent of proposal input order", () => {
  const first = generated(); const reversed = { ...first, proposals: [...first.proposals].reverse() };
  const a = planResearchJobs(first, { workspace_id: "workspace" });
  const b = planResearchJobs(reversed, { workspace_id: "workspace" });
  assert.deepEqual(a, b); assert.equal(a.screens.length, 4); assert.equal(a.finalize.kind, "research.finalize-cohort.v1");
  assert.equal(a.all.length, a.screens.length);
  assert.ok(a.screens.every((job) => job.symbols.length === 5 && !("bars" in job)));
  for (const job of [...a.all, a.finalize]) assert.equal(verifyResearchJob(job, first.cohort), true);
});

test("research job identity rejects payload mutation", () => {
  const value = generated(); const job = planResearchJobs(value, { workspace_id: "workspace" }).screens[0];
  assert.throws(() => verifyResearchJob({ ...job, symbols: [...job.symbols, "QQQ"] }, value.cohort), /identity/);
});
