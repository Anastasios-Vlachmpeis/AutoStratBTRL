/** Deterministic strategy generation, backtesting, and lifecycle supervision. */

export const REGIMES = ["Expansion", "Compression", "Stress", "Recovery"];
export const ASSETS = ["SPY", "QQQ", "IWM", "TLT"];

const NAMES = [
  "Orion Pulse", "Kestrel Drift", "Helix Break", "Cobalt Revert",
  "Nimbus Edge", "Atlas Flux", "Vega Current", "Sable Vector",
  "Aster Signal", "Parallax Run", "Ion Cascade", "Morrow Wave",
];
const ARCHETYPES = ["Momentum", "Mean reversion", "Breakout", "Volatility filter"];
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
  let price = [450, 380, 190, 100][assetIndex];
  const prices = [price];
  const labels = [];
  const specs = {
    Expansion: [0.00125, 0.0080],
    Compression: [0.00005, 0.0055],
    Stress: [-0.00085, 0.0175],
    Recovery: [0.00095, 0.0105],
  };
  const segment = Math.max(1, Math.floor(length / 4));
  const assetVolatility = [1.0, 1.15, 0.62, 0.35][assetIndex];
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

function signal(strategy, prices) {
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
  const returns = [];
  const start = Math.max(52, prices.length - window - 1);
  let priorPosition = 0;
  for (let index = start; index < prices.length - 1; index += 1) {
    const rawSignal = signal(strategy, prices.slice(0, index + 1));
    const position = rawSignal > 0 ? strategy.params.position_size : 0;
    const marketReturn = prices[index + 1] / prices[index] - 1;
    const cost = Math.abs(position - priorPosition) * 0.0005;
    returns.push(position * marketReturn - cost);
    priorPosition = position;
  }
  return { signal: signal(strategy, prices) > 0 ? 1 : 0, returns };
}

