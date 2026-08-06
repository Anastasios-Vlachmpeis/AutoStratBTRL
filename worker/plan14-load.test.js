import assert from "node:assert/strict";
import test from "node:test";
import { buildBackfillJobs, buildCalendarManifest, normalizeCalendarSessions } from "./market-data.js";
import { normalizeResearchConfig } from "./research-contract.js";
import { initialUniverseManifest } from "./universe.js";
import { costPublicSummary, recordCostUsage } from "./cost-controller.js";
import { advanceRolloutPhase, recordRolloutEvidence } from "./rollout.js";
import { hashCanonical } from "./dsl.js";

test("maximum daily research remains explicitly bounded to 160 attempts and 12 finalists", () => {
  const config = normalizeResearchConfig({ sampled_genomes: 999, challengers: 999, finalists: 999 });
  assert.equal(config.sampled_genomes, 128); assert.equal(config.challengers, 32);
  assert.equal(config.total_trials, 160); assert.equal(config.finalists, 12);
});

test("three-year 40-symbol backfill expands deterministically into bounded monthly jobs", async () => {
  const universe = await initialUniverseManifest();
  const sessions = normalizeCalendarSessions([{ date: "2026-08-03", open: "09:30", close: "16:00" }]);
  const calendar = await buildCalendarManifest(sessions, "2023-08-02", "2026-08-02");
  const first = await buildBackfillJobs({ universe, calendar, start: "2023-08-02", end: "2026-08-02" });
  const second = await buildBackfillJobs({ universe, calendar, start: "2023-08-02", end: "2026-08-02" });
  assert.deepEqual(first, second); assert.equal(first.length, 37 * 40);
  assert.equal(new Set(first.map((item) => item.id)).size, first.length);
});

test("representative maximum research usage projects below budget without relying on free allowances", () => {
  const state = {};
  for (let day = 1; day <= 30; day += 1) recordCostUsage(state, { research_trials: 160, research_finalists: 12,
    cloud_run_invocations: 12, cloud_run_vcpu_seconds: 360, cloud_run_gib_seconds: 180,
    queue_operations: 400, worker_requests: 2000, d1_rows_written: 2500, r2_class_a_operations: 50 },
  `2026-09-${String(day).padStart(2, "0")}T20:00:00Z`);
  const summary = costPublicSummary(state, { COST_CONTROL_ENABLED: "true", MONTHLY_BUDGET_LIMIT_USD: "50",
    COST_TELEMETRY_MAX_AGE_MS: "21600000" }, "2026-09-30T21:00:00Z");
  assert.ok(summary.projected_monthly_usd < 50);
  assert.equal(summary.optional_research_allowed, true);
});

test("random invalid or reordered rollout deliveries cannot skip phase A", () => {
  const state = {}, artifact = hashCanonical({ artifact: "fuzz" });
  let seed = 14;
  for (let index = 0; index < 500; index += 1) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const phase = String.fromCharCode(65 + seed % 9);
    try { recordRolloutEvidence(state, { phase, gate: "not-a-gate", status: seed % 2 ? "passed" : "failed",
      artifact_hash: artifact, details: {} }); } catch {}
    try { advanceRolloutPhase(state, { expected_phase: phase, actor: "system", idempotency_key: `fuzz:${index}:value` }); } catch {}
  }
  assert.equal(state.rollout.phase, "A"); assert.equal(state.rollout.transitions.length, 0);
});
