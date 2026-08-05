import assert from "node:assert/strict";
import test from "node:test";
import { applyOrchestrationCommand, claimOperatorIdempotency, createOrchestrationCommand, emptyOrchestrationState, ensureOrchestrationState, executeOrchestrationActionBatch, executionAllowed, orchestrationCommandDisposition, orchestrationMode, pipelineFollowups, publicOrchestrationState } from "./orchestration.js";

const at = "2026-08-05T12:00:00.000Z";
const command = (kind, values = {}) => createOrchestrationCommand({ kind, timestamp: at,
  actor: kind.startsWith("pause_") || ["kill_switch", "clear_kill_switch", "flatten_all", "global_pause", "global_resume", "resume_execution", "reset_daily_loss_halt", "run_broker_canary"].includes(kind) ? "operator:test" : "system",
  correlation_id: values.intent_id ?? `${kind}:test`, ...values });

test("duplicate commands return the prior result without advancing state", () => {
  const first = applyOrchestrationCommand(emptyOrchestrationState(), command("session_watchdog"));
  const second = applyOrchestrationCommand(first.state, command("session_watchdog"));
  assert.equal(first.state.version, 1); assert.equal(second.state.version, 1); assert.equal(second.idempotent, true);
  assert.deepEqual(second.result, first.result);
});

test("operator idempotency keys replay one exact command and reject payload conflicts", () => {
  const state = { orchestration: emptyOrchestrationState() };
  const first = command("pause_research", { actor: "operator:admin", correlation_id: "ui:pause:12345678" });
  const duplicate = claimOperatorIdempotency(state, "ui:pause:12345678", first.command_id);
  assert.equal(duplicate.duplicate, false);
  assert.equal(claimOperatorIdempotency(state, "ui:pause:12345678", first.command_id).duplicate, true);
  const conflict = command("resume_research", { actor: "operator:admin", correlation_id: "ui:pause:12345678" });
  assert.throws(() => claimOperatorIdempotency(state, "ui:pause:12345678", conflict.command_id), /different command payload/);
});

test("kill switch blocks new target intents even when an old message arrives later", () => {
  const killed = applyOrchestrationCommand(emptyOrchestrationState(), command("kill_switch", { actor: "operator:admin" }));
  assert.equal(killed.state.controls.flatten_requested, true);
  assert.deepEqual(killed.result.actions.map((item) => item.kind), ["broker.cancel_unsafe_orders", "broker.flatten_all"]);
  const stale = command("compute_released_targets", { intent_id: "bar-before-kill", timestamp: "2026-08-05T11:55:00.000Z" });
  const blocked = applyOrchestrationCommand(killed.state, stale);
  assert.equal(executionAllowed({ orchestration: blocked.state }), false); assert.equal(blocked.result.status, "blocked");
  assert.equal(blocked.result.reason, "kill_switch"); assert.deepEqual(blocked.result.actions, []);
});

test("operator can cancel only framework-managed open orders without enabling execution", () => {
  const cancelled = applyOrchestrationCommand(emptyOrchestrationState(), command("cancel_open_orders", {
    actor: "operator:admin", correlation_id: "cancel:test",
  }));
  assert.equal(cancelled.result.actions[0].kind, "broker.cancel_unsafe_orders");
  assert.equal(cancelled.state.controls.execution_paused, false);
});

test("entry cutoff keeps released reconciliation reduce-only while pausing incubation", () => {
  const stopped = applyOrchestrationCommand(emptyOrchestrationState(), command("stop_entries"));
  const released = applyOrchestrationCommand(stopped.state, command("compute_released_targets"));
  assert.equal(released.result.status, "applied");
  assert.equal(released.result.actions[0].block_new_risk, true);
  assert.equal(applyOrchestrationCommand(stopped.state, command("compute_incubation_targets")).result.reason,
    "entries_paused");
});

