import { canonicalJson, hashCanonical } from "./dsl.js";

export const INCUBATION_SCHEMA_VERSION = 2;
export const INCUBATION_POLICY_SCHEMA_VERSION = "incubation-policy-v1";
export const INCUBATION_MIN_VALID_SESSIONS = 10;
export const INCUBATION_MIN_CLOSED_TRADES = 67;
export const INCUBATION_MAX_VALID_SESSIONS = 20;
export const INCUBATION_MIN_COVERAGE = .90;
export const REGULAR_SESSION_FIVE_MINUTE_BARS = 78;

const finite = (value) => Number.isFinite(Number(value));
const round = (value, digits = 10) => Number(Number(value || 0).toFixed(digits));
const sign = (value) => Math.sign(Number(value) || 0);
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const clone = (value) => JSON.parse(JSON.stringify(value));
const freeze = (value) => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
};

function merge(left, right) {
  return Object.fromEntries(Object.keys({ ...left, ...right }).map((key) => [key,
    left[key] && typeof left[key] === "object" && !Array.isArray(left[key])
      && right?.[key] && typeof right[key] === "object" && !Array.isArray(right[key])
      ? merge(left[key], right[key]) : (right?.[key] ?? left[key]),
  ]));
}

export function createIncubationPolicy(overrides = {}) {
  const policy = merge({
    schema_version: INCUBATION_POLICY_SCHEMA_VERSION,
    progress: { minimum_valid_days: 10, minimum_eligible_trades: 67, maximum_valid_days: 20 },
    day: { minimum_coverage: .90, expected_regular_bars: 78 },
    diversity: { minimum_symbols: 5, maximum_symbol_fraction: .35 },
    execution: { starting_balance: 100_000, maximum_strategy_gross: .005,
      slippage_bps_per_fill: 5, require_next_bar_open: true,
      flatten_before_close_minutes: 10, flat_target_minutes: 5 },
    evidence: { minimum_trades_for_hard_performance: 20, hard_expectancy_floor: -.01,
      release_expectancy_floor: -.0025, hard_drawdown_ceiling: .20,
      release_drawdown_ceiling: .15, maximum_cost_to_gross_profit: .80,
      minimum_trades_per_valid_day: .1, maximum_trades_per_valid_day: 1_000,
      maximum_mean_holding_bars: 156, maximum_exposure: .005 },
  }, overrides);
  policy.schema_version = INCUBATION_POLICY_SCHEMA_VERSION;
  policy.progress.minimum_valid_days = 10;
  policy.progress.minimum_eligible_trades = 67;
  policy.progress.maximum_valid_days = 20;
  policy.day.minimum_coverage = Math.max(.90, Math.min(1, Number(policy.day.minimum_coverage) || .90));
  policy.diversity.minimum_symbols = Math.max(5, Math.floor(Number(policy.diversity.minimum_symbols) || 5));
  policy.diversity.maximum_symbol_fraction = Math.min(.35, Math.max(.01,
    Number(policy.diversity.maximum_symbol_fraction) || .35));
  return freeze(JSON.parse(canonicalJson(policy)));
}

export function incubationPolicyHash(policy = createIncubationPolicy()) { return hashCanonical(policy); }

function frozenProvenance(strategy, policy, options = {}) {
  return {
    dna_hash: strategy.dna_hash ?? strategy.strategy_dna?.dna_hash ?? null,
    compiler_schema_hash: strategy.strategy_dna?.compiler?.schema_sha256 ?? null,
    compiler_semantic_hash: strategy.strategy_dna?.compiler?.semantic_sha256 ?? null,
    universe_hash: strategy.strategy_dna?.scope?.universe_sha256 ?? null,
    feed: options.feed ?? "iex",
    execution_config_hash: strategy.backtest_runs?.development?.config_hash
      ?? strategy.backtest_runs?.holdout?.config_hash ?? null,
    supervisor_policy_hash: strategy.supervision?.policy_hash
      ?? strategy.backtest_runs?.holdout?.policy_hash ?? strategy.lifecycle?.provenance?.policy_hash ?? null,
    behavior_hash: strategy.behavior_hash ?? strategy.research?.behavior_hash ?? null,
    baseline: { development: clone(strategy.metrics ?? {}), validation: clone(strategy.validation ?? {}) },
    symbols: [...new Set(strategy.strategy_dna?.scope?.symbols ?? [strategy.asset].filter(Boolean))].sort(),
    policy_hash: incubationPolicyHash(policy),
  };
}

