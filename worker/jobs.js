import { CONTROL_PLANE_WORKSPACE } from "./control-plane.js";

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

export async function consumeArchitectureQueue(batch, env) {
  for (const message of batch.messages ?? []) {
    try {
      const body = message.body ?? {};
      if (body.kind === "architecture.verify-checkpoint.v1") await verifyCheckpoint(body, env);
      else if (body.kind === "market-data.backfill-partition.v1") await processMarketBackfill(body, env);
      else throw new Error(`Unsupported architecture job: ${body.kind ?? "missing"}`);
      message.ack();
    } catch (error) {
      console.error("Architecture queue job failed", { id: message.id, error: messageOf(error) });
      message.retry({ delaySeconds: 30 });
    }
  }
}
