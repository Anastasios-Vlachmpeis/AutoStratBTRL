import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTROL_PLANE_WORKSPACE,
  PrivateArtifactRepository,
  controlPlaneBindings,
  controlPlaneMode,
  createControlPlaneRuntime,
  redactPrivateBars,
} from "./control-plane.js";

class MemoryStorage {
  constructor() {
    this.values = new Map();
  }

  async get(key) { return this.values.get(key); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async list({ prefix }) { return new Map([...this.values].filter(([key]) => key.startsWith(prefix))); }
  async delete(keys) { (Array.isArray(keys) ? keys : [keys]).forEach((key) => this.values.delete(key)); }
}

class MemoryD1 {
  constructor() {
    this.checkpoints = new Map();
    this.artifacts = new Map();
    this.receipts = new Map();
  }

  prepare(sql) {
    const database = this;
    let args = [];
    return {
      bind(...values) { args = values; return this; },
      async run() {
        if (sql.includes("INSERT INTO architecture_state_checkpoints")) {
          database.checkpoints.set(`${args[0]}:${args[1]}`, { state_hash: args[2] });
        } else if (sql.includes("INSERT INTO architecture_artifact_mirrors")) {
          database.artifacts.set(`${args[0]}:${args[1]}:${args[2]}`, { object_key: args[3], content_hash: args[4] });
        } else if (sql.includes("DELETE FROM architecture_artifact_mirrors")) {
          for (const key of database.artifacts.keys()) if (key.startsWith(`${args[0]}:`)) database.artifacts.delete(key);
        }
        return { success: true };
      },
      async first() {
        if (sql.includes("SELECT 1 AS ok")) return { ok: 1 };
        return null;
      },
    };
  }
}

class MemoryR2 {
  constructor() { this.objects = new Map(); }
  async put(key, value, options) { this.objects.set(key, { value, options }); }
  async list({ prefix }) {
    return { objects: [...this.objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })), truncated: false };
  }
  async delete(keys) { (Array.isArray(keys) ? keys : [keys]).forEach((key) => this.objects.delete(key)); }
}

test("legacy control plane keeps the Durable Object authoritative", async () => {
  const storage = new MemoryStorage();
  const runtime = createControlPlaneRuntime(storage, {});
  const state = { schemaVersion: 5, strategies: [], events: [] };
  assert.equal(controlPlaneMode({ CONTROL_PLANE_MODE: "unknown" }), "legacy");
  assert.deepEqual(controlPlaneBindings({}), { d1: false, r2: false, queue: false });
  assert.equal((await runtime.saveState(state)).status, "disabled");
  assert.deepEqual(await runtime.loadState(), state);
  assert.equal((await runtime.health(true)).authority, "durable_object");
});

test("dual-write checkpoints D1 and queues an idempotent verification", async () => {
  const storage = new MemoryStorage();
  const database = new MemoryD1();
  const bucket = new MemoryR2();
  const messages = [];
  const runtime = createControlPlaneRuntime(storage, {
    CONTROL_PLANE_MODE: "dual_write",
    AXIOM_DB: database,
    AXIOM_ARTIFACTS: bucket,
    AXIOM_JOBS: { async send(body) { messages.push(body); } },
  });
  const result = await runtime.saveState({ schemaVersion: 5, strategies: [{ id: "AX-1" }], events: [] });
  assert.equal(result.status, "ok");
  assert.equal(database.checkpoints.size, 1);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, "architecture.verify-checkpoint.v1");
  const health = await runtime.health(true);
  assert.equal(health.ready, true);
  assert.deepEqual(health.bindings, { d1: true, r2: true, queue: true });
  assert.equal(health.normalized_cutover_available, false);
});

test("artifact dual-write redacts embedded bars and mirrors private JSON to R2", async () => {
  const storage = new MemoryStorage();
  const database = new MemoryD1();
  const bucket = new MemoryR2();
  const repository = new PrivateArtifactRepository(storage, {
    CONTROL_PLANE_MODE: "dual_write", AXIOM_DB: database, AXIOM_ARTIFACTS: bucket,
  });
  await repository.putArtifact("artifact-1", {
    strategy_id: "AX-1", result: { bars: [{ c: 100 }], metrics: { sharpe: 1.2 } }, holdout_bars: [{ c: 101 }],
  }, { phase: "holdout" });
  const stored = await repository.getArtifact("artifact-1");
  assert.deepEqual(stored, { strategy_id: "AX-1", result: { metrics: { sharpe: 1.2 } } });
  assert.equal(bucket.objects.size, 1);
  assert.equal(database.artifacts.size, 1);
  const mirrored = JSON.parse([...bucket.objects.values()][0].value);
  assert.deepEqual(mirrored, stored);
});