export function emptyIncubationEvidence({ policy = createIncubationPolicy(), strategy = {},
  startedAt = null, feed = "iex" } = {}) {
  const frozenPolicy = createIncubationPolicy(policy);
  const provenance = frozenProvenance(strategy, frozenPolicy, { feed });
  return { schema_version: INCUBATION_SCHEMA_VERSION, incubation_id: null,
    policy: frozenPolicy, policy_hash: incubationPolicyHash(frozenPolicy),
    provenance, provenance_hash: hashCanonical(provenance),
    started_at: startedAt, status: "incubation_continue", pending_targets: {}, positions: {},
    shadow_orders: [], shadow_fills: [], closed_trade_ledger: [], excluded_trade_ledger: [],
    sessions: {}, processed_event_ids: [], critical_faults: [], parity_mismatches: [],
    completed_sessions: 0, valid_trading_days: 0, closed_trades: 0, eligible_trades: 0,
    realized_pnl: 0, costs: 0, latest_prices: {}, decision_history: [], decision: null,
    maximum_observed_exposure: 0, equity_curve: [], signed_exposure_curve: [],
    qualified: false, timed_out: false };
}

export function startIncubation(strategy, { policy = createIncubationPolicy(), startedAt = new Date().toISOString(),
  feed = "iex" } = {}) {
  if (strategy.incubation?.schema_version === INCUBATION_SCHEMA_VERSION && strategy.incubation.started_at) {
    return strategy.incubation;
  }
  const evidence = emptyIncubationEvidence({ policy, strategy, startedAt, feed });
  evidence.incubation_id = `incubation-${hashCanonical({ strategy_id: strategy.id, started_at: startedAt,
    policy_hash: evidence.policy_hash }).slice(0, 40)}`;
  strategy.incubation = evidence;
  return evidence;
}

export function ensureIncubationEvidence(strategy) {
  if (strategy.incubation?.schema_version === INCUBATION_SCHEMA_VERSION) return strategy.incubation;
  const prior = strategy.incubation;
  const evidence = startIncubation({ ...strategy, incubation: null }, {
    startedAt: prior?.started_at ?? strategy.backtest_runs?.holdout?.completed_at ?? "1970-01-01T00:00:00.000Z",
  });
  if (prior?.schema_version === 1) {
    evidence.closed_trade_ledger = (prior.closed_trade_ledger ?? []).map((trade) => ({ ...trade,
      symbol: trade.symbol ?? strategy.asset, eligible: true, exclusion_reasons: [] }));
    evidence.sessions = clone(prior.sessions ?? {}); evidence.processed_event_ids = [...(prior.processed_event_ids ?? [])];
    evidence.critical_faults = clone(prior.critical_faults ?? []);
  }
  strategy.incubation = evidence;
  refreshCounters(evidence);
  return evidence;
}

function session(evidence, date) {
  return evidence.sessions[date] ??= { session_date: date, event_ids: [], observed_bars: 0,
    expected_bars: evidence.policy.day.expected_regular_bars, coverage: 0, active_before_open: false,
    critical_fault: false, critical_faults: [], completed: false, valid: false, exclusions: [] };
}

function addFault(evidence, day, code, eventId, details = {}) {
  const finding = { code, event_id: eventId, session_date: day.session_date, ...details };
  if (!day.critical_faults.some((item) => item.code === code && item.event_id === eventId)) {
    day.critical_fault = true; day.critical_faults.push(finding); evidence.critical_faults.push(finding);
  }
}

