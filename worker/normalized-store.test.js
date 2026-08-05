import assert from "node:assert/strict";
import test from "node:test";
import { NormalizedStore, NORMALIZED_WORKSPACE_TABLES } from "./normalized-store.js";

class MemoryD1 {
  constructor() { this.calls = []; this.readModel = null; this.counts = { strategies: 0, incidents: 0, artifacts: 0 }; this.migrationStatus = null; this.resetRows = new Map(); }
  prepare(sql) {
    const db = this; let args = [];
    const statement = {
      sql, bind(...values) { args = values; this.args = values; return this; },
      async run() {
        db.calls.push({ sql, args });
        if (sql.includes("INSERT INTO normalized_read_models")) db.readModel = {
          read_model_id: args[1], source_checkpoint_hash: args[2], schema_version: args[3], response_json: args[4],
          response_hash: args[5], comparison_status: args[6], comparison_artifact_id: null, created_at: args[7],
        };
        if (sql.includes("INSERT INTO workspace_migration_manifests")) db.migrationStatus = args[8];
        return { meta: { changes: 1 } };
      },
      async first() {
        if (sql.includes("FROM normalized_read_models")) return db.readModel;
        if (sql.includes("COUNT(*) AS count FROM strategies")) return { count: db.counts.strategies };
        if (sql.includes("COUNT(*) AS count FROM incidents")) return { count: db.counts.incidents };
        if (sql.includes("COUNT(*) AS count FROM artifact_manifests")) return { count: db.counts.artifacts };
        if (sql.includes("FROM workspace_migration_manifests")) return db.migrationStatus ? { status: db.migrationStatus } : null;
        return null;
      },
      async all() {
        db.calls.push({ sql, args });
        const match = sql.match(/^SELECT (.+) FROM ([a-z_]+) WHERE workspace_id=\?$/);
        return { results: match ? (db.resetRows.get(match[2]) ?? []) : [] };
      },
      async _run() { return this.run(); },
    };
    return statement;
  }
  async batch(statements) { return Promise.all(statements.map((statement) => statement._run())); }
}

const clock = () => new Date("2026-08-05T12:00:00.000Z");
const hash = (char) => char.repeat(64);

const exported = () => ({
  workspace: { workspaceId: "workspace-1", displayName: "Axiom", environment: "development" },
  schemaVersion: 8,
  sourceCheckpointHash: hash("a"),
  comparisonStatus: "matched",
  compilerVersions: [{ compilerVersionId: "compiler-1", implementationHash: hash("b") }],
  supervisorPolicyVersions: [{ policyVersionId: "policy-1", policyHash: hash("c"), policy: { release: true } }],
  universeVersions: [{ universeVersionId: "universe-1", symbolsObjectKey: "universe/u1.json", symbolsHash: hash("d"), symbolCount: 1 }],
  calendarVersions: [{ calendarVersionId: "calendar-1", firstSession: "2026-01-01", lastSession: "2026-08-05", objectKey: "cal/c1.json", contentHash: hash("e") }],
  strategies: [{ strategyId: "strategy-1", name: "First", qualityState: "development" }],
  strategyDna: [{ dnaId: "dna-1", strategyId: "strategy-1", compilerVersionId: "compiler-1", dnaHash: hash("f"), dna: { signal: "close > sma" } }],
  lineages: [{ lineageId: "lineage-1", childStrategyId: "strategy-1" }],
  cohorts: [{ cohortId: "cohort-1", universeVersionId: "universe-1", policyVersionId: "policy-1", generationSeed: "seed", requestedTrials: 1 }],
  datasets: [{ datasetId: "dataset-1", datasetRootHash: hash("1"), universeVersionId: "universe-1", calendarVersionId: "calendar-1", rangeStart: "2026-01-01", rangeEnd: "2026-08-05", manifestObjectKey: "datasets/d1.json", manifestHash: hash("2") }],
  datasetSlices: [{ datasetSliceId: "slice-1", datasetId: "dataset-1", rangeStart: "2026-01-01", rangeEnd: "2026-06-01", sliceHash: hash("3"), manifestObjectKey: "datasets/s1.json" }],
  trials: [{ trialId: "trial-1", cohortId: "cohort-1", strategyId: "strategy-1", dnaId: "dna-1", datasetSliceId: "slice-1", trialSeed: "trial-seed" }],
  lifecycleTransitions: [{ strategyId: "strategy-1", sequence: 1, toState: "development" }],
  auditEvents: [{ action: "migration.import", subjectKind: "strategy", subjectId: "strategy-1" }],
  readModel: { strategies: [{ id: "strategy-1" }], version: 8 },
});

test("export writes dependency-ordered normalized domains and a deterministic read model last", async () => {
  const db = new MemoryD1(), store = new NormalizedStore(db, { clock, batchSize: 3 });
  const first = await store.persistExport(exported());
  const second = await store.persistExport(exported());
  assert.equal(first.readModelId, second.readModelId);
  assert.equal(first.responseHash, second.responseHash);
  const inserts = db.calls.map((call) => call.sql.match(/INSERT INTO ([a-z_]+)/)?.[1]).filter(Boolean);
  assert.ok(inserts.includes("strategies")); assert.ok(inserts.includes("strategy_dna")); assert.ok(inserts.includes("lifecycle_transitions"));
  assert.equal(inserts.at(-1), "normalized_read_models");
  assert.deepEqual((await store.loadLatestReadModel("workspace-1")).response, exported().readModel);
});

