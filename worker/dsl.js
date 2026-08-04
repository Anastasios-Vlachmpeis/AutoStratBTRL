/**
 * Axiom Strategy DSL v1 reference compiler.  This module deliberately has no
 * dynamic imports, eval, network, or storage access: a DNA document is data,
 * never executable user code.
 */

const encoder = new TextEncoder();
export const DSL_VERSION = "1.0.0";
export const SCHEMA_SHA256 = "05dcadc08adf0172b720b59d8a7efb394b5c2429a3727deacb9d808dab7b38c3";
export const SEMANTIC_SHA256 = "5798d51c72aad04b9ccb0d8825af559bdc9419554dfbd1ab12aa4b61226ff452";
export const COMPILER_MANIFEST = Object.freeze({
  semantic_version: "1.0.0",
  schema_sha256: SCHEMA_SHA256,
  semantic_sha256: SEMANTIC_SHA256,
});

export const SUPPORTED_OPERATIONS = Object.freeze(["open", "high", "low", "close", "volume", "vwap_proxy", "constant",
  "simple_return", "log_return", "gap_return", "sma", "ema", "price_average_distance",
  "moving_average_difference", "slope", "zscore", "bollinger_distance", "rolling_high_distance",
  "rolling_low_distance", "rate_of_change", "true_range", "atr", "realized_volatility",
  "bar_range_percentile", "relative_volume", "minutes_since_open", "minutes_until_close",
  "is_finite", "is_missing", "add", "subtract", "multiply", "safe_divide", "absolute",
  "negate", "safe_log", "greater_than", "greater_equal", "less_than", "less_equal", "equal",
  "and", "or", "not"]);
const OPS = new Set(SUPPORTED_OPERATIONS);
const RAW = new Set(["open", "high", "low", "close", "volume", "vwap_proxy"]);
const BOOLEAN = new Set(["is_finite", "is_missing", "greater_than", "greater_equal", "less_than", "less_equal", "equal", "and", "or", "not"]);
const WINDOWED = new Set(["sma", "ema", "slope", "zscore", "bollinger_distance", "rolling_high_distance", "rolling_low_distance", "atr", "realized_volatility", "bar_range_percentile", "relative_volume"]);
const RETURN = new Set(["simple_return", "log_return", "rate_of_change"]);
const BINARY = new Set(["price_average_distance", "moving_average_difference", "add", "subtract", "multiply", "safe_divide", "greater_than", "greater_equal", "less_than", "less_equal", "equal", "and", "or"]);
const UNARY = new Set(["absolute", "negate", "safe_log", "is_finite", "is_missing", "not"]);
const timeParts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false,
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" });

function fail(message) { throw new Error(`DSL validation: ${message}`); }
function finite(value) { return typeof value === "number" && Number.isFinite(value); }
function missing(value) { return !finite(value); }
function number(value) { return finite(value) ? value : null; }
function bool(value) { return value === true; }
function average(values) { const xs = values.filter(finite); return xs.length === values.length && xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; }
function populationStdev(values) { const m = average(values); return m === null ? null : Math.sqrt(values.reduce((s, x) => s + (x - m) ** 2, 0) / values.length); }
function minMax(values, which) { return values.length && values.every(finite) ? Math[which](...values) : null; }
function clock(value) { const found = String(value).match(/^(\d\d):(\d\d)$/); return found ? Number(found[1]) * 60 + Number(found[2]) : NaN; }
function localClock(bar, intervalMs) {
  const parts = Object.fromEntries(timeParts.formatToParts(new Date(bar.t ?? bar.timestamp)).filter((x) => x.type !== "literal").map((x) => [x.type, x.value]));
  return { minutes: Number(parts.hour) * 60 + Number(parts.minute) + Math.round(intervalMs / 60000),
    weekday: parts.weekday, date: `${parts.year}-${parts.month}-${parts.day}` };
}