function normalizeTargets(symbolEvaluations, forceFlatten = false, policy) {
  const startingBalance = Number(policy.execution.starting_balance);
  const maximumNotional = startingBalance * Number(policy.execution.maximum_strategy_gross);
  const raw = Object.fromEntries(Object.entries(symbolEvaluations).map(([symbol, item]) => [symbol,
    forceFlatten ? 0 : finite(item?.shadow_target_notional) ? Number(item.shadow_target_notional)
      : finite(item?.target) ? Number(item.target) * startingBalance
        : sign(item?.signal) * maximumNotional]));
  const gross = Object.values(raw).reduce((sum, value) => sum + Math.abs(value), 0);
  const scale = gross > maximumNotional ? maximumNotional / gross : 1;
  return Object.fromEntries(Object.entries(raw).map(([symbol, value]) => [symbol, round(value * scale)]));
}

function fill(evidence, strategy, day, symbol, side, units, price, eventId, at, kind) {
  const orderId = `shadow-order-${hashCanonical({ incubation_id: evidence.incubation_id, event_id: eventId,
    symbol, side, units, kind }).slice(0, 32)}`;
  if (evidence.shadow_orders.some((item) => item.order_id === orderId)) return null;
  const cost = Math.abs(units * price) * evidence.policy.execution.slippage_bps_per_fill / 10_000;
  const order = { order_id: orderId, strategy_id: strategy.id, symbol, side, signed_units: units,
    price, kind, event_id: eventId, filled_at: at, cost: round(cost) };
  evidence.shadow_orders.push(order); evidence.shadow_fills.push({ ...order, fill_id: `fill-${orderId}` });
  evidence.costs = round(evidence.costs + cost);
  return order;
}

function closePosition(evidence, strategy, day, symbol, position, price, eventId, at, eventIndex) {
  const side = position.signed_units > 0 ? "sell" : "buy";
  const exit = fill(evidence, strategy, day, symbol, side, -position.signed_units, price, eventId, at, "exit");
  if (!exit) return null;
  const grossPnl = position.realized_partial_pnl + (price - position.avg_entry_price) * position.signed_units;
  const totalCost = position.entry_cost + position.partial_exit_cost + exit.cost;
  const entryNotional = Math.max(Math.abs(position.gross_entry_notional), 1e-12);
  const trade = { trade_id: `${evidence.incubation_id}:${symbol}:${position.lifecycle_sequence}`,
    trade_key: `${symbol}:${position.opened_event_id}:${eventId}`, symbol,
    direction: position.signed_units > 0 ? "long" : "short", signed_units: position.peak_units,
    entry_price: position.avg_entry_price, exit_price: price, entry_at: position.opened_at, exit_at: at,
    opened_event_id: position.opened_event_id, closed_event_id: eventId,
    holding_bars: Math.max(1, eventIndex - position.opened_event_index), fill_count: position.fill_count + 1,
    gross_pnl: round(grossPnl), cost: round(totalCost), pnl: round(grossPnl - totalCost),
    net_return: round((grossPnl - totalCost) / entryNotional), session_date: day.session_date,
    eligible: !day.critical_fault, exclusion_reasons: day.critical_fault ? ["critical_fault_period"] : [] };
  evidence.closed_trade_ledger.push(trade); evidence.realized_pnl = round(evidence.realized_pnl + trade.pnl);
  return trade;
}

