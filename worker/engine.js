/** Deterministic strategy generation, backtesting, and lifecycle supervision. */

import { buildStrategyDNA, evaluateLatestTarget, evaluateStrategyTargets } from "./dsl.js";
import { DSL_FAMILIES, buildGeneratedStrategyDNA } from "./dsl-generation.js";
import { emptyResearchState, ensureResearchState, publicResearchState } from "./research-contract.js";
import { INITIAL_UNIVERSE_SYMBOLS } from "./universe.js";

export const REGIMES = ["Expansion", "Compression", "Stress", "Recovery"];
export const ASSETS = [...INITIAL_UNIVERSE_SYMBOLS];
export const CURRENT_SCHEMA_VERSION = 10;

const NAMES = [
  "Orion Pulse", "Kestrel Drift", "Helix Break", "Cobalt Revert",
  "Nimbus Edge", "Atlas Flux", "Vega Current", "Sable Vector",
  "Aster Signal", "Parallax Run", "Ion Cascade", "Morrow Wave",
];
const ARCHETYPES = DSL_FAMILIES;
const ACTIVE_STATES = new Set(["released", "healthy", "watch", "adjusted"]);

class SeededRandom {
  constructor(seed) {
    this.state = seed >>> 0;
  }

  next() {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }

  between(low, high) {
    return low + this.next() * (high - low);
  }

  integer(low, high) {
    return Math.floor(this.between(low, high + 1));
  }

  gaussian() {
    let value = 0;
    for (let index = 0; index < 12; index += 1) value += this.next();
    return value - 6;
  }

  pick(values) {
    return values[Math.floor(this.next() * values.length)];
  }
}

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const stdev = (values) => {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
};
const round = (value, digits = 4) => Number(value.toFixed(digits));
const product = (values) => values.reduce((result, value) => result * value, 1);
const clone = (value) => structuredClone(value);

export function marketSeries(seed, length = 420, assetIndex = 0) {
  const rng = new SeededRandom(seed * 97 + assetIndex * 7919);
  let price = [450, 380, 190, 100][assetIndex % 4];
  const prices = [price];
  const labels = [];
  const specs = {
    Expansion: [0.00125, 0.0080],
    Compression: [0.00005, 0.0055],
    Stress: [-0.00085, 0.0175],
    Recovery: [0.00095, 0.0105],
  };
  const segment = Math.max(1, Math.floor(length / 4));
  const assetVolatility = [1.0, 1.15, 0.62, 0.35][assetIndex % 4];
  let memory = 0;

  for (let index = 0; index < length - 1; index += 1) {
    const regime = REGIMES[Math.min(Math.floor(index / segment), 3)];
    const [drift, volatility] = specs[regime];
    const noise = rng.gaussian();
    memory = regime === "Compression" ? -0.42 * memory + noise : 0.12 * memory + noise;
    const cyclical = Math.sin(index / 17 + assetIndex) * 0.0007;
    const dailyReturn = drift + cyclical + volatility * assetVolatility * memory;
    price = Math.max(0.01, price * (1 + clamp(dailyReturn, -0.16, 0.16)));
    prices.push(price);
    labels.push(regime);
  }
  labels.push(labels.at(-1));
  return { prices, labels };
}

function strategyFormat(strategy) {
  return strategy?.strategy_format === "dsl-v1" && strategy?.strategy_dna ? "dsl-v1" : "legacy-archetype-v0";
}

function barsForEvaluation(values) {
  if (!Array.isArray(values)) return [];
  const start = new Date("2026-01-05T14:30:00Z");
  let cursor = new Date(start);
  if (values.every((item) => item && typeof item === "object")) return values.map((item) => {
    while ([0, 6].includes(cursor.getUTCDay())) cursor.setUTCDate(cursor.getUTCDate() + 1);
    const point = {
      ...item, t: item.t ?? cursor.toISOString(), o: Number(item.o ?? item.c), h: Number(item.h ?? item.c),
      l: Number(item.l ?? item.c), c: Number(item.c), v: Number(item.v ?? 0),
    };
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    return point;
  });
  return values.map((value) => {
    while ([0, 6].includes(cursor.getUTCDay())) cursor.setUTCDate(cursor.getUTCDate() + 1);
    const point = { t: cursor.toISOString(), o: Number(value), h: Number(value), l: Number(value), c: Number(value), v: 1 };
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    return point;
  });
}

function signal(strategy, prices) {
  if (strategyFormat(strategy) === "dsl-v1") {
    return Math.sign(evaluateLatestTarget(strategy.strategy_dna, barsForEvaluation(prices)));
  }
  const params = strategy.params;
  if (strategy.archetype === "Momentum") {
    if (prices.length < params.slow) return 0;
    const fast = mean(prices.slice(-params.fast));
    const slow = mean(prices.slice(-params.slow));
    const delta = fast / slow - 1;
    return delta > params.threshold ? 1 : delta < -params.threshold ? -1 : 0;
  }
  if (strategy.archetype === "Mean reversion") {
    if (prices.length < params.lookback) return 0;
    const window = prices.slice(-params.lookback);
    const sigma = stdev(window) || 1;
    const zscore = (prices.at(-1) - mean(window)) / sigma;
    return zscore > params.entry_z ? -1 : zscore < -params.entry_z ? 1 : 0;
  }
  if (strategy.archetype === "Breakout") {
    if (prices.length <= params.lookback) return 0;
    const prior = prices.slice(-params.lookback - 1, -1);
    const current = prices.at(-1);
    return current > Math.max(...prior) * (1 + params.buffer)
      ? 1
      : current < Math.min(...prior) * (1 - params.buffer) ? -1 : 0;
  }
  if (prices.length < params.lookback + 1) return 0;
  const returns = [];
  for (let index = prices.length - params.lookback + 1; index < prices.length; index += 1) {
    returns.push(prices[index] / prices[index - 1] - 1);
  }
  const realized = stdev(returns) * Math.sqrt(252);
  const trend = prices.at(-1) / prices.at(-params.lookback) - 1;
  if (realized > params.vol_ceiling) return 0;
  return trend > params.threshold ? 1 : trend < -params.threshold ? -1 : 0;
}

export function latestSignal(strategy, prices) {
  return signal(strategy, prices);
}

