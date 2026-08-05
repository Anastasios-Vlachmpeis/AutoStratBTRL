import { canonicalJson, hashCanonical } from "./dsl.js";

export const HEALTH_SCHEMA_VERSION = 1;
export const HEALTH_POLICY_SCHEMA_VERSION = "release-health-policy-v1";

const clone = (value) => JSON.parse(JSON.stringify(value));
const finite = (value) => Number.isFinite(Number(value));
const round = (value, digits = 10) => Number(Number(value || 0).toFixed(digits));
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const stdev = (values) => {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
};
const quantile = (values, probability) => {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * probability, lower = Math.floor(index), upper = Math.ceil(index);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
};
const freeze = (value) => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
};

export function createHealthPolicy(overrides = {}) {
  const policy = {
    schema_version: HEALTH_POLICY_SCHEMA_VERSION,
    windows: { rolling_sessions: 10, rolling_trades: 30, watch_weak_sessions: 2,
      quarantine_weak_sessions: 4, recovery_sessions: 3, retirement_weak_sessions: 7,
      retirement_minimum_trades: 20 },
    hard: { daily_loss: .005, rolling_drawdown: .15, overnight_position: true,
      provenance_mismatch: true, unexplained_parity: true },
    soft: { minimum_session_coverage: .90, expectancy_floor: -.0025, sharpe_floor: -.25,
      profit_factor_floor: .70, hit_rate_floor: .30, drawdown_ceiling: .10,
      cost_to_gross_profit_ceiling: .80, maximum_symbol_fraction: .50,
      maximum_mean_holding_bars: 312 },
    overlays: { watch_multiplier: .50, quarantine_multiplier: 0,
      operational_multiplier: 0, correlated_loss_multiplier: .75,
      concentration_fraction: .35 },
    ...clone(overrides),
  };
  policy.windows = { rolling_sessions: 10, rolling_trades: 30, watch_weak_sessions: 2,
    quarantine_weak_sessions: 4, recovery_sessions: 3, retirement_weak_sessions: 7,
    retirement_minimum_trades: 20, ...(overrides.windows ?? {}) };
  policy.hard = { daily_loss: .005, rolling_drawdown: .15, overnight_position: true,
    provenance_mismatch: true, unexplained_parity: true, ...(overrides.hard ?? {}) };
  policy.soft = { minimum_session_coverage: .90, expectancy_floor: -.0025, sharpe_floor: -.25,
    profit_factor_floor: .70, hit_rate_floor: .30, drawdown_ceiling: .10,
    cost_to_gross_profit_ceiling: .80, maximum_symbol_fraction: .50,
    maximum_mean_holding_bars: 312, ...(overrides.soft ?? {}) };
  policy.overlays = { watch_multiplier: .50, quarantine_multiplier: 0,
    operational_multiplier: 0, correlated_loss_multiplier: .75,
    concentration_fraction: .35, ...(overrides.overlays ?? {}) };
  return freeze(JSON.parse(canonicalJson(policy)));
}

export function healthPolicyHash(policy = createHealthPolicy()) { return hashCanonical(policy); }

function baselineDistributions(strategy) {
  const rows = [strategy.metrics, strategy.validation, strategy.fitness,
    ...(strategy.backtest_runs?.development?.folds ?? []),
    ...(strategy.backtest_runs?.holdout?.folds ?? []),
    ...Object.values(strategy.validation?.per_symbol ?? {}),
    ...Object.values(strategy.incubation?.sessions ?? {}).map((item) => item.metrics),
  ].filter((item) => item && typeof item === "object");
  const aliases = { daily_sharpe: ["daily_sharpe", "sharpe", "sharpe_proxy"],
    expectancy: ["expectancy"], drawdown: ["drawdown", "max_drawdown"],
    profit_factor: ["profit_factor"], hit_rate: ["hit_rate", "win_rate"],
    tail_loss: ["tail_loss"], turnover: ["turnover"], exposure: ["exposure", "average_exposure"],
    concentration: ["concentration", "maximum_symbol_fraction"] };
  return Object.fromEntries(Object.entries(aliases).map(([metric, names]) => [metric,
    rows.map((row) => names.map((name) => Number(row?.[name])).find(Number.isFinite))
      .filter(Number.isFinite).map((value) => round(value))]));
}

