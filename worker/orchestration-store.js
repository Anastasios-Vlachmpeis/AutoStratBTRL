import { sha256 } from "./backtest.js";

const encoder = new TextEncoder();
const json = (value) => JSON.stringify(value ?? {});
const parse = (value, fallback = {}) => typeof value === "string" ? JSON.parse(value) : (value ?? fallback);
const iso = (value) => new Date(value).toISOString();
const id = (prefix, value) => `${prefix}-${String(value).replace(/[^a-zA-Z0-9_.-]/g, "_")}`;

function jitterUnit(value) {
  let hash = 2166136261;
  for (const char of String(value)) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0) / 0x100000000;
}

/** A deterministic retry delay: randomness is derived from the job identity. */
export function retryDelayMs(jobId, attempt, { baseMs = 1_000, capMs = 300_000 } = {}) {
  const ceiling = Math.min(capMs, baseMs * (2 ** Math.max(0, attempt - 1)));
  return Math.floor(ceiling * (0.5 + jitterUnit(`${jobId}:${attempt}`)));
}

export class OrchestrationStore {
  constructor(db, { queue, artifacts, clock = () => new Date(), leaseMs = 60_000, maxAttempts = 5 } = {}) {
    if (!db) throw new Error("AXIOM_DB is required");
    this.db = db; this.queue = queue; this.artifacts = artifacts; this.clock = clock;
    this.leaseMs = leaseMs; this.maxAttempts = maxAttempts;
  }
  now() { return iso(this.clock()); }
  statement(sql, ...values) { return this.db.prepare(sql).bind(...values); }

  async loadLifecycle(workspaceId, strategyId) {
    const row = await this.statement(`SELECT version,state,snapshot_json,snapshot_hash,updated_at
      FROM orchestration_strategy_lifecycle WHERE workspace_id=? AND strategy_id=?`, workspaceId, strategyId).first();
    if (!row) return null;
    const snapshot = parse(row.snapshot_json, null);
    if (!snapshot || await sha256(snapshot) !== row.snapshot_hash) throw new Error("orchestration lifecycle snapshot hash mismatch");
    return { version: Number(row.version), state: row.state, snapshot, snapshotHash: row.snapshot_hash, updatedAt: row.updated_at };
  }

  async persistLifecycle({ workspaceId, strategyId, expectedVersion = 0, state, snapshot, command, outbox, fromState = null, transition = {} }) {
    if (!command?.idempotencyKey || !command?.kind) throw new Error("command idempotencyKey and kind are required");
    const existing = await this.statement("SELECT command_id FROM orchestration_commands WHERE workspace_id = ? AND idempotency_key = ?", workspaceId, command.idempotencyKey).first();
    if (existing) return { idempotent: true, commandId: existing.command_id };
    const now = this.now(), version = expectedVersion + 1;
    const commandId = command.id ?? id("cmd", await sha256({ workspaceId, key: command.idempotencyKey }));
    const outboxId = outbox?.id ?? id("out", commandId);
    const snapshotHash = await sha256(snapshot);
    const stmts = [
      this.statement(`INSERT INTO orchestration_strategy_lifecycle (workspace_id,strategy_id,version,state,snapshot_json,snapshot_hash,updated_at)
        VALUES (?,?,?,?,?,?,?) ON CONFLICT(workspace_id,strategy_id) DO UPDATE SET version=excluded.version,state=excluded.state,snapshot_json=excluded.snapshot_json,snapshot_hash=excluded.snapshot_hash,updated_at=excluded.updated_at
        WHERE orchestration_strategy_lifecycle.version = ?`, workspaceId, strategyId, version, state, json(snapshot), snapshotHash, now, expectedVersion),
      this.statement(`INSERT INTO orchestration_commands (command_id,workspace_id,strategy_id,idempotency_key,command_kind,payload_json,created_at)
        SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM orchestration_strategy_lifecycle
        WHERE workspace_id=? AND strategy_id=? AND version=? AND snapshot_hash=?)`, commandId, workspaceId, strategyId,
      command.idempotencyKey, command.kind, json(command.payload), now, workspaceId, strategyId, version, snapshotHash),
    ];
    // The transition is an append-only audit record.  It is deliberately in
    // the same batch as the snapshot and command, so no visible state lacks
    // the event that explains how it was reached.
    const transitionId = transition.id ?? id("transition", await sha256({ commandId, version, state }));
    stmts.push(this.statement(`INSERT INTO orchestration_transitions (transition_id,workspace_id,strategy_id,command_id,from_state,to_state,version,details_json,created_at)
      SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM orchestration_commands WHERE command_id=?)`,
    transitionId, workspaceId, strategyId, commandId, fromState, state, version, json(transition.details), now, commandId));
    if (outbox) stmts.push(this.statement(`INSERT INTO orchestration_outbox (outbox_id,command_id,message_kind,payload_json,available_at,created_at)
      SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM orchestration_commands WHERE command_id=?)`, outboxId, commandId, outbox.kind, json(outbox.payload ?? { command_id: commandId }), outbox.availableAt ?? now, now, commandId));
    const results = await this.db.batch(stmts);
    const commandResult = results[1]?.meta?.changes ?? results[1]?.changes;
    if (commandResult === 0) {
      const duplicate = await this.statement("SELECT command_id FROM orchestration_commands WHERE workspace_id=? AND idempotency_key=?", workspaceId, command.idempotencyKey).first();
      if (duplicate) return { idempotent: true, commandId: duplicate.command_id };
      throw new Error("lifecycle compare-and-swap failed");
    }
    return { idempotent: false, commandId, outboxId, version, snapshotHash };
  }

