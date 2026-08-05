/**
 * Pure, versioned supervision policy for sealed intraday evaluation.
 *
 * This module deliberately has no storage, clock, data-feed, or lifecycle
 * access.  Callers persist the policy document with its hash beside evidence;
 * replaying the same document and artifacts produces the same decision.
 */
import { canonicalJson, sha256 } from "./dsl.js";

export const EVALUATION_POLICY_SCHEMA_VERSION = "evaluation-policy-v1";
export const MAX_HOLDOUT_CANDIDATES = 3;

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const mean = (items) => items.length ? items.reduce((sum, value) => sum + value, 0) / items.length : 0;
const stdev = (items) => items.length > 1 ? Math.sqrt(mean(items.map((item) => (item - mean(items)) ** 2))) : 0;
const sorted = (items) => [...items].sort((a, b) => a - b);
const quantile = (items, q) => {
  const values = sorted(items.filter((item) => Number.isFinite(item)));
  if (!values.length) return 0;
  const at = clamp(q, 0, 1) * (values.length - 1); const low = Math.floor(at); const high = Math.ceil(at);
  return values[low] + (values[high] - values[low]) * (at - low);
};
const stableId = (value) => String(value ?? "");
const freezeData = (value) => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(freezeData); Object.freeze(value);
  }
  return value;
};

/** Return the immutable policy document. Overrides are data, never callbacks. */
export function createEvaluationPolicy(overrides = {}) {
  const base = {
    schema_version: EVALUATION_POLICY_SCHEMA_VERSION,
    policy_name: "intraday-supervision-v1",
    folds: { anchored_count: 3, rolling_count: 3, minimum_test_bars: 78 * 5, embargo_bars: 6, safety_warmup_bars: 8 },
    trial_confidence: { sharpe_penalty_scale: 0.15, min_confidence: 0.55, max_selection_instability: 0.45 },
    development: {
      // This is deliberately lower than the 67-trade forward-incubation gate:
      // development evidence is a provisional screen, not a release decision.
      min_folds: 3, min_closed_trades: 24, min_symbols: 5, min_coverage: 0.90,
      min_stressed_sharpe: 0.10, min_novelty: 0.05, max_drawdown: 0.18,
      max_concentration: 0.35, max_complexity: 0.85,
    },
    capacity: { max_candidates: MAX_HOLDOUT_CANDIDATES },
    // These are policy values, committed before holdout data is read. Each
    // holdout metric must remain above the development fold distribution's
    // lower quantile plus the matching permitted degradation.
    holdout: {
      lower_fold_quantile: 0.20,
      return_degradation: 0.035, sharpe_degradation: 0.45, max_drawdown_increase: 0.055,
      hard_return_floor: -0.08, hard_sharpe_floor: -0.50, hard_drawdown_ceiling: 0.30,
      min_closed_trades: 20, min_symbols: 3, min_positive_symbol_fraction: 0.50,
      min_positive_regime_fraction: 0.50,
    },
  };
  const merge = (left, right) => Object.fromEntries(Object.keys({ ...left, ...right }).map((key) => [key,
    left[key] && typeof left[key] === "object" && !Array.isArray(left[key]) && right?.[key] && typeof right[key] === "object" && !Array.isArray(right[key])
      ? merge(left[key], right[key]) : (right?.[key] ?? left[key]),
  ]));
  const policy = merge(base, overrides);
  policy.schema_version = EVALUATION_POLICY_SCHEMA_VERSION;
  policy.capacity.max_candidates = MAX_HOLDOUT_CANDIDATES;
  // A caller may make development stricter, but must not turn it into the
  // 67-trade incubation rule or weaken it below the provisional 24-trade bar.
  policy.development.min_closed_trades = Math.max(24, Math.floor(finite(policy.development.min_closed_trades, 24)));
  return freezeData(JSON.parse(canonicalJson(policy)));
}

/** Hash a policy document with the DSL's canonical JSON rules. */
export function evaluationPolicyHash(policy) { return sha256(policy); }

/**
 * Build anchored + rolling chronological folds with a lookback purge and
 * embargo on both sides of the test interval. Indices are half-open bar
 * offsets.  The caller must physically slice only development bars.
 */