export function evaluateStrategyWindow(strategy, prices, window = 21) {
  if (strategyFormat(strategy) === "dsl-v1") {
    const bars = barsForEvaluation(prices);
    const targets = evaluateStrategyTargets(strategy.strategy_dna, bars).targets;
    const returns = [];
    const start = Math.max(52, bars.length - window - 1);
    let priorPosition = 0;
    for (let index = start; index < bars.length - 1; index += 1) {
      const position = targets[index] * Number(strategy.risk_multiplier ?? 1);
      const marketReturn = bars[index + 1].c / bars[index].c - 1;
      const cost = Math.abs(position - priorPosition) * 0.0005;
      returns.push(position * marketReturn - cost);
      priorPosition = position;
    }
    return { signal: Math.sign(targets.at(-1) ?? 0), target: targets.at(-1) ?? 0, returns };
  }
  const returns = [];
  const start = Math.max(52, prices.length - window - 1);
  let priorPosition = 0;
  for (let index = start; index < prices.length - 1; index += 1) {
    const rawSignal = signal(strategy, prices.slice(0, index + 1));
    const position = rawSignal * strategy.params.position_size;
    const marketReturn = prices[index + 1] / prices[index] - 1;
    const cost = Math.abs(position - priorPosition) * 0.0005;
    returns.push(position * marketReturn - cost);
    priorPosition = position;
  }
  return { signal: signal(strategy, prices), returns };
}

export function backtest(strategy, prices, regimes) {
  const bars = barsForEvaluation(prices);
  const closePrices = bars.map((bar) => bar.c);
  const dslTargets = strategyFormat(strategy) === "dsl-v1"
    ? evaluateStrategyTargets(strategy.strategy_dna, bars).targets : null;
  const size = strategy.params.position_size;
  let equity = 1;
  const curve = [equity];
  const returns = [];
  const tradeReturns = [];
  const tradeEvents = [];
  const exposureCurve = [];
  const regimeReturns = Object.fromEntries(REGIMES.map((name) => [name, []]));
  let priorPosition = 0;
  const warmup = 52;

  for (let index = warmup; index < closePrices.length - 1; index += 1) {
    const position = dslTargets
      ? dslTargets[index] * Number(strategy.risk_multiplier ?? 1)
      : signal(strategy, closePrices.slice(0, index + 1)) * size;
    const marketReturn = closePrices[index + 1] / closePrices[index] - 1;
    const cost = Math.abs(position - priorPosition) * 0.0005;
    const daily = position * marketReturn - cost;
    equity *= Math.max(0.01, 1 + daily);
    curve.push(equity);
    returns.push(daily);
    regimeReturns[regimes[index]].push(daily);
    exposureCurve.push(round(position, 6));
    if (position !== priorPosition) {
      tradeReturns.push(daily);
      tradeEvents.push({ signal_index: index, fill_index: index + 1,
        direction: position > priorPosition ? "buy" : "sell", from: round(priorPosition, 6), to: round(position, 6) });
    }
    priorPosition = position;
  }

  let peak = curve[0];
  let maxDrawdown = 0;
  for (const point of curve) {
    peak = Math.max(peak, point);
    maxDrawdown = Math.max(maxDrawdown, 1 - point / peak);
  }
  const totalReturn = equity - 1;
  const annualized = Math.max(equity, 0.01) ** (252 / Math.max(returns.length, 1)) - 1;
  const volatility = stdev(returns) * Math.sqrt(252);
  const sharpe = mean(returns) / Math.max(stdev(returns), 0.0001) * Math.sqrt(252);
  const wins = tradeReturns.filter((value) => value > 0);
  const losses = tradeReturns.filter((value) => value < 0);
  const profitFactor = wins.reduce((sum, value) => sum + value, 0)
    / Math.max(Math.abs(losses.reduce((sum, value) => sum + value, 0)), 0.0001);
  const regimeSummary = {};

  for (const [name, values] of Object.entries(regimeReturns)) {
    const regimeEquity = product(values.map((value) => 1 + value));
    const regimeTotal = regimeEquity - 1;
    const regimeSharpe = mean(values) / Math.max(stdev(values), 0.0001) * Math.sqrt(252);
    let localEquity = 1;
    let localPeak = 1;
    let localDrawdown = 0;
    for (const value of values) {
      localEquity *= 1 + value;
      localPeak = Math.max(localPeak, localEquity);
      localDrawdown = Math.max(localDrawdown, 1 - localEquity / localPeak);
    }
    const score = 0.48 * clamp(regimeSharpe / 2, -1, 1)
      + 0.30 * clamp(regimeTotal / 0.10, -1, 1)
      + 0.22 * clamp((0.18 - localDrawdown) / 0.18, -1, 1);
    regimeSummary[name] = {
      return: round(regimeTotal, 5),
      sharpe: round(regimeSharpe, 3),
      drawdown: round(localDrawdown, 5),
      score: round(score, 4),
    };
  }

  const sampleEvery = Math.max(1, Math.floor(curve.length / 80));
  return {
    return: round(totalReturn, 5),
    annualized: round(annualized, 5),
    volatility: round(volatility, 5),
    sharpe: round(sharpe, 3),
    drawdown: round(maxDrawdown, 5),
    win_rate: round(wins.length / Math.max(tradeReturns.length, 1), 4),
    profit_factor: round(Math.min(profitFactor, 9.99), 3),
    trades: tradeReturns.length,
    trade_events: tradeEvents,
    exposure_curve: exposureCurve,
    regimes: regimeSummary,
    curve: curve.filter((_, index) => index % sampleEvery === 0).map((point) => round(point, 5)),
  };
}

function aggregateResults(results) {
  const metricNames = ["return", "annualized", "volatility", "sharpe", "drawdown", "win_rate", "profit_factor", "trades"];
  const summary = Object.fromEntries(metricNames.map((metric) => [metric, round(mean(results.map((result) => Number(result[metric]))), 4)]));
  const regimeScores = Object.fromEntries(REGIMES.map((regime) => [regime, mean(results.map((result) => result.regimes[regime].score))]));
  const scoreValues = Object.values(regimeScores);
  const robustness = Math.min(...scoreValues) - 0.18 * stdev(scoreValues);
  const rawScore = 58 + 34 * (0.72 * mean(scoreValues) + 0.28 * robustness);
  summary.score = round(clamp(rawScore, 0, 100), 1);
  summary.robustness = round(clamp(0.58 + robustness * 0.35, 0, 1), 3);
  summary.positive_regimes = scoreValues.filter((value) => value > 0).length;
  summary.regime_scores = Object.fromEntries(Object.entries(regimeScores).map(([key, value]) => [key, round(value, 3)]));
  summary.curve = results[0].curve;
  summary.trade_events = results[0].trade_events ?? [];
  summary.exposure_curve = results[0].exposure_curve ?? [];
  return summary;
}

function event(state, kind, title, detail) {
  state.events.unshift({
    kind,
    title,
    detail,
    time: new Date().toISOString().slice(11, 16),
  });
  state.events = state.events.slice(0, 28);
}

