const encoder = new TextEncoder();

export const ARTIFACT_KINDS = Object.freeze([
  "dataset.partition",
  "dataset.manifest",
  "dataset.development.raw",
  "dataset.holdout.raw",
  "research.request",
  "research.result",
  "backtest.result",
  "curve",
  "ledger",
  "replay.bundle",
  "report",
]);

const ARTIFACT_KIND_SET = new Set(ARTIFACT_KINDS);
const VISIBILITIES = new Set(["public_summary", "private", "sealed_holdout", "secret"]);
const HEX_256 = /^[a-f0-9]{64}$/;

function stable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}

async function digest(bytes) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...hash].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function digestText(value) { return digest(encoder.encode(value)); }

function bytesOf(content) {
  if (typeof content === "string") return encoder.encode(content);
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  if (ArrayBuffer.isView(content)) return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
  if (content && typeof content === "object") return encoder.encode(stable(content));
  throw new Error("artifact content must be a string, byte buffer, or JSON value");
}

function json(value, fallback = {}) {
  if (value == null || value === "") return fallback;
  return typeof value === "string" ? JSON.parse(value) : value;
}

function cleanMetadata(value) {
  if (value == null) return {};
  if (Array.isArray(value)) return value.map(cleanMetadata);
  if (typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cleanMetadata(item)]));
}

function assertKind(kind) {
  if (!ARTIFACT_KIND_SET.has(kind)) throw new Error(`unsupported artifact kind: ${kind}`);
}

function assertWorkspace(workspaceId) {
  if (typeof workspaceId !== "string" || !workspaceId.trim() || workspaceId.length > 200) throw new Error("workspaceId is required");
}

function coreFromRow(row) {
  return {
    artifact_id: row.artifact_id,
    workspace_id: row.workspace_id,
    workspace_hash: row.workspace_hash,
    artifact_kind: row.artifact_kind,
    object_key: row.object_key,
    content_hash: row.content_hash,
    byte_length: Number(row.byte_length),
    media_type: row.media_type,
    visibility: row.visibility,
    metadata: json(row.metadata_json),
    created_at: row.created_at,
  };
}

async function objectBytes(object) {
  if (!object) throw new Error("artifact object is missing");
  if (typeof object.arrayBuffer === "function") return new Uint8Array(await object.arrayBuffer());
  if (object.body !== undefined) return bytesOf(object.body);
  if (object.value !== undefined) return bytesOf(object.value);
  throw new Error("artifact object body cannot be read");
}

/**
 * Immutable, content-addressed artifact repository for Workers D1 and R2.
 * Object keys are always derived here and are never accepted from callers.
 */
export class ArtifactStore {
  constructor(db, bucket, { clock = () => new Date() } = {}) {
    if (!db) throw new Error("AXIOM_DB is required");
    if (!bucket) throw new Error("AXIOM_ARTIFACTS is required");
    this.db = db;
    this.bucket = bucket;
    this.clock = clock;
  }

  statement(sql, ...values) { return this.db.prepare(sql).bind(...values); }
  now() { return this.clock().toISOString(); }

  async identity(workspaceId, kind, contentHash) {
    assertWorkspace(workspaceId);
    assertKind(kind);
    if (!HEX_256.test(contentHash)) throw new Error("contentHash must be a lowercase SHA-256 digest");
    const workspaceHash = await digestText(workspaceId);
    const artifactId = `art-${await digestText(stable({ workspaceHash, kind, contentHash }))}`;
    const objectKey = `workspaces/${workspaceHash}/artifacts/${kind.replaceAll(".", "/")}/${contentHash}`;
    return { workspaceHash, artifactId, objectKey };
  }

  async manifestById(workspaceId, artifactId) {
    assertWorkspace(workspaceId);
    if (typeof artifactId !== "string" || !artifactId.startsWith("art-")) throw new Error("artifactId is required");
    return this.statement("SELECT * FROM artifact_manifests WHERE workspace_id=? AND artifact_id=?", workspaceId, artifactId).first();
  }

  async verifyManifest(row) {
    if (!row) throw new Error("artifact manifest not found");
    assertKind(row.artifact_kind);
    const expectedIdentity = await this.identity(row.workspace_id, row.artifact_kind, row.content_hash);
    if (row.workspace_hash !== expectedIdentity.workspaceHash || row.artifact_id !== expectedIdentity.artifactId || row.object_key !== expectedIdentity.objectKey) {
      throw new Error("artifact manifest identity mismatch");
    }
    const core = coreFromRow(row);
    if (await digestText(stable(core)) !== row.manifest_hash) throw new Error("artifact manifest hash mismatch");
    return core;
  }