/** JSON canonicalisation compatible with Python json.dumps(sort_keys=True,separators=(",",":"), allow_nan=False). */
export function canonicalJson(value) {
  const visit = (item) => {
    if (item === null || typeof item === "boolean" || typeof item === "string") return item;
    if (typeof item === "number") { if (!Number.isFinite(item)) throw new TypeError("Canonical JSON rejects non-finite numbers"); return Object.is(item, -0) ? 0 : item; }
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === "object" && Object.getPrototypeOf(item) === Object.prototype) {
      const output = {};
      for (const key of Object.keys(item).sort()) output[key] = visit(item[key]);
      return output;
    }
    throw new TypeError("Canonical JSON accepts plain data only");
  };
  return JSON.stringify(visit(value));
}
/** Small synchronous SHA-256 implementation, kept here so Worker lifecycle code stays synchronous. */
export function sha256(value) {
  const body = typeof value === "string" ? value : canonicalJson(value);
  const bytes = [...encoder.encode(body)]; const bitLength = bytes.length * 8;
  bytes.push(0x80); while ((bytes.length % 64) !== 56) bytes.push(0);
  for (let i = 7; i >= 0; i -= 1) bytes.push(Math.floor(bitLength / 2 ** (i * 8)) & 255);
  const k = "428a2f98 71374491 b5c0fbcf e9b5dba5 3956c25b 59f111f1 923f82a4 ab1c5ed5 d807aa98 12835b01 243185be 550c7dc3 72be5d74 80deb1fe 9bdc06a7 c19bf174 e49b69c1 efbe4786 0fc19dc6 240ca1cc 2de92c6f 4a7484aa 5cb0a9dc 76f988da 983e5152 a831c66d b00327c8 bf597fc7 c6e00bf3 d5a79147 06ca6351 14292967 27b70a85 2e1b2138 4d2c6dfc 53380d13 650a7354 766a0abb 81c2c92e 92722c85 a2bfe8a1 a81a664b c24b8b70 c76c51a3 d192e819 d6990624 f40e3585 106aa070 19a4c116 1e376c08 2748774c 34b0bcb5 391c0cb3 4ed8aa4a 5b9cca4f 682e6ff3 748f82ee 78a5636f 84c87814 8cc70208 90befffa a4506ceb bef9a3f7 c67178f2".split(" ").map((x) => Number.parseInt(x, 16));
  let h = [1779033703,3144134277,1013904242,2773480762,1359893119,2600822924,528734635,1541459225];
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < bytes.length; offset += 64) {
    const w = Array(64).fill(0); for (let j = 0; j < 16; j += 1) w[j] = (bytes[offset + j * 4] << 24) | (bytes[offset + j * 4 + 1] << 16) | (bytes[offset + j * 4 + 2] << 8) | bytes[offset + j * 4 + 3];
    for (let j = 16; j < 64; j += 1) { const s0 = rotr(w[j - 15], 7) ^ rotr(w[j - 15], 18) ^ (w[j - 15] >>> 3); const s1 = rotr(w[j - 2], 17) ^ rotr(w[j - 2], 19) ^ (w[j - 2] >>> 10); w[j] = (w[j - 16] + s0 + w[j - 7] + s1) | 0; }
    let [a,b,c,d,e,f,g,hh] = h;
    for (let j = 0; j < 64; j += 1) { const S1 = rotr(e,6)^rotr(e,11)^rotr(e,25), choice = (e&f)^((~e)&g), temp1 = (hh + S1 + choice + k[j] + w[j]) | 0, S0 = rotr(a,2)^rotr(a,13)^rotr(a,22), majority = (a&b)^(a&c)^(b&c), temp2 = (S0 + majority) | 0; hh=g; g=f; f=e; e=(d+temp1)|0; d=c; c=b; b=a; a=(temp1+temp2)|0; }
    h = [ (h[0]+a)|0, (h[1]+b)|0, (h[2]+c)|0, (h[3]+d)|0, (h[4]+e)|0, (h[5]+f)|0, (h[6]+g)|0, (h[7]+hh)|0 ];
  }
  return h.map((x) => (x >>> 0).toString(16).padStart(8, "0")).join("");
}
export const hashCanonical = sha256;
export function withoutIdentity(dna) { const { strategy_id, dna_hash, ...body } = dna; return body; }

function inputCount(op) {
  if (RAW.has(op) || op === "constant" || op === "gap_return" || op === "true_range" || op === "minutes_since_open" || op === "minutes_until_close") return 0;
  if (BINARY.has(op)) return 2;
  return 1;
}
function nodeLookback(node) {
  if (["rolling_high_distance", "rolling_low_distance"].includes(node.op)) return node.params.window + 1;
  if (WINDOWED.has(node.op)) return node.params.window;
  if (RETURN.has(node.op)) return node.params.lag ?? 1;
  return 0;
}