export function buildFoldManifest({ bar_count, warmup_bars = 0, position_overlap_bars = 1, policy = createEvaluationPolicy() }) {
  const count = Math.max(0, Math.floor(finite(bar_count)));
  const purge = Math.max(0, Math.floor(finite(warmup_bars)) + Math.max(0, Math.floor(finite(position_overlap_bars))) + policy.folds.safety_warmup_bars);
  const embargo = policy.folds.embargo_bars;
  const total = policy.folds.anchored_count + policy.folds.rolling_count;
  const available = count - purge - embargo;
  const testBars = Math.max(policy.folds.minimum_test_bars, Math.floor(available / Math.max(total + 1, 1)));
  const folds = [];
  for (let index = 0; index < total; index += 1) {
    const anchored = index < policy.folds.anchored_count;
    const test_end = Math.min(count, count - Math.max(0, (total - index - 1) * testBars));
    const test_start = Math.max(0, test_end - testBars);
    const train_start = anchored ? 0 : Math.max(0, test_start - testBars * 2 - purge);
    const train_end = Math.max(train_start, test_start - purge);
    folds.push({ id: `${anchored ? "anchored" : "rolling"}-${String(index + 1).padStart(2, "0")}`,
      kind: anchored ? "anchored" : "rolling", train: { start: train_start, end: train_end },
      purge: { start: train_end, end: test_start }, test: { start: test_start, end: test_end },
      embargo: { start: test_end, end: Math.min(count, test_end + embargo) }, warmup_bars: Math.floor(finite(warmup_bars)), position_overlap_bars: Math.floor(finite(position_overlap_bars)), });
  }
  return { schema_version: EVALUATION_POLICY_SCHEMA_VERSION, bar_count: count, purge_bars: purge, embargo_bars: embargo, folds };
}

/** All attempts count, including invalid and duplicate proposals. */
export function trialAwareConfidence({ sharpe = 0, trial_registry = [], selection_instability = 1, policy = createEvaluationPolicy() }) {
  const records = Array.isArray(trial_registry) ? trial_registry : (trial_registry?.attempts ?? trial_registry?.records ?? trial_registry);
  const attempts = Array.isArray(records) ? records.length : Math.max(0, Math.floor(finite(records)));
  const penalty = policy.trial_confidence.sharpe_penalty_scale * Math.sqrt(2 * Math.log(Math.max(1, attempts)));
  const deflated_sharpe = finite(sharpe) - penalty;
  const confidence = 1 / (1 + Math.exp(-(deflated_sharpe - finite(selection_instability) * 1.5)));
  return { attempts, deflated_sharpe: Number(deflated_sharpe.toFixed(10)), confidence: Number(confidence.toFixed(10)), selection_instability: Number(clamp(finite(selection_instability), 0, 1).toFixed(10)) };
}

/**
 * A deterministic PBO-equivalent instability estimate.  It enumerates
 * balanced fold half-splits (up to 64), comparing each selected train winner's
 * out-of-sample score against zero.  It is selection-aware without touching
 * final holdout data.
 */
export function selectionInstability(candidate_fold_scores = {}) {
  const ids = Object.keys(candidate_fold_scores).sort();
  const foldCount = Math.min(...ids.map((id) => Array.isArray(candidate_fold_scores[id]) ? candidate_fold_scores[id].length : 0));
  if (!ids.length || foldCount < 2) return 1;
  const choose = Math.floor(foldCount / 2); const masks = [];
  const visit = (start, picked) => {
    if (masks.length >= 64) return;
    if (picked.length === choose) { masks.push(picked); return; }
    for (let index = start; index <= foldCount - (choose - picked.length); index += 1) visit(index + 1, [...picked, index]);
  };
  visit(0, []);
  let failures = 0;
  for (const trainIndexes of masks) {
    const train = new Set(trainIndexes);
    const winner = ids.map((id) => ({ id, score: mean(candidate_fold_scores[id].slice(0, foldCount).filter((_, index) => train.has(index)).map(finite)) }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))[0];
    const oos = mean(candidate_fold_scores[winner.id].slice(0, foldCount).filter((_, index) => !train.has(index)).map(finite));
    if (oos <= 0) failures += 1;
  }
  return masks.length ? Number((failures / masks.length).toFixed(10)) : 1;
}