function reconcileSymbol(evidence, strategy, day, symbol, desiredNotional, price, eventId, at, eventIndex) {
  const desired = round(desiredNotional / price);
  const current = evidence.positions[symbol];
  if (!current && desired === 0) return 0;
  if (!current) {
    const entry = fill(evidence, strategy, day, symbol, desired > 0 ? "buy" : "sell", desired,
      price, eventId, at, "entry");
    if (entry) evidence.positions[symbol] = { signed_units: desired, peak_units: desired,
      avg_entry_price: price, opened_at: at, opened_event_id: eventId, opened_event_index: eventIndex,
      lifecycle_sequence: (evidence.closed_trade_ledger.filter((item) => item.symbol === symbol).length + 1),
      gross_entry_notional: Math.abs(desired * price), entry_cost: entry.cost,
      partial_exit_cost: 0, realized_partial_pnl: 0, fill_count: 1 };
    return 0;
  }
  if (desired === 0 || sign(desired) !== sign(current.signed_units)) {
    const trade = closePosition(evidence, strategy, day, symbol, current, price, eventId, at, eventIndex);
    if (trade) delete evidence.positions[symbol];
    return trade ? 1 : 0;
  }
  if (Math.abs(desired - current.signed_units) < 1e-10) return 0;
  const delta = desired - current.signed_units;
  if (Math.abs(desired) > Math.abs(current.signed_units)) {
    const added = fill(evidence, strategy, day, symbol, delta > 0 ? "buy" : "sell", delta,
      price, eventId, at, "increase");
    if (added) {
      const oldAbs = Math.abs(current.signed_units), addAbs = Math.abs(delta);
      current.avg_entry_price = (current.avg_entry_price * oldAbs + price * addAbs) / (oldAbs + addAbs);
      current.signed_units = desired; current.peak_units = sign(desired) * Math.max(Math.abs(current.peak_units), Math.abs(desired));
      current.gross_entry_notional += Math.abs(delta * price); current.entry_cost += added.cost; current.fill_count += 1;
    }
  } else {
    const reduced = fill(evidence, strategy, day, symbol, delta > 0 ? "buy" : "sell", delta,
      price, eventId, at, "partial_exit");
    if (reduced) {
      current.realized_partial_pnl += (price - current.avg_entry_price) * -delta;
      current.partial_exit_cost += reduced.cost; current.signed_units = desired; current.fill_count += 1;
    }
  }
  return 0;
}

/** Apply the prior close targets at this bar's open, then freeze this close's
 * multi-symbol targets for the next canonical bar. */