/** Validate the data shape plus DSL semantic, causal, resource, and graph rules. */
export function validateDna(dna, { verifyIdentity = true } = {}) {
  if (!dna || typeof dna !== "object" || Array.isArray(dna)) fail("document must be an object");
  const required = ["dsl_version", "strategy_id", "dna_hash", "compiler", "lineage", "scope", "features", "entry", "exit", "cooldown", "target", "session", "risk", "warmup_bars"];
  for (const key of required) if (!(key in dna)) fail(`missing ${key}`);
  for (const key of Object.keys(dna)) if (!required.includes(key)) fail(`unknown top-level property ${key}`);
  if (dna.dsl_version !== DSL_VERSION) fail("unsupported dsl_version");
  if (!/^DSL1-[a-f0-9]{24}$/.test(dna.strategy_id) || !/^[a-f0-9]{64}$/.test(dna.dna_hash)
      || dna.strategy_id !== `DSL1-${dna.dna_hash.slice(0, 24)}`) fail("invalid identity");
  if (canonicalJson(dna) !== JSON.stringify(JSON.parse(canonicalJson(dna)))) fail("non-canonical document");
  if (!dna.compiler || Object.keys(dna.compiler).length !== 3) fail("invalid compiler");
  for (const [key, value] of Object.entries(COMPILER_MANIFEST)) if (dna.compiler?.[key] !== value) fail(`compiler ${key} mismatch`);
  if (!dna.lineage || Object.keys(dna.lineage).some((key) => !["trial_id", "generation", "parent_strategy_id", "creation_seed"].includes(key)) || !/^[A-Za-z0-9._:-]{1,120}$/.test(dna.lineage.trial_id) || !(dna.lineage.parent_strategy_id === null || /^[A-Za-z0-9._:-]{1,120}$/.test(dna.lineage.parent_strategy_id)) || !Number.isInteger(dna.lineage.generation) || dna.lineage.generation < 1 || dna.lineage.generation > 1000 || !Number.isInteger(dna.lineage.creation_seed) || dna.lineage.creation_seed < 0 || dna.lineage.creation_seed > 4294967295) fail("invalid lineage");
  const scope = dna.scope;
  if (!scope || Object.keys(scope).some((key) => !["mode", "universe_id", "universe_sha256", "symbols", "minimum_dollar_volume", "allow_long", "allow_short"].includes(key)) || scope.mode !== "time_series" || !/^[A-Za-z0-9._:-]{1,120}$/.test(scope.universe_id) || !/^[a-f0-9]{64}$/.test(scope.universe_sha256) || !finite(scope.minimum_dollar_volume) || scope.minimum_dollar_volume < 0 || scope.minimum_dollar_volume > 1e12 || !Array.isArray(scope.symbols) || !scope.symbols.length || scope.symbols.length > 40 || !scope.symbols.every((s) => /^[A-Z][A-Z0-9.-]{0,9}$/.test(s)) || new Set(scope.symbols).size !== scope.symbols.length || typeof scope.allow_long !== "boolean" || typeof scope.allow_short !== "boolean") fail("invalid scope");
  if (!scope.allow_long && !scope.allow_short) fail("scope must permit a side");
  if (!Array.isArray(dna.features) || !dna.features.length || dna.features.length > 64) fail("features must contain 1..64 nodes");
  const ids = new Map();
  for (const node of dna.features) {
    if (!node || typeof node !== "object" || Object.keys(node).some((key) => !["id", "op", "inputs", "params"].includes(key))) fail("invalid feature node shape");
    if (!/^[a-z][a-z0-9_]{0,47}$/.test(node.id) || ids.has(node.id) || !OPS.has(node.op) || !Array.isArray(node.inputs) || node.inputs.length !== inputCount(node.op) || !node.params || typeof node.params !== "object") fail(`invalid node ${node.id ?? "?"}`);
    if (Object.keys(node.params).some((key) => !["value", "window", "lag", "annualization", "epsilon"].includes(key))) fail(`invalid params ${node.id}`);
    if (node.inputs.some((id) => !/^[a-z][a-z0-9_]{0,47}$/.test(id))) fail(`invalid input ${node.id}`);
    if (node.inputs.some((id) => !ids.has(id))) fail(`${node.id} graph must be topologically ordered`);
    if (node.op === "constant" && !finite(node.params.value)) fail(`constant ${node.id} needs finite value`);
    if (WINDOWED.has(node.op) && (!Number.isInteger(node.params.window) || node.params.window < 2 || node.params.window > 252)) fail(`${node.id} needs bounded window`);
    if (RETURN.has(node.op) && (!Number.isInteger(node.params.lag ?? 1) || (node.params.lag ?? 1) < 1 || (node.params.lag ?? 1) > 252)) fail(`${node.id} needs positive causal lag`);
    if (node.params.lag !== undefined && (!Number.isInteger(node.params.lag) || node.params.lag < 0 || node.params.lag > 252)) fail(`invalid lag ${node.id}`);
    if (node.params.annualization !== undefined && (!Number.isInteger(node.params.annualization) || node.params.annualization < 1 || node.params.annualization > 100000)) fail(`invalid annualization ${node.id}`);
    if (node.params.epsilon !== undefined && (!finite(node.params.epsilon) || node.params.epsilon <= 0 || node.params.epsilon > .01)) fail(`invalid epsilon ${node.id}`);
    ids.set(node.id, node);
  }
  for (const node of ids.values()) for (const input of node.inputs) if (!ids.has(input)) fail(`unknown input ${input} in ${node.id}`);
  const visiting = new Set(), done = new Set(), ordered = [], depths = new Map(); let maxDepth = 0, derivedWarmup = 0;
  const walk = (id) => {
    if (visiting.has(id)) fail(`cycle at ${id}`); if (done.has(id)) return depths.get(id);
    visiting.add(id); const node = ids.get(id); const depth = 1 + Math.max(0, ...node.inputs.map(walk));
    visiting.delete(id); done.add(id); depths.set(id, depth); ordered.push(node); maxDepth = Math.max(maxDepth, depth);
    derivedWarmup = Math.max(derivedWarmup, nodeLookback(node) + Math.max(0, ...node.inputs.map((input) => nodeLookback(ids.get(input)))));
    return depth;
  };
  for (const id of ids.keys()) walk(id);
  const nodeType = (node) => BOOLEAN.has(node.op) ? "boolean" : "number";
  for (const node of ids.values()) {
    const types = node.inputs.map((input) => nodeType(ids.get(input)));
    if (["and", "or"].includes(node.op) && !types.every((type) => type === "boolean")) fail(`${node.id} requires boolean inputs`);
    if (node.op === "not" && types[0] !== "boolean") fail(`${node.id} requires boolean input`);
    if (["greater_than", "greater_equal", "less_than", "less_equal", "equal", "add", "subtract", "multiply", "safe_divide", "price_average_distance", "moving_average_difference"].includes(node.op) && !types.every((type) => type === "number")) fail(`${node.id} requires numeric inputs`);
    if (!["and", "or", "not", "is_finite", "is_missing"].includes(node.op) && node.inputs.length === 1 && types[0] !== "number") fail(`${node.id} requires numeric input`);
  }
  if (maxDepth > 12) fail("graph depth exceeds 12");
  if (new Set([...ids.values()].map(nodeLookback).filter(Boolean)).size > 12) fail("too many distinct lookbacks");
  for (const expression of [dna.entry.long, dna.entry.short, dna.exit.flat]) if (expression !== null && !ids.has(expression)) fail(`unknown expression ${expression}`);
  if (dna.entry.long !== null && !BOOLEAN.has(ids.get(dna.entry.long).op)) fail("long entry must be boolean");
  if (dna.entry.short !== null && !BOOLEAN.has(ids.get(dna.entry.short).op)) fail("short entry must be boolean");
  if (dna.exit.flat !== null && !BOOLEAN.has(ids.get(dna.exit.flat).op)) fail("exit must be boolean");
  if (!Number.isInteger(dna.cooldown?.bars) || dna.cooldown.bars < 0 || dna.cooldown.bars > 78) fail("invalid cooldown");
  const target = dna.target;
  if (!target || !finite(target.position_size) || target.position_size <= 0 || target.position_size > 1 || !finite(target.max_strategy_gross) || target.max_strategy_gross <= 0 || target.max_strategy_gross > .005 || !finite(target.per_symbol_cap) || target.per_symbol_cap <= 0 || target.per_symbol_cap > .005 || !["equal_weight", "unit"].includes(target.normalization) || target.ranking !== "none" || typeof target.reverse_on_opposite !== "boolean") fail("invalid target");
  if (!dna.session || dna.session.timezone !== "America/New_York" || dna.session.regular_hours_only !== true || !/^(0[9]|1[0-5]):[0-5][0-9]$/.test(dna.session.entry_cutoff) || !/^(0[9]|1[0-5]):[0-5][0-9]$/.test(dna.session.flatten_at) || clock(dna.session.entry_cutoff) > clock(dna.session.flatten_at)) fail("invalid session");
  const risk = dna.risk;
  if (!risk || !(risk.stop_loss_bps === null || (finite(risk.stop_loss_bps) && risk.stop_loss_bps >= 1 && risk.stop_loss_bps <= 1000)) || !finite(risk.max_turnover_per_day) || risk.max_turnover_per_day <= 0 || risk.max_turnover_per_day > 20 || !Number.isInteger(risk.max_concurrent_symbols) || risk.max_concurrent_symbols < 1 || risk.max_concurrent_symbols > 40 || !finite(risk.minimum_data_coverage) || risk.minimum_data_coverage < .9 || risk.minimum_data_coverage > 1 || risk.flatten_on_unhealthy_data !== true) fail("invalid risk");
  if (!Number.isInteger(dna.warmup_bars) || dna.warmup_bars !== derivedWarmup || dna.warmup_bars > 252) fail(`warmup_bars must equal derived warmup ${derivedWarmup}`);
  if (verifyIdentity && sha256(withoutIdentity(dna)) !== dna.dna_hash) fail("dna_hash does not match canonical document");
  return { ids, ordered, derived_warmup_bars: derivedWarmup, max_depth: maxDepth };
}