function provenance(strategy, policy, releaseId) {
  return { release_id: releaseId, dna_hash: strategy.dna_hash ?? null,
    compiler_schema_hash: strategy.strategy_dna?.compiler?.schema_sha256 ?? null,
    compiler_semantic_hash: strategy.strategy_dna?.compiler?.semantic_sha256 ?? null,
    universe_hash: strategy.strategy_dna?.scope?.universe_sha256 ?? null,
    execution_config_hash: strategy.backtest_runs?.holdout?.config_hash
      ?? strategy.backtest_runs?.development?.config_hash ?? null,
    incubation_decision_id: strategy.incubation?.decision?.decision_id ?? null,
    behavior_hash: strategy.behavior_hash ?? strategy.research?.behavior_hash ?? null,
    baseline: { development: clone(strategy.metrics ?? {}), validation: clone(strategy.validation ?? {}),
      incubation: clone(strategy.incubation?.decision?.summary ?? {}),
      distributions: baselineDistributions(strategy) },
    policy_hash: healthPolicyHash(policy) };
}

export function startReleaseMonitoring(strategy, { releaseId = null,
  startedAt = new Date().toISOString(), policy = createHealthPolicy() } = {}) {
  if (strategy.health?.schema_version === HEALTH_SCHEMA_VERSION && strategy.health.release_id) return strategy.health;
  const frozenPolicy = createHealthPolicy(policy);
  const resolvedReleaseId = releaseId ?? strategy.release_id
    ?? `release-local-${hashCanonical({ strategy_id: strategy.id, dna_hash: strategy.dna_hash,
      incubation_decision: strategy.incubation?.decision?.decision_id }).slice(0, 40)}`;
  const frozenProvenance = provenance(strategy, frozenPolicy, resolvedReleaseId);
  strategy.health = { schema_version: HEALTH_SCHEMA_VERSION, release_id: resolvedReleaseId,
    started_at: startedAt, policy: frozenPolicy, policy_hash: healthPolicyHash(frozenPolicy),
    provenance: frozenProvenance, provenance_hash: hashCanonical(frozenProvenance),
    status: ["healthy", "watch", "quarantined", "retired"].includes(strategy.state)
      ? strategy.state : "released_paper",
    operational_status: "ready", observations: [], processed_event_ids: [], sessions: {},
    positions: {}, closed_trades: [], processed_fill_ids: [], latest_prices: {}, latest_targets: {},
    hard_findings: [], operational_findings: [], decision: null, decision_history: [],
    quarantine_count: 0, risk_overlay_history: [], running_equity: 1, peak_equity: 1,
    maximum_live_drawdown: 0 };
  strategy.risk_overlay ??= { health_multiplier: 1, portfolio_multiplier: 1,
    effective_multiplier: 1, reason_codes: [], updated_at: startedAt };
  return strategy.health;
}

export function ensureHealthEvidence(strategy) {
  return strategy.health?.schema_version === HEALTH_SCHEMA_VERSION
    ? strategy.health : startReleaseMonitoring(strategy);
}

function session(evidence, date) {
  return evidence.sessions[date] ??= { session_date: date, event_ids: [], observations: 0,
    expected_events: 78, coverage: 0, return: 0, costs: 0, operational_faults: [],
    hard_findings: [], completed: false, valid: false, classification: "pending",
    metrics: null, reason_codes: [] };
}

const OPERATIONAL_CODES = new Set(["stale_or_insufficient_market_data", "broker_clock_uncertain",
  "service_unavailable", "market_data_critical_fault", "feed_timeout", "data_gap",
  "open_order_pending", "asset_not_fractionable_for_long", "short_borrow_unavailable"]);
const HARD_CODES = new Set(["daily_loss_limit", "broker_position_attribution_divergence",
  "managed_position_outside_regular_session", "unknown_or_manual_order", "missing_strategy_allocation",
  "order_notional_sanity_limit", "order_share_sanity_limit", "dna_hash_mismatch",
  "frozen_provenance_hash_mismatch", "compiler_provenance_mismatch", "unexplained_target_fill_mismatch"]);