export function recordIncubationEvent(strategy, evaluation, { eventId, sessionDate, bucketClose,
  forceFlatten = false, operationalFaults = [], actualFeed = null } = {}) {
  if (!eventId || !sessionDate || !bucketClose) throw new Error("Canonical incubation event identity is required");
  const evidence = ensureIncubationEvidence(strategy);
  if (evidence.processed_event_ids.includes(eventId)) return { duplicate: true, evidence, closed_trades: 0 };
  const day = session(evidence, sessionDate); const eventIndex = evidence.processed_event_ids.length;
  evidence.processed_event_ids.push(eventId); evidence.processed_event_ids = evidence.processed_event_ids.slice(-8192);
  const symbolEvaluations = evaluation?.symbols && Object.keys(evaluation.symbols).length
    ? evaluation.symbols : { [strategy.asset]: evaluation };
  const closeMs = new Date(bucketClose).getTime(); let canonicalSymbols = 0;
  if (evidence.provenance_hash !== hashCanonical(evidence.provenance)) {
    addFault(evidence, day, "frozen_provenance_hash_mismatch", eventId);
  }
  if (evidence.provenance?.dna_hash && strategy.dna_hash !== evidence.provenance.dna_hash) {
    addFault(evidence, day, "dna_hash_mismatch", eventId);
  }
  if (actualFeed && actualFeed !== evidence.provenance?.feed) addFault(evidence, day, "data_feed_mismatch", eventId);
  for (const symbol of evidence.provenance?.symbols ?? []) {
    if (!symbolEvaluations[symbol]) addFault(evidence, day, "missing_strategy_symbol", eventId, { symbol });
  }
  for (const [symbol, item] of Object.entries(symbolEvaluations)) {
    const barMs = new Date(item?.bar_time).getTime();
    const canonical = Number.isFinite(closeMs) && Number.isFinite(barMs)
      && Math.abs((closeMs - 5 * 60_000) - barMs) <= 1000;
    if (!canonical) addFault(evidence, day, "noncanonical_bar_time", eventId, { symbol });
    else canonicalSymbols += 1;
    if (item?.critical_fault) addFault(evidence, day, String(item.critical_fault), eventId, { symbol });
    if (finite(item?.target) && sign(item.target) !== sign(item?.signal)) {
      const mismatch = { event_id: eventId, session_date: sessionDate, symbol, reason: "signal_target_mismatch" };
      evidence.parity_mismatches.push(mismatch); addFault(evidence, day, mismatch.reason, eventId, { symbol });
    }
  }
  for (const code of operationalFaults) addFault(evidence, day, String(code), eventId);
  if (canonicalSymbols > 0) {
    day.event_ids.push(eventId); day.observed_bars = new Set(day.event_ids).size;
  }
  let newlyClosed = 0;
  for (const [symbol, desired] of Object.entries(evidence.pending_targets)) {
    const item = symbolEvaluations[symbol]; const open = Number(item?.latest_open);
    if (!finite(open) || open <= 0) { addFault(evidence, day, "missing_next_open", eventId, { symbol }); continue; }
    evidence.latest_prices[symbol] = open;
    newlyClosed += reconcileSymbol(evidence, strategy, day, symbol, Number(desired), open,
      eventId, item?.bar_time ?? bucketClose, eventIndex);
  }
  const targets = normalizeTargets(symbolEvaluations, forceFlatten, evidence.policy);
  evidence.maximum_observed_exposure = Math.max(evidence.maximum_observed_exposure,
    Object.values(targets).reduce((sum, value) => sum + Math.abs(value), 0)
      / evidence.policy.execution.starting_balance);
  evidence.pending_targets = targets;
  const openContribution = Object.entries(evidence.positions).reduce((sum, [symbol, position]) => {
    const price = evidence.latest_prices[symbol] ?? position.avg_entry_price;
    return sum + position.realized_partial_pnl + (price - position.avg_entry_price) * position.signed_units
      - position.entry_cost - position.partial_exit_cost;
  }, 0);
  const equity = evidence.policy.execution.starting_balance + evidence.realized_pnl + openContribution;
  evidence.equity_curve.push({ at: bucketClose, value: round(equity), event_id: eventId });
  evidence.signed_exposure_curve.push({ at: bucketClose,
    by_symbol: Object.fromEntries(Object.entries(evidence.positions).map(([symbol, position]) => [symbol,
      round(position.signed_units * (evidence.latest_prices[symbol] ?? position.avg_entry_price)
        / evidence.policy.execution.starting_balance)])), event_id: eventId });
  evidence.closed_trades = evidence.closed_trade_ledger.length;
  refreshCounters(evidence);
  return { duplicate: false, evidence, closed_trades: newlyClosed };
}

// Compatibility entry point used by older callers/tests.
export function recordIncubationBar(strategy, evaluation, options = {}) {
  return recordIncubationEvent(strategy, evaluation, options);
}

function exchangeLocal(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(date).map((item) => [item.type, item.value]));
  return { date: `${values.year}-${values.month}-${values.day}`,
    minute: Number(values.hour) * 60 + Number(values.minute) };
}

function activeBeforeOpen(evidence, sessionDate, sessionOpen) {
  const started = exchangeLocal(evidence.started_at); const [hour, minute] = String(sessionOpen ?? "09:30").split(":").map(Number);
  if (!started || !Number.isFinite(hour + minute)) return false;
  return started.date < sessionDate || (started.date === sessionDate && started.minute <= hour * 60 + minute);
}

function refreshCounters(evidence) {
  evidence.completed_sessions = Object.values(evidence.sessions).filter((item) => item.completed).length;
  evidence.valid_trading_days = Object.values(evidence.sessions).filter((item) => item.completed && item.valid).length;
  const eligible = evidence.closed_trade_ledger.filter((trade) => trade.eligible !== false);
  evidence.closed_trades = evidence.closed_trade_ledger.length; evidence.eligible_trades = eligible.length;
  return eligible;
}

