import assert from "node:assert/strict";
import test from "node:test";
import { ArtifactStore, ARTIFACT_KINDS } from "./artifact-store.js";

class MemoryD1 {
  constructor() { this.manifests = new Map(); }
  prepare(sql) {
    const db = this; let args = [];
    return {
      bind(...values) { args = values; return this; },
      async first() {
        if (sql.includes("SUM(byte_length)")) {
          const rows = [...db.manifests.values()].filter((row) => row.workspace_id === args[0]);
          return { used_bytes: rows.reduce((sum, row) => sum + row.byte_length, 0), artifact_count: rows.length };
        }
        if (sql.includes("artifact_id=?")) return db.manifests.get(args[1])?.workspace_id === args[0] ? db.manifests.get(args[1]) : null;
        if (sql.includes("object_key=?")) return [...db.manifests.values()].find((row) => row.workspace_id === args[0] && row.object_key === args[1]) ?? null;
        return null;
      },
      async all() {
        return { results: [...db.manifests.values()].filter((row) => row.workspace_id === args[0]).sort((a, b) => a.artifact_id.localeCompare(b.artifact_id)) };
      },
      async run() {
        if (sql.includes("DELETE FROM artifact_manifests")) {
          for (const [id, row] of db.manifests) if (row.workspace_id === args[0]) db.manifests.delete(id);
          return { meta: { changes: 1 } };
        }
        if (!sql.includes("INSERT INTO artifact_manifests")) return { meta: { changes: 0 } };
        if (db.manifests.has(args[0])) return { meta: { changes: 0 } };
        const names = ["artifact_id", "workspace_id", "workspace_hash", "artifact_kind", "object_key", "content_hash", "byte_length", "media_type", "visibility", "metadata_json", "manifest_hash", "verified_at", "created_at"];
        db.manifests.set(args[0], Object.fromEntries(names.map((name, index) => [name, args[index]])));
        return { meta: { changes: 1 } };
      },
    };
  }
}

class MemoryR2Object {
  constructor(value, customMetadata = {}) { this.value = new Uint8Array(value); this.customMetadata = { ...customMetadata }; }
  async arrayBuffer() { return this.value.slice().buffer; }
}
class MemoryR2 {
  constructor() { this.objects = new Map(); this.puts = 0; this.deletes = 0; }
  async put(key, value, options = {}) { this.puts += 1; this.objects.set(key, new MemoryR2Object(value, options.customMetadata)); }
  async get(key) { return this.objects.get(key) ?? null; }
  async delete(keys) { this.deletes += 1; for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key); }
}

const clock = () => new Date("2026-08-05T12:00:00.000Z");
const makeStore = () => { const db = new MemoryD1(), r2 = new MemoryR2(); return { db, r2, store: new ArtifactStore(db, r2, { clock }) }; };

test("writes immutable content-addressed objects under opaque workspace-scoped keys", async () => {
  const { db, r2, store } = makeStore();
  const first = await store.put({ workspaceId: "secret-workspace-name", kind: "curve", content: "curve-bytes", mediaType: "text/csv", metadata: { strategy: "s1" } });
  assert.match(first.artifact_id, /^art-[a-f0-9]{64}$/);
  assert.match(first.object_key, /^workspaces\/[a-f0-9]{64}\/artifacts\/curve\/[a-f0-9]{64}$/);
  assert.equal(first.object_key.includes("secret-workspace-name"), false);
  assert.equal(db.manifests.size, 1); assert.equal(r2.puts, 1);
  const read = await store.get({ workspaceId: "secret-workspace-name", artifactId: first.artifact_id });
  assert.equal(new TextDecoder().decode(read.bytes), "curve-bytes");
  const retry = await store.put({ workspaceId: "secret-workspace-name", kind: "curve", content: "curve-bytes", mediaType: "text/csv", metadata: { strategy: "s1" } });
  assert.equal(retry.idempotent, true); assert.equal(r2.puts, 1);
  await assert.rejects(store.put({ workspaceId: "secret-workspace-name", kind: "curve", content: "curve-bytes", metadata: { changed: true } }), /immutable/);
});

test("typed metadata lookup returns only a manifested matching artifact", async () => {
  const { store } = makeStore();
  await store.put({ workspaceId: "w", kind: "dataset.development.raw", content: { SPY: [1] }, metadata: { dataset_id: "d1", phase: "development" } });
  assert.ok(await store.findLatest({ workspaceId: "w", kind: "dataset.development.raw", metadata: { dataset_id: "d1", phase: "development" } }));
  assert.equal(await store.findLatest({ workspaceId: "w", kind: "dataset.development.raw", metadata: { dataset_id: "other" } }), null);
});

test("validates artifact kinds and the caller's expected SHA-256 before writing", async () => {
  const { db, r2, store } = makeStore();
  assert.ok(ARTIFACT_KINDS.includes("dataset.holdout.raw"));
  await assert.rejects(store.put({ workspaceId: "w", kind: "made.up", content: "x" }), /unsupported/);
  await assert.rejects(store.put({ workspaceId: "w", kind: "report", content: "x", expectedHash: "0".repeat(64) }), /SHA-256 mismatch/);
  await assert.rejects(store.put({ workspaceId: "w", kind: "dataset.holdout.raw", content: "x", visibility: "private" }), /sealed_holdout/);
  assert.equal(db.manifests.size, 0); assert.equal(r2.objects.size, 0);
});

