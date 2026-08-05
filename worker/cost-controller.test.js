import assert from "node:assert/strict";
import test from "node:test";
import { costPublicSummary, evaluateCostPolicy, monthlyCostEstimate, recordCostUsage } from "./cost-controller.js";

const env = { COST_CONTROL_ENABLED: "true", MONTHLY_BUDGET_LIMIT_USD: "50", MONTHLY_FIXED_COST_USD: "0",
  COST_TELEMETRY_MAX_AGE_MS: String(7 * 24 * 60 * 60 * 1000) };

test("cost ledger records provider dimensions and projects a deterministic calendar month", () => {
  const state = {};
  recordCostUsage(state, { worker_requests: 1000, cloud_run_vcpu_seconds: 100, research_trials: 32 }, "2026-08-05T12:00:00Z");
  recordCostUsage(state, { worker_requests: 500, r2_class_a_operations: 4 }, "2026-08-05T13:00:00Z");
  const estimate = monthlyCostEstimate(state, env, "2026-08-05T14:00:00Z");
  assert.equal(estimate.usage.worker_requests, 1500);
  assert.equal(estimate.usage.cloud_run_vcpu_seconds, 100);
  assert.equal(estimate.observed_days, 1);
  assert.ok(estimate.projected_monthly_usd > estimate.month_to_date_usd);
  assert.throws(() => recordCostUsage(state, { secret_tokens: 1 }), /Unsupported cost usage/);
  assert.throws(() => recordCostUsage(state, { worker_requests: -1 }), /non-negative/);
});

test("budget levels degrade optional work before risk supervision", () => {
  const policyAt = (cost) => {
    const state = {}; recordCostUsage(state, { manual_cost_usd: cost }, "2026-08-31T12:00:00Z");
    return evaluateCostPolicy(state, env, "2026-08-31T13:00:00Z");
  };
  assert.equal(policyAt(24).level, "normal");
  assert.equal(policyAt(25).level, "informational");
  assert.equal(policyAt(38).level, "constrained");
  assert.equal(policyAt(45).level, "optional_paused");
  assert.equal(policyAt(50).level, "hard_stop");
  for (const policy of [policyAt(45), policyAt(50)]) {
    assert.equal(policy.optional_research_allowed, false);
    assert.equal(policy.finish_active_sealed_validation, true);
    assert.equal(policy.live_data_allowed, true);
    assert.equal(policy.risk_supervision_allowed, true);
  }
});

test("missing or stale cost telemetry fails optional cloud research closed", () => {
  const missing = evaluateCostPolicy({}, env, "2026-08-05T12:00:00Z");
  assert.equal(missing.level, "telemetry_unavailable");
  const staleState = {};
  recordCostUsage(staleState, { worker_requests: 1 }, "2026-08-01T00:00:00Z");
  assert.equal(evaluateCostPolicy(staleState, env, "2026-08-09T00:00:00Z").telemetry_status, "stale");
  const local = costPublicSummary({}, { COST_CONTROL_ENABLED: "false" }, "2026-08-05T12:00:00Z");
  assert.equal(local.level, "disabled");
  assert.equal(local.optional_research_allowed, true);
});
