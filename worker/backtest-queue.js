import { sha256, shardBacktestStrategies } from "./backtest.js";

export function strategyScopeSymbols(strategies) {
  return [...new Set(strategies.flatMap((strategy) => strategy.strategy_dna?.scope?.symbols
    ?? strategy.scope?.symbols ?? [strategy.asset]).map(String).filter(Boolean))].sort();
}

export async function planQueuedBacktest({ phase, dataset, strategies }) {
  if (!["development", "holdout"].includes(phase) || !dataset?.id || !strategies?.length) {
    throw new Error("Queued backtest plan is malformed");
  }
  const groups = shardBacktestStrategies(strategies);
  const identity = { schema_version: 1, phase, dataset_id: dataset.id,
    strategies: strategies.map((strategy) => ({ id: String(strategy.id), dna_hash: String(strategy.dna_hash) }))
      .sort((a, b) => a.id.localeCompare(b.id)) };
  const run_id = `BQR-${(await sha256(identity)).slice(0, 40)}`;
  const shards = await Promise.all(groups.map(async (group, index) => {
    const strategy_ids = group.map((strategy) => String(strategy.id)).sort();
    return { shard_id: `BQS-${(await sha256({ run_id, strategy_ids })).slice(0, 40)}`,
      index, strategy_ids, symbols: strategyScopeSymbols(group), status: "queued" };
  }));
  return { ...identity, run_id, status: "queued", shards, receipts: {}, finalize_queued: false,
    created_at: new Date().toISOString() };
}

export function recordQueuedBacktestReceipt(run, receipt) {
  const shard = run?.shards?.find((item) => item.shard_id === receipt?.shard_id);
  if (!shard || receipt.run_id !== run.run_id || !receipt.artifact_id || !receipt.content_hash) {
    throw new Error("Queued backtest receipt does not match its run");
  }
  const prior = run.receipts?.[shard.shard_id];
  if (prior && (prior.artifact_id !== receipt.artifact_id || prior.content_hash !== receipt.content_hash
      || prior.job_id !== receipt.job_id)) throw new Error("Queued backtest retry changed its receipt");
  run.receipts ??= {};
  run.receipts[shard.shard_id] ??= { ...receipt };
  shard.status = "complete";
  return Object.keys(run.receipts).length === run.shards.length;
}

export async function combineQueuedBacktest(run, artifacts) {
  if (!run?.shards?.length || run.shards.some((shard) => !run.receipts?.[shard.shard_id])) {
    const error = new Error("Queued backtest run is incomplete"); error.status = 409; throw error;
  }
  const ordered = [...run.shards].sort((a, b) => a.shard_id.localeCompare(b.shard_id));
  const items = ordered.map((shard) => {
    const receipt = run.receipts[shard.shard_id];
    const response = artifacts[shard.shard_id];
    if (!response || response.job_id !== receipt.job_id || response.result_hash !== receipt.result_hash) {
      throw new Error("Queued Backtrader artifact failed receipt verification");
    }
    return { shard, receipt, response };
  });
  const jobIds = items.map((item) => item.response.job_id);
  return { response: { schema_version: "backtest-artifact-v2", job_id: await sha256(jobIds), phase: run.phase,
    engine: items[0]?.response.engine, dataset: items[0]?.response.dataset,
    input_hash: await sha256(items.map((item) => item.response.input_hash)),
    result_hash: await sha256(items.map((item) => item.response.result_hash)),
    results: items.flatMap((item) => item.response.results ?? []),
    warnings: items.flatMap((item) => item.response.warnings ?? []),
    shards: items.map((item) => ({ index: item.shard.index, shard_id: item.shard.shard_id,
      strategy_ids: item.shard.strategy_ids, job_id: item.response.job_id, engine: item.response.engine,
      dataset: item.response.dataset, input_hash: item.response.input_hash, result_hash: item.response.result_hash,
      warnings: item.response.warnings ?? [] })) },
    job_id: await sha256(jobIds), config_hash: items[0]?.receipt.config_hash,
    dna: items.flatMap((item) => item.receipt.dna ?? []) };
}
