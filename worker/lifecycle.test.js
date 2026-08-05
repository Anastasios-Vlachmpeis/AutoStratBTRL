import assert from "node:assert/strict";
import test from "node:test";
import { applyLifecycleCommand, initialLifecycle, transitionId } from "./lifecycle.js";

const h = (char) => char.repeat(64);
const base = () => initialLifecycle({ strategy_id: "DSL1-test", dna_hash: h("a"), dataset_hash: h("b"), configuration_hash: h("c"), policy_hash: h("d") });
const command = (state, target, overrides = {}) => {
  const kind = overrides.kind ?? "quality"; const branch = state[kind];
  const value = { schema_version: 1, strategy_id: state.strategy_id, kind, expected: kind === "quality" ? { quality_state: branch.state, version: branch.version } : { operational_state: branch.state, version: branch.version }, target,
    trigger: "test", artifact_id: "artifact-1", event_id: "event-1", policy_hash: h("d"), actor: "system", timestamp: "2026-08-05T00:00:00.000Z", reason_code: "test", explanation: "test transition", correlation_id: "correlation-1", provenance: { dna_hash: h("a"), dataset_hash: h("b"), configuration_hash: h("c") }, ...overrides };
  return { ...value, transition_id: transitionId(value) };
};

test("quality transitions use strict CAS and exact duplicate results", () => {
  const state = base(); const first = command(state, "compiled"); const applied = applyLifecycleCommand(state, first);
  assert.equal(applied.status, "applied"); assert.equal(applied.state.quality.state, "compiled");
  assert.deepEqual(applyLifecycleCommand(applied.state, first), applied);
  assert.equal(applyLifecycleCommand(applied.state, command(state, "structural_reject")).code, "unexpected_predecessor");
});
test("wrong evidence cannot advance quality and operational failures do not alter it", () => {
  const state = base(); const wrong = command(state, "compiled", { provenance: { dna_hash: h("0"), dataset_hash: h("b"), configuration_hash: h("c") } });
  assert.equal(applyLifecycleCommand(state, wrong).code, "provenance_dna_hash_mismatch");
  const failure = applyLifecycleCommand(state, command(state, "service_unavailable", { kind: "operational" }));
  assert.equal(failure.status, "applied"); assert.equal(failure.state.quality.state, "proposed");
});
test("sealed inconclusive is terminal and cannot be routed to release or rework", () => {
  let state = base();
  for (const target of ["compiled", "screened", "development", "supervisor_approved", "sealed_validation", "inconclusive"]) {
    const result = applyLifecycleCommand(state, command(state, target, { correlation_id: `terminal-${target}` })); state = result.state;
  }
  assert.equal(applyLifecycleCommand(state, command({ ...state, quality: { state: "inconclusive", version: state.quality.version } }, "incubation", { correlation_id: "bad" })).code, "illegal_transition");
});
test("deterministic randomized duplicate/reordered deliveries advance only legally", () => {
  let state = base(); const stages = ["compiled", "screened", "development", "supervisor_approved", "sealed_validation", "incubation", "released_paper", "watch"];
  const commands = []; for (const target of stages) { const item = command(state, target, { correlation_id: `c-${target}` }); commands.push(item); state = applyLifecycleCommand(state, item).state; }
  const expected = state; state = base(); let seed = 17; const delivery = [...commands, ...commands];
  delivery.sort(() => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32) - .5);
  for (const item of delivery) { const result = applyLifecycleCommand(state, item); if (result.status === "applied") state = result.state; }
  // Requeued messages may be delivered in any order; a subsequent retry must
  // converge without allowing a stale command to skip a predecessor.
  for (const item of commands) { const result = applyLifecycleCommand(state, item); if (result.status === "applied") state = result.state; }
  assert.equal(state.quality.state, expected.quality.state); assert.equal(state.quality.version, stages.length);
  assert.equal(state.history.length, stages.length);
});

test("autonomous evidence commands complete generation through paper release without a lifecycle click", () => {
  let state = base();
  const stages = ["compiled", "screened", "development", "supervisor_approved", "sealed_validation", "incubation"];
  for (const target of stages) state = applyLifecycleCommand(state,
    command(state, target, { trigger: `artifact:${target}`, correlation_id: `auto:${target}` })).state;
  const timeout = applyLifecycleCommand(state, command(state, "service_unavailable", {
    kind: "operational", trigger: "incubation_timeout", correlation_id: "auto:timeout",
  }));
  assert.equal(timeout.state.quality.state, "incubation");
  state = timeout.state;
  state = applyLifecycleCommand(state, command(state, "queued", {
    kind: "operational", trigger: "watchdog_retry", correlation_id: "auto:retry",
  })).state;
  state = applyLifecycleCommand(state, command(state, "released_paper", {
    trigger: "incubation_evidence", correlation_id: "auto:release",
  })).state;
  assert.equal(state.quality.state, "released_paper");
  assert.equal(state.history.filter((item) => item.kind === "quality").length, 7);
});
