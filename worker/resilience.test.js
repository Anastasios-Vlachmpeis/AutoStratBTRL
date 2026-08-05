import assert from "node:assert/strict";
import test from "node:test";
import { RECOVERY_DRILLS, recoveryDrill } from "./resilience.js";

test("every planned outage has a subsystem-specific deterministic recovery response", () => {
  assert.deepEqual(Object.keys(RECOVERY_DRILLS).sort(), ["alpaca_timeout", "broker_divergence", "cloudflare_timeout",
    "corrupt_artifact", "d1_quota_exhausted", "gcp_timeout", "market_data_gap", "queue_quota_exhausted",
    "r2_quota_exhausted", "region_outage", "stale_callback"].sort());
  for (const [kind, policy] of Object.entries(RECOVERY_DRILLS)) {
    assert.ok(policy.actions.length >= 2, kind);
    assert.ok(policy.scope, kind);
  }
});

test("operational drills preserve strategy quality and are idempotent", () => {
  const state = { strategies: [{ id: "S1", state: "healthy", dna_hash: "frozen" }] };
  const first = recoveryDrill(state, { kind: "gcp_timeout", correlation_id: "JOB-1", at: "2026-08-06T14:00:00Z" });
  const retry = recoveryDrill(state, { kind: "gcp_timeout", correlation_id: "JOB-1", at: "2026-08-06T14:01:00Z" });
  assert.equal(first.quality_state_changed, false);
  assert.equal(retry.duplicate, true);
  assert.equal(state.strategies[0].state, "healthy");
  assert.equal(state.orchestration.incidents.length, 1);
});

test("broker divergence fails closed and requests an idempotent managed flatten", () => {
  const state = { strategies: [{ id: "S1", state: "watch" }] };
  const result = recoveryDrill(state, { kind: "broker_divergence", correlation_id: "BROKER-1" });
  assert.equal(result.severity, "critical_risk");
  assert.equal(state.orchestration.controls.entries_paused, true);
  assert.equal(state.orchestration.controls.flatten_requested, true);
  assert.equal(state.strategies[0].state, "watch");
});

test("quota exhaustion pauses optional research before changing risk evidence", () => {
  const state = { strategies: [{ id: "S1", state: "incubation" }] };
  recoveryDrill(state, { kind: "r2_quota_exhausted", correlation_id: "R2-1" });
  assert.equal(state.orchestration.controls.research_paused, true);
  assert.equal(state.orchestration.controls.execution_paused, false);
  assert.equal(state.strategies[0].state, "incubation");
});
