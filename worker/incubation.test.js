import assert from "node:assert/strict";
import test from "node:test";
import { emptyIncubationEvidence, finalizeIncubationSession, incubationDecision, recordIncubationBar } from "./incubation.js";

function strategy() { return { id: "S-1", state: "incubation", incubation: emptyIncubationEvidence() }; }

test("incubation applies the prior close target at the next open with signed virtual trades", () => {
  const value = strategy();
  recordIncubationBar(value, { signal: 1, latest_open: 100, bar_time: "2026-08-03T13:30:00Z" }, { eventId: "e1", sessionDate: "2026-08-03", bucketClose: "2026-08-03T13:35:00Z" });
  assert.equal(value.incubation.position.signed_units, 0);
  recordIncubationBar(value, { signal: -1, latest_open: 102, bar_time: "2026-08-03T13:35:00Z" }, { eventId: "e2", sessionDate: "2026-08-03", bucketClose: "2026-08-03T13:40:00Z" });
  assert.equal(value.incubation.position.signed_units, 1); assert.equal(value.incubation.position.entry_price, 102);
  recordIncubationBar(value, { signal: 0, latest_open: 101, bar_time: "2026-08-03T13:40:00Z" }, { eventId: "e3", sessionDate: "2026-08-03", bucketClose: "2026-08-03T13:45:00Z" });
  assert.equal(value.incubation.position.signed_units, -1);
  assert.equal(value.incubation.closed_trades, 1); assert.equal(value.incubation.closed_trade_ledger[0].pnl, -1);
  assert.equal(recordIncubationBar(value, { signal: 1, latest_open: 999 }, { eventId: "e3", sessionDate: "2026-08-03", bucketClose: "2026-08-03T13:45:00Z" }).duplicate, true);
});

test("qualification requires both ten valid sessions and 67 completed trades", () => {
  const value = strategy(); value.incubation.closed_trades = 67;
  for (let day = 1; day <= 10; day += 1) {
    const date = `2026-08-${String(day).padStart(2, "0")}`;
    value.incubation.sessions[date] = { session_date: date, event_ids: Array.from({ length: 71 }, (_, i) => `${date}:${i}`),
      observed_bars: 71, critical_fault: false, critical_faults: [], completed: false };
    assert.equal(finalizeIncubationSession(value, date), day === 10 ? "qualified" : "continue");
  }
  assert.equal(value.incubation.qualified, true); assert.equal(value.incubation.valid_trading_days, 10);
});

test("twenty valid sessions without both gates routes to rework and faulty days do not count", () => {
  const value = strategy();
  let decision = "continue";
  for (let day = 1; day <= 21; day += 1) {
    const date = `2026-07-${String(day).padStart(2, "0")}`;
    value.incubation.sessions[date] = { session_date: date, event_ids: Array.from({ length: 78 }, (_, i) => `${date}:${i}`),
      observed_bars: 78, critical_fault: false, critical_faults: [], completed: false };
    decision = finalizeIncubationSession(value, date, { marketDataCriticalFault: day === 1 });
    if (day === 20) assert.equal(decision, "continue");
  }
  assert.equal(value.incubation.valid_trading_days, 20); assert.equal(decision, "rework");
  assert.equal(value.incubation.timed_out, true); assert.equal(incubationDecision(value.incubation), "rework");
});

test("stale monitoring evaluations cannot masquerade as canonical five-minute evidence", () => {
  const value = strategy();
  recordIncubationBar(value, { signal: 1, latest_open: 100, bar_time: "2026-08-03T13:25:00Z" },
    { eventId: "canonical-e1", sessionDate: "2026-08-03", bucketClose: "2026-08-03T13:35:00Z" });
  assert.equal(value.incubation.pending_target, null);
  assert.equal(value.incubation.sessions["2026-08-03"].observed_bars, 0);
  assert.equal(value.incubation.sessions["2026-08-03"].critical_faults[0].code, "noncanonical_bar_time");
});