function history(values, i, window) { return i - window + 1 < 0 ? null : values.slice(i - window + 1, i + 1); }
function featureValue(node, values, bars, i, intervalMs) {
  const input = node.inputs.map((id) => values[id][i]); const bar = bars[i] ?? {}; const p = node.params;
  if (RAW.has(node.op)) {
    if (node.op === "vwap_proxy") return [bar.h, bar.l, bar.c].every(finite) ? (bar.h + bar.l + bar.c) / 3 : null;
    return number(bar[{ open: "o", high: "h", low: "l", close: "c", volume: "v" }[node.op]]);
  }
  if (node.op === "constant") return p.value;
  if (node.op === "minutes_since_open") return Math.max(0, localClock(bar, intervalMs).minutes - 570);
  if (node.op === "minutes_until_close") { const close = bar.session_close ? localClock({ t: bar.session_close }, 0).minutes : 960; return Math.max(0, close - localClock(bar, intervalMs).minutes); }
  if (node.op === "gap_return") return i && finite(bar.o) && finite(bars[i - 1]?.c) && bars[i - 1].c !== 0 ? bar.o / bars[i - 1].c - 1 : null;
  if (node.op === "true_range") { const prev = bars[i - 1]?.c; return [bar.h, bar.l].every(finite) ? Math.max(bar.h - bar.l, finite(prev) ? Math.abs(bar.h - prev) : 0, finite(prev) ? Math.abs(bar.l - prev) : 0) : null; }
  if (node.op === "is_finite") return finite(input[0]); if (node.op === "is_missing") return !finite(input[0]);
  if (node.op === "not") return !bool(input[0]);
  if (node.op === "and") return bool(input[0]) && bool(input[1]); if (node.op === "or") return bool(input[0]) || bool(input[1]);
  if (["greater_than", "greater_equal", "less_than", "less_equal", "equal"].includes(node.op)) {
    if (!input.every(finite)) return false;
    return ({ greater_than: input[0] > input[1], greater_equal: input[0] >= input[1], less_than: input[0] < input[1], less_equal: input[0] <= input[1], equal: input[0] === input[1] })[node.op];
  }
  if (!input.every(finite) && !WINDOWED.has(node.op)) return null;
  if (node.op === "add") return input[0] + input[1]; if (node.op === "subtract") return input[0] - input[1]; if (node.op === "multiply") return input[0] * input[1];
  if (node.op === "safe_divide") return Math.abs(input[1]) > (p.epsilon ?? 1e-12) ? input[0] / input[1] : null;
  if (node.op === "absolute") return Math.abs(input[0]); if (node.op === "negate") return -input[0]; if (node.op === "safe_log") return input[0] > 0 ? Math.log(input[0]) : null;
  if (RETURN.has(node.op)) { const lag = p.lag ?? 1; const prior = values[node.inputs[0]][i - lag]; if (!finite(input[0]) || !finite(prior) || prior === 0) return null; return node.op === "log_return" ? Math.log(input[0] / prior) : input[0] / prior - 1; }
  const x = values[node.inputs[0]]; const window = p.window; const xs = history(x, i, window);
  if (node.op === "sma") return xs ? average(xs) : null;
  if (node.op === "ema") { if (i < window - 1) return null; const seed = average(x.slice(0, window)); if (seed === null) return null; let ema = seed; for (let j = window; j <= i; j += 1) { if (!finite(x[j])) return null; ema = x[j] * 2 / (window + 1) + ema * (1 - 2 / (window + 1)); } return ema; }
  if (node.op === "price_average_distance") return input.every(finite) && input[1] !== 0 ? input[0] / input[1] - 1 : null;
  if (node.op === "moving_average_difference") return input.every(finite) ? input[0] - input[1] : null;
  if (node.op === "slope") { if (!xs || !xs.every(finite)) return null; const mid = (window - 1) / 2, denom = xs.reduce((s, _, j) => s + (j - mid) ** 2, 0); return xs.reduce((s, y, j) => s + (j - mid) * y, 0) / denom; }
  if (node.op === "zscore" || node.op === "bollinger_distance") { const m = xs && average(xs), sd = xs && populationStdev(xs); return m !== null && sd > (p.epsilon ?? 1e-12) ? (input[0] - m) / sd : null; }
  if (node.op === "rolling_high_distance" || node.op === "rolling_low_distance") { const prior = i - window >= 0 ? x.slice(i - window, i) : null; const extreme = minMax(prior ?? [], node.op === "rolling_high_distance" ? "max" : "min"); return finite(input[0]) && finite(extreme) && extreme !== 0 ? input[0] / extreme - 1 : null; }
  if (node.op === "atr") { const tr = values[node.inputs[0]]; return xs ? average(history(tr, i, window) ?? []) : null; }
  if (node.op === "realized_volatility") { if (!xs) return null; const sd = populationStdev(xs); return sd === null ? null : sd * Math.sqrt(p.annualization ?? 252); }
  if (node.op === "bar_range_percentile") { if (!xs || !finite(input[0])) return null; return xs.filter((v) => v <= input[0]).length / xs.length; }
  if (node.op === "relative_volume") { const m = xs && average(xs); return m && finite(input[0]) ? input[0] / m : null; }
  return null;
}

