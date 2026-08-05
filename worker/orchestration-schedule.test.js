import assert from "node:assert/strict";
import test from "node:test";

import { coordinateMarketEvent, planOrchestrationTick } from "./orchestration-schedule.js";

const calendar = { sessions: [
  { date: "2026-03-06", open: "09:30", close: "16:00" },
  { date: "2026-03-09", open: "09:30", close: "16:00" },
  { date: "2026-11-27", open: "09:30", close: "13:00" },
] };

function kinds(result) { return result.intents.map((intent) => intent.kind); }

test("canonical five-minute events create stable target and monitoring intents", () => {
  const event = { id: "five-minute-abc", bucket_close: "2026-03-09T13:35:00.000Z", actionable: true };
  const first = coordinateMarketEvent(event);
  assert.deepEqual(first.map((item) => item.kind), ["compute_incubation_targets", "compute_released_targets", "record_monitoring_observations"]);
  assert.deepEqual(first, coordinateMarketEvent(event));
  assert.deepEqual(coordinateMarketEvent(event, { completed_intent_ids: first.map((item) => item.id) }), []);
  assert.deepEqual(coordinateMarketEvent({ ...event, retroactive: true }), []);
});

test("every-minute watchdog follows the NYSE calendar through DST and skips holidays", () => {
  assert.ok(kinds(planOrchestrationTick({ calendar, now: "2026-03-09T13:30:45Z" })).includes("session_watchdog"));
  assert.ok(kinds(planOrchestrationTick({ calendar, now: "2026-03-09T20:01:00Z" })).includes("verify_flat"));
  assert.deepEqual(planOrchestrationTick({ calendar, now: "2026-03-07T14:00:00Z" }), { session: null, intents: [] });
});

test("near-close phases use an exact early-close session boundary", () => {
  const before = planOrchestrationTick({ calendar, now: "2026-11-27T17:44:00Z" }); // 12:44 ET
  assert.equal(kinds(before).includes("stop_entries"), false);
  const stop = planOrchestrationTick({ calendar, now: "2026-11-27T17:45:00Z" });
  assert.ok(kinds(stop).includes("stop_entries"));
  const flatten = planOrchestrationTick({ calendar, now: "2026-11-27T17:55:00Z" });
  assert.ok(kinds(flatten).includes("cancel_unsafe_orders"));
  assert.ok(kinds(flatten).includes("flatten_positions"));
  assert.equal(flatten.intents.find((item) => item.kind === "flatten_positions").data.session_close, "13:00");
});

test("late ticks repair close work while known IDs suppress duplicate delivery", () => {
  const late = planOrchestrationTick({ calendar, now: "2026-11-27T18:35:00Z" });
  for (const kind of ["reconcile_session", "close_valid_day_ledger", "generate_daily_report", "schedule_bounded_research", "run_daily_cohort", "weekly_operational_diversity_review"]) {
    assert.ok(kinds(late).includes(kind), kind);
  }
  const replay = planOrchestrationTick({ calendar, now: "2026-11-27T18:35:00Z", completed_intent_ids: late.intents.map((item) => item.id) });
  assert.deepEqual(replay.intents, []);
});
