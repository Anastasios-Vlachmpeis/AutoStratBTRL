import assert from "node:assert/strict";
import test from "node:test";
import { hashCanonical } from "./dsl.js";
import { ROLLOUT_GATES, ROLLOUT_PHASES, advanceRolloutPhase, emptyRolloutState,
  evaluateRolloutPhase, publicRolloutState, recordDomainCutover, recordRolloutEvidence } from "./rollout.js";

const H = (value) => hashCanonical({ value });
const fixtures = {
  A: { foundations: { bindings: true, schemas: true, interfaces: true, correlation_ids: true, feature_flags: true, safe_defaults: true } },
  B: { historical_backfill: { symbols: 40, years: 3, invalid_partitions: 0 }, data_shadow: {
    complete_sessions: 10, unexpected_bar_differences: 0, coverage: .95, finalization_p95_seconds: 92 } },
  C: { compiler_parity: { legacy_archetypes: 4, golden_mismatches: 0, vector_parity: true }, research_shadow: {
    cohorts: 3, lifecycle_mutations: 0, trial_accounting_complete: true, runtime_bounded: true } },
  D: { backtest_shadow: { cohorts: 3, phase_runs: 30, service_success_rate: 1, unexpected_signal_fill_differences: 0 },
    reproducibility: { identical_result_hashes: true, artifact_replay: true, holdout_isolated: true, leakage_findings: 0 } },
  E: { normalized_parity: { domains_cut_over: 1, parity_mismatches: 0, references_valid: true, read_model_verified: true },
    observe_only: { autonomous_observe_only: true, accidental_transitions: 0, accidental_orders: 0 },
    rollback_rehearsal: { backup_verified: true, restore_verified: true, idempotency_preserved: true, execution_paused_after_restore: true } },
  F: { incubation_shadow: { valid_days: 10, eligible_trades: 67, critical_faults: 0, parity_mismatches: 0, policy_replay: true },
    shadow_canaries: { data_canary: true, broker_read_canary: true, exclusions_verified: true, strategy_orders: 0 } },
  G: { paper_canary: { symbols: 2, max_notional_usd: 25, reconciliation: true, idempotent_orders: true, unmanaged_orders: 0 },
    close_flatten: { normal_close: true, early_close: true, failure_recovery: true, verified_flat: true },
    kill_switch: { cancel_verified: true, flatten_verified: true, new_risk_blocked: true } },
  H: { long_release: { strategies: 1, strategy_cap: .005, portfolio_gross_cap: .10, attribution_verified: true,
    monitoring_active: true, unresolved_incidents: 0 }, short_safety: { enabled: false } },
  I: { stability: { consecutive_regular_sessions: 30, unresolved_unexpected_differences: 0, duplicate_transitions: 0, duplicate_orders: 0 },
    final_recovery: { backup_export: true, rollback_rehearsal: true, recovery_drills_passed: 11, operator_kill_flatten_verified: true },
    cost: { measured_days: 30, projected_monthly_usd: 32, telemetry_gaps: 0 } },
};

function satisfy(state, phase, overrides = {}) {
  for (const [gate, details] of Object.entries(fixtures[phase])) recordRolloutEvidence(state, { phase, gate,
    status: "passed", artifact_hash: H(`${phase}:${gate}`), observed_at: `2026-08-${String(phase.charCodeAt(0) - 60).padStart(2, "0")}T12:00:00Z`,
    details: { ...details, ...(overrides[gate] ?? {}) } });
}

test("every rollout phase is evidence-bound, sequential, and idempotent", () => {
  const state = { rollout: emptyRolloutState() };
  for (const phase of ROLLOUT_PHASES) {
    assert.equal(state.rollout.phase, phase);
    assert.equal(evaluateRolloutPhase(state).passed, false);
    satisfy(state, phase);
    assert.equal(evaluateRolloutPhase(state).passed, true);
    const input = { expected_phase: phase, actor: "operator:test", idempotency_key: `advance:${phase}:12345678`,
      at: `2026-09-${String(phase.charCodeAt(0) - 64).padStart(2, "0")}T12:00:00Z` };
    const advanced = advanceRolloutPhase(state, input);
    assert.equal(advanced.advanced, true);
    assert.equal(advanceRolloutPhase(state, input).duplicate, true);
  }
  assert.equal(state.rollout.complete, true);
  assert.equal(state.rollout.legacy_authoritative, false);
  assert.equal(state.rollout.transitions.length, 9);
});

