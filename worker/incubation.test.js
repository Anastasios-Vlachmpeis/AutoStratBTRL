import assert from "node:assert/strict";
import test from "node:test";
import { createIncubationPolicy, evaluateIncubationGate, finalizeIncubationSession,
  incubationSummary, publicIncubationState, recordIncubationEvent,
  replayIncubationDecision, startIncubation } from "./incubation.js";

const SYMBOLS = ["AAPL", "AMD", "MSFT", "NVDA", "SPY"];

function strategy(id = "S-1") {
  const value = { id, name: id, asset: "SPY", state: "incubation", dna_hash: "d".repeat(64),
    behavior_hash: `behavior-${id}`, strategy_dna: { scope: { symbols: SYMBOLS,
      universe_sha256: "u".repeat(64) }, compiler: { schema_sha256: "s".repeat(64),
      semantic_sha256: "m".repeat(64) } }, metrics: { sharpe: 1 }, validation: { sharpe: .8 } };
  startIncubation(value, { startedAt: "2026-07-01T12:00:00.000Z" });
  return value;
}

function eligibleTrade(index, sessionDate = `2026-08-${String(index % 10 + 1).padStart(2, "0")}`) {
  const symbol = SYMBOLS[index % SYMBOLS.length];
  return { trade_id: `trade-${index}`, trade_key: `${symbol}:open-${index}:close-${index}`,
    symbol, direction: index % 2 ? "short" : "long", signed_units: index % 2 ? -1 : 1,
    entry_price: 100, exit_price: 100.2, entry_at: `${sessionDate}T14:00:00.000Z`,
    exit_at: `${sessionDate}T14:05:00.000Z`, holding_bars: 1, fill_count: 2,
    gross_pnl: .2, cost: .01, pnl: .19, net_return: .0019, session_date: sessionDate,
    eligible: true, exclusion_reasons: [] };
}

function addValidDays(evidence, count) {
  for (let index = 0; index < count; index += 1) {
    const date = `2026-08-${String(index + 1).padStart(2, "0")}`;
    evidence.sessions[date] = { session_date: date, event_ids: [], observed_bars: 78,
      expected_bars: 78, coverage: 1, active_before_open: true, critical_fault: false,
      critical_faults: [], completed: true, valid: true, exclusions: [] };
  }
}

function addTrades(evidence, count) {
  evidence.closed_trade_ledger.push(...Array.from({ length: count }, (_, index) => eligibleTrade(index)));
}

function evaluation(signals, minute) {
  return { symbols: Object.fromEntries(Object.entries(signals).map(([symbol, signal]) => [symbol,
    { signal, latest_open: 100 + minute / 100, bar_time: `2026-08-03T13:${String(minute).padStart(2, "0")}:00.000Z` }])) };
}

test("shadow broker uses the next open, supports flatten-first reversals, costs, and idempotent events", () => {
  const value = strategy();
  recordIncubationEvent(value, evaluation({ SPY: 1 }, 30), { eventId: "e1", sessionDate: "2026-08-03", bucketClose: "2026-08-03T13:35:00.000Z" });
  assert.deepEqual(value.incubation.positions, {});
  recordIncubationEvent(value, evaluation({ SPY: -1 }, 35), { eventId: "e2", sessionDate: "2026-08-03", bucketClose: "2026-08-03T13:40:00.000Z" });
  assert.ok(value.incubation.positions.SPY.signed_units > 0);
  const closed = recordIncubationEvent(value, evaluation({ SPY: -1 }, 40), { eventId: "e3", sessionDate: "2026-08-03", bucketClose: "2026-08-03T13:45:00.000Z" });
  assert.equal(closed.closed_trades, 1); assert.equal(value.incubation.positions.SPY, undefined);
  recordIncubationEvent(value, evaluation({ SPY: 0 }, 45), { eventId: "e4", sessionDate: "2026-08-03", bucketClose: "2026-08-03T13:50:00.000Z" });
  assert.ok(value.incubation.positions.SPY.signed_units < 0);
  assert.ok(value.incubation.closed_trade_ledger[0].cost > 0);
  assert.equal(value.incubation.equity_curve.length, 4);
  assert.equal(value.incubation.signed_exposure_curve.length, 4);
  const fills = value.incubation.shadow_fills.length;
  assert.equal(recordIncubationEvent(value, evaluation({ SPY: 1 }, 45), { eventId: "e4", sessionDate: "2026-08-03", bucketClose: "2026-08-03T13:50:00.000Z" }).duplicate, true);
  assert.equal(value.incubation.shadow_fills.length, fills);
});

test("shadow sizing consumes the production allocator notional without exceeding the frozen strategy cap", () => {
  const value = strategy();
  const at = (minute) => ({ symbols: Object.fromEntries(SYMBOLS.map((symbol) => [symbol, {
    signal: symbol === "SPY" ? 1 : 0, shadow_target_notional: symbol === "SPY" ? 250 : 0,
    latest_open: 100, bar_time: `2026-08-03T13:${String(minute).padStart(2, "0")}:00.000Z`,
  }])) });
  recordIncubationEvent(value, at(30), { eventId: "notional-1", sessionDate: "2026-08-03",
    bucketClose: "2026-08-03T13:35:00.000Z", actualFeed: "iex" });
  recordIncubationEvent(value, at(35), { eventId: "notional-2", sessionDate: "2026-08-03",
    bucketClose: "2026-08-03T13:40:00.000Z", actualFeed: "iex" });
  assert.equal(value.incubation.positions.SPY.signed_units, 2.5);
  assert.equal(value.incubation.maximum_observed_exposure, .0025);
});

