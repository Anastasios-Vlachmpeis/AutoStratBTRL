import assert from "node:assert/strict";
import test from "node:test";
import { aggregateMetrics, buildBacktestPayload, cleanBars, comparison, developmentWindows, frozenDna, makeDataset, normalizeMetrics,
  remoteEnabled, sha256, signedBacktest, validationDecision, makeMultiSymbolDataset, buildBacktestPayloadV2,
  buildBacktestPayloadShardsV2, dynamicWarmup, normalizeBacktestResultV2, shardBacktestStrategies,
  approvedExecutionConfig } from "./backtest.js";
import { buildGeneratedStrategyDNA } from "./dsl-generation.js";

test("sealed datasets split immutable development and holdout slices", async () => {
  const bars = Array.from({ length: 600 }, (_, index) => ({ t: `2026-01-${String(index + 1).padStart(3, "0")}`, o: 100 + index, h: 101 + index, l: 99 + index, c: 100 + index, v: 10 }));
  const dataset = await makeDataset("SPY", bars);
  assert.equal(dataset.development.length, 450);
  assert.equal(dataset.holdout.length, 150);
  assert.ok(dataset.id.includes(dataset.sha256.slice(0, 16)));
  assert.ok(dataset.development.every((bar) => bar.interval_minutes === 1440));
  assert.deepEqual(developmentWindows(dataset.development).map((item) => item.end), [360, 405, 450]);
});

test("holdout mutations cannot alter the development slice hash", async () => {
  const development = Array.from({ length: 450 }, (_, index) => ({ t: `2025-01-${String(index + 1).padStart(3, "0")}T00:00:00Z`, o: 100, h: 101, l: 99, c: 100 + index, v: 10 }));
  const first = await makeDataset("SPY", [...development, ...Array.from({ length: 150 }, (_, index) => ({ t: `2026-01-${String(index + 1).padStart(3, "0")}T00:00:00Z`, o: 500, h: 501, l: 499, c: 500, v: 10 }))]);
  const second = await makeDataset("SPY", [...development, ...Array.from({ length: 150 }, (_, index) => ({ t: `2026-01-${String(index + 1).padStart(3, "0")}T00:00:00Z`, o: 900, h: 901, l: 899, c: 900, v: 10 }))]);
  assert.equal(await sha256(first.development), await sha256(second.development));
  assert.notEqual(first.sha256, second.sha256);
});

test("canonical hashes include nested DNA parameters", async () => {
  const strategy = { id: "AX-1", asset: "SPY", archetype: "Momentum",
    params: { fast: 5, slow: 20, threshold: .001, position_size: .5 } };
  const first = await frozenDna(strategy);
  strategy.params.fast = 6;
  assert.notEqual(first, await frozenDna(strategy));
});

test("DSL payloads carry a discriminated immutable document without legacy executable fields", async () => {
  const built = buildGeneratedStrategyDNA({ family: "Dual average trend",
    params: { fast: 5, slow: 20, threshold: .001, position_size: .5 }, seed: 4, trialId: "AX-DSL" });
  const strategy = { id: "AX-DSL", asset: "SPY", strategy_format: "dsl-v1",
    strategy_dna: built.dna, dna_hash: built.dna.dna_hash };
  const bars = Array.from({ length: 600 }, (_, index) => ({
    t: new Date(Date.UTC(2024, 0, index + 1, 14, 30)).toISOString(),
    o: 100 + index, h: 101 + index, l: 99 + index, c: 100 + index, v: 10,
  }));
  const dataset = await makeDataset("SPY", bars, { timeframe: "5Min" });
  const { payload } = await buildBacktestPayload("development", [strategy], dataset, dataset.development);
  assert.equal(await frozenDna(strategy), built.dna.dna_hash);
  assert.equal(payload.strategies[0].strategy_format, "dsl-v1");
  assert.deepEqual(payload.strategies[0].dna, built.dna);
  assert.equal("archetype" in payload.strategies[0], false);
  assert.equal("params" in payload.strategies[0], false);
  assert.ok(payload.bars.every((bar) => bar.interval_minutes === 5));
});

