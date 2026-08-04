/** Cloudflare control-plane helpers for the remote Backtrader runner. */

import { validateStrategyDNA } from "./dsl.js";

const encoder = new TextEncoder();
const stable = (value) => {
  const canonical = (item) => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.keys(item).sort().map((key) => [key, canonical(item[key])]));
    }
    return item;
  };
  return JSON.stringify(canonical(value));
};
const round = (value, digits = 4) => Number(Number(value || 0).toFixed(digits));
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const stdev = (values) => {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
};
export const EXECUTION_CONFIG = Object.freeze({ initial_cash: 100000, fill: "next_bar_open",
  allow_short: true, slippage_bps: 5, commission: 0, warmup_bars: 52,
  annualization: 252, risk_free_rate: 0 });

export async function sha256(value) {
  const body = typeof value === "string" ? value : stable(value);
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(body)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function engineMode(env) {
  const mode = String(env.BACKTEST_ENGINE || "legacy").toLowerCase();
  return ["legacy", "shadow", "backtrader"].includes(mode) ? mode : "legacy";
}

export function remoteEnabled(env) {
  return engineMode(env) !== "legacy" && Boolean(env.BACKTEST_SERVICE_URL && env.BACKTEST_SERVICE_SECRET);
}

export function cleanBars(raw) {
  const seen = new Set();
  return (raw ?? []).map((bar) => ({
    t: String(bar.t ?? ""), o: Number(bar.o ?? bar.c), h: Number(bar.h ?? bar.c),
    l: Number(bar.l ?? bar.c), c: Number(bar.c), v: Number(bar.v ?? 0),
    ...(bar.session_close ? { session_close: String(bar.session_close) } : {}),
    ...(bar.data_health ? { data_health: String(bar.data_health) } : {}),
    ...(bar.data_coverage !== undefined ? { data_coverage: Number(bar.data_coverage) } : {}),
    ...(bar.interval_minutes !== undefined ? { interval_minutes: Number(bar.interval_minutes) } : {}),
  })).filter((bar) => bar.t && Number.isFinite(bar.o) && Number.isFinite(bar.h)
    && Number.isFinite(bar.l) && Number.isFinite(bar.c) && bar.c > 0 && !seen.has(bar.t) && (seen.add(bar.t) || true))
    .sort((left, right) => left.t.localeCompare(right.t));
}

export async function makeDataset(symbol, rawBars, options = {}) {
  const maxBars = Math.max(600, Number(options.max_bars ?? 600));
  const timeframe = String(options.timeframe ?? "1Day");
  const defaultInterval = timeframe.toLowerCase() === "5min" ? 5 : timeframe.toLowerCase() === "1day" ? 1440 : undefined;
  const bars = cleanBars(rawBars).map((bar) => bar.interval_minutes === undefined && defaultInterval
    ? { ...bar, interval_minutes: defaultInterval } : bar).slice(-maxBars);
  const split = Math.floor(bars.length * 0.75);
  const development = bars.slice(0, split);
  const holdout = bars.slice(split);
  const hash = await sha256(bars);
  return {
    id: `dataset-${symbol.toLowerCase()}-${timeframe.toLowerCase()}-${hash.slice(0, 16)}`,
    symbol, timeframe, bar_count: bars.length, split_index: split,
    start: bars.at(0)?.t ?? null, end: bars.at(-1)?.t ?? null, sha256: hash,
    development, holdout,
  };
}

export function developmentWindows(bars) {
  const size = Math.max(140, Math.floor(bars.length * 0.68));
  return [0.80, 0.90, 1].map((fraction, index) => {
    const end = index === 2 ? bars.length : Math.floor(bars.length * fraction);
    return { id: `development-${index + 1}`, start: Math.max(0, end - size), end };
  });
}

export async function frozenDna(strategy) {
  if (strategy?.strategy_format === "dsl-v1") {
    validateStrategyDNA(strategy.strategy_dna);
    return strategy.strategy_dna.dna_hash;
  }
  return sha256({ id: strategy.id, asset: strategy.asset, archetype: strategy.archetype, params: strategy.params });
}

export async function configHash() {
  return sha256(EXECUTION_CONFIG);
}

export async function buildBacktestPayload(phase, strategies, dataset, bars) {
  const config_hash = await configHash();
  const dna = await Promise.all(strategies.map(async (strategy) => ({
    ...strategy, dna_hash: strategy.dna_hash ?? await frozenDna(strategy),
  })));
  const sliceHash = await sha256(bars);
  const job_id = await sha256({ phase, dataset: dataset.sha256, slice: sliceHash,
    strategies: dna.map((item) => [item.id, item.dna_hash]), config_hash });
  return {
    config_hash, dna, slice_hash: sliceHash,
    payload: {
      job_id, phase, strategies: dna.map((item) => item.strategy_format === "dsl-v1" ? ({
        strategy_format: "dsl-v1", id: item.id, asset: item.asset,
        dna: item.strategy_dna, dna_hash: item.strategy_dna.dna_hash,
      }) : ({
        strategy_format: "legacy-archetype-v0", id: item.id, asset: item.asset,
        archetype: item.archetype, params: item.params, dna_hash: item.dna_hash,
      })),
      dataset: { snapshot_id: dataset.id, symbol: dataset.symbol, timeframe: dataset.timeframe,
        start: bars.at(0).t, end: bars.at(-1).t, bar_count: bars.length, sha256: sliceHash },
      bars, windows: phase === "development" ? developmentWindows(bars)
        : [{ id: "holdout", start: 0, end: bars.length }],
      execution: { ...EXECUTION_CONFIG },
    },
  };
}

export async function signedBacktest(env, payload) {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signatureBytes = await crypto.subtle.sign("HMAC", await crypto.subtle.importKey(
    "raw", encoder.encode(env.BACKTEST_SERVICE_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), encoder.encode(`${timestamp}.${payload.job_id}.${body}`));
  const signature = [...new Uint8Array(signatureBytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const response = await fetch(`${String(env.BACKTEST_SERVICE_URL).replace(/\/$/, "")}/v1/backtests/batch`, {
    method: "POST", headers: { "content-type": "application/json", "x-axiom-timestamp": timestamp,
      "x-axiom-job-id": payload.job_id, "x-axiom-signature": signature }, body,
    signal: AbortSignal.timeout(Math.min(Math.max(Number(env.BACKTEST_TIMEOUT_MS || 290000), 1000), 300000)),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Backtest service ${response.status}: ${result.error || result.detail || "request failed"}`);
  if (!Array.isArray(result.results)) throw new Error("Backtest service response is missing results");
  return result;
}

export function normalizeMetrics(source = {}) {
  const metrics = source.metrics ?? source;
  const rawCurve = source.curve ?? source.equity_curve ?? metrics.curve ?? [];
  const numericCurve = rawCurve.map((point) => Number(point?.value ?? point)).filter(Number.isFinite);
  const base = numericCurve.find((value) => value > 0) ?? 1;
  const normalizedCurve = numericCurve.map((value) => round(value / base, 6));
  const sampleEvery = Math.max(1, Math.ceil(normalizedCurve.length / 120));
  const curve = normalizedCurve.filter((_, index) => index % sampleEvery === 0 || index === normalizedCurve.length - 1);
  const regimes = source.regimes ?? metrics.regimes ?? {};
  const exposureCurve = (source.exposure_curve ?? metrics.exposure_curve ?? [])
    .map((point) => Number(point?.value ?? point)).filter(Number.isFinite);
  const tradeEvents = source.trade_events ?? metrics.trade_events
    ?? (source.fills ?? []).map((fill) => ({ direction: fill.side, fill_time: fill.t }));
  const regimeValues = Object.values(regimes).map((value) => Number(value?.score ?? value)).filter(Number.isFinite);
  const positiveRegimes = Number.isFinite(Number(metrics.positive_regimes))
    ? Number(metrics.positive_regimes)
    : regimeValues.filter((value) => value > 0).length;
  return {
    return: round(metrics.return), annualized: round(metrics.annualized), volatility: round(metrics.volatility),
    sharpe: round(metrics.sharpe, 2), drawdown: round(metrics.drawdown), win_rate: round(metrics.win_rate),
    profit_factor: round(metrics.profit_factor, 2), trades: Math.max(0, Number(metrics.trades ?? 0)),
    positive_regimes: Math.max(0, positiveRegimes),
    robustness: round(metrics.robustness ?? 0), score: round(metrics.score ?? 0, 1),
    curve, regimes, exposure_curve: exposureCurve, trade_events: tradeEvents,
  };
}

export function aggregateMetrics(results) {
  const all = results.map(normalizeMetrics);
  const avg = (key) => all.reduce((sum, value) => sum + Number(value[key] ?? 0), 0) / Math.max(all.length, 1);
  const output = { return: round(avg("return")), annualized: round(avg("annualized")), volatility: round(avg("volatility")),
    sharpe: round(avg("sharpe"), 2), drawdown: round(Math.max(...all.map((item) => item.drawdown), 0)),
    win_rate: round(avg("win_rate")), profit_factor: round(avg("profit_factor"), 2), trades: Math.round(avg("trades")),
    curve: all[0]?.curve ?? [], exposure_curve: all[0]?.exposure_curve ?? [],
    trade_events: all[0]?.trade_events ?? [] };
  const regimeNames = ["Expansion", "Compression", "Stress", "Recovery"];
  const regimeScores = Object.fromEntries(regimeNames.map((name) => [name,
    mean(all.map((item) => Number(item.regimes?.[name]?.score ?? 0))) ]));
  const scores = Object.values(regimeScores);
  const robustness = Math.min(...scores) - 0.18 * stdev(scores);
  output.score = round(clamp(58 + 34 * (0.72 * mean(scores) + 0.28 * robustness), 0, 100), 1);
  output.robustness = round(clamp(0.58 + robustness * 0.35, 0, 1), 3);
  output.positive_regimes = scores.filter((value) => value > 0).length;
  output.regime_scores = Object.fromEntries(Object.entries(regimeScores).map(([key, value]) => [key, round(value, 3)]));
  return output;
}

export function reviewDecision(metrics) {
  const hardFail = metrics.drawdown > 0.25 || metrics.trades < 12 || metrics.positive_regimes < 2;
  const release = metrics.score >= 61 && metrics.sharpe >= 0.55 && metrics.annualized >= 0.04
    && metrics.drawdown <= 0.20 && metrics.profit_factor >= 1.02
    && metrics.trades >= 18 && metrics.positive_regimes >= 3;
  if (release) return ["validation", `score ${metrics.score.toFixed(1)} · Sharpe ${metrics.sharpe.toFixed(2)} · ${metrics.positive_regimes}/4 regimes`];
  if (hardFail || metrics.score < 48) return ["dropped", `hard gate failed · DD ${(metrics.drawdown * 100).toFixed(1)}% · ${metrics.trades.toFixed(0)} trades`];
  return ["rework", `evidence incomplete · score ${metrics.score.toFixed(1)} · robustness ${metrics.robustness.toFixed(2)}`];
}

export function validationDecision(development, result) {
  const retention = result.sharpe / Math.max(development.sharpe, 0.30);
  result.score = round(clamp(50 + 20 * clamp(result.sharpe / 2, -1, 1)
    + 15 * clamp(result.return / 0.10, -1, 1) + 10 * clamp((0.15 - result.drawdown) / 0.15, -1, 1)
    + 5 * clamp(result.profit_factor - 1, -1, 1), 0, 100), 1);
  result.robustness = round(clamp(0.50 + 0.25 * clamp(retention, -1, 1)
    + 0.15 * clamp((0.15 - result.drawdown) / 0.15, -1, 1), 0, 1), 3);
  result.sharpe_retention = round(retention, 3);
  result.overfit_warning = retention < 0.40 || result.drawdown > development.drawdown * 1.50;
  const hard = result.return <= 0 || result.sharpe <= 0 || result.profit_factor < 0.90 || result.drawdown > 0.20 || result.trades < 4;
  const pass = !hard && !result.overfit_warning && result.trades >= Math.max(4, Math.ceil(development.trades * .20))
    && result.sharpe >= Math.max(.30, development.sharpe * .35) && result.profit_factor >= .90
    && result.drawdown <= Math.min(.20, Math.max(.12, development.drawdown * 1.5, development.drawdown + .025))
    && result.score >= development.score * .55 && result.robustness >= .45;
  return pass ? ["released", `remote holdout passed; Sharpe ${result.sharpe.toFixed(2)}`]
    : hard ? ["dropped", `remote holdout hard gate failed; Sharpe ${result.sharpe.toFixed(2)}`]
      : ["rework", `remote holdout did not generalize; Sharpe retention ${(retention * 100).toFixed(0)}%`];
}

export function comparison(legacy, remote) {
  const delta = (key) => round(Number(remote?.[key] ?? 0) - Number(legacy?.[key] ?? 0));
  const returns = (curve) => (curve ?? []).slice(1).map((value, index) => Number(value) / Number(curve[index]) - 1).filter(Number.isFinite);
  const left = returns(legacy?.curve); const right = returns(remote?.curve);
  const count = Math.min(left.length, right.length);
  let correlation = null;
  if (count > 1) {
    const a = left.slice(-count); const b = right.slice(-count); const ma = mean(a); const mb = mean(b);
    const covariance = mean(a.map((value, index) => (value - ma) * (b[index] - mb)));
    const denominator = stdev(a) * stdev(b);
    correlation = denominator ? round(covariance / denominator, 4) : null;
  }
  const legacyExposure = legacy?.exposure_curve ?? [];
  const remoteExposure = remote?.exposure_curve ?? [];
  const exposureCount = Math.min(legacyExposure.length, remoteExposure.length);
  const directionAlignment = exposureCount
    ? round(legacyExposure.slice(-exposureCount).filter((value, index) => Math.sign(value)
      === Math.sign(remoteExposure.slice(-exposureCount)[index])).length / exposureCount, 4)
    : null;
  const legacyTrades = (legacy?.trade_events ?? []).map((item) => item.direction);
  const remoteTrades = (remote?.trade_events ?? []).map((item) => item.direction);
  const tradeCount = Math.min(legacyTrades.length, remoteTrades.length);
  const tradeDirectionAlignment = tradeCount
    ? round(legacyTrades.slice(0, tradeCount).filter((value, index) => value === remoteTrades[index]).length / tradeCount, 4)
    : legacyTrades.length === remoteTrades.length ? 1 : 0;
  return { legacy: legacy ?? null, remote: remote ?? null,
    deltas: { return: delta("return"), sharpe: delta("sharpe"), drawdown: delta("drawdown"), trades: delta("trades") },
    return_correlation: correlation, signal_direction_alignment: directionAlignment,
    trade_direction_alignment: tradeDirectionAlignment,
    legacy_trade_count: legacyTrades.length, remote_fill_count: remoteTrades.length,
    expected_fill_timing: "next_bar_open",
    unexplained_differences: tradeDirectionAlignment < .95 ? ["trade direction sequence differs beyond fill timing"] : [] };
}
