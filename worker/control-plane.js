import { sha256 } from "./backtest.js";
import { ArtifactStore } from "./artifact-store.js";
import { NormalizedStore } from "./normalized-store.js";
import { compareMigrationParity, exportLegacyState, normalizeLegacyExport, rebuildNormalizedReadModel } from "./state-migration.js";

export const CONTROL_PLANE_WORKSPACE = "axiom-global-supervisor";
export const CONTROL_PLANE_MODES = Object.freeze(["legacy", "dual_write"]);

function messageOf(error) {
  return error instanceof Error ? error.message : String(error ?? "Unknown architecture error");
}

export function controlPlaneMode(env = {}) {
  const requested = String(env.CONTROL_PLANE_MODE ?? "legacy").trim().toLowerCase();
  return CONTROL_PLANE_MODES.includes(requested) ? requested : "legacy";
}

export function controlPlaneBindings(env = {}) {
  return {
    d1: Boolean(env.AXIOM_DB),
    r2: Boolean(env.AXIOM_ARTIFACTS),
    queue: Boolean(env.AXIOM_JOBS),
  };
}

export function redactPrivateBars(value) {
  if (Array.isArray(value)) return value.map(redactPrivateBars);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !["bars", "raw_bars", "development_bars", "holdout_bars"].includes(key))
    .map(([key, item]) => [key, redactPrivateBars(item)]));
}

function encoded(value) {
  return encodeURIComponent(String(value)).replaceAll("%", "_");
}

function r2Metadata(metadata = {}) {
  return Object.fromEntries(Object.entries(metadata)
    .filter(([, value]) => value !== undefined && value !== null)
    .slice(0, 12)
    .map(([key, value]) => [String(key).slice(0, 64), String(value).slice(0, 512)]));
}

export class DurableStateRepository {
  constructor(storage) {
    this.storage = storage;
  }

  async load() {
    return this.storage.get("state");
  }

  async save(state) {
    await this.storage.put("state", state);
  }
}

export class PrivateArtifactRepository {
  constructor(storage, env = {}, workspace = CONTROL_PLANE_WORKSPACE) {
    this.storage = storage;
    this.env = env;
    this.workspace = workspace;
    this.mode = controlPlaneMode(env);
    this.contentStore = String(env.NORMALIZED_STORAGE_ENABLED ?? "false").toLowerCase() === "true"
      && env.AXIOM_DB && env.AXIOM_ARTIFACTS ? new ArtifactStore(env.AXIOM_DB, env.AXIOM_ARTIFACTS) : null;
    this.lastMirror = { status: this.mode === "legacy" ? "disabled" : "not_started" };
  }

  artifactStorageKey(id) {
    return `bt:artifact:${id}`;
  }

  datasetStorageKey(datasetId, phase) {
    return `bt:dataset:${datasetId}:${phase}`;
  }

  researchTrialStorageKey(cohortId, trialId) {
    return `research:trial:${cohortId}:${trialId}`;
  }

  r2Key(kind, id) {
    return `workspaces/${encoded(this.workspace)}/private/${kind}/${encoded(id)}.json`;
  }

  async mirror(kind, id, value, metadata = {}) {
    if (this.mode !== "dual_write") return { status: "disabled" };
    if (!this.env.AXIOM_ARTIFACTS) return { status: "degraded", error: "AXIOM_ARTIFACTS binding is missing" };
    const objectKey = this.r2Key(kind, id);
    const body = JSON.stringify(value);
    const contentHash = await sha256(value);
    try {
      await this.env.AXIOM_ARTIFACTS.put(objectKey, body, {
        httpMetadata: { contentType: "application/json" },
        customMetadata: r2Metadata({ kind, content_hash: contentHash, ...metadata }),
      });
      if (this.env.AXIOM_DB) {
        await this.env.AXIOM_DB.prepare(`
          INSERT INTO architecture_artifact_mirrors
            (workspace_id, object_id, object_kind, object_key, content_hash, byte_length, mirrored_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(workspace_id, object_id, object_kind) DO UPDATE SET
            object_key = excluded.object_key,
            content_hash = excluded.content_hash,
            byte_length = excluded.byte_length,
            mirrored_at = excluded.mirrored_at
        `).bind(this.workspace, String(id), kind, objectKey, contentHash, new TextEncoder().encode(body).byteLength,
          new Date().toISOString()).run();
      }
      this.lastMirror = { status: "ok", object_key: objectKey, content_hash: contentHash };
    } catch (error) {
      this.lastMirror = { status: "degraded", error: messageOf(error) };
      console.warn("Control-plane artifact mirror failed", { kind, id, error: this.lastMirror.error });
    }
    return this.lastMirror;
  }