function parameters(archetype, rng) {
  const size = round(rng.between(0.42, 0.90), 2);
  if (archetype === "Dual average trend") {
    const fast = rng.integer(5, 14);
    return { fast, slow: rng.integer(fast + 12, fast + 38), threshold: round(rng.between(0.001, 0.008), 4), position_size: size };
  }
  if (archetype === "Residual reversion") {
    return { lookback: rng.integer(12, 34), entry_z: round(rng.between(0.75, 1.75), 2), exit_z: 0.35, position_size: size };
  }
  if (archetype === "Range expansion") {
    return { lookback: rng.integer(12, 38), buffer: round(rng.between(0.0005, 0.006), 4), position_size: size };
  }
  return { lookback: rng.integer(9, 24), vol_ceiling: round(rng.between(0.16, 0.42), 2), threshold: round(rng.between(0.004, 0.018), 3), position_size: size };
}

const MAX_REWORK_ATTEMPTS = 3;

function emptyRework(attempt = 0, history = []) {
  return {
    attempt,
    max_attempts: MAX_REWORK_ATTEMPTS,
    diagnosis: null,
    source_stage: null,
    change: null,
    history: clone(history),
  };
}

function newStrategy(state, parent = null, mutateParent = true) {
  const strategyId = `AX-${String(state.cycle).padStart(2, "0")}-${String(state.nextId).padStart(3, "0")}`;
  const rng = new SeededRandom(state.seed + state.nextId * 103 + state.cycle);
  state.nextId += 1;
  if (parent && strategyFormat(parent) !== "dsl-v1") throw new Error("Legacy strategies are replay-only and cannot create new autonomous DNA");
  const archetype = parent ? parent.archetype : rng.pick(ARCHETYPES);
  const asset = parent ? parent.asset : rng.pick(ASSETS);
  const params = parent ? clone(parent.params) : parameters(archetype, rng);

  if (parent && mutateParent) {
    const mutable = Object.keys(params).filter((key) => key !== "position_size");
    const key = rng.pick(mutable);
    params[key] = Number.isInteger(params[key])
      ? Math.max(3, Math.round(params[key] * rng.pick([0.84, 1.16])))
      : round(params[key] * rng.pick([0.88, 1.12]), 4);
    params.position_size = round(clamp(params.position_size * 0.92, 0.2, 1), 2);
  }
  const name = `${NAMES[(state.nextId - 1) % NAMES.length]} ${String.fromCharCode(65 + state.cycle % 26)}${state.nextId % 10}`;
  const generation = parent ? parent.generation + 1 : 1;
  const creationSeed = state.seed + (state.nextId - 1) * 103 + state.cycle;
  let built;
  if (parent && !DSL_FAMILIES.includes(archetype)) {
    const document = clone(parent.strategy_dna);
    delete document.strategy_id; delete document.dna_hash;
    document.lineage = { trial_id: strategyId, generation,
      parent_strategy_id: parent.strategy_dna.strategy_id, creation_seed: creationSeed >>> 0 };
    const tunable = document.features.filter((node) => node.op === "constant"
      && Number.isFinite(Number(node.params?.value)) && ![0, 1, -1].includes(Number(node.params.value)));
    const node = tunable[creationSeed % Math.max(tunable.length, 1)];
    if (node) node.params.value = round(Number(node.params.value) * (generation % 2 ? .88 : 1.12), 8);
    else document.target.position_size = round(clamp(Number(document.target.position_size) * .90, .1, 1), 3);
    built = { dna: buildStrategyDNA(document), explanation: parent.explanation };
  } else {
    built = buildGeneratedStrategyDNA({ family: archetype, params, seed: creationSeed,
      trialId: strategyId, generation, parentStrategyId: parent?.strategy_dna?.strategy_id ?? null });
  }
  return {
    id: strategyId,
    name,
    archetype,
    asset,
    params,
    state: "generated",
    generation,
    parent: parent?.id ?? null,
    lineage_id: parent?.lineage_id ?? parent?.strategy_dna?.lineage?.strategy_id ?? built.dna.strategy_id,
    backtests: 0,
    metrics: null,
    validation: null,
    strategy_format: "dsl-v1",
    strategy_dna: built.dna,
    explanation: built.explanation,
    dna_hash: built.dna.dna_hash,
    compiler: built.dna.compiler,
    risk_multiplier: 1,
    engine_family: null,
    dataset_id: null,
    backtest_runs: {},
    rework: emptyRework(parent?.rework?.attempt ?? 0, parent?.rework?.history ?? []),
    monitor: { returns: [], streak: 0, adjustments: 0, sharpe: null, drawdown: null, ratio: null },
  };
}

function researchDisplayParams(dna) {
  const windows = dna.features.map((node) => node.params?.window ?? node.params?.lag)
    .filter((value) => Number.isFinite(value) && value > 0);
  const constants = dna.features.filter((node) => node.op === "constant")
    .map((node) => Number(node.params.value)).filter(Number.isFinite);
  return {
    position_size: Number(dna.target.position_size),
    primary_lookback: Number(windows[0] ?? dna.warmup_bars ?? 0),
    secondary_lookback: Number(windows[1] ?? windows[0] ?? dna.warmup_bars ?? 0),
    decision_level: Number(constants.find((value) => value !== 0) ?? 0),
  };
}

/** Materialize only selected evolutionary finalists into the existing lifecycle book. */
export function registerResearchFinalists(state, finalists, cohort) {
  const ordered = [...(finalists ?? [])].filter((item) => item?.dna)
    .sort((left, right) => Number(left.selection_rank ?? 999) - Number(right.selection_rank ?? 999)
      || String(left.dna_hash).localeCompare(String(right.dna_hash)));
  if (!ordered.length) return [];
  state.cycle += 1;
  const created = ordered.map((trial, index) => {
    const id = `AX-${String(state.cycle).padStart(2, "0")}-${String(state.nextId).padStart(3, "0")}`;
    state.nextId += 1;
    const dna = clone(trial.dna);
    const parentStrategy = dna.lineage.parent_strategy_id
      ? state.strategies.find((item) => item.id === dna.lineage.parent_strategy_id
        || item.strategy_dna?.strategy_id === dna.lineage.parent_strategy_id)
      : null;
    const symbols = dna.scope.symbols;
    const assetIndex = Number.parseInt(dna.dna_hash.slice(0, 8), 16) % symbols.length;
    return {
      id,
      name: `${NAMES[(state.nextId - 2 + index) % NAMES.length]} E${state.nextId % 10}`,
      archetype: trial.behavior_cluster ? `Behavior ${trial.behavior_cluster}` : `Evolved ${trial.operator ?? "grammar"}`,
      asset: symbols[assetIndex],
      params: researchDisplayParams(dna),
      state: "generated",
      generation: Number(dna.lineage.generation),
      parent: null,
      lineage_id: parentStrategy?.lineage_id ?? dna.lineage.parent_strategy_id ?? dna.strategy_id,
      trial_id: trial.trial_id,
      cohort_id: cohort.cohort_id,
      selection_rank: Number(trial.selection_rank ?? index + 1),
      fitness: clone(trial.fitness ?? null),
      behavior_hash: trial.behavior_hash ?? null,
      behavior_cluster: trial.behavior_cluster ?? null,
      backtests: 0,
      metrics: null,
      validation: null,
      strategy_format: "dsl-v1",
      strategy_dna: dna,
      explanation: trial.explanation ?? null,
      dna_hash: dna.dna_hash,
      compiler: dna.compiler,
      risk_multiplier: 1,
      engine_family: null,
      dataset_id: null,
      backtest_runs: {},
      rework: emptyRework(),
      monitor: { returns: [], streak: 0, adjustments: 0, sharpe: null, drawdown: null, ratio: null },
    };
  });
  state.strategies = [...created, ...state.strategies];
  event(state, "EVOLVE", `${cohort.cohort_id} selected ${created.length} finalists`,
    `${cohort.attempted ?? 0} attempts · development-only Pareto and novelty selection`);
  state.marketClock += 3;
  return created;
}