const seriesValues = (series) => (Array.isArray(series) ? series : []).map((item) => {
  if (typeof item === "number") return item;
  return finite(item?.target ?? item?.value ?? item?.exposure ?? item?.signal, NaN);
}).filter(Number.isFinite);
const pearson = (left, right) => {
  const size = Math.min(left.length, right.length); if (!size) return 0;
  const a = left.slice(0, size); const b = right.slice(0, size); const sa = stdev(a); const sb = stdev(b);
  if (!sa || !sb) return a.every((value, index) => value === b[index]) ? 1 : 0;
  return clamp(mean(a.map((value, index) => (value - mean(a)) * (b[index] - mean(b)))) / (sa * sb), -1, 1);
};
const tradeKeys = (item) => {
  const trades = Array.isArray(item?.trades) ? item.trades : (Array.isArray(item?.closed_trades) ? item.closed_trades : []);
  if (trades.length) return new Set(trades.map((trade, index) => `${trade?.t ?? trade?.opened ?? index}|${trade?.side ?? Math.sign(finite(trade?.size))}`));
  return new Set(seriesValues(item?.target_series ?? item?.targets ?? item?.behavior_series).map((value, index) => value ? `${index}|${Math.sign(value)}` : null).filter(Boolean));
};

/**
 * Compare the candidate against every supplied tested/released archive member.
 * Similarity combines absolute target correlation (inverse strategies are
 * still economically redundant) with directional trade-event Jaccard overlap.
 * Archive members are sorted by ID, making archive order irrelevant.
 */
export function behaviorSimilarity(candidate = {}, archive_members = []) {
  const candidateSeries = seriesValues(candidate.target_series ?? candidate.targets ?? candidate.behavior_series);
  const candidateTrades = tradeKeys(candidate);
  const comparisons = [...(Array.isArray(archive_members) ? archive_members : Object.values(archive_members ?? {}))]
    .sort((a, b) => stableId(a?.strategy_id ?? a?.id ?? a?.dna_hash).localeCompare(stableId(b?.strategy_id ?? b?.id ?? b?.dna_hash)))
    .map((member) => {
      const id = stableId(member?.strategy_id ?? member?.id ?? member?.dna_hash);
      const correlation = Math.abs(pearson(candidateSeries, seriesValues(member?.target_series ?? member?.targets ?? member?.behavior_series)));
      const memberTrades = tradeKeys(member); const union = new Set([...candidateTrades, ...memberTrades]);
      const intersection = [...candidateTrades].filter((key) => memberTrades.has(key)).length;
      const overlap = union.size ? intersection / union.size : 0;
      return { id, target_correlation: Number(correlation.toFixed(10)), trade_overlap: Number(overlap.toFixed(10)), similarity: Number((.7 * correlation + .3 * overlap).toFixed(10)) };
    });
  const max_similarity = Math.max(0, ...comparisons.map((item) => item.similarity));
  const nearest_ids = comparisons.filter((item) => item.similarity === max_similarity && max_similarity > 0).map((item) => item.id);
  return { comparisons, max_similarity: Number(max_similarity.toFixed(10)), nearest_ids, novelty: Number(clamp(1 - max_similarity, 0, 1).toFixed(10)) };
}

function objectValues(value) { return Array.isArray(value) ? value : (value && typeof value === "object" ? Object.values(value) : []); }
function containsHoldoutShape(value) {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => /holdout|sealed/i.test(key) || containsHoldoutShape(child));
}

/**
 * Calibrate a policy from historical development/known-forward-outcome records
 * only. Any holdout/sealed-shaped key is rejected before a value is read. The
 * calibration record includes an order-invariant source hash for audit.
 */