export function finalizeIncubationSession(strategy, sessionDate, { expectedBars = REGULAR_SESSION_FIVE_MINUTE_BARS,
  marketDataCriticalFault = false, sessionOpen = "09:30", operationalFaults = [] } = {}) {
  const evidence = ensureIncubationEvidence(strategy), day = session(evidence, sessionDate);
  if (day.completed) return evaluateIncubationGate(evidence);
  day.expected_bars = Math.max(1, Number(expectedBars) || REGULAR_SESSION_FIVE_MINUTE_BARS);
  day.coverage = round(day.observed_bars / day.expected_bars, 6);
  day.active_before_open = activeBeforeOpen(evidence, sessionDate, sessionOpen);
  if (marketDataCriticalFault) addFault(evidence, day, "market_data_critical_fault", `session:${sessionDate}`);
  for (const code of operationalFaults) addFault(evidence, day, String(code), `session:${sessionDate}`);
  if (Object.keys(evidence.positions).length) addFault(evidence, day, "not_flat_at_session_end", `session:${sessionDate}`);
  day.valid = day.active_before_open && day.coverage >= evidence.policy.day.minimum_coverage && !day.critical_fault;
  if (!day.active_before_open) day.exclusions.push("partial_start_day");
  if (day.coverage < evidence.policy.day.minimum_coverage) day.exclusions.push("insufficient_coverage");
  if (day.critical_fault) day.exclusions.push("critical_fault");
  day.completed = true;
  if (!day.valid) for (const trade of evidence.closed_trade_ledger.filter((item) => item.session_date === sessionDate)) {
    trade.eligible = false;
    if (!trade.exclusion_reasons.includes("invalid_trading_day")) trade.exclusion_reasons.push("invalid_trading_day");
    if (!evidence.excluded_trade_ledger.some((item) => item.trade_id === trade.trade_id)) {
      evidence.excluded_trade_ledger.push({ ...trade, exclusion_reasons: [...trade.exclusion_reasons] });
    }
  }
  refreshCounters(evidence);
  const decision = evaluateIncubationGate(evidence);
  evidence.qualified = decision.outcome === "released_paper"; evidence.timed_out = decision.outcome === "incubation_rework";
  return decision;
}

export function incubationSummary(evidence) {
  const eligible = refreshCounters(evidence);
  const bySymbol = {};
  for (const trade of eligible) bySymbol[trade.symbol] = (bySymbol[trade.symbol] ?? 0) + 1;
  const returns = eligible.map((trade) => Number(trade.net_return)); let equity = 1, peak = 1, drawdown = 0;
  for (const value of returns) { equity *= Math.max(.000001, 1 + value); peak = Math.max(peak, equity); drawdown = Math.max(drawdown, 1 - equity / peak); }
  const grossProfit = eligible.reduce((sum, trade) => sum + Math.max(0, Number(trade.gross_pnl)), 0);
  const costs = eligible.reduce((sum, trade) => sum + Number(trade.cost), 0);
  const maximumSymbolCount = Math.max(0, ...Object.values(bySymbol));
  return { valid_trading_days: evidence.valid_trading_days, eligible_trades: eligible.length,
    completed_trades: evidence.closed_trade_ledger.length, excluded_trades: evidence.excluded_trade_ledger.length,
    contributing_symbols: Object.keys(bySymbol).length, symbol_counts: bySymbol,
    maximum_symbol_fraction: eligible.length ? maximumSymbolCount / eligible.length : 0,
    expectancy: round(mean(returns)), drawdown: round(drawdown), total_return: round(equity - 1),
    trades_per_valid_day: evidence.valid_trading_days ? round(eligible.length / evidence.valid_trading_days) : 0,
    mean_holding_bars: round(mean(eligible.map((trade) => Number(trade.holding_bars)))),
    cost_to_gross_profit: grossProfit > 0 ? round(costs / grossProfit) : (costs > 0 ? 1e9 : 0),
    maximum_exposure: round(evidence.maximum_observed_exposure),
    parity_mismatches: evidence.parity_mismatches.length,
    processed_events: evidence.processed_event_ids.length };
}

