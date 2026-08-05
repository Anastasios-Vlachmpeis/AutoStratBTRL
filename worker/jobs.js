import { CONTROL_PLANE_WORKSPACE } from "./control-plane.js";
import { sha256 } from "./backtest.js";
import { OrchestrationStore } from "./orchestration-store.js";

function messageOf(error) {
  return error instanceof Error ? error.message : String(error ?? "Unknown queue error");
}

async function verifyCheckpoint(body, env) {
  if (!env.AXIOM_DB) throw new Error("AXIOM_DB binding is required for checkpoint verification");
  const workspaceId = String(body.workspace_id ?? "");
  const checkpointId = String(body.checkpoint_id ?? "");
  const expectedHash = String(body.state_hash ?? "");
  if (!workspaceId || !checkpointId || !expectedHash) throw new Error("Checkpoint verification job is malformed");
  const row = await env.AXIOM_DB.prepare(`
    SELECT state_hash FROM architecture_state_checkpoints
    WHERE workspace_id = ? AND checkpoint_id = ?
  `).bind(workspaceId, checkpointId).first();
  if (!row || row.state_hash !== expectedHash) throw new Error("Checkpoint mirror does not match the verification job");
  const receiptId = `checkpoint:${workspaceId}:${checkpointId}`;
  await env.AXIOM_DB.prepare(`
    INSERT INTO architecture_queue_receipts
      (receipt_id, job_kind, workspace_id, object_id, verified_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(receipt_id) DO NOTHING
  `).bind(receiptId, body.kind, workspaceId, checkpointId, new Date().toISOString()).run();
}

async function processMarketBackfill(body, env) {
  if (!env.AXIOM_LAB) throw new Error("AXIOM_LAB binding is required for market-data backfills");
  if (body.workspace_id !== CONTROL_PLANE_WORKSPACE) throw new Error("Market-data job targets an unknown workspace");
  const stub = env.AXIOM_LAB.get(env.AXIOM_LAB.idFromName(CONTROL_PLANE_WORKSPACE));
  const response = await stub.fetch(new Request("https://axiom.internal/internal/market-data/backfill-partition", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error ?? `Market-data backfill returned ${response.status}`);
  }
}

async function processOrchestrationCommand(body, env, messageId = "queue") {
  if (!env.AXIOM_DB || !env.AXIOM_ARTIFACTS || !env.AXIOM_LAB) throw new Error("Orchestration jobs require AXIOM_DB, AXIOM_ARTIFACTS, and AXIOM_LAB");
  if (body.workspace_id !== CONTROL_PLANE_WORKSPACE || !body.command?.command_id) throw new Error("Orchestration command job is malformed");
  const store = new OrchestrationStore(env.AXIOM_DB, { artifacts: env.AXIOM_ARTIFACTS });
  const jobId = `JOB-${(await sha256({ workspace_id: body.workspace_id, command_id: body.command.command_id })).slice(0, 32)}`;
  await store.enqueueJob({ jobId, commandId: body.command.command_id, workspaceId: body.workspace_id,
    strategyId: body.command.strategy_id ?? "__workspace__", kind: body.command.kind, payload: body.command });
  const existing = await store.getJob(jobId);
  if (existing?.status === "completed" || existing?.status === "dead_lettered") return existing;
  const claim = await store.claimJob({ workerId: `queue:${messageId}`, jobId });
  if (!claim) {
    const current = await store.getJob(jobId);
    const error = new Error(`Orchestration job is ${current?.status ?? "unavailable"}`);
    error.retryDelaySeconds = 30;
    throw error;
  }
  try {
    const stub = env.AXIOM_LAB.get(env.AXIOM_LAB.idFromName(CONTROL_PLANE_WORKSPACE));
    const response = await stub.fetch(new Request("https://axiom.internal/internal/orchestration/command", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: body.command }),
    }));
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error ?? `Orchestration command returned ${response.status}`);
    const content = { schema_version: 1, job_id: jobId, command_id: body.command.command_id, result };
    const contentHash = await sha256(content);
    await store.completeJob({ jobId, claimToken: claim.claim_token, manifest: {
      objectKey: `orchestration/results/${jobId}/${contentHash}.json`, contentHash, content,
    }, metadata: { command_id: body.command.command_id, command_kind: body.command.kind } });
    return result;
  } catch (error) {
    const failed = await store.failJob({ jobId, claimToken: claim.claim_token, error: messageOf(error) });
    if (failed.status === "dead_lettered") return failed;
    const retry = new Error(messageOf(error));
    retry.retryDelaySeconds = Math.max(1, Math.ceil((new Date(failed.availableAt).getTime() - Date.now()) / 1000));
    throw retry;
  }
}

export async function consumeArchitectureQueue(batch, env) {
  for (const message of batch.messages ?? []) {
    try {
      const body = message.body ?? {};
      if (body.kind === "architecture.verify-checkpoint.v1") await verifyCheckpoint(body, env);
      else if (body.kind === "market-data.backfill-partition.v1") await processMarketBackfill(body, env);
      else if (body.kind === "orchestration.command.v1") await processOrchestrationCommand(body, env, message.id);
      else throw new Error(`Unsupported architecture job: ${body.kind ?? "missing"}`);
      message.ack();
    } catch (error) {
      console.error("Architecture queue job failed", { id: message.id, error: messageOf(error) });
      message.retry({ delaySeconds: Number(error?.retryDelaySeconds ?? 30) });
    }
  }
}