test("service payload contains only the permitted slice and exact contract fields", async () => {
  const allBars = Array.from({ length: 600 }, (_, index) => ({ t: new Date(Date.UTC(2024, 0, index + 1)).toISOString(),
    o: 100 + index, h: 101 + index, l: 99 + index, c: 100 + index, v: 10 }));
  const dataset = await makeDataset("SPY", allBars);
  const strategy = { id: "AX-CONTRACT", asset: "SPY", archetype: "Momentum",
    params: { fast: 5, slow: 20, threshold: .001, position_size: .5 } };
  const { payload } = await buildBacktestPayload("development", [strategy], dataset, dataset.development);
  assert.equal(payload.bars.length, 450);
  assert.equal(payload.bars.some((bar) => bar.t === dataset.holdout[0].t), false);
  assert.deepEqual(Object.keys(payload.dataset).sort(), ["bar_count", "end", "sha256", "snapshot_id", "start", "symbol", "timeframe"]);
  assert.equal(payload.dataset.sha256, await sha256(payload.bars));
  assert.equal(payload.strategies[0].asset, "SPY");
  assert.equal(payload.execution.fill, "next_bar_open");
});

test("bar cleaning rejects malformed and duplicate timestamps", () => {
  const bars = cleanBars([{ t: "2", c: 2 }, { t: "1", c: 1 }, { t: "1", c: 9 }, { t: "3", c: 0 }]);
  assert.deepEqual(bars.map((item) => item.t), ["1", "2"]);
});

test("remote mode needs both service URL and shared secret", () => {
  assert.equal(remoteEnabled({ BACKTEST_ENGINE: "shadow", BACKTEST_SERVICE_URL: "https://service", BACKTEST_SERVICE_SECRET: "secret" }), true);
  assert.equal(remoteEnabled({ BACKTEST_ENGINE: "shadow", BACKTEST_SERVICE_URL: "https://service" }), false);
  assert.equal(remoteEnabled({ BACKTEST_ENGINE: "legacy", BACKTEST_SERVICE_URL: "https://service", BACKTEST_SERVICE_SECRET: "secret" }), false);
});

test("remote requests use the service timestamp and HMAC contract", async () => {
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url, init };
    return Response.json({ results: [] });
  };
  const payload = { job_id: "job-contract", phase: "development" };
  await signedBacktest({ BACKTEST_SERVICE_URL: "https://backtester.example/", BACKTEST_SERVICE_SECRET: "shared-secret" }, payload);
  const timestamp = captured.init.headers["x-axiom-timestamp"];
  assert.match(timestamp, /^\d{10}$/);
  assert.equal(captured.init.headers["x-axiom-job-id"], payload.job_id);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("shared-secret"),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = await crypto.subtle.sign("HMAC", key,
    new TextEncoder().encode(`${timestamp}.${payload.job_id}.${captured.init.body}`));
  const expected = [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
  assert.equal(captured.init.headers["x-axiom-signature"], expected);
  assert.equal(captured.url, "https://backtester.example/v1/backtests/batch");
});

test("remote metrics retain the existing validation shape", () => {
  const regimes = Object.fromEntries(["Expansion", "Compression", "Stress", "Recovery"]
    .map((name) => [name, { score: .6 }]));
  const metrics = aggregateMetrics([{ metrics: { return: .12, annualized: .13, sharpe: 1.2,
    drawdown: .08, trades: 20, profit_factor: 1.4, regimes }, equity_curve: [{ value: 100000 }, { value: 112000 }] }]);
  assert.equal(metrics.trades, 20);
  assert.ok(metrics.score > 61);
  assert.deepEqual(metrics.curve, [1, 1.12]);
  assert.equal(validationDecision(metrics, { ...metrics, return: .04, sharpe: .8, drawdown: .08, profit_factor: 1.2, trades: 8 })[0], "released");
});

test("remote equity objects normalize to the numeric UI curve shape", () => {
  const metrics = normalizeMetrics({ metrics: { return: .01 }, equity_curve: [{ t: "a", value: 100000 }, { t: "b", value: 101000 }] });
  assert.deepEqual(metrics.curve, [1, 1.01]);
});

