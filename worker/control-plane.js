import { sha256 } from "./backtest.js";

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
    await this.storage.put(this.artifactStorageKey(id), safe);
    const mirror = await this.mirror("artifacts", id, safe, metadata);
    return { value: safe, mirror };
  }

  async getArtifact(id) {
    return this.storage.get(this.artifactStorageKey(id));
  }

  async putDatasetSlice(datasetId, phase, bars, metadata = {}) {
    await this.storage.put(this.datasetStorageKey(datasetId, phase), bars);
    return this.mirror("datasets", `${datasetId}-${phase}`, bars, { dataset_id: datasetId, phase, ...metadata });
  }

  async getDatasetSlice(datasetId, phase) {
    return this.storage.get(this.datasetStorageKey(datasetId, phase));
  }

  async putResearchTrial(cohortId, trialId, value, metadata = {}) {
    const safe = redactPrivateBars(value);
    await this.storage.put(this.researchTrialStorageKey(cohortId, trialId), safe);
    const mirror = await this.mirror("research-trials", `${cohortId}-${trialId}`, safe,
      { cohort_id: cohortId, trial_id: trialId, ...metadata });
    return { value: safe, mirror };
  }

  async getResearchTrial(cohortId, trialId) {
    return this.storage.get(this.researchTrialStorageKey(cohortId, trialId));
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
    this.lastCheckpoint = { status: this.mode === "legacy" ? "disabled" : "not_started" };
  }

  async loadState() {
    return this.state.load();
  }

  async saveState(state) {
    await this.state.save(state);
    this.lastCheckpoint = await this.mirrorCheckpoint(state);
    return this.lastCheckpoint;
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
    return {
      mode: this.mode,
      authority: "durable_object",
      ready,
      bindings,
      probes: { d1: d1Probe },
      last_checkpoint: this.lastCheckpoint,
      last_artifact_mirror: this.artifacts.lastMirror,
      normalized_cutover_available: false,
    };
  }
}

export function createControlPlaneRuntime(storage, env = {}, workspace = CONTROL_PLANE_WORKSPACE) {
  return new ControlPlaneRuntime(storage, env, workspace);
}