/** Reference graph evaluator. Its output uses null for missing numeric values and false for invalid booleans. */
export function evaluateFeatures(dna, bars, { interval_ms = 300000 } = {}) {
  const { ids, ordered } = validateDna(dna); if (!Array.isArray(bars)) throw new TypeError("bars must be an array");
  const values = Object.fromEntries([...ids.keys()].map((id) => [id, Array(bars.length).fill(null)]));
  for (let i = 0; i < bars.length; i += 1) for (const node of ordered) values[node.id][i] = featureValue(node, values, bars, i, interval_ms);
  return values;
}

/** Stateful, sequential target evaluator. Decisions occur after bar close and targets are for the next bar. */
export function evaluateTargets(dna, bars, options = {}) {
  validateDna(dna); const features = evaluateFeatures(dna, bars, options); const intervalMs = options.interval_ms ?? 300000;
  const targets = []; let side = 0, cooldown = 0, entryPrice = null, turnoverDate = null, turnover = 0;
  const grossShare = dna.target.normalization === "equal_weight"
    ? dna.target.max_strategy_gross / dna.risk.max_concurrent_symbols : dna.target.max_strategy_gross;
  const cap = dna.target.position_size * Math.min(grossShare, dna.target.per_symbol_cap);
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i] ?? {}; const session = localClock(bar, intervalMs);
    const sessionClose = bar.session_close ? localClock({ t: bar.session_close }, 0).minutes : 960;
    const regular = session.weekday !== "Sat" && session.weekday !== "Sun" && session.minutes >= 570 && session.minutes <= sessionClose;
    const healthy = (bar.data_health === undefined || bar.data_health === "healthy")
      && (bar.data_coverage === undefined || (finite(bar.data_coverage) && bar.data_coverage >= dna.risk.minimum_data_coverage));
    const value = (id) => id === null ? false : bool(features[id][i]);
    const exit = value(dna.exit.flat); const long = dna.scope.allow_long && value(dna.entry.long); const short = dna.scope.allow_short && value(dna.entry.short);
    const effectiveCutoff = Math.min(clock(dna.session.entry_cutoff), sessionClose - 15);
    const effectiveFlatten = Math.min(clock(dna.session.flatten_at), sessionClose);
    const cutoff = session.minutes > effectiveCutoff; const flatten = session.minutes >= effectiveFlatten;
    const stopped = side && dna.risk.stop_loss_bps !== null && finite(entryPrice) && finite(bar.c) && ((side > 0 && (bar.c / entryPrice - 1) * 10000 <= -dna.risk.stop_loss_bps) || (side < 0 && (entryPrice / bar.c - 1) * 10000 <= -dna.risk.stop_loss_bps));
    const shouldFlatten = !regular || !healthy || flatten || exit || stopped || (long && short);
    const priorSide = side;
    if (shouldFlatten) { if (side) cooldown = dna.cooldown.bars; side = 0; entryPrice = null; }
    else if (side === 0) { if (cooldown > 0) cooldown -= 1; else if (!cutoff && long !== short) { side = long ? 1 : -1; entryPrice = finite(bar.c) ? bar.c : null; } }
    else if (dna.target.reverse_on_opposite && ((side > 0 && short && !long) || (side < 0 && long && !short))) { side = -side; entryPrice = finite(bar.c) ? bar.c : null; }
    if (turnoverDate !== session.date) { turnoverDate = session.date; turnover = 0; }
    const requestedTurnover = Math.abs(side * cap - priorSide * cap);
    if (!shouldFlatten && turnover + requestedTurnover > dna.risk.max_turnover_per_day) side = priorSide;
    else turnover += requestedTurnover;
    targets.push(side * cap);
  }
  return { targets, features, target_unit: "fraction_of_account_equity" };
}
export function evaluateTargetsVector(dna, bars, options = {}) { return evaluateTargets(dna, bars, options); }