test("a declared pass cannot bypass the quantitative gate", () => {
  const state = { rollout: { ...emptyRolloutState(), phase: "D" } };
  satisfy(state, "D", { backtest_shadow: { phase_runs: 29 } });
  const evaluation = evaluateRolloutPhase(state);
  assert.equal(evaluation.passed, false);
  assert.equal(evaluation.gates.find((item) => item.gate === "backtest_shadow").passed, false);
  assert.equal(advanceRolloutPhase(state, { expected_phase: "D", actor: "operator:test",
    idempotency_key: "blocked:D:12345678" }).advanced, false);
});

test("future evidence, skipped phases, and idempotency conflicts are rejected", () => {
  const state = {};
  assert.throws(() => recordRolloutEvidence(state, { phase: "B", gate: "data_shadow", status: "passed",
    artifact_hash: H("future"), details: fixtures.B.data_shadow }), /active phase/);
  satisfy(state, "A");
  assert.throws(() => advanceRolloutPhase(state, { expected_phase: "B", actor: "operator:test",
    idempotency_key: "skip:phase:1234" }), /compare-and-set/);
  const first = { expected_phase: "A", actor: "operator:test", idempotency_key: "advance:A:conflict" };
  advanceRolloutPhase(state, first);
  assert.throws(() => advanceRolloutPhase(state, { ...first, actor: "operator:other" }), /conflict/);
});

test("rollout evidence rejects credentials, non-finite values, and oversized details", () => {
  const base = { phase: "A", gate: "foundations", status: "passed", artifact_hash: H("safe") };
  assert.throws(() => recordRolloutEvidence({}, { ...base, details: { api_secret: "never" } }), /credentials/);
  assert.throws(() => recordRolloutEvidence({}, { ...base, details: { coverage: Number.NaN } }), /finite/);
  assert.throws(() => recordRolloutEvidence({}, { ...base, details: { note: "x".repeat(17_000) } }), /16 KiB/);
});

test("paper and legacy-removal phases encode the hard safety boundaries", () => {
  assert.equal(ROLLOUT_GATES.G.paper_canary({ ...fixtures.G.paper_canary, symbols: 3 }), false);
  assert.equal(ROLLOUT_GATES.H.long_release({ ...fixtures.H.long_release, strategy_cap: .006 }), false);
  assert.equal(ROLLOUT_GATES.H.short_safety({ enabled: false }), true);
  assert.equal(ROLLOUT_GATES.H.short_safety({ enabled: true, whole_share_sizing: true }), false);
  assert.equal(ROLLOUT_GATES.I.stability({ ...fixtures.I.stability, consecutive_regular_sessions: 29 }), false);
  assert.equal(ROLLOUT_GATES.I.cost({ measured_days: 30, projected_monthly_usd: 50, telemetry_gaps: 0 }), false);
});

test("public rollout state exposes decisions but not private evidence details", () => {
  const state = {}; satisfy(state, "A");
  const output = publicRolloutState(state), wire = JSON.stringify(output);
  assert.equal(output.phase, "A"); assert.equal(output.evaluation.passed, true);
  assert.equal(wire.includes("details"), false);
  assert.equal(wire.includes("artifact_hash"), true);
});

test("phase E cuts one domain at a time with CAS and explicit rollback", () => {
  const state = { rollout: { ...emptyRolloutState(), phase: "E" } }, parity = H("parity");
  const mirrored = recordDomainCutover(state, { domain: "research", expected_write: "legacy", expected_read: "legacy",
    target_write: "dual_write", target_read: "legacy", parity_hash: parity, actor: "operator:test" });
  assert.equal(mirrored.write_authority, "dual_write");
  assert.equal(publicRolloutState(state).domain_cutovers.lifecycle.write_authority, "legacy");
  const read = recordDomainCutover(state, { domain: "research", expected_write: "dual_write", expected_read: "legacy",
    target_write: "dual_write", target_read: "normalized", parity_hash: parity, actor: "operator:test" });
  assert.equal(read.read_authority, "normalized");
  assert.throws(() => recordDomainCutover(state, { domain: "research", expected_write: "legacy", expected_read: "legacy",
    target_write: "normalized", target_read: "normalized", parity_hash: parity, actor: "operator:test" }), /compare-and-set/);
  const rolledBack = recordDomainCutover(state, { domain: "research", expected_write: "dual_write", expected_read: "normalized",
    target_write: "dual_write", target_read: "legacy", parity_hash: parity, actor: "operator:test", rollback: true });
  assert.equal(rolledBack.rollback, true); assert.equal(rolledBack.read_authority, "legacy");
});
