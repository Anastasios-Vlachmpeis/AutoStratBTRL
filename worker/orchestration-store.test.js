import assert from "node:assert/strict";
import test from "node:test";
import { OrchestrationStore, retryDelayMs } from "./orchestration-store.js";

// A deliberately small D1 double: it implements the compare-and-set paths
// exercised below, rather than hiding those paths behind a fake repository.
class MemoryD1 {
  constructor() { this.lifecycle = new Map(); this.commands = new Map(); this.outbox = new Map(); this.jobs = new Map(); this.manifests = new Map(); this.incidents = new Map(); }
  prepare(sql) {
    const db = this; let args = [];
    const changes = (n) => ({ meta: { changes: n } });
    const commandByKey = (workspace, key) => [...db.commands.values()].find((row) => row.workspace_id === workspace && row.idempotency_key === key);
    return { bind(...values) { args = values; return this; },
      async first() {
        if (sql.includes("FROM orchestration_commands WHERE workspace_id")) return commandByKey(args[0], args[1]) ?? null;
        if (sql.includes("FROM orchestration_strategy_lifecycle")) return db.lifecycle.get(`${args[0]}:${args[1]}`) ?? null;
        if (sql.includes("FROM orchestration_jobs WHERE job_id")) return db.jobs.get(args[0]) ?? null;
        if (sql.includes("FROM orchestration_jobs WHERE status IN")) return [...db.jobs.values()].find((job) => ["queued", "retrying"].includes(job.status) && job.available_at <= args[0]) ?? null;
        return null;
      },
      async all() {
        if (sql.includes("FROM orchestration_outbox")) return { results: [...db.outbox.values()].filter((row) => !row.sent_at && row.available_at <= args[0] && (!row.claim_expires_at || row.claim_expires_at <= args[1])) };
        if (sql.includes("FROM orchestration_jobs WHERE status='running'")) return { results: [...db.jobs.values()].filter((job) => job.status === "running" && job.lease_expires_at <= args[0]) };
        return { results: [] };
      },
      async run() {
        if (sql.includes("UPDATE orchestration_outbox SET claim_token=?")) { const row = db.outbox.get(args[2]); if (!row || row.sent_at || (row.claim_expires_at && row.claim_expires_at > args[3])) return changes(0); Object.assign(row, { claim_token: args[0], claim_expires_at: args[1], attempts: row.attempts + 1 }); return changes(1); }
        if (sql.includes("UPDATE orchestration_outbox SET sent_at=")) { const row = db.outbox.get(args[1]); if (!row || row.claim_token !== args[2]) return changes(0); Object.assign(row, { sent_at: args[0], claim_token: null, claim_expires_at: null }); return changes(1); }
        if (sql.includes("UPDATE orchestration_outbox SET claim_token=NULL")) { const row = db.outbox.get(args[0]); if (row && row.claim_token === args[1]) Object.assign(row, { claim_token: null, claim_expires_at: null }); return changes(row ? 1 : 0); }
        if (sql.includes("INSERT INTO orchestration_jobs")) { if ([...db.jobs.values()].some((j) => j.command_id === args[1])) return changes(0); db.jobs.set(args[0], { job_id: args[0], command_id: args[1], workspace_id: args[2], strategy_id: args[3], job_kind: args[4], payload_json: args[5], status: "queued", attempts: 0, max_attempts: args[6], available_at: args[7], created_at: args[8], updated_at: args[9] }); return changes(1); }
        if (sql.includes("UPDATE orchestration_jobs SET status='running'")) { const row = db.jobs.get(args[3]); if (!row || !["queued", "retrying"].includes(row.status) || row.available_at > args[4]) return changes(0); Object.assign(row, { status: "running", attempts: row.attempts + 1, claim_token: args[0], lease_expires_at: args[1], updated_at: args[2] }); return changes(1); }
        if (sql.includes("UPDATE orchestration_jobs SET status='retrying'")) { const expired = sql.includes("last_error='lease expired'"), row = db.jobs.get(expired ? args[2] : args[3]); if (!row) return changes(0); Object.assign(row, { status: "retrying", available_at: args[0], claim_token: null, lease_expires_at: null, last_error: expired ? "lease expired" : args[1], updated_at: expired ? args[1] : args[2] }); return changes(1); }
        return changes(0);
      },
      async execute() { return this.run(); },
      _run: async () => {
        if (sql.includes("INSERT INTO orchestration_strategy_lifecycle")) { const key = `${args[0]}:${args[1]}`, current = db.lifecycle.get(key); if (current && current.version !== args[7]) return changes(0); db.lifecycle.set(key, { workspace_id: args[0], strategy_id: args[1], version: args[2], state: args[3], snapshot_json: args[4], snapshot_hash: args[5], updated_at: args[6] }); return changes(1); }
        if (sql.includes("INSERT INTO orchestration_commands")) { const row = commandByKey(args[1], args[3]); if (row) return changes(0); const life = db.lifecycle.get(`${args[7]}:${args[8]}`); if (!life || life.version !== args[9] || life.snapshot_hash !== args[10]) return changes(0); db.commands.set(args[0], { command_id: args[0], workspace_id: args[1], strategy_id: args[2], idempotency_key: args[3] }); return changes(1); }
        if (sql.includes("INSERT INTO orchestration_outbox")) { if (!db.commands.has(args[6])) return changes(0); db.outbox.set(args[0], { outbox_id: args[0], command_id: args[1], message_kind: args[2], payload_json: args[3], available_at: args[4], created_at: args[5], attempts: 0 }); return changes(1); }
        if (sql.includes("INSERT INTO orchestration_result_manifests")) { if (!db.manifests.has(args[1])) db.manifests.set(args[1], { manifest_id: args[0] }); return changes(1); }
        if (sql.includes("UPDATE orchestration_jobs SET status='completed'")) { const row = db.jobs.get(args[2]); if (!row || row.status !== "running" || row.claim_token !== args[3]) return changes(0); Object.assign(row, { status: "completed", result_manifest_id: args[0], claim_token: null }); return changes(1); }
        if (sql.includes("UPDATE orchestration_jobs SET status='dead_lettered'")) { const row = db.jobs.get(args[2]); Object.assign(row, { status: "dead_lettered", claim_token: null }); return changes(1); }
        if (sql.includes("INSERT INTO orchestration_incidents")) { db.incidents.set(args[0], { incident_id: args[0] }); return changes(1); }
        return changes(0);
      },
    };
  }
  async batch(statements) { return Promise.all(statements.map((statement) => statement._run())); }
}
class MemoryR2 { constructor() { this.objects = new Map(); } async put(key, value, options) { this.objects.set(key, { value, customMetadata: options.customMetadata }); } async head(key) { return this.objects.get(key) ?? null; } }