  async dispatchOutbox({ limit = 25, dispatcherId = "dispatcher" } = {}) {
    if (!this.queue) throw new Error("AXIOM_JOBS is required");
    const now = this.now(), until = iso(this.clock().getTime() + this.leaseMs);
    const rows = await this.statement(`SELECT * FROM orchestration_outbox WHERE sent_at IS NULL AND available_at <= ?
      AND (claim_expires_at IS NULL OR claim_expires_at <= ?) ORDER BY created_at LIMIT ?`, now, now, limit).all();
    const sent = [];
    for (const row of rows.results ?? []) {
      const token = `${dispatcherId}:${row.outbox_id}:${await sha256(`${row.outbox_id}:${now}`)}`;
      const claim = await this.statement(`UPDATE orchestration_outbox SET claim_token=?,claim_expires_at=?,attempts=attempts+1
        WHERE outbox_id=? AND sent_at IS NULL AND (claim_expires_at IS NULL OR claim_expires_at <= ?)`, token, until, row.outbox_id, now).run();
      if (!(claim.meta?.changes ?? claim.changes)) continue;
      try {
        await this.queue.send({ kind: row.message_kind, outbox_id: row.outbox_id, command_id: row.command_id, ...parse(row.payload_json) }, { contentType: "json" });
        await this.statement("UPDATE orchestration_outbox SET sent_at=?,claim_token=NULL,claim_expires_at=NULL WHERE outbox_id=? AND claim_token=?", this.now(), row.outbox_id, token).run();
        sent.push(row.outbox_id);
      } catch (error) {
        await this.statement("UPDATE orchestration_outbox SET claim_token=NULL,claim_expires_at=NULL WHERE outbox_id=? AND claim_token=?", row.outbox_id, token).run();
        throw error;
      }
    }
    return sent;
  }

  async enqueueJob({ jobId, commandId, workspaceId, strategyId, kind, payload, maxAttempts = this.maxAttempts, availableAt = this.now() }) {
    const now = this.now();
    await this.statement(`INSERT INTO orchestration_jobs (job_id,command_id,workspace_id,strategy_id,job_kind,payload_json,status,max_attempts,available_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?, 'queued',?,?,?,?) ON CONFLICT(command_id) DO NOTHING`, jobId, commandId, workspaceId, strategyId, kind, json(payload), maxAttempts, availableAt, now, now).run();
  }

  async getJob(jobId) {
    const row = await this.statement("SELECT * FROM orchestration_jobs WHERE job_id=?", jobId).first();
    return row ? { ...row, payload: parse(row.payload_json) } : null;
  }

  async claimJob({ workerId = "worker", jobId = null } = {}) {
    const now = this.now(), until = iso(this.clock().getTime() + this.leaseMs);
    const candidate = jobId
      ? await this.statement("SELECT * FROM orchestration_jobs WHERE job_id=? AND status IN ('queued','retrying') AND available_at <= ?", jobId, now).first()
      : await this.statement(`SELECT * FROM orchestration_jobs WHERE status IN ('queued','retrying') AND available_at <= ?
        ORDER BY available_at,created_at LIMIT 1`, now).first();
    if (!candidate) return null;
    const token = `${workerId}:${candidate.job_id}:${await sha256(`${candidate.job_id}:${now}`)}`;
    const claimed = await this.statement(`UPDATE orchestration_jobs SET status='running',attempts=attempts+1,claim_token=?,lease_expires_at=?,updated_at=?
      WHERE job_id=? AND status IN ('queued','retrying') AND available_at <= ?`, token, until, now, candidate.job_id, now).run();
    if (!(claimed.meta?.changes ?? claimed.changes)) return null;
    return { ...candidate, status: "running", attempts: candidate.attempts + 1, claim_token: token, lease_expires_at: until, payload: parse(candidate.payload_json) };
  }