function addFinding(list, finding) {
  if (!list.some((item) => item.code === finding.code && item.event_id === finding.event_id
      && item.symbol === finding.symbol)) list.push(finding);
}

function strategyFills(strategy, cycle) {
  const output = [];
  for (const fill of cycle.fills ?? []) {
    const allocations = fill.allocations ?? [];
    const allocation = allocations.find((item) => item.strategy_id === strategy.id);
    const gross = allocations.reduce((sum, item) => sum + Math.abs(Number(item.signed_notional)), 0);
    if (!allocation || !(gross > 0)) continue;
    const weight = Math.abs(Number(allocation.signed_notional)) / gross;
    output.push({ ...fill, allocated_quantity: Math.abs(Number(fill.qty)) * weight });
  }
  return output;
}

function applyFill(evidence, fill, expectedPrice, sessionDate) {
  const fillId = String(fill.broker_fill_id ?? `${fill.symbol}:${fill.transaction_time}:${fill.side}`);
  if (evidence.processed_fill_ids.includes(fillId)) return { processed: false, cost: 0 };
  evidence.processed_fill_ids.push(fillId);
  const symbol = fill.symbol, quantity = Number(fill.allocated_quantity), price = Number(fill.price);
  if (!(quantity > 0) || !(price > 0)) return { processed: false, cost: 0 };
  const signed = fill.side === "sell" ? -quantity : quantity;
  const existing = evidence.positions[symbol];
  const slippageBps = finite(expectedPrice) && Number(expectedPrice) > 0
    ? Math.max(0, (fill.side === "buy" ? price / Number(expectedPrice) - 1
      : Number(expectedPrice) / price - 1) * 10_000) : 0;
  const cost = Math.abs(signed * price) * slippageBps / 10_000;
  if (!existing || Math.sign(existing.quantity) === Math.sign(signed)) {
    const prior = existing ?? { quantity: 0, average_price: 0, opened_at: fill.transaction_time,
      entry_notional: 0, entry_cost: 0, partial_pnl: 0, partial_cost: 0, fill_count: 0 };
    const total = Math.abs(prior.quantity) + Math.abs(signed);
    evidence.positions[symbol] = { ...prior, quantity: prior.quantity + signed,
      average_price: total ? (prior.average_price * Math.abs(prior.quantity) + price * Math.abs(signed)) / total : price,
      entry_notional: prior.entry_notional + Math.abs(signed * price),
      entry_cost: prior.entry_cost + cost, fill_count: prior.fill_count + 1 };
    return { processed: true, cost };
  }
  const closing = Math.min(Math.abs(existing.quantity), Math.abs(signed));
  const grossPnl = (price - existing.average_price) * Math.sign(existing.quantity) * closing;
  existing.partial_pnl += grossPnl; existing.partial_cost += cost; existing.fill_count += 1;
  existing.quantity += Math.sign(signed) * closing;
  if (Math.abs(existing.quantity) < 1e-10) {
    const gross = existing.partial_pnl, totalCost = existing.entry_cost + existing.partial_cost;
    const elapsed = new Date(fill.transaction_time).getTime() - new Date(existing.opened_at).getTime();
    evidence.closed_trades.push({ trade_id: `${evidence.release_id}:${symbol}:${fillId}`,
      symbol, direction: Math.sign(signed) > 0 ? "short" : "long", entry_at: existing.opened_at,
      exit_at: fill.transaction_time, gross_pnl: round(gross), cost: round(totalCost),
      pnl: round(gross - totalCost), net_return: round((gross - totalCost) / Math.max(existing.entry_notional, 1e-12)),
      holding_bars: Math.max(1, Math.ceil(Math.max(0, elapsed) / 300_000)),
      fill_count: existing.fill_count, session_date: sessionDate });
    delete evidence.positions[symbol];
  }
  return { processed: true, cost };
}

