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

/**
 * The v2 contract is intentionally separate from EXECUTION_CONFIG.  Existing
 * persisted v1 artifacts can therefore still be replayed while callers move
 * to the multi-symbol intraday runner.
 */
export const BACKTEST_CONTRACT_V2 = "backtest-request-v2";
export const EXECUTION_CONFIG_V2 = Object.freeze({
  version: "execution-v2",
  initial_cash: 100000,
  strategy_gross_limit: 0.005,
  fill: "next_tradable_bar_open",
  allow_short: true,
  no_overnight: true,
  annualization: { bar: 252 * 78, daily: 252, risk_free_rate: 0 },
  warmup: { mode: "dsl_derived", safety_bars: 8 },
  costs: { commission_bps: 0, base_slippage_bps: 5, range_slippage_bps: 2, participation_slippage_bps: 8 },
  participation: { max_bar_volume_fraction: 0.10, fill_policy: "partial_or_reject" },
  stress: { enabled: true, slippage_multiplier: 2, delayed_bars: 1, missed_fill_probability: 0.05, force_session_flatten: true },
  session: { timezone: "America/New_York", regular_hours_only: true, missing_data_blocks_entries: true },
});
export const BACKTEST_BATCH_LIMITS_V2 = Object.freeze({ strategies: 12, symbols_per_strategy: 40, symbol_work_per_shard: 40 });

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
  const normalized = (raw ?? []).map((bar) => ({
    t: String(bar.t ?? ""), o: Number(bar.o ?? bar.c), h: Number(bar.h ?? bar.c),
    l: Number(bar.l ?? bar.c), c: Number(bar.c), v: Number(bar.v ?? 0),
    ...(bar.session_close ? { session_close: String(bar.session_close) } : {}),
    ...(bar.data_health ? { data_health: String(bar.data_health) } : {}),
    ...(bar.data_coverage !== undefined ? { data_coverage: Number(bar.data_coverage) } : {}),
    ...(bar.interval_minutes !== undefined ? { interval_minutes: Number(bar.interval_minutes) } : {}),
  })).filter((bar) => bar.t && Number.isFinite(bar.o) && Number.isFinite(bar.h)
    && Number.isFinite(bar.l) && Number.isFinite(bar.c) && bar.c > 0)
    .sort((left, right) => left.t.localeCompare(right.t) || stable(left).localeCompare(stable(right)));
  return normalized.filter((bar) => !seen.has(bar.t) && (seen.add(bar.t) || true));
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

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function finiteNumber(value, fallback, low, high) {
  const number = Number(value);
  return Number.isFinite(number) ? clamp(number, low, high) : fallback;
}

function canonicalSymbols(symbols) {
  return [...new Set((symbols ?? []).map((symbol) => String(symbol).toUpperCase()))]
    .filter((symbol) => /^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)).sort();
}

function canonicalBarsBySymbol(rawBarsBySymbol, { timeframe = "5Min", max_bars = Infinity } = {}) {
  const source = plainObject(rawBarsBySymbol);
  const symbols = canonicalSymbols(Object.keys(source));
  if (!symbols.length) throw new Error("Multi-symbol dataset requires at least one symbol");
  const defaultInterval = String(timeframe).toLowerCase() === "5min" ? 5 : undefined;
  return Object.fromEntries(symbols.map((symbol) => [symbol, cleanBars(source[symbol])
    .map((bar) => bar.interval_minutes === undefined && defaultInterval ? { ...bar, interval_minutes: defaultInterval } : bar)
    .slice(-Math.max(1, Number(max_bars) || 1))]));
}

function phaseBars(dataset, phase) {
  const selected = phase === "development" ? dataset.development : phase === "holdout" ? dataset.holdout : null;
  if (!selected || !Object.keys(selected).length) throw new Error(`Dataset does not contain a ${phase} slice`);
  return selected;
}

function timestampBounds(barsBySymbol) {
  const bars = Object.values(barsBySymbol).flat();
  if (!bars.length) throw new Error("Dataset slice contains no bars");
  bars.sort((left, right) => left.t.localeCompare(right.t));
  return { start: bars[0].t, end: exclusiveEnd(bars, bars.length - 1) };
}