function refreshStrategyDNA(strategy, parent = null) {
  if (strategyFormat(strategy) !== "dsl-v1") return strategy;
  const built = buildGeneratedStrategyDNA({
    family: strategy.archetype, params: strategy.params,
    seed: strategy.strategy_dna.lineage.creation_seed, trialId: strategy.id,
    generation: strategy.generation, parentStrategyId: parent?.strategy_dna?.strategy_id ?? strategy.strategy_dna.lineage.parent_strategy_id,
  });
  strategy.strategy_dna = built.dna;
  strategy.explanation = built.explanation;
  strategy.dna_hash = built.dna.dna_hash;
  strategy.compiler = built.dna.compiler;
  return strategy;
}

export function generateBatch(state, count = 6, bootstrap = false) {
  state.cycle += 1;
  const created = Array.from({ length: count }, () => newStrategy(state));
  state.strategies = [...created, ...state.strategies];
  event(state, "GENERATE", `Generation ${state.cycle} seeded`, `${count} new strategy DNAs created across ${new Set(created.map((item) => item.asset)).size} markets.`);
  if (!bootstrap) state.marketClock += 3;
}

function decision(metrics) {
  const hardFail = metrics.drawdown > 0.25 || metrics.trades < 12 || metrics.positive_regimes < 2;
  const release = metrics.score >= 61 && metrics.sharpe >= 0.55 && metrics.annualized >= 0.04
    && metrics.drawdown <= 0.20 && metrics.profit_factor >= 1.02
    && metrics.trades >= 18 && metrics.positive_regimes >= 3;
  if (release) return ["validation", `score ${metrics.score.toFixed(1)} · Sharpe ${metrics.sharpe.toFixed(2)} · ${metrics.positive_regimes}/4 regimes`];
  if (hardFail || metrics.score < 48) return ["dropped", `hard gate failed · DD ${(metrics.drawdown * 100).toFixed(1)}% · ${metrics.trades.toFixed(0)} trades`];
  return ["rework", `evidence incomplete · score ${metrics.score.toFixed(1)} · robustness ${metrics.robustness.toFixed(2)}`];
}

function diagnoseDevelopment(strategy) {
  const metrics = strategy.metrics ?? {};
  if ((metrics.drawdown ?? 0) > 0.18) {
    return { code: "risk", text: "development drawdown is too close to the risk limit", key: "position_size", factor: 0.80 };
  }
  if ((metrics.trades ?? 0) < 18) {
    const key = strategy.archetype === "Residual reversion" ? "entry_z"
      : strategy.archetype === "Range expansion" ? "buffer" : "threshold";
    return { code: "frequency", text: "development produced too few independent trades", key, factor: 0.82 };
  }
  if ((metrics.positive_regimes ?? 0) < 3 || (metrics.robustness ?? 0) < 0.60) {
    const key = strategy.archetype === "Dual average trend" ? "slow" : "lookback";
    return { code: "robustness", text: "development performance is not broad enough across regimes", key };
  }
  const key = strategy.archetype === "Residual reversion" ? "entry_z"
    : strategy.archetype === "Range expansion" ? "buffer"
      : strategy.archetype === "Dual average trend" ? "threshold" : "lookback";
  return { code: "edge", text: "development edge is below the promotion threshold", key, factor: 0.88 };
}

function queueRework(strategy, sourceStage, reason) {
  const prior = strategy.rework ?? emptyRework();
  const diagnosis = ["development", "validation"].includes(sourceStage)
    ? diagnoseDevelopment(strategy).text
    : reason;
  strategy.rework = {
    ...prior,
    max_attempts: MAX_REWORK_ATTEMPTS,
    diagnosis,
    source_stage: sourceStage,
    change: prior.change ?? null,
  };
  strategy.state = "rework";
}

function mutateDevelopmentDNA(state, parent) {
  const attempt = (parent.rework?.attempt ?? 0) + 1;
  const diagnosis = diagnoseDevelopment(parent);
  const child = newStrategy(state, parent, false);
  let change;
  if (!DSL_FAMILIES.includes(parent.archetype)) {
    const parentConstants = new Map(parent.strategy_dna.features.filter((node) => node.op === "constant")
      .map((node) => [node.id, Number(node.params.value)]));
    const changed = child.strategy_dna.features.find((node) => node.op === "constant"
      && parentConstants.has(node.id) && parentConstants.get(node.id) !== Number(node.params.value));
    change = changed
      ? { parameter: `feature:${changed.id}.value`, from: parentConstants.get(changed.id), to: Number(changed.params.value) }
      : { parameter: "target.position_size", from: Number(parent.strategy_dna.target.position_size), to: Number(child.strategy_dna.target.position_size) };
    child.params = researchDisplayParams(child.strategy_dna);
  } else {
    const before = child.params[diagnosis.key];
    const numericId = Number(parent.id.split("-").at(-1));
    const factor = diagnosis.factor ?? ((numericId + attempt) % 2 === 0 ? 0.84 : 1.16);
    let after;
    if (Number.isInteger(before)) {
      after = Math.max(3, Math.round(before * factor));
      if (diagnosis.key === "slow") after = Math.max(child.params.fast + 3, after);
    } else {
      after = round(before * factor, 4);
      if (diagnosis.key === "position_size") after = round(clamp(after, 0.20, 1), 2);
      else after = Math.max(0.0001, after);
    }
    if (after === before) after = Number.isInteger(before) ? before + 1 : round(before * 0.9, 4);
    child.params[diagnosis.key] = after;
    refreshStrategyDNA(child, parent);
    change = { parameter: diagnosis.key, from: before, to: after };
  }
  const history = [
    ...(parent.rework?.history ?? []),
    {
      attempt,
      parent_id: parent.id,
      diagnosis: diagnosis.text,
      source_stage: parent.rework?.source_stage ?? "development",
      change,
      development: parent.metrics ? {
        score: parent.metrics.score,
        sharpe: parent.metrics.sharpe,
        drawdown: parent.metrics.drawdown,
        trades: parent.metrics.trades,
        robustness: parent.metrics.robustness,
      } : null,
      cycle: state.cycle,
    },
  ];
  child.rework = {
    attempt,
    max_attempts: MAX_REWORK_ATTEMPTS,
    diagnosis: diagnosis.text,
    source_stage: parent.rework?.source_stage ?? "development",
    change,
    history,
  };
  parent.state = "superseded";
  parent.rework = { ...(parent.rework ?? emptyRework()), diagnosis: diagnosis.text };
  event(state, "REWORK", `${parent.name} → ${child.name}`, `${diagnosis.text} · attempt ${attempt}/${MAX_REWORK_ATTEMPTS} · ${change.parameter} ${change.from} → ${change.to}`);
  return child;
}

