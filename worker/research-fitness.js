/**
 * Development-only vector research screen.
 *
 * This module is deliberately pure: it reads only the bars passed to it and
 * never accepts a second data partition.  It is cheap evidence used to decide
 * which candidates deserve an exact engine run, not a promotion mechanism.
 */
import { evaluateVectorTargets, hashCanonical, validateStrategyDNA } from "./dsl.js";

const COST_PER_TURNOVER = 0.0005; // 5 bps paid on each unit of account turnover
const BARS_PER_YEAR = 19656;
const EPSILON = 1e-12;

const finite = (value) => typeof value === "number" && Number.isFinite(value);
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const average = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const deviation = (values) => {
  if (values.length < 2) return 0;
  const centre = average(values);
  return Math.sqrt(average(values.map((value) => (value - centre) ** 2)));
};
const sortedUnique = (values) => [...new Set(values)].sort();
const stableId = (record) => String(record?.dna_hash ?? record?.trial?.dna?.dna_hash ?? "~");
const recordKey = (record) => `${stableId(record)}:${String(record?.trial_id ?? "")}`;

function requiredSymbols(trial, barsBySymbol) {
  const scope = trial?.dna?.scope?.symbols ?? trial?.scope?.symbols ?? [];
  return sortedUnique(scope.filter((symbol) => Array.isArray(barsBySymbol?.[symbol]) && barsBySymbol[symbol].length > 1));
}

function safeBars(bars) {
  return [...bars].filter((bar) => bar && finite(bar.c) && bar.c > 0)
    .sort((left, right) => String(left.t ?? "").localeCompare(String(right.t ?? "")));
}

/** Three deterministic, anchored walk-forward test windows from development bars only. */
export function buildDevelopmentFolds(barsBySymbol, options = {}) {
  const symbols = sortedUnique(Object.keys(barsBySymbol ?? {}).filter((symbol) => Array.isArray(barsBySymbol[symbol])));
  if (!symbols.length) return [];
  const lengths = symbols.map((symbol) => safeBars(barsBySymbol[symbol]).length).filter(Boolean);
  const length = Math.min(...lengths);
  const foldCount = 3;
  const minimumTestBars = Math.max(2, Math.trunc(options.minimum_fold_bars ?? 20));
  if (!Number.isFinite(length) || length < foldCount * minimumTestBars + 2) return [];
  // Reserve the earliest 40% as initial context, then split the remaining 60%
  // into three chronological test windows.  Each later fold has more training
  // history but never sees bars after its own end.
  const testStart = Math.max(1, Math.floor(length * 0.4));
  const testLength = Math.floor((length - testStart) / foldCount);
  if (testLength < minimumTestBars) return [];
  return Array.from({ length: foldCount }, (_, index) => {
    const start = testStart + index * testLength;
    const end = index === foldCount - 1 ? length - 1 : Math.min(length - 1, start + testLength - 1);
    return Object.freeze({ id: `development-fold-${index + 1}`, ordinal: index + 1,
      train_start: 0, train_end: start - 1, test_start: start, test_end: end, bars: end - start + 1 });
  });
}

function maximumDrawdown(returns) {
  let equity = 1, peak = 1, worst = 0;
  for (const value of returns) { equity *= 1 + value; peak = Math.max(peak, equity); worst = Math.min(worst, equity / peak - 1); }
  return worst;
}

function quantizeTarget(value) {
  if (!finite(value) || Math.abs(value) < 1e-10) return 0;
  return value > 0 ? 1 : -1;
}

function correlation(left, right) {
  const size = Math.min(left.length, right.length);
  if (size < 2) return 0;
  const a = left.slice(0, size); const b = right.slice(0, size);
  const aMean = average(a); const bMean = average(b);
  const numerator = a.reduce((sum, value, index) => sum + (value - aMean) * (b[index] - bMean), 0);
  const denom = Math.sqrt(a.reduce((sum, value) => sum + (value - aMean) ** 2, 0) * b.reduce((sum, value) => sum + (value - bMean) ** 2, 0));
  return denom > EPSILON ? numerator / denom : (a.every((value, index) => value === b[index]) ? 1 : 0);
}

