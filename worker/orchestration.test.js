import assert from "node:assert/strict";
import test from "node:test";
import { applyOrchestrationCommand, createOrchestrationCommand, emptyOrchestrationState, ensureOrchestrationState, executionAllowed } from "./orchestration.js";

const at = "2026-08-05T12:00:00.000Z";
const command = (kind, values = {}) => createOrchestrationCommand({ kind, timestamp: at,
  actor: kind.startsWith("pause_") || ["kill_switch", "clear_kill_switch", "flatten_all", "global_pause", "global_resume", "resume_execution"].includes(kind) ? "operator:test" : "system",
  correlation_id: values.intent_id ?? `${kind}:test`, ...values });

test("duplicate commands return the prior result without advancing state", () => {
  const first = applyOrchestrationCommand(emptyOrchestrationState(), command("session_watchdog"));
  const second = applyOrchestrationCommand(first.state, command("session_watchdog"));
  assert.equal(first.state.version, 1); assert.equal(second.state.version, 1); assert.equal(second.idempotent, true);
  assert.deepEqual(second.result, first.result);
});

test("kill switch blocks new target intents even when an old message arrives later", () => {
  const killed = applyOrchestrationCommand(emptyOrchestrationState(), command("kill_switch", { actor: "operator:admin" }));
  const stale = command("compute_released_targets", { intent_id: "bar-before-kill", timestamp: "2026-08-05T11:55:00.000Z" });
  const blocked = applyOrchestrationCommand(killed.state, stale);
  assert.equal(executionAllowed({ orchestration: blocked.state }), false); assert.equal(blocked.result.status, "blocked");
  assert.equal(blocked.result.reason, "kill_switch"); assert.deepEqual(blocked.result.actions, []);
});

test("post-close controls are idempotent and cannot override quality gates", () => {
  const ledger = command("close_valid_day_ledger", { intent_id: "ledger-2026-08-05", payload: { session_date: "2026-08-05" } });
  const first = applyOrchestrationCommand(emptyOrchestrationState(), ledger);
  assert.equal(first.state.valid_day_ledgers["2026-08-05"].status, "closed");
  assert.throws(() => createOrchestrationCommand({ kind: "override_failed_gate", actor: "operator:admin", timestamp: at }));
});

test("research and release pauses block only their own autonomous actions", () => {
  let state = applyOrchestrationCommand(emptyOrchestrationState(), command("pause_research", { actor: "operator:admin" })).state;
  state = applyOrchestrationCommand(state, command("pause_release", { actor: "operator:admin" })).state;
  assert.equal(applyOrchestrationCommand(state, command("run_daily_cohort")).result.reason, "research_paused");
  assert.equal(applyOrchestrationCommand(state, command("pipeline_release")).result.reason, "release_paused");
  assert.equal(applyOrchestrationCommand(state, command("record_monitoring_observations")).result.status, "applied");
});

test("blocked stable intents remain retryable after their scoped pause is lifted", () => {
  const daily = command("run_daily_cohort", { intent_id: "cohort:2026-08-05" });
  let state = applyOrchestrationCommand(emptyOrchestrationState(), command("pause_research", { actor: "operator:admin" })).state;
  const blocked = applyOrchestrationCommand(state, daily);
  assert.equal(blocked.result.status, "blocked");
  assert.equal(blocked.state.command_results[daily.command_id], undefined);
  assert.equal(blocked.state.completed_intent_ids.includes(daily.intent_id), false);
  state = applyOrchestrationCommand(blocked.state, command("resume_research", { actor: "operator:admin" })).state;
  const retried = applyOrchestrationCommand(state, daily);
  assert.equal(retried.result.status, "applied");
  assert.equal(retried.state.completed_intent_ids.includes(daily.intent_id), true);
});

test("deployment mode changes are reflected in existing orchestration state", () => {
  const holder = { orchestration: emptyOrchestrationState("observe") };
  assert.equal(ensureOrchestrationState(holder, "autonomous").mode, "autonomous");
});

test("a new exchange session reopens entries unless a safety pause remains active", () => {
  let state = applyOrchestrationCommand(emptyOrchestrationState(), command("stop_entries")).state;
  assert.equal(state.controls.entries_paused, true);
  state = applyOrchestrationCommand(state, command("session_watchdog", {
    intent_id: "watchdog:2026-08-06", timestamp: "2026-08-06T13:30:00.000Z",
    payload: { session_date: "2026-08-06" },
  })).state;
  assert.equal(state.controls.entries_paused, false);
  state = applyOrchestrationCommand(state, command("kill_switch", { actor: "operator:admin", correlation_id: "kill:next" })).state;
  const next = applyOrchestrationCommand(state, command("session_watchdog", {
    intent_id: "watchdog:2026-08-07", timestamp: "2026-08-07T13:30:00.000Z",
    payload: { session_date: "2026-08-07" },
  })).state;
  assert.equal(next.controls.entries_paused, true);
});