/** Deliberately small, non-sensitive projection for the browser. Detailed
 * orders, fills, trades, event identities and frozen baselines stay private. */
export function publicIncubationState(evidence) {
  if (!evidence) return null;
  if (evidence.schema_version !== INCUBATION_SCHEMA_VERSION || !evidence.policy) {
    return { schema_version: Number(evidence.schema_version ?? 1), incubation_id: evidence.incubation_id ?? null,
      started_at: evidence.started_at ?? null, status: evidence.status ?? "incubation_continue",
      policy_hash: null, valid_trading_days: Number(evidence.valid_trading_days ?? 0),
      eligible_trades: Number(evidence.eligible_trades ?? evidence.closed_trades ?? 0),
      completed_trades: Number(evidence.closed_trades ?? 0), excluded_trades: 0,
      contributing_symbols: 0, maximum_symbol_fraction: 0,
      sessions: Object.fromEntries(Object.entries(evidence.sessions ?? {}).map(([date, day]) => [date, {
        session_date: day.session_date ?? date, completed: Boolean(day.completed), valid: Boolean(day.valid),
        coverage: Number(day.coverage ?? 0), exclusions: [...(day.exclusions ?? [])], critical_faults: [],
      }])), decision: null };
  }
  const summary = incubationSummary(evidence);
  return { schema_version: evidence.schema_version, incubation_id: evidence.incubation_id,
    started_at: evidence.started_at, status: evidence.status, policy_hash: evidence.policy_hash,
    valid_trading_days: summary.valid_trading_days, eligible_trades: summary.eligible_trades,
    completed_trades: summary.completed_trades, excluded_trades: summary.excluded_trades,
    contributing_symbols: summary.contributing_symbols,
    maximum_symbol_fraction: summary.maximum_symbol_fraction,
    sessions: Object.fromEntries(Object.entries(evidence.sessions ?? {}).map(([date, day]) => [date, {
      session_date: day.session_date, completed: Boolean(day.completed), valid: Boolean(day.valid),
      coverage: Number(day.coverage ?? 0), exclusions: [...(day.exclusions ?? [])],
      critical_faults: (day.critical_faults ?? []).map((item) => ({ code: item.code })),
    }])),
    decision: evidence.decision ? { decision_id: evidence.decision.decision_id,
      outcome: evidence.decision.outcome, findings: [...(evidence.decision.findings ?? [])] } : null,
  };
}

