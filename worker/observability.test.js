import assert from "node:assert/strict";
import test from "node:test";
import { incrementOperationalMetric, operationalHealth, recordHeartbeat, recordOperationalEvent,
  redactOperationalValue, structuredLogLine } from "./observability.js";

test("structured events carry cross-system correlation identities and redact credentials", () => {
  const state = {};
  const event = recordOperationalEvent(state, { at: "2026-08-06T14:00:00Z", subsystem: "backtester",
    severity: "research_degraded", code: "BACKTEST_TIMEOUT", message: "token=abc123 service timed out",
    correlation_id: "bar:123", job_id: "JOB-1", strategy_id: "S1",
    details: { API_SECRET: "never", nested: { authorization: "Bearer private" } } });
  const encoded = structuredLogLine(event);
  assert.equal(event.correlation_id, "bar:123");
  assert.equal(event.job_id, "JOB-1");
  assert.equal(encoded.includes("abc123"), false);
  assert.equal(encoded.includes("never"), false);
  assert.equal(encoded.includes("Bearer private"), false);
  assert.deepEqual(recordOperationalEvent(state, { ...event }), event);
});

test("heartbeats identify the exact missing, stale, degraded, and blocked subsystem", () => {
  const state = {};
  recordHeartbeat(state, "market_data", { at: "2026-08-06T13:59:00Z", status: "healthy" });
  recordHeartbeat(state, "broker", { at: "2026-08-06T13:58:00Z", status: "blocked", detail: { reason: "position_divergence" } });
  recordHeartbeat(state, "queue", { at: "2026-08-06T12:00:00Z", status: "healthy" });
  incrementOperationalMetric(state, "market_data", "ingestion_lag_ms", 750, "2026-08-06T14:00:00Z");
  const health = operationalHealth(state, "2026-08-06T14:00:00Z");
  assert.equal(health.heartbeats.market_data.status, "healthy");
  assert.equal(health.heartbeats.broker.status, "blocked");
  assert.equal(health.heartbeats.queue.status, "stale");
  assert.equal(health.heartbeats.storage.status, "missing");
  assert.equal(health.alerts.find((item) => item.subsystem === "broker").severity, "critical_risk");
  assert.equal(health.metrics["market_data.ingestion_lag_ms"].value, 750);
});

test("redaction is recursive, bounded, and does not mutate the source", () => {
  const source = { password: "one", child: { note: "authorization=Bearer-value" } };
  const safe = redactOperationalValue(source);
  assert.equal(safe.password, "[REDACTED]");
  assert.equal(safe.child.note.includes("Bearer-value"), false);
  assert.equal(source.password, "one");
});