test("a missing mirror binding degrades without losing primary state", async () => {
  const storage = new MemoryStorage();
  const runtime = createControlPlaneRuntime(storage, { CONTROL_PLANE_MODE: "dual_write" });
  const state = { schemaVersion: 5, strategies: [], events: [] };
  const checkpoint = await runtime.saveState(state);
  assert.equal(checkpoint.status, "degraded");
  assert.deepEqual(await runtime.loadState(), state);
  const artifact = await runtime.artifacts.putArtifact("safe", { result: { raw_bars: [1], ok: true } });
  assert.equal(artifact.mirror.status, "degraded");
  assert.deepEqual(await runtime.artifacts.getArtifact("safe"), { result: { ok: true } });
});

test("private cleanup removes Durable Object and mirrored R2 objects", async () => {
  const storage = new MemoryStorage();
  const database = new MemoryD1();
  const bucket = new MemoryR2();
  const repository = new PrivateArtifactRepository(storage, {
    CONTROL_PLANE_MODE: "dual_write", AXIOM_DB: database, AXIOM_ARTIFACTS: bucket,
  }, CONTROL_PLANE_WORKSPACE);
  await repository.putDatasetSlice("dataset-1", "development", [{ t: "2026-01-01T00:00:00Z" }]);
  await repository.putArtifact("artifact-1", { ok: true });
  await repository.putResearchTrial("COH-1", "TR-1", { proposal: { dna: { safe: true } }, holdout_bars: [1] });
  assert.deepEqual(await repository.getResearchTrial("COH-1", "TR-1"), { proposal: { dna: { safe: true } } });
  await repository.clear();
  assert.equal((await storage.list({ prefix: "bt:" })).size, 0);
  assert.equal((await storage.list({ prefix: "research:" })).size, 0);
  assert.equal(bucket.objects.size, 0);
  assert.equal(database.artifacts.size, 0);
});

test("generic artifact retrieval refuses sealed holdout objects even to authenticated admin routes", async () => {
  const repository = new PrivateArtifactRepository(new MemoryStorage(), {});
  repository.contentStore = { async get() { return { manifest: { artifact_kind: "dataset.holdout.raw",
    visibility: "sealed_holdout" }, bytes: new TextEncoder().encode(JSON.stringify([{ secret: "bar" }])) }; } };
  assert.equal(await repository.getArtifact("art-sealed"), undefined);
});

test("failed mirror cleanup preserves authoritative Durable Object evidence", async () => {
  const storage = new MemoryStorage();
  await storage.put("bt:artifact:artifact-1", { ok: true });
  const repository = new PrivateArtifactRepository(storage, {
    CONTROL_PLANE_MODE: "dual_write",
    AXIOM_ARTIFACTS: { async list() { throw new Error("R2 unavailable"); } },
  });
  await assert.rejects(repository.clear(), /R2 unavailable/);
  assert.deepEqual(await storage.get("bt:artifact:artifact-1"), { ok: true });
});

test("bar redaction is recursive and leaves its input untouched", () => {
  const source = { bars: [1], nested: { development_bars: [2], safe: [3] } };
  assert.deepEqual(redactPrivateBars(source), { nested: { safe: [3] } });
  assert.deepEqual(source.bars, [1]);
});

test("normalized migration is deterministic, resumable, persists domains, and completes only after parity", async () => {
  const runtime = createControlPlaneRuntime(new MemoryStorage(), {});
  const calls = { manifests: [], steps: [], exports: [] };
  runtime.normalized = {
    async recordMigrationManifest(value) { calls.manifests.push(structuredClone(value));
      return { migrationManifestId: value.migrationManifestId, manifestHash: value.manifestHash }; },
    async recordMigrationStep(value) { calls.steps.push(structuredClone(value)); return { stepId: value.stepKind }; },
    async persistExport(value) { calls.exports.push(structuredClone(value)); return { readModelId: "read-1" }; },
  };
  const state = { schemaVersion: 5, strategies: [{ id: "AX-1", name: "One", state: "generated" }],
    events: [{ id: "event-1", type: "GENERATED" }], research: { cohorts: [], trials: {} } };
  const first = await runtime.mirrorNormalizedState(state);
  const second = await runtime.mirrorNormalizedState(state);
  assert.equal(first.status, "matched"); assert.equal(second.migration_manifest_id, first.migration_manifest_id);
  assert.equal(calls.manifests.filter((item) => item.status === "complete").length, 2);
  assert.equal(calls.steps.length, 12); assert.equal(calls.exports.length, 2);
  assert.equal(calls.exports[0].strategies[0].strategyId, "AX-1");
  assert.equal(calls.exports[0].lineages[0].childStrategyId, "AX-1");
  assert.equal(calls.exports[0].auditEvents[0].subjectId, "event-1");

  const blocked = await runtime.mirrorNormalizedState({ ...state,
    strategies: [{ ...state.strategies[0], dataset_id: "missing-dataset" }] });
  assert.equal(blocked.status, "degraded");
  assert.match(blocked.error, /references are invalid/);
  assert.equal(calls.manifests.at(-1).status, "failed");
  assert.equal(calls.exports.length, 2, "invalid references must not persist or complete a cutover candidate");
});
