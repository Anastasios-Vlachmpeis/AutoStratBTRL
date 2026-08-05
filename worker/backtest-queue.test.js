import assert from "node:assert/strict";
import test from "node:test";

import { combineQueuedBacktest, planQueuedBacktest, recordQueuedBacktestReceipt, strategyScopeSymbols } from "./backtest-queue.js";

const strategies = [
  { id: "a", dna_hash: "a".repeat(64), strategy_dna: { scope: { symbols: ["MSFT", "AAPL"] } } },
  { id: "b", dna_hash: "b".repeat(64), strategy_dna: { scope: { symbols: ["NVDA"] } } },
];

test("queued plans expose only each deterministic shard symbol union", async () => {
  assert.deepEqual(strategyScopeSymbols(strategies), ["AAPL", "MSFT", "NVDA"]);
  const first = await planQueuedBacktest({ phase: "development", dataset: { id: "sealed" }, strategies });
  const replay = await planQueuedBacktest({ phase: "development", dataset: { id: "sealed" }, strategies: [...strategies].reverse() });
  assert.equal(first.run_id, replay.run_id);
  assert.deepEqual(first.shards.map((item) => item.shard_id), replay.shards.map((item) => item.shard_id));
});

test("receipts are idempotent and finalization is delivery-order invariant", async () => {
  const run = await planQueuedBacktest({ phase: "holdout", dataset: { id: "sealed" }, strategies });
  run.shards = (await Promise.all(strategies.map((strategy) => planQueuedBacktest({
    phase: "holdout", dataset: { id: "sealed" }, strategies: [strategy],
  })))).map((item, index) => ({ ...item.shards[0], index }));
  run.receipts = {};
  const artifacts = {};
  for (const shard of [...run.shards].reverse()) {
    const result_hash = shard.strategy_ids[0].repeat(64).slice(0, 64);
    const response = { job_id: `job-${shard.strategy_ids[0]}`, phase: "holdout", result_hash,
      input_hash: `input-${shard.strategy_ids[0]}`, engine: { name: "backtrader" }, results: [{ id: shard.strategy_ids[0] }] };
    artifacts[shard.shard_id] = response;
    const receipt = { run_id: run.run_id, shard_id: shard.shard_id, artifact_id: `artifact-${shard.shard_id}`,
      content_hash: `content-${shard.shard_id}`, job_id: response.job_id, result_hash, config_hash: "config" };
    recordQueuedBacktestReceipt(run, receipt); recordQueuedBacktestReceipt(run, receipt);
  }
  const first = await combineQueuedBacktest(run, artifacts);
  const second = await combineQueuedBacktest({ ...run, shards: [...run.shards].reverse() }, artifacts);
  assert.deepEqual(first, second);
});

test("an incomplete run is non-decisional", async () => {
  const run = await planQueuedBacktest({ phase: "development", dataset: { id: "sealed" }, strategies });
  await assert.rejects(combineQueuedBacktest(run, {}), /incomplete/);
});