export function calibrateShadowPolicy({ policy = createEvaluationPolicy(), records = [] } = {}) {
  if (!Array.isArray(records)) throw new TypeError("Shadow calibration records must be an array");
  if (records.some(containsHoldoutShape)) throw new Error("Shadow calibration rejects sealed holdout-shaped inputs");
  const source = records.map((record) => ({ id: stableId(record?.strategy_id ?? record?.id ?? record?.dna_hash),
    development: record?.development ?? record?.development_evidence ?? record?.evidence ?? {},
    known_outcome: record?.known_outcome ?? record?.forward_outcome ?? null,
  })).sort((a, b) => a.id.localeCompare(b.id) || canonicalJson(a).localeCompare(canonicalJson(b)));
  const development = source.map((item) => item.development);
  const numeric = (keys) => development.map((item) => finite(keys.map((key) => item?.[key] ?? item?.normalized?.[key]).find(Number.isFinite), NaN)).filter(Number.isFinite);
  const sample_count = source.length; const usable = sample_count >= 8;
  const overrides = usable ? { development: {
    min_stressed_sharpe: Math.max(policy.development.min_stressed_sharpe, quantile(numeric(["stressed_sharpe"]), .20)),
    min_novelty: Math.max(policy.development.min_novelty, quantile(numeric(["novelty"]), .10)),
    max_drawdown: Math.min(policy.development.max_drawdown, quantile(numeric(["max_drawdown", "drawdown"]), .80) || policy.development.max_drawdown),
    max_concentration: Math.min(policy.development.max_concentration, quantile(numeric(["concentration"]), .80) || policy.development.max_concentration),
    // Never reduce below the deliberately provisional development activity floor.
    min_closed_trades: Math.max(policy.development.min_closed_trades, Math.round(quantile(numeric(["activity", "closed_trades"]), .20))),
  } } : {};
  return createEvaluationPolicy({ ...policy,
    development: { ...policy.development, ...(overrides.development ?? {}) },
    calibration: {
    status: usable ? "calibrated_shadow_only" : "insufficient_shadow_evidence", sample_count,
    source_hash: sha256(source), source: "historical-development-known-outcomes-only",
  } });
}

/** Normalize immutable development evidence from all required diagnostics. */
export function normalizeDevelopmentEvidence(evidence = {}, { policy = createEvaluationPolicy(), trial_registry = [] } = {}) {
  const folds = Array.isArray(evidence.folds) ? evidence.folds : [];
  const metric = (item, name) => finite(item?.metrics?.[name] ?? item?.[name]);
  const foldSharpe = folds.map((item) => metric(item, "bar_sharpe") || metric(item, "sharpe"));
  const foldReturns = folds.map((item) => metric(item, "net_return") || metric(item, "return"));
  const foldDrawdowns = folds.map((item) => metric(item, "max_drawdown") || metric(item, "drawdown"));
  const stressed = Array.isArray(evidence.stress) ? evidence.stress : [];
  const stressedSharpe = stressed.length ? Math.min(...stressed.map((item) => metric(item, "bar_sharpe") || metric(item, "sharpe"))) : 0;
  const symbols = objectValues(evidence.per_symbol);
  const regimes = objectValues(evidence.regimes);
  const perturbations = Array.isArray(evidence.perturbations) ? evidence.perturbations : [];
  const nulls = Array.isArray(evidence.nulls) ? evidence.nulls : [];
  const archive_similarity = evidence.archive_members || evidence.tested_released_archive
    ? behaviorSimilarity(evidence.behavior ?? evidence, evidence.archive_members ?? evidence.tested_released_archive) : null;
  const novelty = archive_similarity ? archive_similarity.novelty : clamp(finite(evidence.novelty?.distance ?? evidence.novelty), 0, 1);
  const coverage = clamp(finite(evidence.coverage, 0), 0, 1);
  const concentration = clamp(finite(evidence.concentration ?? evidence.metrics?.symbol_concentration_hhi), 0, 1);
  const complexity = clamp(finite(evidence.complexity), 0, 1);
  const activity = Math.max(0, finite(evidence.closed_trades ?? evidence.metrics?.closed_trades));
  const critical_faults = Array.isArray(evidence.critical_faults) ? evidence.critical_faults.length : Math.max(0, finite(evidence.critical_faults));
  const foldScores = evidence.candidate_fold_scores ?? { [stableId(evidence.strategy_id ?? "candidate")]: foldSharpe };
  const instability = selectionInstability(foldScores);
  const confidence = trialAwareConfidence({ sharpe: mean(foldSharpe), trial_registry, selection_instability: instability, policy });
  const robustness = mean([mean(foldSharpe), stressedSharpe, mean(symbols.map((item) => metric(item, "bar_sharpe") || metric(item, "sharpe"))), mean(regimes.map((item) => metric(item, "score") || metric(item, "bar_sharpe"))), mean(perturbations.map((item) => metric(item, "bar_sharpe") || metric(item, "sharpe")))]);
  const nullSharpe = mean(nulls.map((item) => metric(item, "bar_sharpe") || metric(item, "sharpe")));
  const gates = {
    fold_coverage: folds.length >= policy.development.min_folds,
    symbols: symbols.length >= policy.development.min_symbols,
    data_coverage: coverage >= policy.development.min_coverage,
    no_critical_faults: critical_faults === 0,
    stressed: stressedSharpe >= policy.development.min_stressed_sharpe,
    activity: activity >= policy.development.min_closed_trades,
    drawdown: Math.max(...foldDrawdowns, 0) <= policy.development.max_drawdown,
    concentration: concentration <= policy.development.max_concentration,
    complexity: complexity <= policy.development.max_complexity,
    novelty: novelty >= policy.development.min_novelty,
    confidence: confidence.confidence >= policy.trial_confidence.min_confidence,
    instability: instability <= policy.trial_confidence.max_selection_instability,
    null_superiority: mean(foldSharpe) > nullSharpe,
  };
  return { schema_version: EVALUATION_POLICY_SCHEMA_VERSION, normalized: {
    fold_count: folds.length, fold_sharpe: foldSharpe, fold_return: foldReturns, fold_drawdown: foldDrawdowns,
    stressed_sharpe: stressedSharpe, symbol_count: symbols.length, regime_count: regimes.length,
    perturbation_count: perturbations.length, null_sharpe: nullSharpe, novelty, behavior_similarity: archive_similarity, coverage, critical_faults, concentration, complexity, activity,
    robustness: Number(robustness.toFixed(10)), ...confidence,
  }, gates, all_gates_pass: Object.values(gates).every(Boolean) };
}

