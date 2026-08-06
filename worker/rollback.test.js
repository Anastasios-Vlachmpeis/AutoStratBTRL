import assert from "node:assert/strict";
import test from "node:test";
import { createRollbackBundle, rehearseRollback, restoreRollbackBundle, verifyRollbackBundle } from "./rollback.js";

function fixture() {
  return { schemaVersion: 13, strategies: [{ id: "S1", state: "healthy" }],
    backtestArtifacts: { A1: { id: "A1", result_hash: "a".repeat(64) } },
    alpaca: { api_key: "never-export", api_secret: "also-never", strategy_positions: { S1: { SPY: 2 } } },
    orchestration: { controls: { execution_paused: false }, command_results: { C1: { status: "applied" } } },
    observability: { events: [{ message: "authorization=private" }] } };
}

test("rollback bundle is deterministic, secret-free, and tamper evident", () => {
  const options = { workspace_id: "workspace-test", created_at: "2026-08-06T12:00:00Z" };
  const first = createRollbackBundle(fixture(), options), second = createRollbackBundle(fixture(), options);
  assert.deepEqual(first, second); assert.equal(verifyRollbackBundle(first), true);
  const wire = JSON.stringify(first);
  assert.equal(wire.includes("never-export"), false); assert.equal(wire.includes("also-never"), false);
  assert.equal(wire.includes("authorization=private"), false);
  const tampered = structuredClone(first); tampered.snapshot.strategies[0].state = "released";
  assert.throws(() => verifyRollbackBundle(tampered), /state hash mismatch/);
});

test("restores always pause execution, research, release, and require broker reconciliation", () => {
  const bundle = createRollbackBundle(fixture(), { created_at: "2026-08-06T12:00:00Z" });
  const restored = restoreRollbackBundle(bundle, { restored_at: "2026-08-06T13:00:00Z" });
  for (const key of ["execution_paused", "entries_paused", "research_paused", "release_paused", "global_paused"]) {
    assert.equal(restored.orchestration.controls[key], true);
  }
  assert.equal(restored.orchestration.controls.flatten_requested, false);
  assert.equal(restored.rollback.broker_reconciliation_required, true);
});

test("rollback rehearsal preserves strategy and idempotency identity without mutating current state", () => {
  const current = fixture(), before = structuredClone(current);
  const bundle = createRollbackBundle(current, { created_at: "2026-08-06T12:00:00Z" });
  current.strategies.push({ id: "S2", state: "watch" });
  const { report, restored } = rehearseRollback(current, bundle, { rehearsed_at: "2026-08-06T14:00:00Z" });
  assert.equal(report.passed, true); assert.equal(report.current_managed_position_count, 1);
  assert.deepEqual(restored.strategies.map((item) => item.id), ["S1"]);
  assert.equal(current.strategies.length, 2);
  assert.deepEqual(before.orchestration.command_results, restored.orchestration.command_results);
});

test("backup accepts shared plain-data references but rejects actual cycles", () => {
  const shared = { value: 1 };
  assert.doesNotThrow(() => createRollbackBundle({ left: shared, right: shared }));
  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => createRollbackBundle(cyclic), /cycles/);
});