const fixedClock = () => new Date("2026-08-05T12:00:00.000Z");

test("lifecycle snapshot, idempotent command and outbox are one D1 batch", async () => {
  const db = new MemoryD1(), store = new OrchestrationStore(db, { clock: fixedClock });
  const input = { workspaceId: "w", strategyId: "s", state: "queued", snapshot: { state: "queued" }, command: { kind: "run", idempotencyKey: "same" }, outbox: { kind: "strategy.run" } };
  const first = await store.persistLifecycle(input);
  const retry = await store.persistLifecycle(input);
  assert.equal(first.idempotent, false); assert.equal(retry.idempotent, true);
  assert.equal(db.lifecycle.get("w:s").version, 1); assert.equal(db.commands.size, 1); assert.equal(db.outbox.size, 1);
  assert.deepEqual((await store.loadLifecycle("w", "s")).snapshot, { state: "queued" });
  await assert.rejects(store.persistLifecycle({ ...input, snapshot: { state: "different" }, command: { kind: "run", idempotencyKey: "stale" } }), /compare-and-swap/);
  assert.equal(db.commands.size, 1);
});

test("dispatcher recovers after a send crash and concurrent claims do not duplicate a send", async () => {
  const db = new MemoryD1(), messages = []; let fail = true;
  const store = new OrchestrationStore(db, { clock: fixedClock, queue: { async send(message) { if (fail) throw new Error("crash after claim"); messages.push(message); } } });
  await store.persistLifecycle({ workspaceId: "w", strategyId: "s", state: "queued", snapshot: {}, command: { kind: "run", idempotencyKey: "one" }, outbox: { kind: "strategy.run" } });
  await assert.rejects(store.dispatchOutbox(), /crash/);
  assert.equal([...db.outbox.values()][0].sent_at, undefined);
  fail = false; await store.dispatchOutbox(); await store.dispatchOutbox();
  assert.equal(messages.length, 1); assert.ok([...db.outbox.values()][0].sent_at);
});