function immediateDecision(evidence, eventId) {
  const hard = evidence.hard_findings.filter((item) => item.event_id === eventId);
  const operational = evidence.operational_findings.filter((item) => item.event_id === eventId);
  if (hard.length) return decision(evidence, "quarantined", hard.map((item) => item.code), "ready", eventId);
  if (operational.length) return decision(evidence, evidence.status, operational.map((item) => item.code),
    "operational_blocked", eventId);
  return null;
}

export function recordHealthObservation(strategy, cycle, { eventId, sessionDate,
  observedAt = cycle?.clock?.timestamp ?? cycle?.fetched_at ?? new Date().toISOString() } = {}) {
  if (!eventId || !sessionDate) throw new Error("Health observation requires canonical event and session identities");
  const evidence = ensureHealthEvidence(strategy);
  if (evidence.processed_event_ids.includes(eventId)) return { duplicate: true, evidence, decision: null };
  evidence.processed_event_ids.push(eventId); evidence.processed_event_ids = evidence.processed_event_ids.slice(-8192);
  const day = session(evidence, sessionDate), evaluation = cycle.evaluations?.[strategy.id] ?? {};
  const perSymbol = evaluation.symbols ?? { [strategy.asset]: evaluation };
  const equity = Math.max(Number(cycle.account?.equity ?? 100_000), 1);
  const contributions = (cycle.allocation?.contributions ?? []).filter((item) => item.strategy_id === strategy.id);
  const targets = Object.fromEntries(contributions.map((item) => [item.symbol, Number(item.notional) / equity]));
  let observationReturn = 0;
  for (const [symbol, item] of Object.entries(perSymbol)) {
    const price = Number(item.latest_price), prior = evidence.latest_prices[symbol];
    if (finite(price) && price > 0 && finite(prior) && prior > 0) {
      observationReturn += Number(evidence.latest_targets[symbol] ?? 0) * (price / prior - 1);
    }
    if (finite(price) && price > 0) evidence.latest_prices[symbol] = price;
    if (item.critical_fault) addFinding(evidence.operational_findings,
      { code: String(item.critical_fault), event_id: eventId, session_date: sessionDate, symbol, at: observedAt });
  }
  const targetSymbols = new Set([...Object.keys(evidence.latest_targets ?? {}), ...Object.keys(targets)]);
  const turnover = [...targetSymbols].reduce((sum, symbol) => sum
    + Math.abs(Number(targets[symbol] ?? 0) - Number(evidence.latest_targets?.[symbol] ?? 0)), 0);
  evidence.latest_targets = targets;
  if (evidence.provenance_hash !== hashCanonical(evidence.provenance)) addFinding(evidence.hard_findings,
    { code: "frozen_provenance_hash_mismatch", event_id: eventId, session_date: sessionDate, at: observedAt });
  if (evidence.provenance.dna_hash && evidence.provenance.dna_hash !== strategy.dna_hash) addFinding(evidence.hard_findings,
    { code: "dna_hash_mismatch", event_id: eventId, session_date: sessionDate, at: observedAt });
  for (const item of cycle.safety_reasons ?? []) {
    if (item.strategy_id && item.strategy_id !== strategy.id) continue;
    const finding = { code: String(item.reason ?? "broker_safety"), event_id: eventId,
      session_date: sessionDate, symbol: item.symbol ?? null, at: observedAt };
    if (OPERATIONAL_CODES.has(finding.code)) addFinding(evidence.operational_findings, finding);
    else if (item.severity === "critical" || HARD_CODES.has(finding.code)) addFinding(evidence.hard_findings, finding);
  }
  const fills = strategyFills(strategy, cycle);
  let fillCost = 0;
  for (const fill of fills) fillCost += applyFill(evidence, fill,
    perSymbol[fill.symbol]?.latest_open, sessionDate)?.cost ?? 0;
  const grossTarget = Object.values(targets).reduce((sum, value) => sum + Math.abs(value), 0);
  const symbolMaximum = Math.max(0, ...Object.values(targets).map(Math.abs));
  const observation = { event_id: eventId, session_date: sessionDate, observed_at: observedAt,
    return: round(observationReturn), gross_target: round(grossTarget), turnover: round(turnover),
    cost: round(fillCost),
    maximum_symbol_fraction: grossTarget ? round(symbolMaximum / grossTarget) : 0,
    fill_count: fills.length,
    hard_findings: evidence.hard_findings.filter((item) => item.event_id === eventId).map((item) => item.code),
    operational_findings: evidence.operational_findings.filter((item) => item.event_id === eventId).map((item) => item.code) };
  evidence.observations.push(observation); evidence.observations = evidence.observations.slice(-8192);
  day.event_ids.push(eventId); day.observations += 1;
  day.return = round((1 + day.return) * (1 + observationReturn) - 1);
  day.costs = round(Number(day.costs ?? 0) + fillCost);
  evidence.running_equity = Math.max(.000001, Number(evidence.running_equity ?? 1) * (1 + observationReturn));
  evidence.peak_equity = Math.max(Number(evidence.peak_equity ?? 1), evidence.running_equity);
  evidence.maximum_live_drawdown = Math.max(Number(evidence.maximum_live_drawdown ?? 0),
    1 - evidence.running_equity / Math.max(evidence.peak_equity, 1e-12));
  day.hard_findings = [...new Set([...day.hard_findings, ...observation.hard_findings])];
  day.operational_faults = [...new Set([...day.operational_faults, ...observation.operational_findings])];
  if (day.return <= -evidence.policy.hard.daily_loss) {
    const finding = { code: "daily_loss_limit", event_id: eventId, session_date: sessionDate, at: observedAt };
    addFinding(evidence.hard_findings, finding); day.hard_findings = [...new Set([...day.hard_findings, finding.code])];
  }
  if (evidence.maximum_live_drawdown >= evidence.policy.hard.rolling_drawdown) {
    const finding = { code: "rolling_drawdown_limit", event_id: eventId, session_date: sessionDate, at: observedAt };
    addFinding(evidence.hard_findings, finding); day.hard_findings = [...new Set([...day.hard_findings, finding.code])];
  }
  return { duplicate: false, evidence, observation, decision: immediateDecision(evidence, eventId) };
}