export function evaluateIncubationGate(evidence, { releasedBehaviorHashes = [] } = {}) {
  if (!evidence?.policy || evidence.policy_hash !== incubationPolicyHash(evidence.policy)) {
    throw new Error("Frozen incubation policy hash mismatch");
  }
  if (!evidence.provenance || evidence.provenance_hash !== hashCanonical(evidence.provenance)) {
    throw new Error("Frozen incubation provenance hash mismatch");
  }
  const summary = incubationSummary(evidence), policy = evidence.policy, findings = [];
  const terminalPerformance = summary.eligible_trades >= policy.evidence.minimum_trades_for_hard_performance
    && summary.expectancy < policy.evidence.hard_expectancy_floor;
  if (terminalPerformance) findings.push("hard_expectancy_floor");
  if (summary.drawdown > policy.evidence.hard_drawdown_ceiling) findings.push("hard_drawdown_ceiling");
  let outcome = findings.length ? "incubation_reject" : "incubation_continue";
  if (!findings.length && summary.valid_trading_days >= policy.progress.maximum_valid_days
      && summary.eligible_trades < policy.progress.minimum_eligible_trades) {
    outcome = "incubation_rework"; findings.push("maximum_days_without_trade_count");
  }
  const countersReady = summary.valid_trading_days >= policy.progress.minimum_valid_days
    && summary.eligible_trades >= policy.progress.minimum_eligible_trades;
  if (!findings.length && countersReady) {
    if (summary.contributing_symbols < policy.diversity.minimum_symbols) findings.push("insufficient_symbol_diversity");
    if (summary.maximum_symbol_fraction > policy.diversity.maximum_symbol_fraction) findings.push("symbol_concentration");
    if (summary.expectancy < policy.evidence.release_expectancy_floor) findings.push("expectancy_degradation");
    if (summary.drawdown > policy.evidence.release_drawdown_ceiling) findings.push("incubation_drawdown");
    if (summary.cost_to_gross_profit > policy.evidence.maximum_cost_to_gross_profit) findings.push("cost_sensitivity");
    if (summary.mean_holding_bars > policy.evidence.maximum_mean_holding_bars) findings.push("holding_time_out_of_range");
    if (summary.trades_per_valid_day < policy.evidence.minimum_trades_per_valid_day
        || summary.trades_per_valid_day > policy.evidence.maximum_trades_per_valid_day) findings.push("trade_frequency_out_of_range");
    if (summary.maximum_exposure > policy.evidence.maximum_exposure) findings.push("exposure_out_of_range");
    const baseline = evidence.provenance.baseline ?? {};
    const durations = [baseline.development?.average_trade_duration_bars,
      baseline.validation?.average_trade_duration_bars].map(Number).filter((value) => value > 0);
    if (durations.length && (summary.mean_holding_bars < Math.min(...durations) / 4
        || summary.mean_holding_bars > Math.max(...durations) * 4)) findings.push("holding_time_baseline_deviation");
    const baselineDrawdowns = [baseline.development?.drawdown, baseline.validation?.drawdown]
      .map(Number).filter((value) => value >= 0);
    if (baselineDrawdowns.length && summary.drawdown > Math.max(.02, Math.max(...baselineDrawdowns) * 2.5)) {
      findings.push("drawdown_baseline_deviation");
    }
    if (summary.parity_mismatches) findings.push("live_replay_parity_mismatch");
    if (evidence.provenance?.behavior_hash && releasedBehaviorHashes.includes(evidence.provenance.behavior_hash)) {
      findings.push("behavior_redundant_with_release");
    }
    outcome = findings.length ? (summary.valid_trading_days >= policy.progress.maximum_valid_days
      ? "incubation_reject" : "incubation_continue") : "released_paper";
  }
  const days = Object.values(evidence.sessions);
  const latestDay = days.filter((item) => item.completed).sort((a, b) => a.session_date.localeCompare(b.session_date)).at(-1);
  const activeCriticalFault = days.some((item) => !item.completed && item.critical_fault);
  if ((latestDay && !latestDay.valid && latestDay.critical_fault) || activeCriticalFault) {
    outcome = "incubation_blocked";
  }
  const replay = { schema_version: INCUBATION_SCHEMA_VERSION, policy_hash: evidence.policy_hash,
    incubation_id: evidence.incubation_id, outcome, summary, findings };
  replay.decision_id = `incubation-decision-${hashCanonical(replay).slice(0, 40)}`;
  evidence.status = outcome; evidence.decision = replay;
  if (!evidence.decision_history.some((item) => item.decision_id === replay.decision_id)) evidence.decision_history.push(replay);
  return replay;
}

export function replayIncubationDecision(evidence, options = {}) {
  const copy = clone(evidence); copy.decision = null; copy.decision_history = [];
  return evaluateIncubationGate(copy, options);
}

// Legacy scalar disposition retained for callers that only need counter state.
export function incubationDecision(evidence) {
  const outcome = evaluateIncubationGate(evidence).outcome;
  return outcome === "released_paper" ? "qualified"
    : outcome === "incubation_rework" ? "rework" : outcome === "incubation_reject" ? "reject" : "continue";
}
