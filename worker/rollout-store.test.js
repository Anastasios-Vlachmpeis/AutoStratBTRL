import assert from "node:assert/strict";
import test from "node:test";
import { hashCanonical } from "./dsl.js";
import { createRollbackBundle, rehearseRollback } from "./rollback.js";
import { advanceRolloutPhase, emptyRolloutState, recordDomainCutover, recordRolloutEvidence } from "./rollout.js";
import { RolloutStore } from "./rollout-store.js";
import { NORMALIZED_WORKSPACE_TABLES } from "./normalized-store.js";

class MockDb {
  constructor() { this.statements = []; this.batches = []; }
  prepare(sql) { return { bind: (...values) => ({ sql, values, run: async () => { this.statements.push({ sql, values }); } }) }; }
  async batch(statements) { this.batches.push(statements); }
}

const foundation = { bindings: true, schemas: true, interfaces: true, correlation_ids: true,
  feature_flags: true, safe_defaults: true };

test("rollout snapshots batch immutable evidence before phase state", async () => {
  const state = {};
  recordRolloutEvidence(state, { phase: "A", gate: "foundations", status: "passed",
    artifact_hash: hashCanonical(foundation), observed_at: "2026-08-06T12:00:00Z", details: foundation });
  advanceRolloutPhase(state, { expected_phase: "A", actor: "operator:test",
    idempotency_key: "persist:A:123456", at: "2026-08-06T13:00:00Z" });
  const db = new MockDb(), output = await new RolloutStore(db).persistRollout("workspace-test", state, "2026-08-06T14:00:00Z");
  assert.equal(db.batches.length, 1); assert.equal(db.batches[0].length, 3);
  assert.match(db.batches[0][0].sql, /rollout_gate_evidence/);
  assert.match(db.batches[0][1].sql, /rollout_transitions/);
  assert.match(db.batches[0][2].sql, /rollout_phase_state/);
  assert.match(output.state_hash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(db.batches).includes("feature_flags"), false);
});

test("backup and rehearsal persistence store hashes and R2 references but no snapshot", async () => {
  const source = { strategies: [{ id: "S1" }], orchestration: { command_results: {} } };
  const bundle = createRollbackBundle(source, { workspace_id: "workspace-test", created_at: "2026-08-06T12:00:00Z" });
  const { report } = rehearseRollback(source, bundle, { rehearsed_at: "2026-08-06T13:00:00Z" });
  const db = new MockDb(), store = new RolloutStore(db);
  await store.persistBackupManifest("workspace-test", bundle, "workspaces/hash/rollbacks/bundle.json");
  await store.persistRehearsal("workspace-test", report);
  assert.equal(db.statements.length, 2);
  assert.equal(JSON.stringify(db.statements).includes("snapshot"), false);
  assert.match(db.statements[0].sql, /rollback_backup_manifests/);
  assert.match(db.statements[1].sql, /rollback_rehearsals/);
});

test("workspace reset allowlist covers every Plan 14 rollout table", () => {
  const tables = new Set(NORMALIZED_WORKSPACE_TABLES.map(([table]) => table));
  for (const table of ["rollout_phase_state", "rollout_gate_evidence", "rollout_transitions",
    "rollback_backup_manifests", "rollback_rehearsals", "rollout_domain_cutovers"]) assert.equal(tables.has(table), true);
});

test("domain authority changes persist independently", async () => {
  const state = { rollout: { ...emptyRolloutState(), phase: "E" } };
  recordDomainCutover(state, { domain: "market_data", expected_write: "legacy", expected_read: "legacy",
    target_write: "dual_write", target_read: "legacy", parity_hash: hashCanonical({ parity: 1 }), actor: "operator:test" });
  const db = new MockDb(); await new RolloutStore(db).persistRollout("workspace-test", state);
  assert.equal(db.batches[0].some((statement) => /rollout_domain_cutovers/.test(statement.sql)), true);
});

test("long rollout history is persisted in bounded D1 batches", async () => {
  const state = {};
  for (let index = 0; index < 60; index += 1) recordRolloutEvidence(state, { phase: "A", gate: "foundations",
    status: index === 59 ? "passed" : "failed", artifact_hash: hashCanonical({ index }),
    observed_at: `2026-08-06T12:${String(index).padStart(2, "0")}:00Z`, details: { ...foundation, index } });
  const db = new MockDb(), result = await new RolloutStore(db).persistRollout("workspace-test", state);
  assert.equal(result.statement_count, 61); assert.equal(result.batch_count, 2);
  assert.equal(db.batches.every((batch) => batch.length <= 50), true);
});