function exclusiveEnd(bars, index) {
  if (bars[index + 1]?.t) return bars[index + 1].t;
  const current = bars[index]; const milliseconds = Math.max(1, Number(current?.interval_minutes ?? 5)) * 60_000;
  const instant = new Date(current?.t).getTime();
  return Number.isFinite(instant) ? new Date(instant + milliseconds).toISOString() : String(current?.t ?? "");
}

/**
 * Freeze an adjusted, regular-session multi-symbol snapshot.  Splitting is
 * done once per symbol and the returned development object physically has no
 * reference to the holdout object.  The aggregate hash binds every symbol
 * hash and every feed/calendar/universe revision.
 */
export async function makeMultiSymbolDataset(rawBarsBySymbol, options = {}) {
  const metadata = plainObject(options.metadata);
  const timeframe = String(options.timeframe ?? metadata.timeframe ?? "5Min");
  const all = canonicalBarsBySymbol(rawBarsBySymbol, { timeframe, max_bars: options.max_bars ?? Infinity });
  const symbolEntries = await Promise.all(Object.entries(all).map(async ([symbol, bars]) => {
    const split_index = Math.floor(bars.length * finiteNumber(options.development_ratio, .75, .50, .95));
    const development = bars.slice(0, split_index);
    const holdout = bars.slice(split_index);
    return { symbol, bars, development, holdout, split_index, sha256: await sha256(bars),
      development_sha256: await sha256(development), holdout_sha256: await sha256(holdout) };
  }));
  const symbols = symbolEntries.map((item) => item.symbol).sort();
  const universe = plainObject(metadata.universe);
  const calendar = plainObject(metadata.calendar);
  const feed = plainObject(metadata.feed);
  const manifest = {
    schema_version: 2,
    timeframe,
    adjustment: String(metadata.adjustment ?? "all"),
    session: String(metadata.session ?? "regular"),
    universe: { id: String(universe.id ?? metadata.universe_id ?? "universe-unversioned"),
      sha256: String(universe.sha256 ?? metadata.universe_sha256 ?? "unversioned"), symbols },
    calendar: { id: String(calendar.id ?? metadata.calendar_id ?? "nyse-regular"),
      revision: String(calendar.revision ?? metadata.calendar_revision ?? "unversioned"),
      sha256: String(calendar.sha256 ?? metadata.calendar_sha256 ?? "unversioned"), timezone: "America/New_York" },
    feed: { name: String(feed.name ?? metadata.feed_name ?? "iex"),
      revision: String(feed.revision ?? metadata.feed_revision ?? "unversioned") },
    data_revision: String(metadata.data_revision ?? "unversioned"),
    symbols: symbolEntries.map((item) => ({ symbol: item.symbol, sha256: item.sha256,
      development_sha256: item.development_sha256, holdout_sha256: item.holdout_sha256,
      bar_count: item.bars.length, split_index: item.split_index,
      start: item.bars.at(0)?.t ?? null, end: item.bars.at(-1)?.t ?? null })),
  };
  const aggregate = await sha256({ manifest, bars_by_symbol: all });
  const development = Object.fromEntries(symbolEntries.map((item) => [item.symbol, item.development]));
  const holdout = Object.fromEntries(symbolEntries.map((item) => [item.symbol, item.holdout]));
  const development_hash = await sha256({ manifest: aggregate, bars_by_symbol: development });
  const holdout_hash = await sha256({ manifest: aggregate, bars_by_symbol: holdout });
  return { id: `dataset-v2-${aggregate.slice(0, 24)}`, sha256: aggregate, manifest: { ...manifest, sha256: aggregate },
    development, holdout, development_hash, holdout_hash };
}

/** Return a copy suitable for a development request, with no holdout bars. */
export function developmentDatasetView(dataset) {
  const bars_by_symbol = structuredClone(phaseBars(dataset, "development"));
  return { id: dataset.id, sha256: dataset.sha256, manifest: structuredClone(dataset.manifest),
    bars_by_symbol, slice_sha256: dataset.development_hash };
}

export function dynamicWarmup(strategy, execution = EXECUTION_CONFIG_V2) {
  const safety = finiteNumber(execution?.warmup?.safety_bars, 8, 0, 64);
  if (strategy?.strategy_format === "dsl-v1") {
    validateStrategyDNA(strategy.strategy_dna);
    return Math.min(320, Number(strategy.strategy_dna.warmup_bars) + safety);
  }
  return Math.min(320, Math.max(1, finiteNumber(strategy?.warmup_bars, 52, 1, 252)) + safety);
}