  async verifyResultManifest({ objectKey, contentHash, content, byteLength }) {
    if (!objectKey || !/^[a-f0-9]{64}$/i.test(contentHash ?? "")) throw new Error("result manifest requires objectKey and SHA-256 contentHash");
    if (content !== undefined && await sha256(content) !== contentHash) throw new Error("result manifest content hash mismatch");
    if (!this.artifacts) throw new Error("AXIOM_ARTIFACTS is required for result completion");
    if (content !== undefined) await this.artifacts.put(objectKey, typeof content === "string" ? content : json(content), { customMetadata: { content_hash: contentHash } });
    const head = await this.artifacts.head?.(objectKey);
    const actual = head?.customMetadata?.content_hash ?? head?.customMetadata?.contentHash;
    if (actual && actual !== contentHash) throw new Error("stored result manifest content hash mismatch");
    if (!head && content === undefined) throw new Error("result object cannot be verified");
    return { objectKey, contentHash, byteLength: byteLength ?? (content === undefined ? null : encoder.encode(typeof content === "string" ? content : json(content)).byteLength) };
  }

  async completeJob({ jobId, claimToken, manifest, metadata = {} }) {
    const verified = await this.verifyResultManifest(manifest);
    const now = this.now(), manifestId = id("result", await sha256({ jobId, objectKey: verified.objectKey, contentHash: verified.contentHash }));
    const results = await this.db.batch([
      this.statement(`INSERT INTO orchestration_result_manifests (manifest_id,job_id,object_key,content_hash,byte_length,metadata_json,verified_at,created_at)
        VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(job_id) DO NOTHING`, manifestId, jobId, verified.objectKey, verified.contentHash, verified.byteLength, json(metadata), now, now),
      this.statement(`UPDATE orchestration_jobs SET status='completed',result_manifest_id=?,claim_token=NULL,lease_expires_at=NULL,updated_at=?
        WHERE job_id=? AND status='running' AND claim_token=?`, manifestId, now, jobId, claimToken),
    ]);
    if (!(results[1]?.meta?.changes ?? results[1]?.changes)) {
      const job = await this.statement("SELECT status,result_manifest_id FROM orchestration_jobs WHERE job_id=?", jobId).first();
      if (job?.status === "completed" && job.result_manifest_id) return { idempotent: true, manifestId: job.result_manifest_id };
      throw new Error("job lease was not held");
    }
    return { idempotent: false, manifestId };
  }

  async failJob({ jobId, claimToken, error }) {
    const job = await this.statement("SELECT * FROM orchestration_jobs WHERE job_id=?", jobId).first();
    if (!job || job.status !== "running" || job.claim_token !== claimToken) throw new Error("job lease was not held");
    const now = this.now();
    if (job.attempts >= job.max_attempts) return this.deadLetter(job, String(error), now);
    const available = iso(this.clock().getTime() + retryDelayMs(jobId, job.attempts));
    await this.statement(`UPDATE orchestration_jobs SET status='retrying',available_at=?,claim_token=NULL,lease_expires_at=NULL,last_error=?,updated_at=?
      WHERE job_id=? AND claim_token=?`, available, String(error), now, jobId, claimToken).run();
    return { status: "retrying", availableAt: available };
  }
  async deadLetter(job, error, now = this.now()) {
    const incidentId = id("incident", await sha256({ jobId: job.job_id, attempts: job.attempts, error }));
    await this.db.batch([
      this.statement("UPDATE orchestration_jobs SET status='dead_lettered',claim_token=NULL,lease_expires_at=NULL,last_error=?,updated_at=? WHERE job_id=?", error, now, job.job_id),
      this.statement("INSERT INTO orchestration_incidents (incident_id,job_id,workspace_id,strategy_id,incident_kind,details_json,opened_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(incident_id) DO NOTHING", incidentId, job.job_id, job.workspace_id, job.strategy_id, "job_dead_lettered", json({ error, attempts: job.attempts }), now),
    ]);
    return { status: "dead_lettered", incidentId };
  }
  async repairExpiredLeases({ limit = 100 } = {}) {
    const now = this.now();
    const rows = await this.statement("SELECT * FROM orchestration_jobs WHERE status='running' AND lease_expires_at <= ? ORDER BY lease_expires_at LIMIT ?", now, limit).all();
    const repaired = [];
    for (const job of rows.results ?? []) {
      if (job.attempts >= job.max_attempts) repaired.push(await this.deadLetter(job, "lease expired", now));
      else {
        const available = iso(this.clock().getTime() + retryDelayMs(job.job_id, job.attempts));
        const result = await this.statement("UPDATE orchestration_jobs SET status='retrying',available_at=?,claim_token=NULL,lease_expires_at=NULL,last_error='lease expired',updated_at=? WHERE job_id=? AND status='running' AND lease_expires_at <= ?", available, now, job.job_id, now).run();
        if (result.meta?.changes ?? result.changes) repaired.push({ jobId: job.job_id, status: "retrying", availableAt: available });
      }
    }
    return repaired;
  }