function metrics(evidence) {
  const sessions = Object.values(evidence.sessions).filter((item) => item.completed && item.valid)
    .sort((a, b) => a.session_date.localeCompare(b.session_date)).slice(-evidence.policy.windows.rolling_sessions);
  const daily = sessions.map((item) => Number(item.return));
  const trades = evidence.closed_trades.slice(-evidence.policy.windows.rolling_trades);
  const tradeReturns = trades.map((item) => Number(item.net_return));
  let equity = 1, peak = 1, drawdown = 0;
  for (const value of daily) { equity *= Math.max(.000001, 1 + value); peak = Math.max(peak, equity); drawdown = Math.max(drawdown, 1 - equity / peak); }
  const wins = trades.filter((item) => item.pnl > 0), losses = trades.filter((item) => item.pnl < 0);
  const grossProfit = wins.reduce((sum, item) => sum + Number(item.gross_pnl), 0);
  const grossLoss = Math.abs(losses.reduce((sum, item) => sum + Number(item.gross_pnl), 0));
  const costs = trades.reduce((sum, item) => sum + Number(item.cost), 0);
  const observations = evidence.observations.filter((item) => sessions.some((day) => day.session_date === item.session_date));
  let lossStreak = 0, maximumLossStreak = 0;
  for (const trade of trades) { lossStreak = trade.pnl < 0 ? lossStreak + 1 : 0; maximumLossStreak = Math.max(maximumLossStreak, lossStreak); }
  return { valid_sessions: sessions.length, trades: trades.length, total_return: round(equity - 1),
    daily_sharpe: round(mean(daily) / Math.max(stdev(daily), 1e-8) * Math.sqrt(252), 4),
    trade_sharpe: round(mean(tradeReturns) / Math.max(stdev(tradeReturns), 1e-8) * Math.sqrt(Math.max(1, tradeReturns.length)), 4),
    expectancy: round(mean(tradeReturns)), drawdown: round(drawdown), hit_rate: trades.length ? wins.length / trades.length : 0,
    profit_factor: grossLoss ? round(grossProfit / grossLoss) : grossProfit > 0 ? 99 : 0,
    tail_loss: round(Math.min(0, ...tradeReturns)), cost_to_gross_profit: grossProfit ? round(costs / grossProfit) : costs ? 1e9 : 0,
    maximum_loss_streak: maximumLossStreak,
    trades_per_session: sessions.length ? round(trades.length / sessions.length) : 0,
    mean_holding_bars: round(mean(trades.map((item) => Number(item.holding_bars ?? 1)))),
    maximum_symbol_fraction: Math.max(0, ...observations.map((item) => item.maximum_symbol_fraction)),
    mean_gross_exposure: round(mean(observations.map((item) => item.gross_target))),
    mean_turnover: round(mean(observations.map((item) => item.turnover))),
    total_execution_cost: round(observations.reduce((sum, item) => sum + Number(item.cost ?? 0), 0)),
    operational_fault_rate: evidence.observations.length
      ? round(evidence.operational_findings.length / evidence.observations.length) : 0 };
}