test("authoritative lifecycle recovery rejects a corrupted D1 snapshot", async () => {
  const db = new MemoryD1(), store = new OrchestrationStore(db, { clock: fixedClock });
  await store.persistLifecycle({ workspaceId: "w", strategyId: "s", state: "queued", snapshot: { version: 1 }, command: { kind: "run", idempotencyKey: "recover" } });
  db.lifecycle.get("w:s").snapshot_json = JSON.stringify({ version: 99 });
  await assert.rejects(store.loadLifecycle("w", "s"), /hash mismatch/);
});

test("completion requires an R2-verified manifest and duplicate completion is harmless", async () => {
  const db = new MemoryD1(), r2 = new MemoryR2(), store = new OrchestrationStore(db, { clock: fixedClock, artifacts: r2 });
  await store.enqueueJob({ jobId: "j", commandId: "c", workspaceId: "w", strategyId: "s", kind: "run", payload: {} });
  const claim = await store.claimJob({ jobId: "j" });
  await assert.rejects(store.completeJob({ jobId: "j", claimToken: claim.claim_token, manifest: { objectKey: "r/j", contentHash: "0".repeat(64), content: { nope: true } } }));
  const content = { ok: true }; const hash = await (await import("./backtest.js")).sha256(content);
  assert.equal((await store.completeJob({ jobId: "j", claimToken: claim.claim_token, manifest: { objectKey: "r/j", contentHash: hash, content } })).idempotent, false);
  assert.equal((await store.completeJob({ jobId: "j", claimToken: claim.claim_token, manifest: { objectKey: "r/j", contentHash: hash, content } })).idempotent, true);
});

test("lease watchdog repairs expired claims and deterministic bounded backoff", async () => {
  const db = new MemoryD1(), store = new OrchestrationStore(db, { clock: fixedClock, leaseMs: 1 });
  await store.enqueueJob({ jobId: "j", commandId: "c", workspaceId: "w", strategyId: "s", kind: "run", payload: {} });
  const claim = await store.claimJob({ jobId: "j" }); db.jobs.get("j").lease_expires_at = "2020-01-01T00:00:00.000Z";
  const repaired = await store.repairExpiredLeases();
  assert.equal(repaired[0].status, "retrying"); assert.equal(db.jobs.get("j").status, "retrying");
  assert.equal(retryDelayMs("j", 3), retryDelayMs("j", 3)); assert.ok(retryDelayMs("j", 100) <= 300_000);
  assert.ok(claim.claim_token);
});

test("poison jobs become dead letters and open an operator-visible incident", async () => {
  const db = new MemoryD1(), store = new OrchestrationStore(db, { clock: fixedClock, maxAttempts: 1 });
  await store.enqueueJob({ jobId: "poison", commandId: "poison-command", workspaceId: "w", strategyId: "s", kind: "run", payload: {}, maxAttempts: 1 });
  const claim = await store.claimJob({ jobId: "poison" });
  const result = await store.failJob({ jobId: "poison", claimToken: claim.claim_token, error: "invalid deterministic payload" });
  assert.equal(result.status, "dead_lettered");
  assert.equal(db.jobs.get("poison").status, "dead_lettered");
  assert.equal(db.incidents.size, 1);
});