test("reads reject corrupt bytes, corrupt object metadata and tampered D1 manifests", async () => {
  const { db, r2, store } = makeStore();
  const first = await store.put({ workspaceId: "w", kind: "backtest.result", content: { pnl: 12 } });
  const object = r2.objects.get(first.object_key);
  object.value[0] ^= 0xff;
  await assert.rejects(store.get({ workspaceId: "w", artifactId: first.artifact_id }), /content mismatch/);
  object.value[0] ^= 0xff; object.customMetadata.content_hash = "0".repeat(64);
  await assert.rejects(store.get({ workspaceId: "w", artifactId: first.artifact_id }), /metadata mismatch/);
  object.customMetadata.content_hash = first.content_hash;
  db.manifests.get(first.artifact_id).byte_length += 1;
  await assert.rejects(store.get({ workspaceId: "w", artifactId: first.artifact_id }), /manifest hash mismatch/);
});

test("an R2 orphan cannot be retrieved through the internal key audit path", async () => {
  const { r2, store } = makeStore();
  const fakeKey = `workspaces/${"a".repeat(64)}/artifacts/report/${"b".repeat(64)}`;
  await r2.put(fakeKey, new TextEncoder().encode("orphan"));
  await assert.rejects(store.getByObjectKey({ workspaceId: "w", objectKey: fakeKey }), /orphan artifact object rejected/);
});

test("public projections never expose raw holdout artifacts or object keys", async () => {
  const { store } = makeStore();
  const holdout = await store.put({ workspaceId: "w", kind: "dataset.holdout.raw", content: "sealed bars", visibility: "sealed_holdout", metadata: { raw_key: "secret" } });
  const report = await store.put({ workspaceId: "w", kind: "report", content: "safe", visibility: "public_summary", metadata: { internal: "hidden" } });
  assert.equal(store.publicProjection(holdout), null);
  const projected = store.publicProjection(report);
  assert.equal(projected.artifact_kind, "report");
  assert.equal("object_key" in projected, false); assert.equal("metadata" in projected, false); assert.equal("workspace_id" in projected, false);
});

test("quota pressure pauses optional research without disabling risk operations or deleting evidence", async () => {
  const { r2, store } = makeStore();
  await store.put({ workspaceId: "w", kind: "research.result", content: "1234567890" });
  const high = await store.quotaStatus({ workspaceId: "w", quotaBytes: 11, researchPauseRatio: 0.9 });
  assert.equal(high.pressure, "high"); assert.equal(high.pause_optional_research, true); assert.equal(high.allow_risk_operations, true);
  assert.equal(high.deletion_performed, false); assert.equal(r2.deletes, 0);
  const normal = await store.quotaStatus({ workspaceId: "w", quotaBytes: 100 });
  assert.equal(normal.pressure, "normal"); assert.equal(normal.pause_optional_research, false);
});

test("workspace enumeration and reset manifests are exact, isolated and non-destructive", async () => {
  const { db, r2, store } = makeStore();
  await store.put({ workspaceId: "one", kind: "ledger", content: "one-a" });
  await store.put({ workspaceId: "two", kind: "ledger", content: "two" });
  await store.put({ workspaceId: "one", kind: "replay.bundle", content: "one-b" });
  const listed = await store.enumerateWorkspace("one");
  assert.equal(listed.length, 2); assert.ok(listed.every((item) => item.workspace_id === "one"));
  const reset = await store.buildResetManifest("one");
  assert.equal(reset.artifact_count, 2); assert.equal(reset.object_keys.length, 2); assert.match(reset.reset_manifest_hash, /^[a-f0-9]{64}$/);
  assert.equal(reset.deletion_performed, false); assert.equal(r2.deletes, 0); assert.equal(db.manifests.size, 3);
});

test("an exact prepared reset deletes only that workspace and rejects intervening writes", async () => {
  const { db, r2, store } = makeStore();
  await store.put({ workspaceId: "w1", kind: "report", content: "one" });
  await store.put({ workspaceId: "w2", kind: "report", content: "two" });
  const stale = await store.buildResetManifest("w1");
  await store.put({ workspaceId: "w1", kind: "report", content: "new" });
  await assert.rejects(store.executeReset({ workspaceId: "w1", manifest: stale }), /changed after reset preparation/);
  const exact = await store.buildResetManifest("w1");
  const result = await store.executeReset({ workspaceId: "w1", manifest: exact });
  assert.equal(result.deleted_artifacts, 2);
  assert.equal([...db.manifests.values()].filter((row) => row.workspace_id === "w1").length, 0);
  assert.equal([...db.manifests.values()].filter((row) => row.workspace_id === "w2").length, 1);
  assert.equal(r2.objects.size, 1);
});