function softFindings(evidence, summary) {
  const p = evidence.policy.soft, findings = [];
  if (summary.trades >= 5 && summary.expectancy < p.expectancy_floor) findings.push("expectancy_degradation");
  if (summary.valid_sessions >= 3 && summary.daily_sharpe < p.sharpe_floor) findings.push("risk_adjusted_return_degradation");
  if (summary.trades >= 10 && summary.profit_factor < p.profit_factor_floor) findings.push("profit_factor_degradation");
  if (summary.trades >= 10 && summary.hit_rate < p.hit_rate_floor) findings.push("hit_rate_degradation");
  if (summary.drawdown > p.drawdown_ceiling) findings.push("rolling_drawdown_degradation");
  if (summary.cost_to_gross_profit > p.cost_to_gross_profit_ceiling) findings.push("cost_degradation");
  if (summary.maximum_symbol_fraction > p.maximum_symbol_fraction) findings.push("symbol_concentration");
  if (summary.mean_holding_bars > p.maximum_mean_holding_bars) findings.push("holding_period_drift");
  const distributions = evidence.provenance.baseline?.distributions ?? {};
  const lowerSharpe = quantile(distributions.daily_sharpe ?? [], .10);
  const lowerExpectancy = quantile(distributions.expectancy ?? [], .10);
  const upperDrawdown = quantile(distributions.drawdown ?? [], .90);
  if (lowerSharpe !== null && summary.valid_sessions >= 3 && summary.daily_sharpe < lowerSharpe - 1.5) findings.push("sharpe_distribution_shift");
  if (lowerExpectancy !== null && summary.trades >= 5
      && summary.expectancy < lowerExpectancy - Math.max(.0025, Math.abs(lowerExpectancy))) findings.push("expectancy_distribution_shift");
  if (upperDrawdown !== null && summary.drawdown > Math.max(.05, upperDrawdown * 1.5)) findings.push("drawdown_distribution_shift");
  return [...new Set(findings)];
}

function trailingCount(days, classification) {
  let count = 0;
  for (const day of [...days].reverse()) { if (day.classification !== classification) break; count += 1; }
  return count;
}

function decision(evidence, outcome, findings, operationalOutcome, eventId, summary = metrics(evidence)) {
  const payload = { schema_version: HEALTH_SCHEMA_VERSION, release_id: evidence.release_id,
    policy_hash: evidence.policy_hash, provenance_hash: evidence.provenance_hash,
    outcome, quality_outcome: outcome === "operational_blocked" ? evidence.status : outcome,
    operational_outcome: operationalOutcome, findings: [...new Set(findings)].sort(), summary,
    evidence_event_id: eventId };
  payload.decision_id = `health-decision-${hashCanonical(payload).slice(0, 40)}`;
  evidence.decision = payload;
  if (!evidence.decision_history.some((item) => item.decision_id === payload.decision_id)) evidence.decision_history.push(payload);
  return payload;
}