test("daily-halt reset and bounded canary require explicit operator commands", () => {
  assert.equal(applyOrchestrationCommand(emptyOrchestrationState(), command("reset_daily_loss_halt"))
    .result.actions[0].kind, "risk.reset_daily_halt");
  const canary = applyOrchestrationCommand(emptyOrchestrationState(), command("run_broker_canary", {
    payload: { symbol: "spy", side: "buy", notional: 25 },
  }));
  assert.deepEqual(canary.result.actions[0].payload, { symbol: "SPY", side: "buy", notional: 25 });
  assert.throws(() => applyOrchestrationCommand(emptyOrchestrationState(),
    command("run_broker_canary", { payload: { symbol: "SPY", side: "buy", notional: 26 } })), /\$1 to \$25/);
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

test("observe is passive for system commands while operator controls remain usable", () => {
  assert.equal(orchestrationCommandDisposition("observe", "system"), "observe");
  assert.equal(orchestrationCommandDisposition("observe", "operator:admin"), "execute");
  assert.equal(orchestrationCommandDisposition("autonomous", "system"), "execute");
  assert.equal(orchestrationMode({ ORCHESTRATION_MODE: "legacy" }), "legacy");
});

test("runtime action batches fail loudly at an unhandled action and remain incomplete", async () => {
  const completed = [];
  const dispatch = async (action) => {
    if (action.kind === "pipeline.missing") throw new Error(`Unhandled orchestration action: ${action.kind}`);
    completed.push(action.kind);
  };
  await assert.rejects(executeOrchestrationActionBatch([
    { kind: "broker.stop_entries" }, { kind: "pipeline.missing" }, { kind: "report.generate_daily" },
  ], dispatch), /Unhandled orchestration action/);
  assert.deepEqual(completed, ["broker.stop_entries"]);
});

test("runtime action batches execute every registered action exactly once", async () => {
  const completed = [];
  const result = await executeOrchestrationActionBatch([
    { kind: "pipeline.compute_targets" }, { kind: "pipeline.monitor" }, { kind: "report.generate_daily" },
  ], async (action) => { completed.push(action.kind); });
  assert.deepEqual(result, completed);
});

test("research, review, and validation are separate durable pipeline stages", () => {
  assert.deepEqual(pipelineFollowups("research.run_cohort", { cohortId: "COH-1" }),
    [{ kind: "pipeline_review", suffix: "development:COH-1" }]);
  assert.deepEqual(pipelineFollowups("pipeline.review", { hasValidation: true }),
    [{ kind: "pipeline_validate", suffix: "sealed-validation" }]);
  assert.deepEqual(pipelineFollowups("pipeline.review", { hasValidation: false }), []);
  assert.deepEqual(pipelineFollowups("research.run_cohort", { paused: true }), []);
  assert.throws(() => pipelineFollowups("research.run_cohort"), /cohort ID/);
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

test("workspace reset requires an operator, a prepared manifest, and the exact confirmation", () => {
  const prepared = applyOrchestrationCommand(emptyOrchestrationState(), command("prepare_workspace_reset", {
    actor: "operator:admin", correlation_id: "reset:prepare",
  }));
  assert.equal(prepared.result.actions[0].kind, "workspace.prepare_reset");
  assert.throws(() => applyOrchestrationCommand(prepared.state, command("execute_workspace_reset", {
    actor: "operator:admin", correlation_id: "reset:bad",
    payload: { manifest_hash: "a".repeat(64), confirmation: "reset" },
  })), /exact confirmation phrase/);
  const executed = applyOrchestrationCommand(prepared.state, command("execute_workspace_reset", {
    actor: "operator:admin", correlation_id: "reset:execute",
    payload: { manifest_hash: "a".repeat(64), confirmation: "RESET NONPRODUCTION WORKSPACE" },
  }));
  assert.equal(executed.result.actions[0].kind, "workspace.execute_reset");
});

test("public orchestration state reveals reset provenance but not private reset inventory", () => {
  const state = emptyOrchestrationState();
  state.pending_reset = { manifest_hash: "b".repeat(64), prepared_at: at, requested_by: "operator:admin",
    artifact_manifest: { object_keys: ["private/workspace/holdout.json"], artifact_ids: ["A-SECRET"] },
    identity: { d1_target_ids: ["strategies:private"] } };
  const projection = publicOrchestrationState(state);
  assert.deepEqual(projection.pending_reset, { manifest_hash: "b".repeat(64), prepared_at: at,
    requested_by: "operator:admin" });
  assert.equal(JSON.stringify(projection).includes("private/workspace"), false);
  assert.equal(JSON.stringify(projection).includes("A-SECRET"), false);
});