export function reworkCandidates(state) {
  const created = [];
  const waiting = state.strategies.filter((item) => item.state === "rework");
  for (const parent of waiting) {
    if (["capacity", "data"].includes(parent.rework?.source_stage)) continue;
    if ((parent.rework?.attempt ?? 0) >= MAX_REWORK_ATTEMPTS) {
      parent.state = "dropped";
      event(state, "DROP", `${parent.name} rework exhausted`, `${MAX_REWORK_ATTEMPTS} traceable improvement attempts completed without promotion.`);
      continue;
    }
    created.push(mutateDevelopmentDNA(state, parent));
  }
  state.strategies = [...created, ...state.strategies];
  return created;
}

function finalizeValidationPool(state, pool) {
  const unique = [...new Map(pool.map((strategy) => [strategy.id, strategy])).values()]
    .sort((left, right) => right.metrics.score - left.metrics.score);
  unique.slice(0, 3).forEach((strategy) => {
    const wasWaiting = strategy.state === "capacity_wait";
    strategy.state = "validation";
    if (wasWaiting) event(state, "PROMOTE", `${strategy.name} → validation`, "Validation capacity opened; frozen DNA moved forward without retuning.");
  });
  unique.slice(3).forEach((strategy) => {
    strategy.state = "capacity_wait";
    strategy.capacity_wait = { reason: "bounded sealed-holdout pool", at: new Date().toISOString() };
    event(state, "CAPACITY_WAIT", `${strategy.name} held`, "Validation cap reached; frozen DNA retained without retuning.");
  });
}

export function reviewCandidates(state, bootstrap = false) {
  reworkCandidates(state);
  const candidates = state.strategies.filter((item) => item.state === "generated" || (item.state === "rework" && item.rework?.source_stage === "data"));
  const validationPool = state.strategies.filter((item) => item.state === "capacity_wait");
  if (!candidates.length && !validationPool.length) {
    if (!bootstrap) event(state, "REVIEW", "No candidates waiting", "Generate a new cohort or reproduce a released strategy first.");
    return;
  }
  for (const strategy of candidates) {
    const assetIndex = ASSETS.indexOf(strategy.asset);
    const numericId = Number(strategy.id.split("-").at(-1));
    const results = [0, 41, 83].map((offset) => {
      const market = marketSeries(state.seed + offset + numericId, 420, assetIndex);
      return backtest(strategy, market.prices, market.labels);
    });
    strategy.backtests += 3;
    strategy.metrics = aggregateResults(results);
    const [nextState, reason] = decision(strategy.metrics);
    strategy.state = nextState;
    if (nextState === "validation") validationPool.push(strategy);
    else if (nextState === "rework") queueRework(strategy, "development", reason);
    event(state, nextState === "validation" ? "PROMOTE" : nextState === "dropped" ? "DROP" : "REWORK", `${strategy.name} → ${nextState}`, reason);
  }
  finalizeValidationPool(state, validationPool);
  state.marketClock += 8;
}

function marketRegimes(prices) {
  return prices.map((price, index) => {
    if (index < 20) return "Compression";
    const window = prices.slice(index - 20, index + 1);
    const recentReturns = window.slice(1).map((value, offset) => value / window[offset] - 1);
    const trend = price / window[0] - 1;
    const volatility = stdev(recentReturns) * Math.sqrt(252);
    if (trend > 0.04) return "Expansion";
    if (trend < -0.04) return "Stress";
    if (volatility < 0.13) return "Compression";
    return "Recovery";
  });
}

export function reviewCandidatesWithBars(state, barsBySymbol, dslBarsBySymbol = barsBySymbol) {
  reworkCandidates(state);
  const candidates = state.strategies.filter((item) => item.state === "generated" || (item.state === "rework" && item.rework?.source_stage === "data"));
  const validationPool = state.strategies.filter((item) => item.state === "capacity_wait");
  if (!candidates.length && !validationPool.length) {
    event(state, "REVIEW", "No candidates waiting", "Generate a new cohort or reproduce a released strategy first.");
    return;
  }
  for (const strategy of candidates) {
    const sourceBars = strategyFormat(strategy) === "dsl-v1" ? dslBarsBySymbol : barsBySymbol;
    const allPrices = (sourceBars[strategy.asset] ?? []).map((bar) => Number(bar.c)).filter((value) => Number.isFinite(value) && value > 0);
    if (allPrices.length < 400) {
      queueRework(strategy, "data", `waiting for sufficient Alpaca history (${allPrices.length}/400 bars)`);
      event(state, "REWORK", `${strategy.name} waiting for data`, `Only ${allPrices.length} compatible Alpaca bars were available.`);
      continue;
    }
    const prices = allPrices.slice(-600);
    const developmentEnd = Math.floor(prices.length * 0.75);
    const development = prices.slice(0, developmentEnd);
    const windowSize = Math.max(140, Math.floor(development.length * 0.68));
    const ends = [Math.floor(development.length * 0.80), Math.floor(development.length * 0.90), development.length];
    const results = ends.map((end) => {
      const start = Math.max(0, end - windowSize);
      const windowBars = (sourceBars[strategy.asset] ?? []).slice(-600).slice(0, developmentEnd).slice(start, end);
      const windowPrices = windowBars.map((bar) => Number(bar.c));
      const result = backtest(strategy, windowBars, marketRegimes(windowPrices));
      result.trade_events = result.trade_events.map((trade) => ({ ...trade,
        signal_time: windowBars[trade.signal_index]?.t ?? null,
        fill_time: windowBars[trade.fill_index]?.t ?? null,
      }));
      return result;
    });
    strategy.backtests += results.length;
    strategy.metrics = aggregateResults(results);
    const [nextState, reason] = decision(strategy.metrics);
    strategy.state = nextState;
    if (nextState === "validation") validationPool.push(strategy);
    else if (nextState === "rework") queueRework(strategy, "development", reason);
    event(state, nextState === "validation" ? "PROMOTE" : nextState === "dropped" ? "DROP" : "REWORK", `${strategy.name} → ${nextState}`, `${reason} · development data only`);
  }
  finalizeValidationPool(state, validationPool);
  state.marketClock += 8;
}