export function finalizeHealthSession(strategy, sessionDate, { expectedEvents = 78,
  operationalFaults = [], hardFindings = [] } = {}) {
  const evidence = ensureHealthEvidence(strategy), day = session(evidence, sessionDate);
  if (day.completed) return evaluateHealthDecision(evidence, { evidenceEventId: `session:${sessionDate}` });
  day.expected_events = Math.max(1, Number(expectedEvents) || 78);
  day.coverage = round(day.observations / day.expected_events, 6);
  day.operational_faults = [...new Set([...day.operational_faults, ...operationalFaults])];
  day.hard_findings = [...new Set([...day.hard_findings, ...hardFindings])];
  day.valid = day.coverage >= evidence.policy.soft.minimum_session_coverage
    && !day.operational_faults.length && !day.hard_findings.length;
  day.completed = true;
  const summary = metrics(evidence), findings = softFindings(evidence, summary);
  day.metrics = summary; day.reason_codes = findings;
  day.classification = !day.valid ? "blocked" : findings.length ? "weak" : "healthy";
  return evaluateHealthDecision(evidence, { evidenceEventId: `session:${sessionDate}` });
}

export function evaluateHealthDecision(evidence, { evidenceEventId = "replay" } = {}) {
  if (!evidence?.policy || evidence.policy_hash !== healthPolicyHash(evidence.policy)) throw new Error("Frozen health policy hash mismatch");
  if (!evidence.provenance || evidence.provenance_hash !== hashCanonical(evidence.provenance)) throw new Error("Frozen health provenance hash mismatch");
  const complete = Object.values(evidence.sessions).filter((item) => item.completed)
    .sort((a, b) => a.session_date.localeCompare(b.session_date));
  const latest = complete.at(-1), summary = metrics(evidence);
  if (latest?.hard_findings?.length) return decision(evidence, "quarantined", latest.hard_findings, "ready", evidenceEventId, summary);
  if (latest && (!latest.valid || latest.operational_faults.length)) {
    return decision(evidence, "operational_blocked", latest.operational_faults.length
      ? latest.operational_faults : ["invalid_monitoring_session"], "operational_blocked", evidenceEventId, summary);
  }
  const valid = complete.filter((item) => item.valid), weak = trailingCount(valid, "weak"), recovered = trailingCount(valid, "healthy");
  let outcome = evidence.status === "released_paper" ? "healthy" : evidence.status;
  let findings = latest?.reason_codes ?? [];
  if (evidence.status === "quarantined") {
    if (weak >= evidence.policy.windows.retirement_weak_sessions
        && summary.trades >= evidence.policy.windows.retirement_minimum_trades) outcome = "retired";
    else outcome = "quarantined";
  } else if (evidence.status === "watch") {
    if (weak >= evidence.policy.windows.quarantine_weak_sessions) outcome = "quarantined";
    else if (recovered >= evidence.policy.windows.recovery_sessions) { outcome = "healthy"; findings = ["sustained_recovery"]; }
    else outcome = "watch";
  } else if (weak >= evidence.policy.windows.quarantine_weak_sessions) outcome = "quarantined";
  else if (weak >= evidence.policy.windows.watch_weak_sessions) outcome = "watch";
  else outcome = "healthy";
  return decision(evidence, outcome, findings, "ready", evidenceEventId, summary);
}

export function replayHealthDecision(evidence, options = {}) {
  const copy = clone(evidence); copy.decision = null; copy.decision_history = [];
  return evaluateHealthDecision(copy, options);
}

export function healthMultiplier(decisionValue, policy = createHealthPolicy()) {
  if (decisionValue.operational_outcome === "operational_blocked") return policy.overlays.operational_multiplier;
  return decisionValue.quality_outcome === "watch" ? policy.overlays.watch_multiplier
    : ["quarantined", "retired"].includes(decisionValue.quality_outcome) ? policy.overlays.quarantine_multiplier : 1;
}