test("shadow comparison records exposure and trade-direction alignment", () => {
  const result = comparison(
    { curve: [1, 1.01, 1.02], exposure_curve: [0, 1, -1], trade_events: [{ direction: "buy" }, { direction: "sell" }] },
    { curve: [1, 1.009, 1.019], exposure_curve: [0, 1, -1], trade_events: [{ direction: "buy" }, { direction: "sell" }] },
  );
  assert.equal(result.signal_direction_alignment, 1);
  assert.equal(result.trade_direction_alignment, 1);
  assert.deepEqual(result.unexplained_differences, []);
});

function fiveMinuteBars(symbol, count = 120, start = Date.UTC(2026, 0, 2, 14, 30)) {
  return Array.from({ length: count }, (_, index) => ({
    t: new Date(start + index * 300_000).toISOString(), o: 100 + index, h: 101 + index, l: 99 + index,
    c: 100.5 + index, v: 1000 + index, source: symbol,
  }));
}

function v2Strategy(id, symbols = ["SPY", "QQQ"]) {
  const built = buildGeneratedStrategyDNA({ family: "Dual average trend",
    params: { fast: 5, slow: 20, threshold: .001, position_size: .25 }, seed: Number(id.replace(/\D/g, "")) || 1,
    trialId: id, symbols });
  return { id, strategy_format: "dsl-v1", strategy_dna: built.dna, dna_hash: built.dna.dna_hash };
}

async function v2Fixture() {
  const strategy = v2Strategy("V2-1");
  return { strategy, dataset: await makeMultiSymbolDataset({ QQQ: fiveMinuteBars("QQQ"), SPY: fiveMinuteBars("SPY") }, {
    metadata: { universe: { id: strategy.strategy_dna.scope.universe_id, sha256: strategy.strategy_dna.scope.universe_sha256 },
      calendar: { id: "nyse-v1", sha256: "calendar-hash", revision: "1" }, feed: { name: "iex", revision: "1" }, data_revision: "revision-1" },
  }) };
}

test("v2 payload canonicalizes symbols and bars, with a stable immutable identity", async () => {
  const { strategy, dataset } = await v2Fixture();
  const first = await buildBacktestPayloadV2("development", [strategy], dataset);
  const reordered = { ...dataset, development: { SPY: [...dataset.development.SPY].reverse(), QQQ: [...dataset.development.QQQ].reverse() } };
  const second = await buildBacktestPayloadV2("development", [strategy], reordered);
  assert.equal(first.payload.schema_version, "backtest-request-v2");
  assert.equal(first.job_id, second.job_id);
  assert.deepEqual(Object.keys(first.payload.bars_by_symbol), ["QQQ", "SPY"]);
  assert.deepEqual(first.payload.dataset.symbols.map((item) => item.symbol), ["QQQ", "SPY"]);
  assert.equal(first.payload.dataset.sha256, await sha256(first.payload.bars_by_symbol));
  assert.equal("asset" in first.payload.strategies[0], false);
  assert.equal(first.payload.windows.every((window) => window.start < window.end), true);
});

test("v2 development payload physically excludes holdout and holdout mutation leaves it unchanged", async () => {
  const { strategy, dataset } = await v2Fixture();
  const first = await buildBacktestPayloadV2("development", [strategy], dataset);
  const changed = structuredClone(dataset);
  changed.holdout.SPY[0].c += 9999;
  const second = await buildBacktestPayloadV2("development", [strategy], changed);
  const holdoutStamp = dataset.holdout.SPY[0].t;
  assert.equal(first.job_id, second.job_id);
  assert.equal(first.payload.bars_by_symbol.SPY.some((bar) => bar.t === holdoutStamp), false);
  assert.equal(JSON.stringify(first.payload).includes("holdout"), false);
  const rebuilt = await makeMultiSymbolDataset({
    SPY: [...dataset.development.SPY, ...changed.holdout.SPY], QQQ: [...dataset.development.QQQ, ...changed.holdout.QQQ],
  }, { metadata: { universe: dataset.manifest.universe, calendar: dataset.manifest.calendar, feed: dataset.manifest.feed,
    adjustment: dataset.manifest.adjustment, session: dataset.manifest.session, data_revision: dataset.manifest.data_revision } });
  const rebuiltPayload = await buildBacktestPayloadV2("development", [strategy], rebuilt);
  assert.equal(first.job_id, rebuiltPayload.job_id);
});