export function backtest(strategy, prices, regimes) {
  const size = strategy.params.position_size;
  let equity = 1;
  const curve = [equity];
  const returns = [];
  const tradeReturns = [];
  const regimeReturns = Object.fromEntries(REGIMES.map((name) => [name, []]));
  let priorPosition = 0;
  const warmup = 52;

  for (let index = warmup; index < prices.length - 1; index += 1) {
    const position = signal(strategy, prices.slice(0, index + 1)) * size;
    const marketReturn = prices[index + 1] / prices[index] - 1;
    const cost = Math.abs(position - priorPosition) * 0.0005;
    const daily = position * marketReturn - cost;
    equity *= Math.max(0.01, 1 + daily);
    curve.push(equity);
    returns.push(daily);
    regimeReturns[regimes[index]].push(daily);
    if (position !== priorPosition) tradeReturns.push(daily);
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
  if (archetype === "Momentum") {
    const fast = rng.integer(5, 14);
    return { fast, slow: rng.integer(fast + 12, fast + 38), threshold: round(rng.between(0.001, 0.008), 4), position_size: size };
  }
  if (archetype === "Mean reversion") {
    return { lookback: rng.integer(12, 34), entry_z: round(rng.between(0.75, 1.75), 2), exit_z: 0.35, position_size: size };
  }
  if (archetype === "Breakout") {
    return { lookback: rng.integer(12, 38), buffer: round(rng.between(0.0005, 0.006), 4), position_size: size };
  }
  return { lookback: rng.integer(9, 24), vol_ceiling: round(rng.between(0.16, 0.42), 2), threshold: round(rng.between(0.004, 0.018), 3), position_size: size };
}

function newStrategy(state, parent = null) {
  const strategyId = `AX-${String(state.cycle).padStart(2, "0")}-${String(state.nextId).padStart(3, "0")}`;
  const rng = new SeededRandom(state.seed + state.nextId * 103 + state.cycle);
  state.nextId += 1;
  const archetype = parent ? parent.archetype : rng.pick(ARCHETYPES);
  const asset = parent ? parent.asset : rng.pick(ASSETS);
  const params = parent ? clone(parent.params) : parameters(archetype, rng);

  if (parent) {
    const mutable = Object.keys(params).filter((key) => key !== "position_size");
    const key = rng.pick(mutable);
    params[key] = Number.isInteger(params[key])
      ? Math.max(3, Math.round(params[key] * rng.pick([0.84, 1.16])))
      : round(params[key] * rng.pick([0.88, 1.12]), 4);
    params.position_size = round(clamp(params.position_size * 0.92, 0.2, 1), 2);
  }
  const name = `${NAMES[(state.nextId - 1) % NAMES.length]} ${String.fromCharCode(65 + state.cycle % 26)}${state.nextId % 10}`;
  return {
    id: strategyId,
    name,
    archetype,
    asset,
    params,
    state: "generated",
    generation: parent ? parent.generation + 1 : 1,
    parent: parent?.id ?? null,
    backtests: 0,
    metrics: null,
    validation: null,
    monitor: { returns: [], streak: 0, adjustments: 0, sharpe: null, drawdown: null, ratio: null },
  };
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

export function reviewCandidates(state, bootstrap = false) {
  const candidates = state.strategies.filter((item) => ["generated", "rework"].includes(item.state));
  if (!candidates.length) {
    if (!bootstrap) event(state, "REVIEW", "No candidates waiting", "Generate a new cohort or reproduce a released strategy first.");
    return;
  }
  const validationPool = [];
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
    event(state, nextState === "validation" ? "PROMOTE" : nextState === "dropped" ? "DROP" : "REWORK", `${strategy.name} → ${nextState}`, reason);
  }
  validationPool.sort((left, right) => right.metrics.score - left.metrics.score).slice(3).forEach((strategy) => {
    strategy.state = "rework";
    event(state, "REWORK", `${strategy.name} held`, "Release cap reached; retained for the next evidence cycle.");
  });
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

export function reviewCandidatesWithBars(state, barsBySymbol) {
  const candidates = state.strategies.filter((item) => ["generated", "rework"].includes(item.state));
  if (!candidates.length) {
    event(state, "REVIEW", "No candidates waiting", "Generate a new cohort or reproduce a released strategy first.");
    return;
  }
  const validationPool = [];
  for (const strategy of candidates) {
    const allPrices = (barsBySymbol[strategy.asset] ?? []).map((bar) => Number(bar.c)).filter((value) => Number.isFinite(value) && value > 0);
    if (allPrices.length < 400) {
      strategy.state = "rework";
      event(state, "REWORK", `${strategy.name} waiting for data`, `Only ${allPrices.length} Alpaca daily bars were available.`);
      continue;
    }
    const prices = allPrices.slice(-600);
    const developmentEnd = Math.floor(prices.length * 0.75);
    const development = prices.slice(0, developmentEnd);
    const windowSize = Math.max(140, Math.floor(development.length * 0.68));
    const ends = [Math.floor(development.length * 0.80), Math.floor(development.length * 0.90), development.length];
    const results = ends.map((end) => {
      const windowPrices = development.slice(Math.max(0, end - windowSize), end);
      return backtest(strategy, windowPrices, marketRegimes(windowPrices));
    });
    strategy.backtests += results.length;
    strategy.metrics = aggregateResults(results);
    const [nextState, reason] = decision(strategy.metrics);
    strategy.state = nextState;
    if (nextState === "validation") validationPool.push(strategy);
    event(state, nextState === "validation" ? "PROMOTE" : nextState === "dropped" ? "DROP" : "REWORK", `${strategy.name} → ${nextState}`, `${reason} · development data only`);
  }
  validationPool.sort((left, right) => right.metrics.score - left.metrics.score).slice(3).forEach((strategy) => {
    strategy.state = "rework";
    event(state, "REWORK", `${strategy.name} held`, "Release cap reached; retained for the next evidence cycle.");
  });
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
    event(state, nextState === "released" ? "RELEASE" : nextState === "dropped" ? "DROP" : "REWORK", `${strategy.name} → ${nextState}`, reason);
  }
  state.marketClock += 5;
}

export function validateCandidatesWithBars(state, barsBySymbol) {
  const candidates = state.strategies.filter((item) => item.state === "validation");
  if (!candidates.length) {
    event(state, "VALIDATE", "No strategies awaiting validation", "Supervisor approval is required before holdout testing.");
    return;
  }
  for (const strategy of candidates) {
    const allPrices = (barsBySymbol[strategy.asset] ?? []).map((bar) => Number(bar.c)).filter((value) => Number.isFinite(value) && value > 0).slice(-600);
    const validationStart = Math.floor(allPrices.length * 0.75);
    const holdout = allPrices.slice(validationStart);
    if (holdout.length < 100) {
      strategy.state = "rework";
      event(state, "REWORK", `${strategy.name} validation deferred`, `Only ${holdout.length} untouched bars were available.`);
      continue;
    }
    const result = backtest(strategy, holdout, marketRegimes(holdout));
    strategy.backtests += 1;
    strategy.validation = result;
    const [nextState, reason] = validationVerdict(strategy, result);
    strategy.state = nextState;
    event(state, nextState === "released" ? "RELEASE" : nextState === "dropped" ? "DROP" : "REWORK", `${strategy.name} → ${nextState}`, `${reason} · untouched final 25%`);
  }
  state.marketClock += 5;
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
        strategy.params.position_size = round(strategy.params.position_size * 0.80, 2);
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
    strategy.params.position_size = round(strategy.params.position_size * 0.80, 2);
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
    if (order.side === "buy") priorManaged.add(order.symbol);
    event(state, "ORDER", `${order.side.toUpperCase()} ${order.symbol} submitted`, `${order.status} · ${order.client_order_id}`);
  }
  for (const failure of cycle.order_errors ?? []) {
    event(state, "ORDER_ERROR", `${failure.symbol} order failed`, failure.message);
  }
  state.alpaca = {
    connected: true,
    fetched_at: cycle.fetched_at,
    feed: cycle.feed,
    trading_enabled: cycle.trading_enabled,
    can_trade_now: cycle.can_trade_now,
    account: cycle.account,
    positions: cycle.positions,
    open_orders: cycle.open_orders,
    clock: cycle.clock,
    proposed_orders: cycle.proposed_orders,
    submitted_orders: cycle.submitted_orders,
    order_errors: cycle.order_errors,
    managed_symbols: [...priorManaged],
    last_cycle_bucket: cycle.scheduled_bucket,
    last_bar_time: latestBarTime,
  };
  if (hasNewMarketData) state.marketClock += 21;
  event(state, "ALPACA", "Alpaca paper account synchronized", `${cycle.feed.toUpperCase()} data · ${cycle.positions.length} positions · trading ${cycle.trading_enabled ? "enabled" : "disabled"}`);
  return true;
}