function validationVerdict(strategy, result) {
  const development = strategy.metrics;
  const sharpeRetention = result.sharpe / Math.max(development.sharpe, 0.30);
  result.score = round(clamp(
    50
      + 20 * clamp(result.sharpe / 2, -1, 1)
      + 15 * clamp(result.return / 0.10, -1, 1)
      + 10 * clamp((0.15 - result.drawdown) / 0.15, -1, 1)
      + 5 * clamp(result.profit_factor - 1, -1, 1),
    0, 100,
  ), 1);
  result.robustness = round(clamp(
    0.50 + 0.25 * clamp(sharpeRetention, -1, 1) + 0.15 * clamp((0.15 - result.drawdown) / 0.15, -1, 1),
    0, 1,
  ), 3);
  result.sharpe_retention = round(sharpeRetention, 3);
  result.overfit_warning = sharpeRetention < 0.40 || result.drawdown > development.drawdown * 1.50;

  const hardFailure = result.return <= 0 || result.sharpe <= 0 || result.profit_factor < 0.90
    || result.drawdown > 0.20 || result.trades < 4;
  const requiredTrades = Math.max(4, Math.ceil(development.trades * 0.20));
  const requiredSharpe = Math.max(0.30, development.sharpe * 0.35);
  const requiredProfitFactor = 0.90;
  const drawdownLimit = Math.min(0.20, Math.max(0.12, development.drawdown * 1.50, development.drawdown + 0.025));
  const passes = !hardFailure && !result.overfit_warning
    && result.trades >= requiredTrades && result.sharpe >= requiredSharpe
    && result.profit_factor >= requiredProfitFactor && result.drawdown <= drawdownLimit
    && result.score >= development.score * 0.55 && result.robustness >= 0.45;
  if (passes) return ["released", `unseen Sharpe ${result.sharpe.toFixed(2)} · ${(result.return * 100).toFixed(1)}% return · ${result.trades} trades`];
  if (hardFailure) return ["dropped", `unseen data failed hard gate · Sharpe ${result.sharpe.toFixed(2)} · DD ${(result.drawdown * 100).toFixed(1)}%`];
  return ["rework", `unseen evidence did not generalize · Sharpe retention ${(sharpeRetention * 100).toFixed(0)}%`];
}

export function validateCandidates(state, bootstrap = false) {
  const candidates = state.strategies.filter((item) => item.state === "validation");
  if (!candidates.length) {
    if (!bootstrap) event(state, "VALIDATE", "No strategies awaiting validation", "Supervisor approval is required before holdout testing.");
    return;
  }
  for (const strategy of candidates) {
    const assetIndex = ASSETS.indexOf(strategy.asset);
    const numericId = Number(strategy.id.split("-").at(-1));
    const unseen = marketSeries(state.seed + 10007 + numericId, 420, assetIndex);
    const result = backtest(strategy, unseen.prices, unseen.labels);
    strategy.backtests += 1;
    strategy.validation = result;
    const [nextState, reason] = validationVerdict(strategy, result);
    strategy.state = nextState;
    if (nextState === "rework") queueRework(strategy, "validation", reason);
    event(state, nextState === "released" ? "RELEASE" : nextState === "dropped" ? "DROP" : "REWORK", `${strategy.name} → ${nextState}`, reason);
  }
  state.marketClock += 5;
}

export function validateCandidatesWithBars(state, barsBySymbol, options = {}, dslBarsBySymbol = barsBySymbol) {
  const family = options.family ?? null;
  const strategyIds = options.strategyIds ? new Set(options.strategyIds) : null;
  const candidates = state.strategies.filter((item) => item.state === "validation"
    && (!family || (item.engine_family ?? "legacy") === family)
    && (!strategyIds || strategyIds.has(item.id)));
  if (!candidates.length) {
    if (!options.silent) event(state, "VALIDATE", "No strategies awaiting validation", "Supervisor approval is required before holdout testing.");
    return;
  }
  for (const strategy of candidates) {
    const sourceBars = strategyFormat(strategy) === "dsl-v1" ? dslBarsBySymbol : barsBySymbol;
    const allPrices = (sourceBars[strategy.asset] ?? []).map((bar) => Number(bar.c)).filter((value) => Number.isFinite(value) && value > 0).slice(-600);
    const validationStart = Math.floor(allPrices.length * 0.75);
    const holdout = allPrices.slice(validationStart);
    if (holdout.length < 100) {
      event(state, "VALIDATE", `${strategy.name} validation deferred`, `Only ${holdout.length} untouched bars were available; frozen DNA remains in validation.`);
      continue;
    }
    const holdoutBars = (sourceBars[strategy.asset] ?? []).slice(-600).slice(validationStart);
    const result = backtest(strategy, holdoutBars, marketRegimes(holdout));
    strategy.backtests += 1;
    strategy.validation = result;
    const [nextState, reason] = validationVerdict(strategy, result);
    strategy.state = nextState;
    if (nextState === "rework") queueRework(strategy, "validation", reason);
    event(state, nextState === "released" ? "RELEASE" : nextState === "dropped" ? "DROP" : "REWORK", `${strategy.name} → ${nextState}`, `${reason} · untouched final 25%`);
  }
  if (options.advanceClock !== false) state.marketClock += 5;
}

export function reproduce(state, strategyId) {
  const parent = state.strategies.find((item) => item.id === strategyId);
  if (!parent) throw new Error("Strategy not found");
  if (!ACTIVE_STATES.has(parent.state)) throw new Error("Only a released strategy can reproduce");
  const child = newStrategy(state, parent);
  state.strategies.unshift(child);
  const changed = Object.keys(child.params).filter((key) => child.params[key] !== parent.params[key]);
  event(state, "REPRODUCE", `${child.name} born from ${parent.name}`, `Lineage ${parent.id} · mutated ${changed.join(", ")}.`);
  state.marketClock += 2;
}