/** Only documented, non-strategy execution knobs can vary between runs. */
export function approvedExecutionConfig(overrides = {}) {
  const source = plainObject(overrides);
  if (source.initial_cash !== undefined && Number(source.initial_cash) !== EXECUTION_CONFIG_V2.initial_cash) {
    throw new Error("V2 isolated starting cash is fixed at 100000");
  }
  if (source.strategy_gross_limit !== undefined && Number(source.strategy_gross_limit) !== EXECUTION_CONFIG_V2.strategy_gross_limit) {
    throw new Error("V2 strategy gross limit is fixed at 0.5%");
  }
  const costs = plainObject(source.costs); const participation = plainObject(source.participation);
  const stress = plainObject(source.stress); const warmup = plainObject(source.warmup);
  if (stress.enabled === false || stress.force_session_flatten === false) {
    throw new Error("V2 stress evaluation and forced session flattening cannot be disabled");
  }
  return {
    ...EXECUTION_CONFIG_V2,
    initial_cash: EXECUTION_CONFIG_V2.initial_cash,
    strategy_gross_limit: EXECUTION_CONFIG_V2.strategy_gross_limit,
    costs: { ...EXECUTION_CONFIG_V2.costs,
      base_slippage_bps: finiteNumber(costs.base_slippage_bps, EXECUTION_CONFIG_V2.costs.base_slippage_bps, 0, 200),
      range_slippage_bps: finiteNumber(costs.range_slippage_bps, EXECUTION_CONFIG_V2.costs.range_slippage_bps, 0, 200),
      participation_slippage_bps: finiteNumber(costs.participation_slippage_bps, EXECUTION_CONFIG_V2.costs.participation_slippage_bps, 0, 500),
      commission_bps: finiteNumber(costs.commission_bps, EXECUTION_CONFIG_V2.costs.commission_bps, 0, 100) },
    participation: { ...EXECUTION_CONFIG_V2.participation,
      max_bar_volume_fraction: finiteNumber(participation.max_bar_volume_fraction, EXECUTION_CONFIG_V2.participation.max_bar_volume_fraction, .001, .25) },
    stress: { ...EXECUTION_CONFIG_V2.stress,
      slippage_multiplier: finiteNumber(stress.slippage_multiplier, EXECUTION_CONFIG_V2.stress.slippage_multiplier, 1, 10),
      delayed_bars: Math.round(finiteNumber(stress.delayed_bars, EXECUTION_CONFIG_V2.stress.delayed_bars, 0, 10)),
      missed_fill_probability: finiteNumber(stress.missed_fill_probability, EXECUTION_CONFIG_V2.stress.missed_fill_probability, 0, .5),
      enabled: true,
      force_session_flatten: true },
    warmup: { ...EXECUTION_CONFIG_V2.warmup,
      safety_bars: Math.round(finiteNumber(warmup.safety_bars, EXECUTION_CONFIG_V2.warmup.safety_bars, 0, 64)) },
  };
}

function strategyV2(strategy, execution) {
  const dna_hash = strategy.dna_hash ?? strategy.strategy_dna?.dna_hash;
  const scope = strategy.strategy_format === "dsl-v1" ? strategy.strategy_dna?.scope : {
    mode: "time_series", universe_id: "legacy-single-symbol", universe_sha256: "legacy", symbols: [String(strategy.asset ?? "")],
    allow_long: true, allow_short: true };
  if (strategy.strategy_format === "dsl-v1") validateStrategyDNA(strategy.strategy_dna);
  const symbols = canonicalSymbols(scope?.symbols);
  if (!symbols.length || symbols.length > BACKTEST_BATCH_LIMITS_V2.symbols_per_strategy) throw new Error(`Strategy ${strategy.id} has an invalid symbol scope`);
  // Scope and warmup are verified locally before payload construction.  The
  // DSL document itself is the only strategy source sent to the v2 service.
  const envelope = strategy.strategy_format === "dsl-v1" ? {
    id: strategy.id, strategy_format: "dsl-v1", dna: strategy.strategy_dna, dna_hash,
  } : { id: strategy.id, strategy_format: "legacy-archetype-v0", asset: strategy.asset, archetype: strategy.archetype,
    params: strategy.params, dna_hash };
  return { envelope, scope: structuredClone(scope), warmup_bars: dynamicWarmup(strategy, execution) };
}