test("live dual-write projection mirrors strategy state and frontend response", async () => {
  const db = new MemoryD1(), store = new NormalizedStore(db, { clock });
  const input = { workspaceId: "workspace-1", stateHash: hash("s"), schemaVersion: 11,
    strategies: [{ id: "s1", name: "One", archetype: "trend", generation: 1,
      lifecycle: { quality: { state: "development" }, operational: { state: "ready" } } }],
    readModel: { summary: { generated: 1 }, strategies: [{ id: "s1" }] }, comparisonStatus: "matched" };
  const first = await store.persistSnapshotProjection(input);
  const second = await store.persistSnapshotProjection(input);
  assert.equal(first.readModelId, second.readModelId);
  assert.equal((await store.loadLatestReadModel("workspace-1")).response.strategies[0].id, "s1");
  assert.ok(db.calls.some((call) => call.sql.includes("INSERT INTO strategies")));
});

test("read model corruption is rejected and cutover health reports every blocker", async () => {
  const db = new MemoryD1(), store = new NormalizedStore(db, { clock });
  await store.persistExport(exported());
  db.readModel.response_json = JSON.stringify({ altered: true });
  await assert.rejects(store.loadLatestReadModel("workspace-1"), /hash mismatch/);
  await store.persistExport(exported()); db.counts = { strategies: 1, incidents: 1, artifacts: 2 }; db.migrationStatus = "verifying";
  const unhealthy = await store.checkCutoverHealth("workspace-1", { minimumStrategies: 2, sourceCheckpointHash: hash("9") });
  assert.equal(unhealthy.ready, false);
  assert.deepEqual(unhealthy.reasons.sort(), ["artifacts_unverified", "checkpoint_mismatch", "critical_incidents_open", "migration_incomplete", "strategy_count_below_minimum"].sort());
  db.counts = { strategies: 2, incidents: 0, artifacts: 0 }; db.migrationStatus = "complete";
  assert.equal((await store.checkCutoverHealth("workspace-1", { minimumStrategies: 2, sourceCheckpointHash: hash("a") })).ready, true);
});

test("migration bookkeeping and quota incidents use deterministic identities", async () => {
  const db = new MemoryD1(), store = new NormalizedStore(db, { clock });
  const manifest = { workspaceId: "workspace-1", sourceSchemaVersion: 5, targetSchemaVersion: 8, sourceExportObjectKey: "exports/v5.json", sourceExportHash: hash("a"), manifestObjectKey: "migration/m1.json", counts: { strategies: 1 } };
  assert.deepEqual(await store.recordMigrationManifest(manifest), await store.recordMigrationManifest(manifest));
  const step = { workspaceId: "workspace-1", migrationManifestId: (await store.recordMigrationManifest(manifest)).migrationManifestId, stepKind: "strategies", input: { count: 1 }, status: "complete" };
  assert.deepEqual(await store.recordMigrationStep(step), await store.recordMigrationStep(step));
  const first = await store.recordQuotaPressure({ workspaceId: "workspace-1", usedBytes: 95, quotaBytes: 100 });
  const retry = await store.recordQuotaPressure({ workspaceId: "workspace-1", usedBytes: 96, quotaBytes: 100 });
  assert.equal(first.incidentId, retry.incidentId); assert.equal(first.researchPaused, true);
  await store.recordAuditEvent({ workspaceId: "workspace-1", actor: "admin", action: "artifact.read",
    subjectKind: "backtest_artifact", subjectId: "art-1", requestId: "ray-1" });
  assert.ok(db.calls.some((call) => call.sql.includes("INSERT INTO audit_events")
    && call.args.includes("artifact.read") && call.args.includes("art-1")));
});

test("reset enumeration is workspace-bound, deterministic and covers the exact allowlist", async () => {
  const db = new MemoryD1(), store = new NormalizedStore(db, { clock });
  db.resetRows.set("strategies", [{ strategy_id: "s1" }, { strategy_id: "s2" }]);
  db.resetRows.set("audit_events", [{ audit_event_id: "a1" }]);
  db.resetRows.set("workspaces", [{ workspace_id: "workspace-1" }]);
  const first = await store.enumerateWorkspaceResetTargets("workspace-1");
  const second = await store.enumerateWorkspaceResetTargets("workspace-1");
  assert.deepEqual(first, second); assert.equal(first.length, 3);
  assert.ok(first.every((target) => target.storageKind === "d1" && target.targetLocator.includes('"table"')));
  const selectedTables = db.calls.filter((call) => call.sql.startsWith("SELECT ")).map((call) => call.sql.match(/FROM ([a-z_]+)/)?.[1]).filter(Boolean);
  const resetTables = NORMALIZED_WORKSPACE_TABLES.map(([table]) => table)
    .filter((table) => !["workspace_reset_targets", "workspace_reset_manifests", "workspaces"].includes(table));
  assert.deepEqual(new Set(selectedTables), new Set(resetTables));
  assert.equal(new Set(NORMALIZED_WORKSPACE_TABLES.map(([table]) => table)).size, NORMALIZED_WORKSPACE_TABLES.length);
  const prepared = await store.prepareWorkspaceReset({ workspaceId: "workspace-1", requestedBy: "operator:admin", manifestObjectKey: "reset/r1.json" });
  assert.equal(prepared.targets.length, 3); assert.match(prepared.manifestHash, /^[a-f0-9]{64}$/);
  const supplied = await store.prepareWorkspaceReset({ workspaceId: "workspace-1", requestedBy: "operator:admin",
    manifestObjectKey: "reset/r2.json", manifestHash: hash("9") });
  assert.equal(supplied.manifestHash, hash("9"));
});