  async putArtifact(id, value, metadata = {}) {
    const safe = redactPrivateBars(value);
    if (this.contentStore) {
      await this.ensureWorkspace();
      const manifest = await this.contentStore.put({ workspaceId: this.workspace, kind: "backtest.result",
        content: safe, visibility: "private", mediaType: "application/json", metadata: { legacy_id: id, ...metadata } });
      return { value: safe, mirror: { status: "ok", object_key: manifest.object_key,
        content_hash: manifest.content_hash, artifact_id: manifest.artifact_id } };
    }
    await this.storage.put(this.artifactStorageKey(id), safe);
    const mirror = await this.mirror("artifacts", id, safe, metadata);
    return { value: safe, mirror };
  }

  async getArtifact(id) {
    const local = await this.storage.get(this.artifactStorageKey(id));
    if (local || !this.contentStore) return local;
    const found = id.startsWith("art-")
      ? await this.contentStore.get({ workspaceId: this.workspace, artifactId: id })
      : await this.contentStore.findLatest({ workspaceId: this.workspace, kind: "backtest.result", metadata: { legacy_id: id } });
    return found ? JSON.parse(new TextDecoder().decode(found.bytes)) : undefined;
  }

  async putDatasetSlice(datasetId, phase, bars, metadata = {}) {
    if (this.contentStore) {
      await this.ensureWorkspace();
      const kind = phase === "holdout" ? "dataset.holdout.raw" : "dataset.development.raw";
      const manifest = await this.contentStore.put({ workspaceId: this.workspace, kind, content: bars,
        visibility: phase === "holdout" ? "sealed_holdout" : "private", mediaType: "application/json",
        metadata: { dataset_id: datasetId, phase, ...metadata } });
      return { status: "ok", object_key: manifest.object_key, content_hash: manifest.content_hash,
        artifact_id: manifest.artifact_id };
    }
    await this.storage.put(this.datasetStorageKey(datasetId, phase), bars);
    return this.mirror("datasets", `${datasetId}-${phase}`, bars, { dataset_id: datasetId, phase, ...metadata });
  }

  async getDatasetSlice(datasetId, phase) {
    const local = await this.storage.get(this.datasetStorageKey(datasetId, phase));
    if (local || !this.contentStore) return local;
    const kind = phase === "holdout" ? "dataset.holdout.raw" : "dataset.development.raw";
    const found = await this.contentStore.findLatest({ workspaceId: this.workspace, kind,
      metadata: { dataset_id: datasetId, phase } });
    if (!found) return undefined;
    if (phase === "holdout") await this.recordHoldoutAccess(found.manifest, "backtest_validation");
    return JSON.parse(new TextDecoder().decode(found.bytes));
  }

  async putResearchTrial(cohortId, trialId, value, metadata = {}) {
    const safe = redactPrivateBars(value);
    if (this.contentStore) {
      await this.ensureWorkspace();
      const manifest = await this.contentStore.put({ workspaceId: this.workspace, kind: "research.result",
        content: safe, visibility: "private", mediaType: "application/json",
        metadata: { cohort_id: cohortId, trial_id: trialId, ...metadata } });
      return { value: safe, mirror: { status: "ok", object_key: manifest.object_key,
        content_hash: manifest.content_hash, artifact_id: manifest.artifact_id } };
    }
    await this.storage.put(this.researchTrialStorageKey(cohortId, trialId), safe);
    const mirror = await this.mirror("research-trials", `${cohortId}-${trialId}`, safe,
      { cohort_id: cohortId, trial_id: trialId, ...metadata });
    return { value: safe, mirror };
  }

  async getResearchTrial(cohortId, trialId) {
    const local = await this.storage.get(this.researchTrialStorageKey(cohortId, trialId));
    if (local || !this.contentStore) return local;
    const found = await this.contentStore.findLatest({ workspaceId: this.workspace, kind: "research.result",
      metadata: { cohort_id: cohortId, trial_id: trialId } });
    return found ? JSON.parse(new TextDecoder().decode(found.bytes)) : undefined;
  }