function v2Windows(phase, barsBySymbol) {
  const { start, end } = timestampBounds(barsBySymbol);
  if (phase !== "development") return [{ id: "holdout", start, end }];
  const anchor = barsBySymbol[Object.keys(barsBySymbol).sort()[0]];
  const ends = [.60, .80, 1].map((fraction, index) => index === 2
    ? anchor.length - 1 : Math.max(0, Math.floor(anchor.length * fraction) - 1));
  const rollingSize = Math.max(1, Math.floor(anchor.length * .45));
  const anchored = ends.map((final, index) => ({ id: `anchored-${index + 1}`,
    start: anchor[0]?.t ?? start, end: exclusiveEnd(anchor, final) || end }));
  const rolling = ends.map((final, index) => ({ id: `rolling-${index + 1}`,
    start: anchor[Math.max(0, final - rollingSize + 1)]?.t ?? start, end: exclusiveEnd(anchor, final) || end }));
  return [...anchored, ...rolling];
}

/**
 * Build the immutable v2 wire document. The selected bars are copied into the
 * payload; no dataset object (and therefore no holdout reference) is sent.
 */
export async function buildBacktestPayloadV2(phase, strategies, dataset, options = {}) {
  if (!["development", "holdout", "shadow"].includes(phase)) throw new Error("Unsupported v2 backtest phase");
  const actualPhase = phase === "shadow" ? "development" : phase;
  const bars_by_symbol = canonicalBarsBySymbol(phaseBars(dataset, actualPhase), { timeframe: dataset.manifest?.timeframe ?? "5Min" });
  const execution = approvedExecutionConfig(options.execution);
  const preparedStrategies = await Promise.all([...strategies].map(async (strategy) => strategyV2(
    { ...strategy, dna_hash: strategy.dna_hash ?? await frozenDna(strategy) }, execution)));
  preparedStrategies.sort((left, right) => `${left.envelope.dna_hash}:${left.envelope.id}`.localeCompare(`${right.envelope.dna_hash}:${right.envelope.id}`));
  const normalizedStrategies = preparedStrategies.map((item) => item.envelope);
  if (normalizedStrategies.length > BACKTEST_BATCH_LIMITS_V2.strategies) throw new Error("v2 batch exceeds 12 strategies");
  const available = new Set(Object.keys(bars_by_symbol));
  for (const strategy of preparedStrategies) for (const symbol of strategy.scope.symbols) {
    if (!available.has(symbol)) throw new Error(`Strategy ${strategy.envelope.id} scope symbol ${symbol} is absent from dataset`);
  }
  for (const strategy of preparedStrategies) {
    const universeId = dataset.manifest?.universe?.id ?? dataset.manifest?.universe_id;
    const universeHash = dataset.manifest?.universe?.sha256 ?? dataset.manifest?.universe_sha256;
    if (strategy.envelope.strategy_format === "dsl-v1" && (strategy.scope.universe_id !== universeId || strategy.scope.universe_sha256 !== universeHash)) {
      throw new Error(`Strategy ${strategy.envelope.id} scope does not match frozen dataset universe`);
    }
  }
  const per_symbol_hashes = Object.fromEntries(await Promise.all(Object.entries(bars_by_symbol)
    .sort(([a], [b]) => a.localeCompare(b)).map(async ([symbol, bars]) => [symbol, await sha256(bars)])));
  const slice_sha256 = await sha256(bars_by_symbol);
  const config_hash = await sha256(execution);
  const windows = v2Windows(actualPhase, bars_by_symbol);
  const datasetManifest = {
    // A development replay is intentionally insensitive to unsubmitted
    // holdout bytes. The phase-specific slice identity is still immutable and
    // can be mapped back to the sealed parent snapshot by the control plane.
    schema_version: 2, snapshot_id: `dataset-v2-${actualPhase}-${slice_sha256.slice(0, 24)}`, timeframe: String(dataset.manifest?.timeframe ?? "5Min"),
    feed: String(dataset.manifest?.feed?.name ?? dataset.manifest?.feed ?? "iex"),
    adjustment: String(dataset.manifest?.adjustment ?? "all"), session: String(dataset.manifest?.session ?? "regular"),
    universe_id: String(dataset.manifest?.universe?.id ?? dataset.manifest?.universe_id ?? "universe-unversioned"),
    universe_sha256: String(dataset.manifest?.universe?.sha256 ?? dataset.manifest?.universe_sha256 ?? "unversioned"),
    calendar_id: String(dataset.manifest?.calendar?.id ?? dataset.manifest?.calendar_id ?? "nyse-regular"),
    calendar_sha256: String(dataset.manifest?.calendar?.sha256 ?? dataset.manifest?.calendar_sha256 ?? "unversioned"),
    symbols: Object.entries(bars_by_symbol).sort(([a], [b]) => a.localeCompare(b)).map(([symbol, bars]) => ({
      symbol, start: bars.at(0)?.t ?? null, end: bars.at(-1)?.t ?? null, bar_count: bars.length, sha256: per_symbol_hashes[symbol],
    })), sha256: slice_sha256,
  };
  const shard_index = Math.max(0, Math.floor(Number(options.shard_index ?? 0)));
  const identity = { schema_version: BACKTEST_CONTRACT_V2, phase, strategies: normalizedStrategies,
    dataset: datasetManifest, bars_by_symbol, windows, execution, shard_index };
  const job_id = await sha256(identity);
  return { job_id, config_hash, slice_hash: slice_sha256, dna: normalizedStrategies,
    payload: { schema_version: BACKTEST_CONTRACT_V2, job_id, phase, strategies: normalizedStrategies,
      dataset: datasetManifest, bars_by_symbol, windows, execution } };
}