function behaviorFingerprint(targets) {
  // Fixed-size sampling keeps the comparison cost bounded and makes the
  // fingerprint independent of object/key ordering.
  const probeLength = 192;
  const flattened = targets.flatMap(({ symbol, targets: series }) => series
    .map((target, index) => ({ key: `${symbol}:${index}:${quantizeTarget(target)}`, value: quantizeTarget(target) })));
  const step = Math.max(1, Math.ceil(flattened.length / probeLength));
  const sampled = flattened.filter((_, index) => index % step === 0).slice(0, probeLength);
  const probe = sampled.map((item) => item.key);
  return { behavior_hash: hashCanonical(probe), probe, quantized_targets: sampled.map((item) => item.value) };
}

function targetReturns(targets, bars, start, end) {
  const values = [], exposures = []; let turnover = 0, trades = 0, activeBars = 0;
  let previous = start > 0 ? (targets[start - 1] ?? 0) : 0;
  for (let index = start; index <= end && index + 1 < bars.length; index += 1) {
    const target = finite(targets[index]) ? targets[index] : NaN;
    if (!finite(target)) return { invalid: true, values: [], turnover: Infinity, trades: 0, activeBars: 0, exposures: [] };
    const change = Math.abs(target - previous);
    turnover += change;
    if (quantizeTarget(target) !== quantizeTarget(previous)) trades += 1;
    if (target !== 0) activeBars += 1;
    const nextReturn = bars[index].c > 0 && bars[index + 1].c > 0 ? bars[index + 1].c / bars[index].c - 1 : NaN;
    if (!finite(nextReturn)) return { invalid: true, values: [], turnover: Infinity, trades: 0, activeBars: 0, exposures: [] };
    values.push(target * nextReturn - change * COST_PER_TURNOVER);
    exposures.push(Math.abs(target)); previous = target;
  }
  return { invalid: false, values, turnover, trades, activeBars, exposures };
}

function foldMetrics(symbolResults) {
  const returns = symbolResults.flatMap((item) => item.values);
  const costs = symbolResults.reduce((sum, item) => sum + item.turnover * COST_PER_TURNOVER, 0);
  const grossTurnover = symbolResults.reduce((sum, item) => sum + item.turnover, 0);
  const trades = symbolResults.reduce((sum, item) => sum + item.trades, 0);
  const activeBars = symbolResults.reduce((sum, item) => sum + item.activeBars, 0);
  const exposures = symbolResults.flatMap((item) => item.exposures);
  const netReturn = returns.reduce((sum, value) => sum + value, 0);
  const sharpe = deviation(returns) > EPSILON ? average(returns) / deviation(returns) * Math.sqrt(BARS_PER_YEAR) : 0;
  const symbolReturns = symbolResults.map((item) => item.values.reduce((sum, value) => sum + value, 0));
  const absReturns = symbolReturns.map(Math.abs); const totalAbs = absReturns.reduce((sum, value) => sum + value, 0);
  return { net_return: netReturn, expectancy: returns.length ? average(returns) : 0, sharpe,
    max_drawdown: maximumDrawdown(returns), tail_loss: returns.length ? Math.min(...returns) : 0,
    turnover: grossTurnover, cost: costs, trades, active_bars: activeBars, observations: returns.length,
    average_exposure: average(exposures), symbol_returns: symbolReturns,
    concentration: totalAbs > EPSILON ? Math.max(...absReturns) / totalAbs : 1 };
}

function complexity(dna) {
  const parameters = dna.features.reduce((sum, node) => sum + Object.keys(node.params ?? {}).length, 0);
  return dna.features.length + parameters * 0.2 + (dna.cooldown?.bars ?? 0) * 0.01;
}