  async put({ workspaceId, kind, content, expectedHash = null, mediaType = "application/octet-stream", visibility = "private", metadata = {} }) {
    assertWorkspace(workspaceId);
    assertKind(kind);
    if (!VISIBILITIES.has(visibility)) throw new Error("artifact visibility is invalid");
    if (kind === "dataset.holdout.raw" && visibility !== "sealed_holdout") throw new Error("raw holdout artifacts require sealed_holdout visibility");
    const bytes = bytesOf(content);
    const contentHash = await digest(bytes);
    if (expectedHash != null && expectedHash !== contentHash) throw new Error("artifact SHA-256 mismatch");
    const identity = await this.identity(workspaceId, kind, contentHash);
    const existing = await this.manifestById(workspaceId, identity.artifactId);
    const createdAt = existing?.created_at ?? this.now();
    const core = {
      artifact_id: identity.artifactId,
      workspace_id: workspaceId,
      workspace_hash: identity.workspaceHash,
      artifact_kind: kind,
      object_key: identity.objectKey,
      content_hash: contentHash,
      byte_length: bytes.byteLength,
      media_type: mediaType,
      visibility,
      metadata: cleanMetadata(metadata),
      created_at: createdAt,
    };
    const manifestHash = await digestText(stable(core));
    if (existing) {
      const verified = await this.verifyManifest(existing);
      if (stable(verified) !== stable(core)) throw new Error("immutable artifact manifest conflict");
      await this.verifyStoredObject(verified);
      return { ...verified, manifest_hash: manifestHash, idempotent: true };
    }

    await this.bucket.put(identity.objectKey, bytes, { customMetadata: {
      artifact_id: identity.artifactId,
      workspace_hash: identity.workspaceHash,
      artifact_kind: kind,
      content_hash: contentHash,
    } });
    await this.verifyStoredObject(core);
    const result = await this.statement(`INSERT INTO artifact_manifests
      (artifact_id,workspace_id,workspace_hash,artifact_kind,object_key,content_hash,byte_length,media_type,visibility,metadata_json,manifest_hash,verified_at,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(artifact_id) DO NOTHING`,
    identity.artifactId, workspaceId, identity.workspaceHash, kind, identity.objectKey, contentHash, bytes.byteLength,
    mediaType, visibility, stable(core.metadata), manifestHash, createdAt, createdAt).run();
    if ((result.meta?.changes ?? result.changes ?? 0) === 0) {
      const raced = await this.manifestById(workspaceId, identity.artifactId);
      const verified = await this.verifyManifest(raced);
      if (stable(verified) !== stable(core)) throw new Error("immutable artifact manifest conflict");
    }
    return { ...core, manifest_hash: manifestHash, idempotent: false };
  }

  async verifyStoredObject(core) {
    const object = await this.bucket.get(core.object_key);
    const bytes = await objectBytes(object);
    if (bytes.byteLength !== core.byte_length || await digest(bytes) !== core.content_hash) throw new Error("artifact object content mismatch");
    const custom = object.customMetadata ?? {};
    if (custom.artifact_id !== core.artifact_id || custom.workspace_hash !== core.workspace_hash || custom.artifact_kind !== core.artifact_kind ||
        custom.content_hash !== core.content_hash) throw new Error("artifact object metadata mismatch");
    return bytes;
  }

  async get({ workspaceId, artifactId }) {
    const row = await this.manifestById(workspaceId, artifactId);
    const manifest = await this.verifyManifest(row);
    const bytes = await this.verifyStoredObject(manifest);
    return { manifest: { ...manifest, manifest_hash: row.manifest_hash }, bytes };
  }

  async findLatest({ workspaceId, kind, metadata = {} }) {
    assertWorkspace(workspaceId); assertKind(kind);
    const rows = await this.statement(`SELECT * FROM artifact_manifests
      WHERE workspace_id=? AND artifact_kind=? ORDER BY created_at DESC`, workspaceId, kind).all();
    for (const row of rows.results ?? []) {
      const values = json(row.metadata_json);
      if (Object.entries(metadata).every(([key, value]) => values?.[key] === value)) {
        return this.get({ workspaceId, artifactId: row.artifact_id });
      }
    }
    return null;
  }