export function portfolioRiskOverlays(strategies, allocation = {}, policy = createHealthPolicy()) {
  const gross = {};
  for (const item of allocation.contributions ?? []) gross[item.strategy_id] = (gross[item.strategy_id] ?? 0) + Math.abs(Number(item.notional));
  const total = Object.values(gross).reduce((sum, value) => sum + value, 0), overlays = {};
  for (const strategy of strategies) {
    const fraction = total ? (gross[strategy.id] ?? 0) / total : 0;
    overlays[strategy.id] = { multiplier: fraction > policy.overlays.concentration_fraction
      ? round(policy.overlays.concentration_fraction / fraction, 6) : 1,
    reason_codes: fraction > policy.overlays.concentration_fraction ? ["portfolio_strategy_concentration"] : [] };
  }
  const active = strategies.filter((item) => item.health);
  for (let left = 0; left < active.length; left += 1) for (let right = left + 1; right < active.length; right += 1) {
    const a = Object.values(active[left].health.sessions).filter((item) => item.completed && item.valid).slice(-10).map((item) => item.return);
    const b = Object.values(active[right].health.sessions).filter((item) => item.completed && item.valid).slice(-10).map((item) => item.return);
    const count = Math.min(a.length, b.length); if (count < 5 || a.at(-1) >= 0 || b.at(-1) >= 0) continue;
    const av = a.slice(-count), bv = b.slice(-count), am = mean(av), bm = mean(bv);
    const covariance = av.reduce((sum, value, index) => sum + (value - am) * (bv[index] - bm), 0);
    const correlation = covariance / Math.max(1e-12,
      Math.sqrt(av.reduce((sum, value) => sum + (value - am) ** 2, 0)
        * bv.reduce((sum, value) => sum + (value - bm) ** 2, 0)));
    if (correlation >= .80) for (const strategy of [active[left], active[right]]) {
      overlays[strategy.id].multiplier = Math.min(overlays[strategy.id].multiplier,
        policy.overlays.correlated_loss_multiplier);
      overlays[strategy.id].reason_codes.push("correlated_loss_cluster");
    }
  }
  return overlays;
}

export function championReplacementAssessment(candidate, champion) {
  if (!champion || !["released", "healthy", "watch", "quarantined"].includes(champion.state)) {
    return { eligible: false, reason_codes: ["champion_not_active"] };
  }
  const candidateSharpe = Number(candidate.validation?.daily_sharpe ?? candidate.validation?.sharpe ?? -Infinity);
  const championSharpe = Number(champion.validation?.daily_sharpe ?? champion.validation?.sharpe ?? -Infinity);
  const candidateDrawdown = Number(candidate.validation?.drawdown ?? Infinity);
  const championDrawdown = Number(champion.validation?.drawdown ?? Infinity);
  const behaviorDifferent = (candidate.behavior_hash ?? candidate.research?.behavior_hash)
    !== (champion.behavior_hash ?? champion.research?.behavior_hash);
  const improved = candidateSharpe >= championSharpe + .05
    || candidateDrawdown <= championDrawdown * .90;
  return { eligible: Boolean(behaviorDifferent && improved), reason_codes: [
    !behaviorDifferent && "behavior_not_diverse", !improved && "portfolio_evidence_not_improved",
  ].filter(Boolean), diagnostics: { candidate_sharpe: candidateSharpe, champion_sharpe: championSharpe,
    candidate_drawdown: candidateDrawdown, champion_drawdown: championDrawdown } };
}

export function publicHealthState(evidence) {
  if (!evidence) return null;
  const summary = evidence.policy ? metrics(evidence) : {};
  const latest = Object.values(evidence.sessions ?? {}).filter((item) => item.completed)
    .sort((a, b) => a.session_date.localeCompare(b.session_date)).at(-1) ?? null;
  return { schema_version: evidence.schema_version, release_id: evidence.release_id,
    started_at: evidence.started_at, status: evidence.status,
    operational_status: evidence.operational_status ?? "ready", policy_hash: evidence.policy_hash,
    summary, completed_sessions: Object.values(evidence.sessions ?? {}).filter((item) => item.completed).length,
    latest_session: latest ? { session_date: latest.session_date, valid: latest.valid,
      coverage: latest.coverage, classification: latest.classification,
      reason_codes: [...(latest.reason_codes ?? [])], metrics: clone(latest.metrics ?? {}) } : null,
    decision: evidence.decision ? { decision_id: evidence.decision.decision_id,
      outcome: evidence.decision.outcome, quality_outcome: evidence.decision.quality_outcome,
      operational_outcome: evidence.decision.operational_outcome,
      findings: [...evidence.decision.findings] } : null };
}