/** Return a single quality decision; infrastructure/data failures are orthogonal. */
export function superviseDevelopment({ evidence = {}, trial_registry = [], policy = createEvaluationPolicy(), status = "ok" } = {}) {
  if (status === "infrastructure_error" || status === "data_error") return { decision: null, status, reasons: [status], evidence: null };
  const normalized = normalizeDevelopmentEvidence(evidence, { policy, trial_registry });
  const failed = Object.entries(normalized.gates).filter(([, passed]) => !passed).map(([name]) => name);
  const fatal = ["data_coverage", "no_critical_faults", "activity", "drawdown", "concentration", "complexity"].filter((name) => failed.includes(name));
  const decision = !failed.length ? "supervisor_approved" : fatal.length ? "development_reject" : "development_rework";
  return { decision, status: "ok", reasons: failed, evidence: normalized };
}

/**
 * Select at most three approved candidates, preferring distinct behaviour
 * clusters. Remaining valid candidates are capacity waits, never rejects.
 */
export function selectValidationCapacity(candidates = [], { policy = createEvaluationPolicy() } = {}) {
  const approved = candidates.filter((item) => item?.decision === "supervisor_approved")
    .sort((a, b) => finite(b?.evidence?.normalized?.robustness) - finite(a?.evidence?.normalized?.robustness) || stableId(a.strategy_id).localeCompare(stableId(b.strategy_id)));
  const selected = []; const clusters = new Set();
  for (const candidate of approved) if (selected.length < policy.capacity.max_candidates && !clusters.has(stableId(candidate.behavior_cluster ?? candidate?.evidence?.normalized?.behavior_cluster))) {
    selected.push(candidate); clusters.add(stableId(candidate.behavior_cluster ?? candidate?.evidence?.normalized?.behavior_cluster));
  }
  for (const candidate of approved) if (selected.length < policy.capacity.max_candidates && !selected.includes(candidate)) selected.push(candidate);
  const selectedIds = new Set(selected.map((item) => stableId(item.strategy_id)));
  return { selected: selected.map((item) => ({ ...item, decision: "supervisor_approved" })),
    waiting: approved.filter((item) => !selectedIds.has(stableId(item.strategy_id))).map((item) => ({ ...item, decision: "capacity_wait" })),
    capacity: policy.capacity.max_candidates };
}

/** Compute immutable, distribution-based degradation floors before holdout opens. */
export function precommittedDegradationBounds(development_folds = [], { policy = createEvaluationPolicy() } = {}) {
  const values = (name, alternate) => development_folds.map((item) => finite(item?.metrics?.[name] ?? item?.[name] ?? item?.metrics?.[alternate] ?? item?.[alternate]));
  const q = policy.holdout.lower_fold_quantile;
  return { net_return_floor: Number((quantile(values("net_return", "return"), q) - policy.holdout.return_degradation).toFixed(10)),
    sharpe_floor: Number((quantile(values("bar_sharpe", "sharpe"), q) - policy.holdout.sharpe_degradation).toFixed(10)),
    drawdown_ceiling: Number((quantile(values("max_drawdown", "drawdown"), 1 - q) + policy.holdout.max_drawdown_increase).toFixed(10)),
    closed_trades_floor: policy.holdout.min_closed_trades, symbol_count_floor: policy.holdout.min_symbols,
    positive_symbol_fraction_floor: policy.holdout.min_positive_symbol_fraction,
    positive_regime_fraction_floor: policy.holdout.min_positive_regime_fraction };
}