/** Stable shards: ordering changes never move a strategy between shards. */
export function shardBacktestStrategies(strategies, limits = {}) {
  const maxStrategies = Math.max(1, Math.min(BACKTEST_BATCH_LIMITS_V2.strategies, Math.floor(Number(limits.max_strategies ?? BACKTEST_BATCH_LIMITS_V2.strategies))));
  const maxSymbols = Math.max(1, Math.min(BACKTEST_BATCH_LIMITS_V2.symbols_per_strategy, Math.floor(Number(limits.max_symbols ?? BACKTEST_BATCH_LIMITS_V2.symbols_per_strategy))));
  const maxSymbolWork = Math.max(maxSymbols, Math.floor(Number(limits.max_symbol_work ?? BACKTEST_BATCH_LIMITS_V2.symbol_work_per_shard)));
  const ordered = [...strategies].map((strategy) => ({ ...strategy, _sort_hash: strategy.dna_hash ?? strategy.strategy_dna?.dna_hash ?? String(strategy.id) }))
    .sort((left, right) => `${left._sort_hash}:${left.id}`.localeCompare(`${right._sort_hash}:${right.id}`));
  const weighted = [];
  for (const strategy of ordered) {
    const symbols = strategy.strategy_dna?.scope?.symbols ?? strategy.scope?.symbols ?? [strategy.asset];
    const symbolCount = canonicalSymbols(symbols).length;
    if (symbolCount > maxSymbols) throw new Error(`Strategy ${strategy.id} exceeds ${maxSymbols} symbols`);
    weighted.push({ strategy, symbolCount });
  }
  const shards = []; let active = []; let activeWork = 0;
  for (const item of weighted) {
    if (active.length && (active.length >= maxStrategies || activeWork + item.symbolCount > maxSymbolWork)) {
      shards.push(active); active = []; activeWork = 0;
    }
    active.push(item.strategy); activeWork += item.symbolCount;
  }
  if (active.length) shards.push(active);
  return shards.map((shard) => shard.map(({ _sort_hash, ...strategy }) => strategy));
}