  /** Internal repair/audit entry point. It will not read an unmanifested key. */
  async getByObjectKey({ workspaceId, objectKey }) {
    assertWorkspace(workspaceId);
    const row = await this.statement("SELECT * FROM artifact_manifests WHERE workspace_id=? AND object_key=?", workspaceId, objectKey).first();
    if (!row) throw new Error("orphan artifact object rejected");
    return this.get({ workspaceId, artifactId: row.artifact_id });
  }

  publicProjection(manifestOrRow) {
    const row = manifestOrRow?.manifest ?? manifestOrRow;
    if (!row || row.artifact_kind === "dataset.holdout.raw") return null;
    return Object.freeze({
      artifact_id: row.artifact_id,
      artifact_kind: row.artifact_kind,
      content_hash: row.content_hash,
      byte_length: Number(row.byte_length),
      media_type: row.media_type,
      created_at: row.created_at,
    });
  }

  async enumerateWorkspace(workspaceId) {
    assertWorkspace(workspaceId);
    const rows = await this.statement("SELECT * FROM artifact_manifests WHERE workspace_id=? ORDER BY artifact_id", workspaceId).all();
    const manifests = [];
    for (const row of rows.results ?? []) manifests.push({ ...(await this.verifyManifest(row)), manifest_hash: row.manifest_hash });
    return manifests;
  }

  async quotaStatus({ workspaceId, quotaBytes, researchPauseRatio = 0.9 }) {
    if (!Number.isSafeInteger(quotaBytes) || quotaBytes <= 0) throw new Error("quotaBytes must be a positive integer");
    if (!(researchPauseRatio > 0 && researchPauseRatio <= 1)) throw new Error("researchPauseRatio must be in (0, 1]");
    const row = await this.statement("SELECT COALESCE(SUM(byte_length),0) AS used_bytes,COUNT(*) AS artifact_count FROM artifact_manifests WHERE workspace_id=?", workspaceId).first();
    const usedBytes = Number(row?.used_bytes ?? 0);
    const ratio = usedBytes / quotaBytes;
    return Object.freeze({
      workspace_id: workspaceId,
      used_bytes: usedBytes,
      quota_bytes: quotaBytes,
      artifact_count: Number(row?.artifact_count ?? 0),
      utilization: ratio,
      pressure: ratio >= 1 ? "exhausted" : ratio >= researchPauseRatio ? "high" : "normal",
      pause_optional_research: ratio >= researchPauseRatio,
      allow_risk_operations: true,
      deletion_performed: false,
    });
  }

  async buildResetManifest(workspaceId) {
    const artifacts = await this.enumerateWorkspace(workspaceId);
    const core = {
      workspace_id: workspaceId,
      artifact_ids: artifacts.map((item) => item.artifact_id),
      object_keys: artifacts.map((item) => item.object_key),
      artifact_count: artifacts.length,
      byte_length: artifacts.reduce((sum, item) => sum + item.byte_length, 0),
      generated_at: this.now(),
    };
    return Object.freeze({ ...core, reset_manifest_hash: await digestText(stable(core)), deletion_performed: false });
  }

  async executeReset({ workspaceId, manifest }) {
    if (!manifest || manifest.workspace_id !== workspaceId || manifest.deletion_performed) throw new Error("prepared reset manifest is required");
    const core = { workspace_id: manifest.workspace_id, artifact_ids: manifest.artifact_ids,
      object_keys: manifest.object_keys, artifact_count: manifest.artifact_count,
      byte_length: manifest.byte_length, generated_at: manifest.generated_at };
    if (await digestText(stable(core)) !== manifest.reset_manifest_hash) throw new Error("reset manifest hash mismatch");
    const current = await this.enumerateWorkspace(workspaceId);
    if (stable(current.map((item) => item.artifact_id)) !== stable(manifest.artifact_ids)
        || stable(current.map((item) => item.object_key)) !== stable(manifest.object_keys)) {
      throw new Error("workspace artifacts changed after reset preparation");
    }
    if (manifest.object_keys.length) await this.bucket.delete(manifest.object_keys);
    await this.statement("DELETE FROM artifact_manifests WHERE workspace_id=?", workspaceId).run();
    return Object.freeze({ workspace_id: workspaceId, reset_manifest_hash: manifest.reset_manifest_hash,
      deleted_artifacts: manifest.artifact_count, deleted_bytes: manifest.byte_length,
      deletion_performed: true, completed_at: this.now() });
  }
}