/** Evaluate one candidate against only its supplied development bars. */
export function evaluateResearchTrial(trial, barsBySymbol, options = {}) {
  const dna = trial?.dna ?? trial;
  const recordBase = { trial_id: String(trial?.trial_id ?? dna?.lineage?.trial_id ?? "unknown"), dna_hash: dna?.dna_hash ?? null,
    ordinal: Number.isInteger(Number(trial?.ordinal)) ? Number(trial.ordinal) : null,
    generation: dna?.lineage?.generation ?? null, operator: trial?.operator ?? "sample", status: "screened" };
  try { validateStrategyDNA(dna); } catch (error) {
    return { ...recordBase, status: "invalid", skip_expensive: true, constraint_failures: ["invalid_dna"], error: String(error.message ?? error), fitness: null };
  }
  const symbols = requiredSymbols({ dna }, barsBySymbol);
  const minimumSymbols = Math.max(5, Math.trunc(options.minimum_symbols ?? 5));
  if (symbols.length < minimumSymbols) return { ...recordBase, status: "rejected", skip_expensive: true,
    constraint_failures: ["insufficient_symbols"], symbols, fitness: null };
  const folds = buildDevelopmentFolds(Object.fromEntries(symbols.map((symbol) => [symbol, barsBySymbol[symbol]])), options);
  if (folds.length !== 3) return { ...recordBase, status: "rejected", skip_expensive: true,
    constraint_failures: ["insufficient_development_bars"], symbols, fitness: null };
  const vectors = []; const bySymbol = {};
  try {
    for (const symbol of symbols) {
      const bars = safeBars(barsBySymbol[symbol]);
      const result = evaluateVectorTargets(dna, bars, { interval_ms: options.interval_ms ?? 300000 });
      if (result.targets.length !== bars.length || result.targets.some((target) => !finite(target))) throw new Error(`invalid target for ${symbol}`);
      bySymbol[symbol] = { bars, targets: result.targets };
      vectors.push({ symbol, targets: result.targets });
    }
  } catch (error) {
    return { ...recordBase, status: "invalid", skip_expensive: true, constraint_failures: ["invalid_target"], error: String(error.message ?? error), symbols, fitness: null };
  }
  const perFold = folds.map((fold) => {
    const results = symbols.map((symbol) => ({ symbol, ...targetReturns(bySymbol[symbol].targets, bySymbol[symbol].bars, fold.test_start, fold.test_end) }));
    return { ...fold, ...foldMetrics(results), invalid: results.some((item) => item.invalid) };
  });
  const failures = [];
  if (perFold.some((fold) => fold.invalid)) failures.push("invalid_target");
  const netReturns = perFold.map((fold) => fold.net_return);
  const sharpes = perFold.map((fold) => fold.sharpe);
  const drawdowns = perFold.map((fold) => fold.max_drawdown);
  const tails = perFold.map((fold) => fold.tail_loss);
  const totalTrades = perFold.reduce((sum, fold) => sum + fold.trades, 0);
  const totalObservations = perFold.reduce((sum, fold) => sum + fold.observations, 0);
  const totalTurnover = perFold.reduce((sum, fold) => sum + fold.turnover, 0);
  const maxConcentration = Math.max(...perFold.map((fold) => fold.concentration));
  const minTrades = Math.max(1, Math.trunc(options.minimum_trades ?? 8));
  const maxTurnover = finite(options.maximum_turnover) ? options.maximum_turnover : 20;
  const maximumConcentration = finite(options.maximum_symbol_concentration) ? options.maximum_symbol_concentration : .35;
  if (totalTrades < minTrades) failures.push("insufficient_activity");
  if (maxConcentration > maximumConcentration + EPSILON) failures.push("symbol_concentration");
  if (totalTurnover > maxTurnover + EPSILON) failures.push("excessive_turnover");
  const trialCount = Math.max(1, Math.trunc(options.trial_count ?? 1));
  const averageSharpe = average(sharpes); const trialAwareSharpe = averageSharpe / Math.sqrt(1 + Math.log(trialCount));
  const stability = 1 / (1 + deviation(netReturns) + deviation(sharpes) * .01);
  const returnBySymbol = symbols.map((symbol) => perFold.reduce((sum, fold, foldIndex) => sum + (fold.symbol_returns[symbols.indexOf(symbol)] ?? 0), 0));
  const behavior = behaviorFingerprint(vectors);
  const fitness = {
    net_return: average(netReturns), expectancy: average(perFold.map((fold) => fold.expectancy)),
    sharpe_proxy: trialAwareSharpe, raw_sharpe: averageSharpe,
    max_drawdown: Math.min(...drawdowns), tail_loss: Math.min(...tails), stability,
    turnover: totalTurnover, cost: perFold.reduce((sum, fold) => sum + fold.cost, 0),
    trades: totalTrades, activity: totalObservations ? totalTrades / totalObservations : 0,
    exposure: average(perFold.map((fold) => fold.average_exposure)), complexity: complexity(dna),
    concentration: maxConcentration, symbol_stability: 1 / (1 + deviation(returnBySymbol)),
    novelty: 1, cost_sensitivity: -perFold.reduce((sum, fold) => sum + fold.cost, 0),
  };
  const objectives = { return: fitness.net_return, expectancy: fitness.expectancy, sharpe: fitness.sharpe_proxy,
    drawdown: fitness.max_drawdown, tail: fitness.tail_loss, stability: fitness.stability,
    cost: fitness.cost_sensitivity, activity: Math.min(1, fitness.activity * 100), exposure: fitness.exposure,
    complexity: -fitness.complexity, concentration: -fitness.concentration, novelty: fitness.novelty };
  return { ...recordBase, status: failures.length ? "rejected" : "eligible", skip_expensive: failures.length > 0,
    constraint_failures: failures, symbols, folds: perFold, fitness, objectives, behavior_fingerprint: behavior.behavior_hash,
    behavior_probe: behavior.probe, behavior_series: behavior.quantized_targets, dna, dataset_scope: "development_only" };
}