export async function buildBacktestPayloadShardsV2(phase, strategies, dataset, options = {}) {
  const shards = shardBacktestStrategies(strategies, options.limits);
  return Promise.all(shards.map((shard, index) => buildBacktestPayloadV2(phase, shard, dataset, { ...options, shard_index: index })
    .then((built) => ({ ...built, shard_index: index, shard_count: shards.length }))));
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
  const number = (value, digits = 4) => Number.isFinite(Number(value)) ? round(value, digits) : 0;
  const drawdownCurve = (source.drawdown_curve ?? metrics.drawdown_curve ?? [])
    .map((point) => number(point?.value ?? point, 6));
  const turnoverCurve = (source.turnover_curve ?? metrics.turnover_curve ?? [])
    .map((point) => number(point?.value ?? point, 6));
  const perSymbol = plainObject(source.per_symbol ?? metrics.per_symbol ?? source.per_symbol_metrics);
  const normalizedPerSymbol = Object.fromEntries(Object.entries(perSymbol).sort(([a], [b]) => a.localeCompare(b))
    .map(([symbol, value]) => [symbol, {
      return: number(value?.return ?? value?.net_return), sharpe: number(value?.sharpe, 2),
      drawdown: number(value?.drawdown), trades: Math.max(0, Number(value?.trades ?? 0)),
      turnover: number(value?.turnover), exposure: number(value?.exposure),
    }]));
  return {
    return: round(metrics.return ?? metrics.net_return), annualized: round(metrics.annualized ?? metrics.annualized_return),
    volatility: round(metrics.volatility ?? metrics.bar_volatility),
    sharpe: round(metrics.sharpe ?? metrics.daily_sharpe ?? metrics.bar_sharpe, 2),
    drawdown: round(metrics.drawdown ?? metrics.max_drawdown), win_rate: round(metrics.win_rate ?? metrics.hit_rate),
    profit_factor: round(metrics.profit_factor, 2), trades: Math.max(0, Number(metrics.trades ?? metrics.closed_trades ?? 0)),
    positive_regimes: Math.max(0, positiveRegimes),
    robustness: round(metrics.robustness ?? 0), score: round(metrics.score ?? 0, 1),
    curve, regimes, exposure_curve: exposureCurve, trade_events: tradeEvents,
    // v2 intraday fields.  The v1 keys above remain the stable UI contract.
    net_return: number(metrics.net_return ?? metrics.return), bar_sharpe: number(metrics.bar_sharpe ?? metrics.sharpe, 2),
    daily_sharpe: number(metrics.daily_sharpe), sortino: number(metrics.sortino ?? metrics.daily_sortino ?? metrics.bar_sortino, 2),
    calmar: number(metrics.calmar, 2), expectancy: number(metrics.expectancy), turnover: number(metrics.turnover),
    exposure: number(metrics.exposure), hit_rate: number(metrics.hit_rate ?? metrics.win_rate), tail_loss: number(metrics.tail_loss),
    drawdown_duration_bars: Math.max(0, Number(metrics.drawdown_duration_bars ?? metrics.max_drawdown_duration_bars ?? 0)),
    average_trade_duration_bars: number(metrics.average_trade_duration_bars ?? metrics.mean_trade_duration_bars),
    concentration: number(metrics.concentration ?? metrics.symbol_concentration_hhi),
    capacity_proxy: number(metrics.capacity_proxy ?? metrics.capacity_proxy_notional), drawdown_curve: drawdownCurve, turnover_curve: turnoverCurve,
    per_symbol: normalizedPerSymbol,
  };
}

/** Keep rich v2 artifacts available without making UI callers parse service shapes. */
export function normalizeBacktestResultV2(source = {}) {
  const metrics = normalizeMetrics(source);
  const ledger = {
    signals: source.signals ?? [], targets: source.targets ?? [], orders: source.orders ?? [], fills: source.fills ?? [],
    closed_trades: source.closed_trades ?? source.trades ?? [], rejected_fills: source.rejected_fills ?? [],
    session_flatten_events: source.session_flatten_events ?? [],
  };
  return {
    metrics,
    portfolio: { equity_curve: source.equity_curve ?? source.curve ?? [], drawdown_curve: source.drawdown_curve ?? [],
      signed_exposure_curve: source.exposure_curve ?? [], turnover_curve: source.turnover_curve ?? [],
      per_symbol: metrics.per_symbol },
    ledger,
    warnings: source.validation_warnings ?? source.warnings ?? [],
    provenance: { contract_version: source.contract_version ?? BACKTEST_CONTRACT_V2,
      input_hash: source.input_hash ?? null, result_hash: source.result_hash ?? null,
      engine: source.engine ?? null, dataset: source.dataset ?? null, compiler: source.compiler ?? null },
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
