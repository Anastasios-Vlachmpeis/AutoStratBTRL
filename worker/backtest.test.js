import assert from "node:assert/strict";
import test from "node:test";
import { aggregateMetrics, buildBacktestPayload, cleanBars, comparison, developmentWindows, frozenDna, makeDataset, normalizeMetrics,
  remoteEnabled, sha256, signedBacktest, validationDecision } from "./backtest.js";

test("sealed datasets split immutable development and holdout slices", async () => {
  const bars = Array.from({ length: 600 }, (_, index) => ({ t: `2026-01-${String(index + 1).padStart(3, "0")}`, o: 100 + index, h: 101 + index, l: 99 + index, c: 100 + index, v: 10 }));
  const dataset = await makeDataset("SPY", bars);
  assert.equal(dataset.development.length, 450);
  assert.equal(dataset.holdout.length, 150);
  assert.ok(dataset.id.includes(dataset.sha256.slice(0, 16)));
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