function dominates(left, right) {
  const keys = Object.keys(left.objectives ?? {});
  if (!keys.length || keys.some((key) => !finite(left.objectives[key]) || !finite(right.objectives?.[key]))) return false;
  return keys.every((key) => left.objectives[key] >= right.objectives[key] - EPSILON)
    && keys.some((key) => left.objectives[key] > right.objectives[key] + EPSILON);
}

/** Deterministic non-dominated fronts.  Earlier rank is better. */
export function paretoRank(records = []) {
  const ordered = [...records].sort((left, right) => stableId(left).localeCompare(stableId(right)) || String(left.trial_id).localeCompare(String(right.trial_id)));
  const remaining = ordered.filter((record) => record.status === "eligible" && !record.skip_expensive);
  const ranked = new Map(); let rank = 1; let pool = remaining;
  while (pool.length) {
    const front = pool.filter((record) => !pool.some((other) => other !== record && dominates(other, record)));
    for (const record of front) ranked.set(record, rank);
    pool = pool.filter((record) => !front.includes(record)); rank += 1;
  }
  return ordered.map((record) => ({ ...record, pareto_rank: ranked.get(record) ?? null }))
    .sort((left, right) => (left.pareto_rank ?? Number.MAX_SAFE_INTEGER) - (right.pareto_rank ?? Number.MAX_SAFE_INTEGER)
      || stableId(left).localeCompare(stableId(right)) || String(left.trial_id).localeCompare(String(right.trial_id)));
}

function annotateDuplicates(records, archive = [], threshold = .995) {
  const seenDna = new Set(archive.map((item) => typeof item === "string" ? item : item.dna_hash).filter(Boolean));
  const seenBehavior = new Map();
  for (const item of archive) if (item?.behavior_fingerprint && item?.behavior_series) seenBehavior.set(item.behavior_fingerprint, item.behavior_series);
  return [...records].sort((a, b) => stableId(a).localeCompare(stableId(b))).map((record) => {
    let duplicate = seenDna.has(record.dna_hash); let duplicateKind = duplicate ? "dna" : null;
    if (!duplicate && record.behavior_series) for (const [fingerprint, series] of seenBehavior) {
      if (fingerprint === record.behavior_fingerprint || correlation(record.behavior_series, series) >= threshold) { duplicate = true; duplicateKind = "behavior"; break; }
    }
    // A structurally valid proposal remains in the duplicate registry even
    // when another screen constraint rejects it.  Otherwise the same failed
    // genome could be charged repeatedly in the very next trial.
    if (!duplicate) { if (record.dna_hash) seenDna.add(record.dna_hash); if (record.behavior_series) seenBehavior.set(record.behavior_fingerprint, record.behavior_series); }
    return duplicate ? { ...record, status: record.status === "invalid" ? "invalid" : "duplicate", duplicate_kind: duplicateKind,
      skip_expensive: true, constraint_failures: sortedUnique([...(record.constraint_failures ?? []), `${duplicateKind}_duplicate`]) } : record;
  });
}