  async recordOperatorApproval({ approvalId, workspaceId, strategyId = null, kind, subjectHash, approvedBy, decision = "approved", rationale = null, expiresAt = null }) {
    if (!["approved", "rejected"].includes(decision)) throw new Error("approval decision must be approved or rejected");
    const now = this.now();
    await this.statement(`INSERT INTO orchestration_operator_approvals
      (approval_id,workspace_id,strategy_id,approval_kind,subject_hash,approved_by,decision,rationale,expires_at,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,approval_kind,subject_hash) DO UPDATE SET
      approved_by=excluded.approved_by,decision=excluded.decision,rationale=excluded.rationale,expires_at=excluded.expires_at,created_at=excluded.created_at`,
    approvalId, workspaceId, strategyId, kind, subjectHash, approvedBy, decision, rationale, expiresAt, now).run();
  }

  async recordConfigApproval({ approvalId, workspaceId, configKey, configHash, approvedBy, decision = "approved", expiresAt = null }) {
    if (!["approved", "rejected"].includes(decision)) throw new Error("approval decision must be approved or rejected");
    await this.statement(`INSERT INTO orchestration_config_approvals
      (approval_id,workspace_id,config_key,config_hash,approved_by,decision,expires_at,created_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,config_key,config_hash) DO UPDATE SET
      approved_by=excluded.approved_by,decision=excluded.decision,expires_at=excluded.expires_at,created_at=excluded.created_at`,
    approvalId, workspaceId, configKey, configHash, approvedBy, decision, expiresAt, this.now()).run();
  }

  async resetInventory(workspaceId) {
    const d1Targets = [];
    const direct = [
      ["orchestration_strategy_lifecycle", "strategy_id"], ["orchestration_commands", "command_id"],
      ["orchestration_transitions", "transition_id"], ["orchestration_jobs", "job_id"],
      ["orchestration_incidents", "incident_id"], ["orchestration_operator_approvals", "approval_id"],
      ["orchestration_config_approvals", "approval_id"],
    ];
    for (const [table, key] of direct) {
      const result = await this.statement(`SELECT ${key} FROM ${table} WHERE workspace_id=? ORDER BY ${key}`, workspaceId).all();
      d1Targets.push(...(result.results ?? []).map((row) => `${table}:${row[key]}`));
    }
    const outbox = await this.statement(`SELECT o.outbox_id FROM orchestration_outbox o
      JOIN orchestration_commands c ON c.command_id=o.command_id WHERE c.workspace_id=? ORDER BY o.outbox_id`, workspaceId).all();
    d1Targets.push(...(outbox.results ?? []).map((row) => `orchestration_outbox:${row.outbox_id}`));
    const manifests = await this.statement(`SELECT m.manifest_id,m.object_key FROM orchestration_result_manifests m
      JOIN orchestration_jobs j ON j.job_id=m.job_id WHERE j.workspace_id=? ORDER BY m.manifest_id`, workspaceId).all();
    d1Targets.push(...(manifests.results ?? []).map((row) => `orchestration_result_manifests:${row.manifest_id}`));
    return { d1_targets: d1Targets.sort(), object_keys: (manifests.results ?? []).map((row) => row.object_key).filter(Boolean).sort() };
  }

  async clearWorkspace(workspaceId) {
    const inventory = await this.resetInventory(workspaceId);
    if (inventory.object_keys.length && this.artifacts) await this.artifacts.delete(inventory.object_keys);
    await this.statement(`DELETE FROM orchestration_result_manifests WHERE job_id IN
      (SELECT job_id FROM orchestration_jobs WHERE workspace_id=?)`, workspaceId).run();
    await this.statement(`DELETE FROM orchestration_outbox WHERE command_id IN
      (SELECT command_id FROM orchestration_commands WHERE workspace_id=?)`, workspaceId).run();
    for (const table of ["orchestration_jobs", "orchestration_transitions", "orchestration_commands",
      "orchestration_incidents", "orchestration_operator_approvals", "orchestration_config_approvals",
      "orchestration_strategy_lifecycle"]) {
      await this.statement(`DELETE FROM ${table} WHERE workspace_id=?`, workspaceId).run();
    }
  }
}