export function explainDna(dna) {
  const meta = validateDna(dna); const names = Object.fromEntries(dna.features.map((node) => [node.id, node.op.replaceAll("_", " ")]));
  return { summary: `${dna.scope.symbols.join(", ")}: ${dna.entry.long ? `long when ${names[dna.entry.long]}` : "no long entries"}; ${dna.entry.short ? `short when ${names[dna.entry.short]}` : "no short entries"}; flatten by ${dna.session.flatten_at}.`,
    graph: { nodes: dna.features.map((node) => ({ id: node.id, label: node.op, params: node.params })), edges: dna.features.flatMap((node) => node.inputs.map((source) => ({ source, target: node.id }))) },
    derived_warmup_bars: meta.derived_warmup_bars, complexity: { nodes: dna.features.length, depth: meta.max_depth } };
}

export function buildDna(document) {
  const base = structuredClone(document); delete base.strategy_id; delete base.dna_hash;
  base.dsl_version ??= DSL_VERSION; base.compiler ??= { ...COMPILER_MANIFEST };
  // Identity is derived from every semantic field, not from mutable display metadata.
  const hash = sha256(base); const dna = { ...base, strategy_id: `DSL1-${hash.slice(0, 24)}`, dna_hash: hash };
  validateDna(dna, { verifyIdentity: false }); return dna;
}

