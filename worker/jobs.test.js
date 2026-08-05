import assert from "node:assert/strict";
import test from "node:test";

import { consumeArchitectureQueue } from "./jobs.js";

class VerificationD1 {
  constructor(hash = "hash-1") {
    this.hash = hash;
    this.receipts = 0;
  }

  prepare(sql) {
    const database = this;
    let args = [];
    return {
      bind(...values) { args = values; return this; },
      async first() {
        if (!sql.includes("architecture_state_checkpoints")) return null;
        return args[0] === "workspace" && args[1] === "checkpoint" ? { state_hash: database.hash } : null;
      },
      async run() {
        if (sql.includes("architecture_queue_receipts")) database.receipts += 1;
        return { success: true };
      },
    };
  }
}

function queueMessage(body) {
  return {
    id: "message-1", body, acked: false, retried: false,
    ack() { this.acked = true; },
    retry() { this.retried = true; },
  };
}

test("queue consumer verifies a checkpoint mirror and acknowledges it", async () => {
  const database = new VerificationD1();
  const message = queueMessage({
    kind: "architecture.verify-checkpoint.v1", workspace_id: "workspace",
    checkpoint_id: "checkpoint", state_hash: "hash-1",
  });
  await consumeArchitectureQueue({ messages: [message] }, { AXIOM_DB: database });
  assert.equal(message.acked, true);
  assert.equal(message.retried, false);
  assert.equal(database.receipts, 1);
});

test("queue consumer retries malformed or mismatched verification jobs", async () => {
  const database = new VerificationD1("different");
  const mismatch = queueMessage({
    kind: "architecture.verify-checkpoint.v1", workspace_id: "workspace",
    checkpoint_id: "checkpoint", state_hash: "hash-1",
  });
  const unsupported = queueMessage({ kind: "unknown" });
  await consumeArchitectureQueue({ messages: [mismatch, unsupported] }, { AXIOM_DB: database });
  assert.equal(mismatch.retried, true);
  assert.equal(unsupported.retried, true);
  assert.equal(database.receipts, 0);
});

test("queue consumer delegates market-data partitions to the singleton Durable Object", async () => {
  let requestBody;
  const namespace = {
    idFromName(name) { assert.equal(name, "axiom-global-supervisor"); return "singleton-id"; },
    get(id) {
      assert.equal(id, "singleton-id");
      return { async fetch(request) { requestBody = await request.json(); return Response.json({ ok: true }); } };
    },
  };
  const body = {
    kind: "market-data.backfill-partition.v1", workspace_id: "axiom-global-supervisor",
    backfill_id: "backfill-1", job: { id: "job-1" },
  };
  const message = queueMessage(body);
  await consumeArchitectureQueue({ messages: [message] }, { AXIOM_LAB: namespace });
  assert.equal(message.acked, true);
  assert.deepEqual(requestBody, body);
});

test("queue consumer delegates bounded research stages to the singleton", async () => {
  const paths = [];
  const namespace = { idFromName() { return "singleton-id"; }, get() { return { async fetch(request) {
    paths.push(new URL(request.url).pathname); return Response.json({ ok: true });
  } }; } };
  const screen = queueMessage({ kind: "research.screen-trial.v1", workspace_id: "axiom-global-supervisor",
    job_id: "RSJ-test", cohort_id: "cohort" });
  const finalize = queueMessage({ kind: "research.finalize-cohort.v1", workspace_id: "axiom-global-supervisor",
    job_id: "RFJ-test", cohort_id: "cohort" });
  await consumeArchitectureQueue({ messages: [screen, finalize] }, { AXIOM_LAB: namespace });
  assert.deepEqual(paths, ["/internal/research/screen-trial", "/internal/research/finalize-cohort"]);
  assert.equal(screen.acked, true); assert.equal(finalize.acked, true);
});

test("queue consumer delegates Backtrader shards and deterministic finalizers", async () => {
  const paths = [];
  const namespace = { idFromName() { return "singleton-id"; }, get() { return { async fetch(request) {
    paths.push(new URL(request.url).pathname); return Response.json({ ok: true });
  } }; } };
  const shard = queueMessage({ kind: "backtest.run-shard.v1", workspace_id: "axiom-global-supervisor",
    run_id: "run", shard_id: "shard" });
  const finalize = queueMessage({ kind: "backtest.finalize-run.v1", workspace_id: "axiom-global-supervisor", run_id: "run" });
  await consumeArchitectureQueue({ messages: [shard, finalize] }, { AXIOM_LAB: namespace });
  assert.deepEqual(paths, ["/internal/backtest/run-shard", "/internal/backtest/finalize-run"]);
  assert.equal(shard.acked, true); assert.equal(finalize.acked, true);
});
