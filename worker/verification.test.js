import assert from "node:assert/strict";
import test from "node:test";
import { hashCanonical } from "./dsl.js";
import { TEST_LAYERS, createVerificationReport, evaluateVerificationReadiness } from "./verification.js";

function reports(overrides = {}) {
  return TEST_LAYERS.map((layer, index) => createVerificationReport({ layer, status: "passed", tests: 10,
    failures: 0, critical_faults: 0, coverage: layer === "schema_unit" ? .91 : null,
    artifact_hash: hashCanonical({ layer }), completed_at: `2026-08-06T${String(index).padStart(2, "0")}:00:00Z`,
    ...(overrides[layer] ?? {}) }));
}

test("release verification requires every layer, 90 percent coverage, and no critical fault", () => {
  const ready = evaluateVerificationReadiness(reports());
  assert.equal(ready.ready, true); assert.equal(ready.total_tests, 100);
  assert.equal(evaluateVerificationReadiness(reports({ schema_unit: { coverage: .899 } })).ready, false);
  const critical = evaluateVerificationReadiness(reports({ broker_mocks: { critical_faults: 1 } }));
  assert.equal(critical.ready, false);
  assert.ok(critical.layers.find((item) => item.layer === "broker_mocks").blockers.includes("critical_faults"));
});

test("deferred cloud integration remains an explicit final-release blocker", () => {
  const result = evaluateVerificationReadiness(reports({ cloud_integration: { status: "deferred" } }));
  assert.equal(result.ready, false);
  assert.deepEqual(result.layers.find((item) => item.layer === "cloud_integration").blockers, ["deferred"]);
});

test("verification reports are immutable and tamper evident", () => {
  const source = reports()[0], changed = { ...source, failures: 1 };
  assert.throws(() => evaluateVerificationReadiness([changed]), /hash mismatch/);
  assert.throws(() => createVerificationReport({ layer: "unknown", status: "passed", artifact_hash: "a".repeat(64) }), /identity/);
});