/** Holdout quality decision. A transport/data error must be supplied separately. */
export function decideHoldout({ development_folds = [], holdout = {}, policy = createEvaluationPolicy(), status = "ok" } = {}) {
  if (status === "infrastructure_error" || status === "data_error") return { decision: null, status, bounds: null, reasons: [status] };
  const bounds = precommittedDegradationBounds(development_folds, { policy });
  const metrics = holdout.metrics ?? holdout;
  const net = finite(metrics.net_return ?? metrics.return); const sharpe = finite(metrics.bar_sharpe ?? metrics.sharpe);
  const drawdown = finite(metrics.max_drawdown ?? metrics.drawdown); const trades = finite(metrics.closed_trades ?? metrics.trades);
  const symbolEvidence = objectValues(holdout.per_symbol);
  const symbols = symbolEvidence.length || finite(holdout.symbol_count);
  const symbol_positive_fraction = symbolEvidence.length
    ? symbolEvidence.filter((item) => finite(item?.net_return ?? item?.return) > 0).length / symbolEvidence.length : 0;
  const regimeEvidence = objectValues(holdout.regimes ?? metrics.regimes);
  const regime_positive_fraction = regimeEvidence.length
    ? regimeEvidence.filter((item) => finite(item?.score ?? item?.net_return ?? item?.return ?? item) > 0).length / regimeEvidence.length : 0;
  const hard = net <= policy.holdout.hard_return_floor || sharpe <= policy.holdout.hard_sharpe_floor || drawdown >= policy.holdout.hard_drawdown_ceiling;
  const passes = net >= bounds.net_return_floor && sharpe >= bounds.sharpe_floor && drawdown <= bounds.drawdown_ceiling
    && trades >= bounds.closed_trades_floor && symbols >= bounds.symbol_count_floor
    && symbol_positive_fraction >= bounds.positive_symbol_fraction_floor
    && regime_positive_fraction >= bounds.positive_regime_fraction_floor;
  return { decision: hard ? "holdout_reject" : passes ? "incubation" : "inconclusive", status: "ok", bounds,
    diagnostics: { symbol_positive_fraction: Number(symbol_positive_fraction.toFixed(10)), regime_positive_fraction: Number(regime_positive_fraction.toFixed(10)) },
    reasons: [net < bounds.net_return_floor && "return_degradation", sharpe < bounds.sharpe_floor && "sharpe_degradation", drawdown > bounds.drawdown_ceiling && "drawdown_degradation", trades < bounds.closed_trades_floor && "activity", symbols < bounds.symbol_count_floor && "symbols", symbol_positive_fraction < bounds.positive_symbol_fraction_floor && "symbol_stability", regime_positive_fraction < bounds.positive_regime_fraction_floor && "regime_stability"].filter(Boolean) };
}

/** Replay supervisor output and reject a mismatched policy hash before scoring. */
export function replaySupervisorDecision({ policy, policy_hash, artifacts = {} }) {
  const resolved = policy ?? createEvaluationPolicy(); const computed_hash = evaluationPolicyHash(resolved);
  if (policy_hash && policy_hash !== computed_hash) throw new Error("Evaluation policy hash mismatch");
  const supervision = superviseDevelopment({ evidence: artifacts.evidence, trial_registry: artifacts.trial_registry, policy: resolved, status: artifacts.status });
  const capacity = selectValidationCapacity(artifacts.candidates ?? [artifacts.candidate ?? { strategy_id: artifacts.evidence?.strategy_id, ...supervision }], { policy: resolved });
  const holdout = artifacts.holdout ? decideHoldout({ development_folds: artifacts.evidence?.folds, holdout: artifacts.holdout, policy: resolved, status: artifacts.holdout_status }) : null;
  return { policy_hash: computed_hash, supervision, capacity, holdout, replay_hash: sha256({ policy_hash: computed_hash, artifacts: JSON.parse(canonicalJson(artifacts)) }) };
}