export function advanceMarket(state, periods = 1, bootstrap = false) {
  const evaluatedIds = new Set();
  for (let period = 0; period < periods; period += 1) {
    state.marketClock += 21;
    const active = state.strategies.filter((item) => ACTIVE_STATES.has(item.state));
    for (const strategy of active) {
      evaluatedIds.add(strategy.id);
      const rng = new SeededRandom(state.seed + state.marketClock * 17 + Number(strategy.id.split("-").at(-1)));
      const quality = ((strategy.metrics?.score ?? 55) - 55) / 10000;
      const returns = Array.from({ length: 21 }, () => quality + rng.gaussian() * 0.009 + 0.00015);
      const monitor = strategy.monitor;
      monitor.returns = [...monitor.returns, ...returns].slice(-63);
      const observed = monitor.returns.slice(-42);
      const sharpe = mean(observed) / Math.max(stdev(observed), 0.0001) * Math.sqrt(252);
      let equity = 1;
      let peak = 1;
      let drawdown = 0;
      for (const value of observed) {
        equity *= 1 + value;
        peak = Math.max(peak, equity);
        drawdown = Math.max(drawdown, 1 - equity / peak);
      }
      const expected = Math.max((strategy.metrics?.annualized ?? 0.03) / 252, 0.0001);
      const ratio = mean(observed) / expected;
      Object.assign(monitor, { sharpe: round(sharpe, 2), drawdown: round(drawdown, 4), ratio: round(ratio, 2) });
      const failing = sharpe < 0.30 || drawdown > 0.08 || ratio < 0.45;
      monitor.streak = failing ? monitor.streak + 1 : 0;

      if (drawdown > 0.12 || (monitor.streak >= 2 && (sharpe < -0.50 || ratio < 0.10)) || monitor.adjustments >= 3) {
        strategy.state = "dropped";
        event(state, "DROP", `${strategy.name} retired`, `monitor Sharpe ${sharpe.toFixed(2)} · rolling DD ${(drawdown * 100).toFixed(1)}%`);
      } else if (monitor.streak >= 2) {
        strategy.state = "adjusted";
        if (strategyFormat(strategy) === "dsl-v1") strategy.risk_multiplier = round(Number(strategy.risk_multiplier ?? 1) * 0.80, 4);
        else strategy.params.position_size = round(strategy.params.position_size * 0.80, 2);
        monitor.adjustments += 1;
        monitor.streak = 0;
        event(state, "ADJUST", `${strategy.name} risk reduced`, "position size cut 20% after two weak monitor windows.");
      } else if (failing) {
        strategy.state = "watch";
      } else {
        if (strategy.state !== "healthy") event(state, "HEALTHY", `${strategy.name} cleared monitor`, `rolling Sharpe ${sharpe.toFixed(2)} · DD ${(drawdown * 100).toFixed(1)}%`);
        strategy.state = "healthy";
      }
    }
  }
  if (evaluatedIds.size && !bootstrap) {
    event(state, "MARKET", `Paper market advanced ${periods * 21} sessions`, `Supervisor evaluated ${evaluatedIds.size} released strategies.`);
  } else if (!evaluatedIds.size && !bootstrap) {
    event(state, "MARKET", "No strategies in market", "Release a candidate before advancing the paper market.");
  }
}

function monitorStrategy(state, strategy, newReturns) {
  const monitor = strategy.monitor;
  monitor.returns = [...monitor.returns, ...newReturns].slice(-63);
  const observed = monitor.returns.slice(-42);
  const sharpe = mean(observed) / Math.max(stdev(observed), 0.0001) * Math.sqrt(252);
  let equity = 1;
  let peak = 1;
  let drawdown = 0;
  for (const value of observed) {
    equity *= 1 + value;
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, 1 - equity / peak);
  }
  const expected = Math.max((strategy.metrics?.annualized ?? 0.03) / 252, 0.0001);
  const ratio = mean(observed) / expected;
  Object.assign(monitor, { sharpe: round(sharpe, 2), drawdown: round(drawdown, 4), ratio: round(ratio, 2) });
  const failing = sharpe < 0.30 || drawdown > 0.08 || ratio < 0.45;
  monitor.streak = failing ? monitor.streak + 1 : 0;
  if (drawdown > 0.12 || (monitor.streak >= 2 && (sharpe < -0.50 || ratio < 0.10)) || monitor.adjustments >= 3) {
    strategy.state = "dropped";
    event(state, "DROP", `${strategy.name} retired`, `Alpaca monitor Sharpe ${sharpe.toFixed(2)} · rolling DD ${(drawdown * 100).toFixed(1)}%`);
  } else if (monitor.streak >= 2) {
    strategy.state = "adjusted";
    if (strategyFormat(strategy) === "dsl-v1") strategy.risk_multiplier = round(Number(strategy.risk_multiplier ?? 1) * 0.80, 4);
    else strategy.params.position_size = round(strategy.params.position_size * 0.80, 2);
    monitor.adjustments += 1;
    monitor.streak = 0;
    event(state, "ADJUST", `${strategy.name} risk reduced`, "position size cut 20% after two weak live-data windows.");
  } else if (failing) {
    strategy.state = "watch";
  } else {
    if (strategy.state !== "healthy") event(state, "HEALTHY", `${strategy.name} cleared Alpaca monitor`, `rolling Sharpe ${sharpe.toFixed(2)} · DD ${(drawdown * 100).toFixed(1)}%`);
    strategy.state = "healthy";
  }
}

export function applyAlpacaOverview(state, overview) {
  const previous = state.alpaca ?? {};
  state.alpaca = {
    ...previous,
    connected: true,
    fetched_at: overview.fetched_at,
    account: overview.account,
    positions: overview.positions,
    open_orders: overview.open_orders,
    portfolio_history: overview.portfolio_history ?? previous.portfolio_history ?? { period: "3M", timeframe: "1D", points: [] },
    clock: overview.clock,
    feed: previous.feed ?? "iex",
    trading_enabled: previous.trading_enabled ?? false,
    short_trading_enabled: previous.short_trading_enabled ?? false,
    can_trade_now: Boolean(previous.trading_enabled && overview.clock?.is_open
      && !overview.account?.trading_blocked && !overview.account?.account_blocked),
    proposed_orders: previous.proposed_orders ?? [],
    submitted_orders: previous.submitted_orders ?? [],
    order_errors: previous.order_errors ?? [],
    safety_reasons: previous.safety_reasons ?? [],
    managed_symbols: previous.managed_symbols ?? [],
  };
  event(state, "ALPACA", "Alpaca portfolio refreshed", `${overview.positions.length} positions · ${overview.open_orders.length} open orders · read only`);
}