function template({ symbols, seed, trial, nodes, entry, warmup, positionSize }) {
  const safeTrial = String(trial).replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 120) || `trial-${seed >>> 0}`;
  return buildDna({ compiler: { ...COMPILER_MANIFEST }, lineage: { trial_id: safeTrial, generation: 1, parent_strategy_id: null, creation_seed: seed >>> 0 }, scope: { mode: "time_series", universe_id: "us-iex-liquid-40-v1", universe_sha256: "6702cf7b153c4cbbc37cd79b4a8c544456841b981fa27cdd40975fbc41d56e43", symbols, minimum_dollar_volume: 0, allow_long: true, allow_short: true }, features: nodes, entry, exit: { flat: null }, cooldown: { bars: 0 }, target: { position_size: positionSize, max_strategy_gross: .005, per_symbol_cap: .005, normalization: "unit", ranking: "none", reverse_on_opposite: true }, session: { timezone: "America/New_York", regular_hours_only: true, entry_cutoff: "15:45", flatten_at: "15:55" }, risk: { stop_loss_bps: null, max_turnover_per_day: 20, max_concurrent_symbols: 40, minimum_data_coverage: .9, flatten_on_unhealthy_data: true }, warmup_bars: warmup });
}
/** Temporary lossless-ish import path for the four current hard-coded archetypes. */
export function legacyArchetypeToDsl(strategy) {
  const p = strategy?.params ?? {}, symbol = strategy?.asset ?? "SPY", seed = strategy?.seed ?? 0, trial = strategy?.id ?? `legacy-${seed}`, size = p.position_size ?? .002;
  const close = { id: "close", op: "close", inputs: [], params: {} };
  if (strategy?.archetype === "Momentum") { const fast = p.fast ?? 10, slow = p.slow ?? 30, t = p.threshold ?? .001; return template({ symbols: [symbol], seed, trial, positionSize: size, warmup: slow, nodes: [close, { id: "fast", op: "sma", inputs: ["close"], params: { window: fast } }, { id: "slow", op: "sma", inputs: ["close"], params: { window: slow } }, { id: "delta", op: "price_average_distance", inputs: ["fast", "slow"], params: {} }, { id: "upper", op: "constant", inputs: [], params: { value: t } }, { id: "lower", op: "constant", inputs: [], params: { value: -t } }, { id: "long", op: "greater_than", inputs: ["delta", "upper"], params: {} }, { id: "short", op: "less_than", inputs: ["delta", "lower"], params: {} }], entry: { long: "long", short: "short" } }); }
  if (strategy?.archetype === "Mean reversion") { const w = p.lookback ?? 20, z = p.entry_z ?? 1.5; return template({ symbols: [symbol], seed, trial, positionSize: size, warmup: w, nodes: [close, { id: "z", op: "zscore", inputs: ["close"], params: { window: w } }, { id: "upper", op: "constant", inputs: [], params: { value: z } }, { id: "lower", op: "constant", inputs: [], params: { value: -z } }, { id: "long", op: "less_than", inputs: ["z", "lower"], params: {} }, { id: "short", op: "greater_than", inputs: ["z", "upper"], params: {} }], entry: { long: "long", short: "short" } }); }
  if (strategy?.archetype === "Breakout") { const w = p.lookback ?? 20, b = p.buffer ?? .001; return template({ symbols: [symbol], seed, trial, positionSize: size, warmup: w + 1, nodes: [close, { id: "high", op: "rolling_high_distance", inputs: ["close"], params: { window: w } }, { id: "low", op: "rolling_low_distance", inputs: ["close"], params: { window: w } }, { id: "up", op: "constant", inputs: [], params: { value: b } }, { id: "down", op: "constant", inputs: [], params: { value: -b } }, { id: "long", op: "greater_than", inputs: ["high", "up"], params: {} }, { id: "short", op: "less_than", inputs: ["low", "down"], params: {} }], entry: { long: "long", short: "short" } }); }
  // Volatility filter: trend may enter only while realized volatility is below the cap.
  const w = p.lookback ?? 20, threshold = p.threshold ?? .001, ceiling = p.vol_ceiling ?? .25;
  return template({ symbols: [symbol], seed, trial, positionSize: size, warmup: w + 1, nodes: [close, { id: "returns", op: "simple_return", inputs: ["close"], params: { lag: 1 } }, { id: "vol", op: "realized_volatility", inputs: ["returns"], params: { window: w, annualization: 252 } }, { id: "trend", op: "simple_return", inputs: ["close"], params: { lag: w } }, { id: "cap", op: "constant", inputs: [], params: { value: ceiling } }, { id: "upper", op: "constant", inputs: [], params: { value: threshold } }, { id: "lower", op: "constant", inputs: [], params: { value: -threshold } }, { id: "quiet", op: "less_than", inputs: ["vol", "cap"], params: {} }, { id: "up", op: "greater_than", inputs: ["trend", "upper"], params: {} }, { id: "down", op: "less_than", inputs: ["trend", "lower"], params: {} }, { id: "long", op: "and", inputs: ["quiet", "up"], params: {} }, { id: "short", op: "and", inputs: ["quiet", "down"], params: {} }], entry: { long: "long", short: "short" } });
}

// Deliberately explicit integration names; concise aliases remain useful to tools/tests.
export const buildStrategyDNA = buildDna;
export const validateStrategyDNA = validateDna;
export const evaluateStrategyTargets = evaluateTargets;
export const evaluateVectorTargets = evaluateTargetsVector;
export const explainStrategyDNA = explainDna;
export const legacyStrategyToDSL = legacyArchetypeToDsl;
export function evaluateLatestTarget(dna, bars, options = {}) { return evaluateTargets(dna, bars, options).targets.at(-1) ?? 0; }