export function createDemoState() {
  const state = {
    schemaVersion: 2,
    seed: 20260801,
    cycle: 14,
    marketClock: 126,
    nextId: 38,
    strategies: [],
    events: [],
    lastScheduledBucket: null,
    alpaca: { connected: false, managed_symbols: [], last_cycle_bucket: null },
  };
  generateBatch(state, 8, true);
  reviewCandidates(state, true);
  validateCandidates(state, true);
  advanceMarket(state, 2, true);
  event(state, "SYSTEM", "Foundry restored", "Durable paper environment is online.");
  return state;
}

export function migrateState(state) {
  if ((state.schemaVersion ?? 1) >= 2) return state;
  let moved = 0;
  for (const strategy of state.strategies ?? []) {
    if (strategy.validation === undefined) strategy.validation = null;
    if (ACTIVE_STATES.has(strategy.state) && !strategy.validation) {
      strategy.state = "validation";
      moved += 1;
    }
  }
  state.schemaVersion = 2;
  if (moved) event(state, "VALIDATE", "Validation gate migration applied", `${moved} previously released strategies now require untouched-data validation.`);
  return state;
}

export function snapshot(state) {
  const strategies = clone(state.strategies);
  const released = strategies.filter((item) => ACTIVE_STATES.has(item.state));
  const scored = strategies.filter((item) => item.metrics);
  const averageScore = mean(scored.map((item) => item.metrics.score));
  const simulatedCapital = released.length
    ? 10000000 * product(released.map((item) => 1 + clamp(mean(item.monitor.returns), -0.02, 0.02)))
    : 10000000;
  const capital = state.alpaca?.connected ? Number(state.alpaca.account?.equity ?? simulatedCapital) : simulatedCapital;
  return {
    meta: {
      cycle: state.cycle,
      clock: state.marketClock,
      environment: state.alpaca?.connected ? "ALPACA PAPER" : "PAPER SIM",
      schema_version: state.schemaVersion ?? 2,
      seed: state.seed,
      last_scheduled_bucket: state.lastScheduledBucket,
    },
    summary: {
      generated: strategies.filter((item) => item.state === "generated").length,
      testing: strategies.filter((item) => item.state === "rework").length,
      validation: strategies.filter((item) => item.state === "validation").length,
      released: released.length,
      dropped: strategies.filter((item) => item.state === "dropped").length,
      average_score: round(averageScore, 1),
      capital: round(capital, 2),
    },
    strategies,
    events: clone(state.events),
    alpaca: clone(state.alpaca ?? { connected: false }),
    policy: {
      release_score: 61, min_sharpe: 0.55, max_drawdown: 0.20,
      validation_min_sharpe: 0.30, validation_max_drawdown: 0.20, monitor_window: 21,
    },
  };
}