export function applyAlpacaCycle(state, cycle) {
  if (cycle.scheduled_bucket && state.alpaca?.last_cycle_bucket === cycle.scheduled_bucket) return false;
  const barTimes = Object.values(cycle.evaluations ?? {}).map((evaluation) => evaluation.bar_time).filter(Boolean);
  const latestBarTime = barTimes.sort().at(-1) ?? state.alpaca?.last_bar_time ?? null;
  const hasNewMarketData = latestBarTime != null && latestBarTime !== state.alpaca?.last_bar_time;
  for (const strategy of state.strategies) {
    const evaluation = cycle.evaluations?.[strategy.id];
    if (evaluation && ["released", "healthy", "watch", "adjusted"].includes(strategy.state)) {
      if (hasNewMarketData) monitorStrategy(state, strategy, evaluation.returns ?? []);
      strategy.live = {
        signal: evaluation.signal,
        latest_price: evaluation.latest_price,
        bar_time: evaluation.bar_time,
      };
    }
  }
  const priorManaged = new Set(state.alpaca?.managed_symbols ?? []);
  for (const order of cycle.submitted_orders ?? []) {
    // Reconciliation never submits against an unmanaged position, so every
    // accepted Axiom order (including a new short sale) safely establishes
    // management for that symbol.
    priorManaged.add(order.symbol);
    event(state, "ORDER", `${order.side.toUpperCase()} ${order.symbol} submitted`, `${order.status} · ${order.client_order_id}`);
  }
  for (const failure of cycle.order_errors ?? []) {
    event(state, "ORDER_ERROR", `${failure.symbol} order failed`, failure.message);
  }
  for (const safety of cycle.safety_reasons ?? []) {
    event(state, "ALPACA_SAFETY", `${safety.symbol ?? "Portfolio"} safety check`, safety.reason ?? safety.message ?? "order skipped");
  }
  state.alpaca = {
    connected: true,
    fetched_at: cycle.fetched_at,
    feed: cycle.feed,
    trading_enabled: cycle.trading_enabled,
    short_trading_enabled: cycle.short_trading_enabled ?? false,
    can_trade_now: cycle.can_trade_now,
    account: cycle.account,
    positions: cycle.positions,
    open_orders: cycle.open_orders,
    portfolio_history: cycle.portfolio_history ?? state.alpaca?.portfolio_history ?? { period: "3M", timeframe: "1D", points: [] },
    clock: cycle.clock,
    proposed_orders: cycle.proposed_orders,
    submitted_orders: cycle.submitted_orders,
    order_errors: cycle.order_errors,
    safety_reasons: cycle.safety_reasons ?? [],
    managed_symbols: [...priorManaged],
    last_cycle_bucket: cycle.scheduled_bucket,
    last_bar_time: latestBarTime,
  };
  if (hasNewMarketData) state.marketClock += 21;
  event(state, "ALPACA", "Alpaca paper account synchronized", `${cycle.feed.toUpperCase()} data · ${cycle.positions.length} positions · trading ${cycle.trading_enabled ? "enabled" : "disabled"}`);
  return true;
}

export function createDemoState() {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    seed: 20260801,
    cycle: 0,
    marketClock: 0,
    nextId: 1,
    strategies: [],
    events: [],
    lastScheduledBucket: null,
    alpaca: { connected: false, managed_symbols: [], last_cycle_bucket: null, short_trading_enabled: false, safety_reasons: [] },
    marketData: {},
    research: emptyResearchState(),
  };
}

export function migrateState(state) {
  const version = state.schemaVersion ?? 1;
  if (version < 3) return createDemoState();
  if (version >= CURRENT_SCHEMA_VERSION) return state;
  const migrated = clone(state);
  migrated.schemaVersion = CURRENT_SCHEMA_VERSION;
  migrated.strategies = (migrated.strategies ?? []).map((strategy) => ({
    ...strategy,
    strategy_format: strategy.strategy_format ?? (strategy.strategy_dna ? "dsl-v1" : "legacy-archetype-v0"),
    legacy_dna: strategy.strategy_dna ? (strategy.legacy_dna ?? null) : (strategy.legacy_dna ?? {
      id: strategy.id, asset: strategy.asset, archetype: strategy.archetype, params: clone(strategy.params ?? {}),
    }),
    strategy_dna: strategy.strategy_dna ?? null,
    explanation: strategy.explanation ?? null,
    compiler: strategy.compiler ?? strategy.strategy_dna?.compiler ?? null,
    risk_multiplier: Number(strategy.risk_multiplier ?? 1),
    rework: strategy.rework ?? emptyRework(),
    dna_hash: strategy.dna_hash ?? null,
    engine_family: strategy.engine_family ?? null,
    dataset_id: strategy.dataset_id ?? null,
    backtest_runs: strategy.backtest_runs ?? {},
    lineage_id: strategy.lineage_id ?? strategy.strategy_dna?.lineage?.parent_strategy_id ?? strategy.strategy_dna?.strategy_id ?? strategy.id,
  }));
  migrated.datasets ??= {};
  migrated.backtestArtifacts ??= {};
  migrated.marketData ??= {};
  ensureResearchState(migrated);
  return migrated;
}

export function snapshot(state) {
  const strategies = clone(state.strategies);
  const released = strategies.filter((item) => ACTIVE_STATES.has(item.state));
  const scored = strategies.filter((item) => item.metrics);
  const averageScore = mean(scored.map((item) => item.metrics.score));
  const simulatedCapital = released.length
    ? 100000 * product(released.map((item) => 1 + clamp(mean(item.monitor.returns), -0.02, 0.02)))
    : 100000;
  const capital = state.alpaca?.connected ? Number(state.alpaca.account?.equity ?? simulatedCapital) : simulatedCapital;
  return {
    meta: {
      cycle: state.cycle,
      clock: state.marketClock,
      environment: state.alpaca?.connected ? "ALPACA PAPER" : "PAPER SIM",
      schema_version: state.schemaVersion ?? CURRENT_SCHEMA_VERSION,
      seed: state.seed,
      last_scheduled_bucket: state.lastScheduledBucket,
    },
    summary: {
      generated: strategies.filter((item) => item.state === "generated").length,
      testing: strategies.filter((item) => item.state === "rework").length,
      validation: strategies.filter((item) => item.state === "validation" || item.state === "capacity_wait").length,
      released: released.length,
      dropped: strategies.filter((item) => ["development_reject", "holdout_reject", "inconclusive", "dropped"].includes(item.state)).length,
      average_score: round(averageScore, 1),
      capital: round(capital, 2),
    },
    strategies,
    events: clone(state.events),
    alpaca: clone(state.alpaca ?? { connected: false }),
    market_data: clone({
      schema_version: state.marketData?.schema_version ?? 1,
      mode: state.marketData?.mode ?? "off",
      universe: state.marketData?.universe ?? null,
      calendar: state.marketData?.calendar ?? null,
      backfill: state.marketData?.backfill ?? null,
      live: state.marketData?.live ?? null,
    }),
    research: publicResearchState(state.research),
    policy: {
      release_score: 61, min_sharpe: 0.55, max_drawdown: 0.20,
      validation_min_sharpe: 0.30, validation_max_drawdown: 0.20, monitor_window: 21,
    },
  };
}