/** Screen, rank, de-duplicate, and select at most twelve diverse finalists. */
export function screenResearchTrials(trials, barsBySymbol, options = {}) {
  const evaluated = (trials ?? []).map((trial) => evaluateResearchTrial(trial, barsBySymbol, { ...options, trial_count: trials?.length ?? 1 }));
  return finalizeResearchScreen(evaluated, options);
}

/**
 * Apply every cohort-wide decision to independently evaluated trial records.
 * Input order is intentionally discarded so Queue delivery order cannot alter
 * duplicate attribution, Pareto fronts, novelty, clusters, or finalists.
 */
export function finalizeResearchScreen(evaluated = [], options = {}) {
  const canonical = [...evaluated].sort((left, right) => Number(left?.ordinal ?? Number.MAX_SAFE_INTEGER)
    - Number(right?.ordinal ?? Number.MAX_SAFE_INTEGER)
    || String(left?.trial_id ?? "").localeCompare(String(right?.trial_id ?? "")));
  const deduplicated = annotateDuplicates(canonical, options.novelty_archive ?? [], options.near_duplicate_correlation ?? .995);
  const withNovelty = deduplicated.map((record) => {
    if (!record.fitness) return record;
    const archive = options.novelty_archive ?? [];
    const nearest = archive.reduce((highest, item) => item?.behavior_series && record.behavior_series ? Math.max(highest, correlation(record.behavior_series, item.behavior_series)) : highest, 0);
    const fitness = { ...record.fitness, novelty: 1 - clamp(nearest, -1, 1) };
    return { ...record, fitness, objectives: { ...record.objectives, novelty: fitness.novelty } };
  });
  const ranked = paretoRank(withNovelty);
  const finalistLimit = Math.max(1, Math.min(12, Math.trunc(options.finalists ?? 12)));
  const clusterCap = Math.max(1, Math.min(finalistLimit, Math.trunc(options.cluster_cap ?? 3)));
  const chosen = []; const clusterMembers = [];
  for (const candidate of ranked) {
    if (candidate.status !== "eligible" || candidate.skip_expensive) continue;
    const cluster = clusterMembers.find((member) => correlation(candidate.behavior_series, member.behavior_series) >= (options.cluster_correlation ?? .9));
    const count = cluster ? clusterMembers.filter((member) => member.cluster_id === cluster.cluster_id).length : 0;
    if (count >= clusterCap) continue;
    const selected = { ...candidate, cluster_id: cluster?.cluster_id ?? `cluster-${String(chosen.length + 1).padStart(2, "0")}`,
      selected_for_expensive: true, selection_rank: chosen.length + 1 };
    chosen.push(selected); clusterMembers.push(selected); if (chosen.length >= finalistLimit) break;
  }
  const selectedByHash = new Map(chosen.map((item) => [recordKey(item), item]));
  const records = ranked.map((record) => selectedByHash.get(recordKey(record)) ?? { ...record, selected_for_expensive: false, selection_rank: null });
  return { records, finalists: chosen, summary: { attempted: canonical.length, eligible: records.filter((record) => record.status === "eligible").length,
    duplicates: records.filter((record) => record.status === "duplicate").length, finalists: chosen.length,
    contract_hash: hashCanonical(records.map((record) => ({ dna_hash: record.dna_hash, status: record.status, pareto_rank: record.pareto_rank, selected: record.selected_for_expensive }))) } };
}

/** Re-run finalist selection over already evaluated records without recomputing vector evidence. */
export function selectResearchFinalists(records, options = {}) {
  const ranked = paretoRank(records);
  const limit = Math.max(1, Math.min(12, Math.trunc(options.finalists ?? 12)));
  const output = []; const clusters = [];
  for (const record of ranked) {
    if (record.status !== "eligible" || record.skip_expensive) continue;
    const related = clusters.find((other) => correlation(record.behavior_series ?? [], other.behavior_series ?? []) >= (options.cluster_correlation ?? .9));
    const count = related ? clusters.filter((other) => other.cluster_id === related.cluster_id).length : 0;
    if (count >= Math.max(1, Math.trunc(options.cluster_cap ?? 3))) continue;
    const item = { ...record, cluster_id: related?.cluster_id ?? `cluster-${String(output.length + 1).padStart(2, "0")}`,
      selected_for_expensive: true, selection_rank: output.length + 1 };
    output.push(item); clusters.push(item); if (output.length === limit) break;
  }
  return output;
}