  async ensureWorkspace() {
    if (!this.env.AXIOM_DB) return;
    const now = new Date().toISOString();
    await this.env.AXIOM_DB.prepare(`INSERT INTO workspaces
      (workspace_id,display_name,environment,status,created_at,updated_at)
      VALUES (?,?,?,'active',?,?) ON CONFLICT(workspace_id) DO UPDATE SET updated_at=excluded.updated_at`)
      .bind(this.workspace, this.workspace, String(this.env.ENVIRONMENT ?? "development"), now, now).run();
  }

  async recordHoldoutAccess(manifest, purpose) {
    if (!this.env.AXIOM_DB) return;
    const requestHash = await sha256({ workspace_id: this.workspace, artifact_id: manifest.artifact_id, purpose });
    await this.env.AXIOM_DB.prepare(`INSERT INTO holdout_access_ledger
      (workspace_id,access_id,dataset_slice_id,artifact_id,strategy_id,purpose,actor,request_hash,decision_id,accessed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,request_hash,actor,purpose) DO NOTHING`).bind(this.workspace,
      `holdout-access-${requestHash.slice(0, 32)}`, manifest.metadata?.dataset_slice_id ?? null,
      manifest.artifact_id, null, purpose, "system", requestHash, null, new Date().toISOString()).run();
  }

  async clear() {
    if (this.mode === "dual_write") {
      const prefix = `workspaces/${encoded(this.workspace)}/private/`;
      if (this.env.AXIOM_ARTIFACTS) {
        let cursor;
        do {
          const page = await this.env.AXIOM_ARTIFACTS.list({ prefix, cursor });
          const objectKeys = (page.objects ?? []).map((item) => item.key);
          if (objectKeys.length) await this.env.AXIOM_ARTIFACTS.delete(objectKeys);
          cursor = page.truncated ? page.cursor : undefined;
        } while (cursor);
      }
      if (this.env.AXIOM_DB) {
        await this.env.AXIOM_DB.prepare("DELETE FROM architecture_artifact_mirrors WHERE workspace_id = ?")
          .bind(this.workspace).run();
      }
    }
    // Keep the authoritative copy intact if mirror cleanup fails. This lets the
    // reset be retried instead of leaving state that references deleted evidence.
    const keys = await this.storage.list({ prefix: "bt:" });
    if (keys.size) await this.storage.delete([...keys.keys()]);
    const researchKeys = await this.storage.list({ prefix: "research:" });
    if (researchKeys.size) await this.storage.delete([...researchKeys.keys()]);
  }
}

export class ControlPlaneRuntime {
  constructor(storage, env = {}, workspace = CONTROL_PLANE_WORKSPACE) {
    this.env = env;
    this.workspace = workspace;
    this.mode = controlPlaneMode(env);
    this.state = new DurableStateRepository(storage);
    this.artifacts = new PrivateArtifactRepository(storage, env, workspace);
    this.normalized = String(env.NORMALIZED_STORAGE_ENABLED ?? "false").toLowerCase() === "true" && env.AXIOM_DB
      ? new NormalizedStore(env.AXIOM_DB) : null;
    this.lastCheckpoint = { status: this.mode === "legacy" ? "disabled" : "not_started" };
  }

  async loadState() {
    return this.state.load();
  }

  async saveState(state) {
    await this.state.save(state);
    this.lastCheckpoint = await this.mirrorCheckpoint(state);
    if (this.normalized && !state.orchestration?.pending_reset) await this.mirrorNormalizedState(state);
    return this.lastCheckpoint;
  }

  async mirrorNormalizedState(state) {
    try {
      const exported = exportLegacyState(state, { workspace_id: this.workspace, exported_at: new Date().toISOString() });
      const normalized = normalizeLegacyExport(exported);
      const readModel = rebuildNormalizedReadModel(normalized);
      const parity = compareMigrationParity(exported, normalized, readModel);
      await this.normalized.persistSnapshotProjection({ workspaceId: this.workspace,
        stateHash: exported.export_hash, schemaVersion: state.schemaVersion ?? 1,
        strategies: state.strategies ?? [], readModel,
        comparisonStatus: parity.cutover_ready ? "matched" : "mismatched",
        environment: String(this.env.ENVIRONMENT ?? "development") });
      this.lastNormalized = { status: parity.cutover_ready ? "matched" : "blocked",
        source_checkpoint_hash: exported.export_hash, issues: parity.integrity.issues.length };
    } catch (error) {
      this.lastNormalized = { status: "degraded", error: messageOf(error) };
      console.warn("Normalized state mirror failed", this.lastNormalized);
    }
    return this.lastNormalized;
  }

