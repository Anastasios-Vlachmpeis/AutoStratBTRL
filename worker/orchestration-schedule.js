import { exchangeParts, normalizeCalendarSessions } from "./market-data.js";

/**
 * Pure, calendar-led work planner for the Plan 07 supervisor.  It deliberately
 * creates idempotent command intents instead of dispatching work itself.
 */
export const ORCHESTRATION_SCHEDULE_VERSION = 1;

export const DEFAULT_CLOSE_PHASES = Object.freeze({
  stop_entries: 30,
  cancel_unsafe_orders: 10,
  flatten_positions: 10,
  verify_flat: 5,
  reconcile_session: -10,
  close_valid_day_ledger: -15,
  pipeline_incubation: -16,
  pipeline_release: -17,
  generate_daily_report: -20,
  schedule_bounded_research: -25,
  run_daily_cohort: -30,
  weekly_operational_diversity_review: -35,
});

function clockMinutes(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value ?? ""));
  if (!match) throw new Error(`Invalid exchange clock value: ${value}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

function isoMinute(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid orchestration timestamp");
  date.setUTCSeconds(0, 0);
  return date.toISOString();
}

function intentId(kind, scope) {
  // IDs are deliberately semantic rather than random/hashes: they remain
  // inspectable while still being stable across retries and supervisor restarts.
  return `orchestration-v${ORCHESTRATION_SCHEDULE_VERSION}:${kind}:${scope}`;
}

function knownIntentIds(options = {}) {
  const values = options.completed_intent_ids ?? options.delivered_intent_ids ?? options.intent_ids ?? [];
  return new Set(values instanceof Set ? values : values ?? []);
}

function isKnown(intent, known) {
  return known.has(intent.id);
}

function localWeekday(date) {
  // Date-only calendar values are weekday-stable at noon UTC.
  return new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" })
    .format(new Date(`${date}T12:00:00Z`));
}

function weekStart(date) {
  const value = new Date(`${date}T12:00:00Z`);
  const offset = (value.getUTCDay() + 6) % 7;
  value.setUTCDate(value.getUTCDate() - offset);
  return value.toISOString().slice(0, 10);
}

export function sessionForMarketTime(calendar, at) {
  const sessions = normalizeCalendarSessions(calendar?.sessions ?? calendar ?? []);
  const parts = exchangeParts(at);
  return sessions.find((session) => session.date === parts.date) ?? null;
}

export function canonicalFiveMinuteEventId(event = {}) {
  const id = event.event_id ?? event.id;
  if (!id || typeof id !== "string") throw new Error("Canonical five-minute event ID is required");
  if (!event.bucket_close && !event.close_t && !event.bar?.t) {
    throw new Error("Canonical five-minute event close is required");
  }
  return id;
}

/**
 * Plans the target/monitoring commands caused by one finalized canonical bar.
 * Source corrections and non-actionable bars are retained as evidence but never
 * produce a new trading decision.
 */
export function planMarketEvent(event, options = {}) {
  const eventId = canonicalFiveMinuteEventId(event);
  const known = knownIntentIds(options);
  if (event.actionable === false || event.retroactive === true) return [];
  const close = String(event.bucket_close ?? event.close_t ?? event.bar?.t);
  const common = { event_id: eventId, bucket_close: close, trigger: "canonical_five_minute_event" };
  const intents = [
    { id: intentId("compute_incubation_targets", eventId), kind: "compute_incubation_targets", data: common },
    { id: intentId("compute_released_targets", eventId), kind: "compute_released_targets", data: common },
    { id: intentId("record_monitoring_observations", eventId), kind: "record_monitoring_observations", data: common },
  ];
  return intents.filter((intent) => !isKnown(intent, known));
}

function closeIntent(kind, session, dueMinute, data = {}) {
  return {
    id: intentId(kind, `${session.date}:${dueMinute}`),
    kind,
    data: { session_date: session.date, session_open: session.open, session_close: session.close, due_exchange_minute: dueMinute, ...data },
  };
}

function isLastSessionOfWeek(session, sessions) {
  const start = weekStart(session.date);
  return sessions.filter((item) => weekStart(item.date) === start).at(-1)?.date === session.date;
}

/**
 * Plans all work due at `now`.  Passed phases remain due until their stable
 * intent ID is recorded, which makes a late Cron wake or restart repairable.
 */
export function planOrchestrationTick({ calendar, now, completed_intent_ids, delivered_intent_ids, intent_ids, close_phases } = {}) {
  const sessions = normalizeCalendarSessions(calendar?.sessions ?? calendar ?? []);
  const parts = exchangeParts(now);
  const session = sessions.find((item) => item.date === parts.date);
  if (!session) return { session: null, intents: [] };

  const known = knownIntentIds({ completed_intent_ids, delivered_intent_ids, intent_ids });
  const open = clockMinutes(session.open);
  const close = clockMinutes(session.close);
  const phases = { ...DEFAULT_CLOSE_PHASES, ...(close_phases ?? {}) };
  const intents = [];

  // A watchdog command is emitted once for every exchange minute in session.
  if (parts.minute_of_day >= open && parts.minute_of_day < close) {
    const minute = isoMinute(now);
    intents.push({ id: intentId("session_watchdog", minute), kind: "session_watchdog",
      data: { session_date: session.date, scheduled_minute: minute, trigger: "every_minute" } });
  }

  const addWhenDue = (kind, offset, data) => {
    const dueMinute = close - Number(offset);
    if (parts.minute_of_day >= dueMinute) intents.push(closeIntent(kind, session, dueMinute, data));
  };
  addWhenDue("stop_entries", phases.stop_entries);
  addWhenDue("cancel_unsafe_orders", phases.cancel_unsafe_orders);
  addWhenDue("flatten_positions", phases.flatten_positions);
  addWhenDue("verify_flat", phases.verify_flat);
  addWhenDue("reconcile_session", phases.reconcile_session);
  addWhenDue("close_valid_day_ledger", phases.close_valid_day_ledger);
  addWhenDue("pipeline_incubation", phases.pipeline_incubation);
  addWhenDue("pipeline_release", phases.pipeline_release);
  addWhenDue("generate_daily_report", phases.generate_daily_report);
  addWhenDue("schedule_bounded_research", phases.schedule_bounded_research,
    { preconditions: ["valid_day_ledger_closed", "data_health_permits", "research_not_paused"] });
  addWhenDue("run_daily_cohort", phases.run_daily_cohort,
    { preconditions: ["data_health_permits", "cohort_budget_available", "research_not_paused"] });
  if (isLastSessionOfWeek(session, sessions)) {
    addWhenDue("weekly_operational_diversity_review", phases.weekly_operational_diversity_review,
      { week_start: weekStart(session.date) });
  }

  return { session, intents: intents.filter((intent) => !isKnown(intent, known)) };
}

// Names kept explicit for callers that treat event and clock scheduling as two
// separate coordinator entry points.
export const coordinateMarketEvent = planMarketEvent;
export const coordinateScheduleTick = planOrchestrationTick;

/** Combine event-driven and clock-driven work while keeping ingestion pauses
 * scoped. Safety/watchdog/close work must continue while source polling and
 * canonical event consumption are paused. */
export function planOrchestrationWork({ events = [], calendar = null, now,
  completed_intent_ids = [], ingestion_paused = false } = {}) {
  const intents = [];
  if (!ingestion_paused) {
    for (const event of events) intents.push(...planMarketEvent(event, { completed_intent_ids }));
  }
  if (calendar) intents.push(...planOrchestrationTick({ calendar, now, completed_intent_ids }).intents);
  return intents;
}