test("noncanonical bars and active critical faults block rather than judge strategy quality", () => {
  const value = strategy();
  recordIncubationEvent(value, evaluation({ SPY: 1 }, 25), { eventId: "bad-time", sessionDate: "2026-08-21", bucketClose: "2026-08-03T13:35:00.000Z" });
  assert.equal(value.incubation.sessions["2026-08-21"].observed_bars, 0);
  addValidDays(value.incubation, 10);
  value.incubation.closed_trade_ledger.push(...Array.from({ length: 67 }, (_, index) => ({
    ...eligibleTrade(index), net_return: -.02, gross_pnl: -2, pnl: -2.01,
  })));
  assert.equal(evaluateIncubationGate(value.incubation).outcome, "incubation_blocked");
});

test("200 eligible trades in seven days cannot release", () => {
  const evidence = strategy().incubation; addValidDays(evidence, 7); addTrades(evidence, 200);
  assert.equal(evaluateIncubationGate(evidence).outcome, "incubation_continue");
});

test("ten days and 66 trades continue, while trade 67 releases immediately", () => {
  const evidence = strategy().incubation; addValidDays(evidence, 10); addTrades(evidence, 66);
  assert.equal(evaluateIncubationGate(evidence).outcome, "incubation_continue");
  evidence.closed_trade_ledger.push(eligibleTrade(66));
  const decision = evaluateIncubationGate(evidence);
  assert.equal(decision.outcome, "released_paper");
  assert.equal(decision.summary.valid_trading_days, 10); assert.equal(decision.summary.eligible_trades, 67);
});

test("67 trades must span five symbols and no symbol may exceed 35 percent", () => {
  const evidence = strategy().incubation; addValidDays(evidence, 10);
  evidence.closed_trade_ledger.push(...Array.from({ length: 67 }, (_, index) => ({
    ...eligibleTrade(index), symbol: index < 30 ? "SPY" : SYMBOLS[1 + index % 4], trade_id: `con-${index}`,
  })));
  const decision = evaluateIncubationGate(evidence);
  assert.equal(decision.outcome, "incubation_continue");
  assert.ok(decision.findings.includes("symbol_concentration"));
});

test("twenty valid days below 67 trades deterministically route to rework", () => {
  const evidence = strategy().incubation; addValidDays(evidence, 20); addTrades(evidence, 66);
  const first = evaluateIncubationGate(evidence), replay = replayIncubationDecision(evidence);
  assert.equal(first.outcome, "incubation_rework"); assert.equal(replay.decision_id, first.decision_id);
});

test("invalid sessions exclude their trades and do not advance either counter", () => {
  const value = strategy(); const date = "2026-08-03";
  value.incubation.sessions[date] = { session_date: date, event_ids: ["one"], observed_bars: 1,
    expected_bars: 78, coverage: 0, active_before_open: true, critical_fault: false,
    critical_faults: [], completed: false, valid: false, exclusions: [] };
  value.incubation.closed_trade_ledger.push(eligibleTrade(0, date));
  const decision = finalizeIncubationSession(value, date);
  assert.equal(decision.outcome, "incubation_continue");
  assert.equal(value.incubation.valid_trading_days, 0); assert.equal(value.incubation.eligible_trades, 0);
  assert.equal(value.incubation.excluded_trade_ledger.length, 1);
});

test("frozen policy and provenance survive later caller changes; tampering is rejected", () => {
  const value = strategy(); const policy = createIncubationPolicy({ evidence: { release_drawdown_ceiling: .12 } });
  const fresh = { ...value, id: "S-frozen", incubation: null };
  startIncubation(fresh, { policy, startedAt: "2026-08-01T12:00:00.000Z", feed: "iex" });
  const frozenHash = fresh.incubation.policy_hash, dnaHash = fresh.incubation.provenance.dna_hash;
  startIncubation(fresh, { policy: createIncubationPolicy(), startedAt: "2026-08-02T12:00:00.000Z" });
  assert.equal(fresh.incubation.policy_hash, frozenHash); assert.equal(fresh.incubation.provenance.dna_hash, dnaHash);
  const tampered = structuredClone(fresh.incubation);
  tampered.policy.evidence.release_drawdown_ceiling = .5;
  assert.throws(() => evaluateIncubationGate(tampered), /policy hash mismatch/);
  const provenanceTamper = structuredClone(fresh.incubation);
  provenanceTamper.provenance.feed = "sip";
  assert.throws(() => evaluateIncubationGate(provenanceTamper), /provenance hash mismatch/);
});

test("public incubation projection exposes progress but no order, fill, trade, event, or baseline data", () => {
  const evidence = strategy().incubation; addValidDays(evidence, 1); addTrades(evidence, 2);
  evidence.shadow_orders.push({ secret: true }); evidence.shadow_fills.push({ secret: true });
  const publicState = publicIncubationState(evidence), serialized = JSON.stringify(publicState);
  assert.equal(publicState.eligible_trades, 2); assert.equal(publicState.valid_trading_days, 1);
  for (const forbidden of ["shadow_orders", "shadow_fills", "closed_trade_ledger", "processed_event_ids", "equity_curve", "signed_exposure_curve", "baseline"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  assert.equal(incubationSummary(evidence).contributing_symbols, 2);
});

test("legacy incubation evidence remains safely viewable until its first lazy migration", () => {
  const projected = publicIncubationState({ schema_version: 1, started_at: "2026-01-01T00:00:00Z",
    valid_trading_days: 4, closed_trades: 12, sessions: {} });
  assert.equal(projected.valid_trading_days, 4); assert.equal(projected.eligible_trades, 12);
  assert.equal(projected.policy_hash, null);
});