  async loadNormalizedReadModel() {
    return this.normalized?.loadLatestReadModel(this.workspace) ?? null;
  }

  async clearCompatibilityMetadata() {
    if (!this.env.AXIOM_DB) return;
    for (const table of ["architecture_queue_receipts", "architecture_artifact_mirrors", "architecture_state_checkpoints"]) {
      await this.env.AXIOM_DB.prepare(`DELETE FROM ${table} WHERE workspace_id=?`).bind(this.workspace).run();
    }
  }

  async compatibilityResetInventory() {
    if (!this.env.AXIOM_DB) return { d1_targets: [], object_keys: [] };
    const targets = [];
    for (const [table, key] of [["architecture_queue_receipts", "receipt_id"],
      ["architecture_artifact_mirrors", "object_id"], ["architecture_state_checkpoints", "checkpoint_id"]]) {
      const result = await this.env.AXIOM_DB.prepare(`SELECT ${key} FROM ${table} WHERE workspace_id=? ORDER BY ${key}`)
        .bind(this.workspace).all();
      targets.push(...(result.results ?? []).map((row) => `${table}:${row[key]}`));
    }
    const objects = await this.env.AXIOM_DB.prepare(`SELECT object_key FROM architecture_artifact_mirrors
      WHERE workspace_id=? ORDER BY object_key`).bind(this.workspace).all();
    return { d1_targets: targets.sort(), object_keys: (objects.results ?? []).map((row) => row.object_key).sort() };
  }

  async mirrorCheckpoint(state) {
    if (this.mode !== "dual_write") return { status: "disabled" };
    if (!this.env.AXIOM_DB) return { status: "degraded", error: "AXIOM_DB binding is missing" };
    const stateHash = await sha256(state);
    const checkpointId = `${state.schemaVersion ?? 0}-${stateHash}`;
    const now = new Date().toISOString();
    try {
      await this.env.AXIOM_DB.prepare(`
        INSERT INTO architecture_state_checkpoints
          (workspace_id, checkpoint_id, state_hash, schema_version, strategy_count, event_count, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, checkpoint_id) DO NOTHING
      `).bind(this.workspace, checkpointId, stateHash, Number(state.schemaVersion ?? 0),
        Number(state.strategies?.length ?? 0), Number(state.events?.length ?? 0), now).run();
      if (this.env.AXIOM_JOBS) {
        await this.env.AXIOM_JOBS.send({
          kind: "architecture.verify-checkpoint.v1",
          workspace_id: this.workspace,
          checkpoint_id: checkpointId,
          state_hash: stateHash,
        }, { contentType: "json" });
      }
      return { status: "ok", checkpoint_id: checkpointId, state_hash: stateHash };
    } catch (error) {
      const result = { status: "degraded", error: messageOf(error) };
      console.warn("Control-plane checkpoint mirror failed", result);
      return result;
    }
  }

  async health(probe = false) {
    const bindings = controlPlaneBindings(this.env);
    let d1Probe = this.mode === "legacy" ? "not_required" : bindings.d1 ? "configured" : "missing";
    if (probe && bindings.d1) {
      try {
        await this.env.AXIOM_DB.prepare("SELECT 1 AS ok").first();
        d1Probe = "ok";
      } catch (error) {
        d1Probe = `error: ${messageOf(error)}`;
      }
    }
    const ready = this.mode === "legacy" || (bindings.d1 && bindings.r2 && bindings.queue && d1Probe === "ok");
    const normalizedHealth = this.normalized
      ? await this.normalized.checkCutoverHealth(this.workspace, { requireMigrationComplete: true })
      : { ready: false, reasons: ["normalized_storage_disabled"] };
    return {
      mode: this.mode,
      authority: "durable_object",
      ready,
      bindings,
      probes: { d1: d1Probe },
      last_checkpoint: this.lastCheckpoint,
      last_artifact_mirror: this.artifacts.lastMirror,
      normalized_cutover_available: normalizedHealth.ready,
      normalized: { status: this.lastNormalized?.status ?? "not_started", reasons: normalizedHealth.reasons },
    };
  }
}

export function createControlPlaneRuntime(storage, env = {}, workspace = CONTROL_PLANE_WORKSPACE) {
  return new ControlPlaneRuntime(storage, env, workspace);
}