test("v2 hashes change when a permitted bar mutates", async () => {
  const { strategy, dataset } = await v2Fixture();
  const first = await buildBacktestPayloadV2("development", [strategy], dataset);
  const changed = structuredClone(dataset);
  changed.development.SPY[20].c += 1;
  const second = await buildBacktestPayloadV2("development", [strategy], changed);
  assert.notEqual(first.payload.dataset.sha256, second.payload.dataset.sha256);
  assert.notEqual(first.job_id, second.job_id);
});

test("v2 derives DSL warmup and has bounded deterministic 12 by 40 shards", async () => {
  const { strategy, dataset } = await v2Fixture();
  assert.equal(dynamicWarmup(strategy), strategy.strategy_dna.warmup_bars + 8);
  const strategies = Array.from({ length: 13 }, (_, index) => v2Strategy(`V2-${index + 10}`));
  const first = shardBacktestStrategies(strategies);
  const second = shardBacktestStrategies([...strategies].reverse());
  assert.deepEqual(first.map((group) => group.map((item) => item.id)), second.map((group) => group.map((item) => item.id)));
  assert.deepEqual(first.map((group) => group.length), [12, 1]);
  const shards = await buildBacktestPayloadShardsV2("development", strategies, dataset);
  const replay = await buildBacktestPayloadShardsV2("development", [...strategies].reverse(), dataset);
  assert.equal(shards.length, 2);
  assert.notEqual(shards[0].job_id, shards[1].job_id);
  assert.deepEqual(shards.map((item) => item.job_id), replay.map((item) => item.job_id));
  assert.equal(shards[0].payload.execution.warmup.mode, "dsl_derived");
});

test("v2 deterministically isolates each 40-symbol finalist into bounded work shards", () => {
  const symbols = Array.from({ length: 40 }, (_, index) => `S${String(index).padStart(2, "0")}`);
  const strategies = Array.from({ length: 12 }, (_, index) => v2Strategy(`V2-WIDE-${index + 1}`, symbols));
  const first = shardBacktestStrategies(strategies);
  const replay = shardBacktestStrategies([...strategies].reverse());
  assert.deepEqual(first.map((group) => group.length), Array(12).fill(1));
  assert.deepEqual(first.map((group) => group[0].id), replay.map((group) => group[0].id));
});

test("v2 approved execution policy cannot disable stress, flattening, cash, or gross limits", () => {
  assert.throws(() => approvedExecutionConfig({ initial_cash: 99_999 }), /fixed at 100000/);
  assert.throws(() => approvedExecutionConfig({ strategy_gross_limit: .01 }), /fixed at 0.5%/);
  assert.throws(() => approvedExecutionConfig({ stress: { enabled: false } }), /cannot be disabled/);
  assert.throws(() => approvedExecutionConfig({ stress: { force_session_flatten: false } }), /cannot be disabled/);
  const config = approvedExecutionConfig({ costs: { base_slippage_bps: 7 } });
  assert.equal(config.initial_cash, 100_000);
  assert.equal(config.strategy_gross_limit, .005);
  assert.equal(config.stress.enabled, true);
  assert.equal(config.stress.force_session_flatten, true);
});

test("v2 normalization preserves existing UI metrics and exposes portfolio artifacts", () => {
  const result = normalizeBacktestResultV2({
    metrics: { return: .08, sharpe: 1.1, daily_sharpe: .9, sortino: 1.4, calmar: .7, turnover: 2.1,
      exposure: .3, hit_rate: .55, tail_loss: -.02, drawdown_duration_bars: 17, capacity_proxy: .8 },
    equity_curve: [{ t: "a", value: 100000 }, { t: "b", value: 108000 }], drawdown_curve: [{ value: 0 }, { value: .03 }],
    turnover_curve: [{ value: .1 }], per_symbol: { SPY: { return: .04, sharpe: .7, drawdown: .02, trades: 3 } },
    fills: [{ id: "fill-1" }], warnings: ["stress warning"], result_hash: "r".repeat(64),
  });
  assert.equal(result.metrics.return, .08);
  assert.equal(result.metrics.daily_sharpe, .9);
  assert.equal(result.metrics.per_symbol.SPY.trades, 3);
  assert.deepEqual(result.metrics.curve, [1, 1.08]);
  assert.equal(result.portfolio.per_symbol.SPY.sharpe, .7);
  assert.equal(result.ledger.fills.length, 1);
});
