import { hashCanonical } from "./dsl.js";

export const OBSERVABILITY_SCHEMA_VERSION = 1;
export const ALERT_SEVERITIES = Object.freeze(["info", "research_degraded", "execution_blocked", "critical_risk"]);
export const SUBSYSTEMS = Object.freeze(["scheduler", "market_data", "queue", "backtester", "broker", "storage", "cost_telemetry"]);
const SECRET_KEY = /(secret|password|token|api[_-]?key|hmac|credential|authorization|private[_-]?key)/i;
const SECRET_VALUE = /(authorization|bearer|token|api[-_ ]?key|secret|password|hmac|credential)\s*[:=]\s*[^\s,;]+/ig;
const iso = (value) => {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (Number.isNaN(date.getTime())) throw new TypeError("Operational event timestamp is invalid");
  return date.toISOString();
};

export function redactOperationalValue(value, seen = new WeakSet()) {
  if (typeof value === "string") return value.replace(SECRET_VALUE, "$1=[REDACTED]");
  if (value == null || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => redactOperationalValue(item, seen));
  return Object.fromEntries(Object.entries(value).slice(0, 200).map(([key, item]) => [key,
    SECRET_KEY.test(key) ? "[REDACTED]" : redactOperationalValue(item, seen)]));
}

export function ensureObservabilityState(state) {
  state.observability ??= { schema_version: OBSERVABILITY_SCHEMA_VERSION, events: [], metrics: {}, heartbeats: {}, alerts: [] };
  state.observability.schema_version = OBSERVABILITY_SCHEMA_VERSION;
  state.observability.events ??= []; state.observability.metrics ??= {};
  state.observability.heartbeats ??= {}; state.observability.alerts ??= [];
  return state.observability;
}

export function recordOperationalEvent(state, input = {}) {
  const store = ensureObservabilityState(state), at = iso(input.at);
  const severity = ALERT_SEVERITIES.includes(input.severity) ? input.severity : "info";
  const subsystem = SUBSYSTEMS.includes(input.subsystem) ? input.subsystem : "scheduler";
  const safe = redactOperationalValue({ code: String(input.code ?? "event"), message: String(input.message ?? ""),
    correlation_id: input.correlation_id ?? null, bar_id: input.bar_id ?? null, job_id: input.job_id ?? null,
    transition_id: input.transition_id ?? null, broker_intent_id: input.broker_intent_id ?? null,
    order_id: input.order_id ?? null, strategy_id: input.strategy_id ?? null, details: input.details ?? null });
  const identity = { schema_version: OBSERVABILITY_SCHEMA_VERSION, at, severity, subsystem, ...safe };
  const event = { event_id: `OEV-${hashCanonical(identity).slice(0, 32)}`, ...identity };
  if (!store.events.some((item) => item.event_id === event.event_id)) store.events.push(event);
  store.events = store.events.slice(-4096);
  return event;
}

export function incrementOperationalMetric(state, subsystem, metric, value = 1, at = new Date()) {
  if (!SUBSYSTEMS.includes(subsystem) || !/^[a-z][a-z0-9_.-]{1,80}$/.test(String(metric))) {
    throw new TypeError("Operational metric identity is invalid");
  }
  const amount = Number(value);
  if (!Number.isFinite(amount)) throw new TypeError("Operational metric value must be finite");
  const store = ensureObservabilityState(state), key = `${subsystem}.${metric}`;
  const current = store.metrics[key] ?? { value: 0, samples: 0, updated_at: null };
  current.value += amount; current.samples += 1; current.updated_at = iso(at);
  store.metrics[key] = current;
  return current;
}

export function recordHeartbeat(state, subsystem, { status = "healthy", at = new Date(), correlation_id = null, detail = null } = {}) {
  if (!SUBSYSTEMS.includes(subsystem)) throw new TypeError("Unknown heartbeat subsystem");
  if (!["healthy", "degraded", "blocked"].includes(status)) throw new TypeError("Heartbeat status is invalid");
  const heartbeat = { subsystem, status, at: iso(at), correlation_id, detail: redactOperationalValue(detail) };
  ensureObservabilityState(state).heartbeats[subsystem] = heartbeat;
  return heartbeat;
}

const severityFor = (subsystem, status) => status === "blocked" && subsystem === "broker" ? "critical_risk"
  : ["broker", "market_data"].includes(subsystem) ? "execution_blocked" : "research_degraded";

export function operationalHealth(state, at = new Date(), maxAgeMs = {}) {
  const timestamp = iso(at), now = new Date(timestamp).getTime(), store = ensureObservabilityState(state);
  const defaultAge = { scheduler: 3 * 60_000, market_data: 8 * 60_000, queue: 15 * 60_000,
    backtester: 24 * 60 * 60_000, broker: 8 * 60_000, storage: 60 * 60_000, cost_telemetry: 6 * 60 * 60_000 };
  const heartbeats = {}, alerts = [];
  for (const subsystem of SUBSYSTEMS) {
    const current = store.heartbeats[subsystem];
    const age = current ? now - new Date(current.at).getTime() : null;
    const expected = Number(maxAgeMs[subsystem] ?? defaultAge[subsystem]);
    const status = !current ? "missing" : age < 0 || age > expected ? "stale" : current.status;
    heartbeats[subsystem] = { subsystem, status, at: current?.at ?? null, age_ms: age, detail: current?.detail ?? null };
    if (status !== "healthy") alerts.push({ alert_id: `ALT-${hashCanonical({ subsystem, status, at: timestamp.slice(0, 16) }).slice(0, 24)}`,
      subsystem, code: `${subsystem}_${status}`, severity: severityFor(subsystem, status), status,
      summary: `${subsystem.replaceAll("_", " ")} heartbeat is ${status}`, opened_at: current?.at ?? timestamp });
  }
  store.alerts = alerts.slice(-256);
  return { schema_version: OBSERVABILITY_SCHEMA_VERSION, evaluated_at: timestamp, heartbeats, alerts,
    metrics: redactOperationalValue(store.metrics) };
}

export function structuredLogLine(event) {
  return JSON.stringify(redactOperationalValue(event));
}
