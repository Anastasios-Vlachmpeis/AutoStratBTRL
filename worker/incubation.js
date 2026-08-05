export const INCUBATION_SCHEMA_VERSION = 1;
export const INCUBATION_MIN_VALID_SESSIONS = 10;
export const INCUBATION_MIN_CLOSED_TRADES = 67;
export const INCUBATION_MAX_VALID_SESSIONS = 20;
export const INCUBATION_MIN_COVERAGE = .90;
export const REGULAR_SESSION_FIVE_MINUTE_BARS = 78;

const finite = (value) => Number.isFinite(Number(value));
const sign = (value) => Math.sign(Number(value) || 0);
const round = (value, digits = 8) => Number(Number(value || 0).toFixed(digits));

export function emptyIncubationEvidence() {
  return { schema_version: INCUBATION_SCHEMA_VERSION, pending_target: null,
    position: { signed_units: 0, entry_price: null, entry_at: null },
    closed_trade_ledger: [], sessions: {}, processed_event_ids: [], critical_faults: [],
    completed_sessions: 0, valid_trading_days: 0, closed_trades: 0, realized_pnl: 0,
    qualified: false, timed_out: false };
}

export function ensureIncubationEvidence(strategy) {
  const current = strategy.incubation?.schema_version === INCUBATION_SCHEMA_VERSION
    ? strategy.incubation : emptyIncubationEvidence();
  current.position ??= { signed_units: 0, entry_price: null, entry_at: null };
  current.closed_trade_ledger ??= []; current.sessions ??= {};
  current.processed_event_ids ??= []; current.critical_faults ??= [];
  strategy.incubation = current;
  return current;
}

function session(evidence, date) {
  return evidence.sessions[date] ??= { session_date: date, event_ids: [], observed_bars: 0,
    expected_bars: REGULAR_SESSION_FIVE_MINUTE_BARS, coverage: 0, critical_fault: false,
    critical_faults: [], completed: false, valid: false };
}

function fault(evidence, day, code, eventId) {
  const finding = { code, event_id: eventId, session_date: day.session_date };
  day.critical_fault = true; day.critical_faults.push(finding); evidence.critical_faults.push(finding);
}

/** Apply the prior close's target at this bar's open, then retain this close's
 * signal as the target for the following bar. No broker/order objects exist in
 * this state machine. */
export function recordIncubationBar(strategy, evaluation, { eventId, sessionDate, bucketClose } = {}) {
  if (!eventId || !sessionDate || !bucketClose) throw new Error("Canonical incubation event identity is required");
  const evidence = ensureIncubationEvidence(strategy);
  if (evidence.processed_event_ids.includes(eventId)) return { duplicate: true, evidence };
  const day = session(evidence, sessionDate);
  evidence.processed_event_ids.push(eventId); evidence.processed_event_ids = evidence.processed_event_ids.slice(-4096);
  const closeMs = new Date(bucketClose).getTime(), barMs = new Date(evaluation?.bar_time).getTime();
  const canonical = Number.isFinite(closeMs) && Number.isFinite(barMs) && Math.abs((closeMs - 5 * 60_000) - barMs) <= 1000;
  if (!canonical) fault(evidence, day, "noncanonical_bar_time", eventId);
  else { day.event_ids.push(eventId); day.observed_bars = day.event_ids.length; }
  const open = Number(evaluation?.latest_open);
  if (!finite(open) || open <= 0) fault(evidence, day, "missing_next_open", eventId);
  if (evaluation?.critical_fault) fault(evidence, day, String(evaluation.critical_fault), eventId);

  const target = evidence.pending_target;
  const position = evidence.position;
  const fillAt = evaluation?.bar_time ?? bucketClose;
  if (canonical && target !== null && finite(open) && open > 0 && target !== position.signed_units) {
    if (position.signed_units !== 0) {
      const trade = { trade_id: `${strategy.id}:${eventId}:${evidence.closed_trade_ledger.length + 1}`,
        direction: position.signed_units > 0 ? "long" : "short", signed_units: position.signed_units,
        entry_price: position.entry_price, exit_price: open, entry_at: position.entry_at,
        exit_at: fillAt, pnl: round((open - position.entry_price) * position.signed_units) };
      evidence.closed_trade_ledger.push(trade); evidence.realized_pnl = round(evidence.realized_pnl + trade.pnl);
    }
    evidence.position = target === 0 ? { signed_units: 0, entry_price: null, entry_at: null }
      : { signed_units: target, entry_price: open, entry_at: fillAt };
  }
  if (canonical) evidence.pending_target = sign(evaluation?.signal);
  evidence.closed_trades = evidence.closed_trade_ledger.length;
  return { duplicate: false, evidence };
}

export function finalizeIncubationSession(strategy, sessionDate, { expectedBars = REGULAR_SESSION_FIVE_MINUTE_BARS,
  marketDataCriticalFault = false } = {}) {
  const evidence = ensureIncubationEvidence(strategy), day = session(evidence, sessionDate);
  if (day.completed) return incubationDecision(evidence);
  day.expected_bars = Math.max(1, Number(expectedBars) || REGULAR_SESSION_FIVE_MINUTE_BARS);
  day.coverage = round(day.observed_bars / day.expected_bars, 6);
  if (marketDataCriticalFault) fault(evidence, day, "market_data_critical_fault", `session:${sessionDate}`);
  day.valid = day.coverage >= INCUBATION_MIN_COVERAGE && !day.critical_fault;
  day.completed = true;
  evidence.completed_sessions = Object.values(evidence.sessions).filter((item) => item.completed).length;
  evidence.valid_trading_days = Object.values(evidence.sessions).filter((item) => item.completed && item.valid).length;
  const decision = incubationDecision(evidence);
  evidence.qualified = decision === "qualified"; evidence.timed_out = decision === "rework";
  return decision;
}

export function incubationDecision(evidence) {
  if (Number(evidence.valid_trading_days) >= INCUBATION_MIN_VALID_SESSIONS
      && Number(evidence.closed_trades) >= INCUBATION_MIN_CLOSED_TRADES) return "qualified";
  return Number(evidence.valid_trading_days) >= INCUBATION_MAX_VALID_SESSIONS ? "rework" : "continue";
}
