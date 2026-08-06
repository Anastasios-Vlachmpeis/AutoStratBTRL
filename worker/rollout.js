import { hashCanonical } from "./dsl.js";

export const ROLLOUT_SCHEMA_VERSION = 1;
export const ROLLOUT_PHASES = Object.freeze(["A", "B", "C", "D", "E", "F", "G", "H", "I"]);
export const CUTOVER_DOMAINS = Object.freeze(["strategy_catalog", "research", "lifecycle", "market_data", "artifacts",
  "broker", "incubation", "monitoring", "operator_read_model"]);

const n = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const truth = (value) => value === true;
const all = (value, keys) => keys.every((key) => value?.[key] === true);

export const ROLLOUT_GATES = Object.freeze({
  A: Object.freeze({
    foundations: (d) => all(d, ["bindings", "schemas", "interfaces", "correlation_ids", "feature_flags", "safe_defaults"]),
  }),
  B: Object.freeze({
    historical_backfill: (d) => n(d.symbols) >= 40 && n(d.years) >= 3 && n(d.invalid_partitions) === 0,
    data_shadow: (d) => n(d.complete_sessions) >= 10 && n(d.unexpected_bar_differences) === 0
      && n(d.coverage) >= .9 && n(d.finalization_p95_seconds) > 0,
  }),
  C: Object.freeze({
    compiler_parity: (d) => n(d.legacy_archetypes) >= 4 && n(d.golden_mismatches) === 0 && truth(d.vector_parity),
    research_shadow: (d) => n(d.cohorts) >= 3 && n(d.lifecycle_mutations) === 0
      && truth(d.trial_accounting_complete) && truth(d.runtime_bounded),
  }),
  D: Object.freeze({
    backtest_shadow: (d) => n(d.cohorts) >= 3 && n(d.phase_runs) >= 30
      && n(d.service_success_rate) === 1 && n(d.unexpected_signal_fill_differences) === 0,
    reproducibility: (d) => truth(d.identical_result_hashes) && truth(d.artifact_replay)
      && truth(d.holdout_isolated) && n(d.leakage_findings) === 0,
  }),
  E: Object.freeze({
    normalized_parity: (d) => n(d.domains_cut_over) >= 1 && n(d.parity_mismatches) === 0
      && truth(d.references_valid) && truth(d.read_model_verified),
    observe_only: (d) => truth(d.autonomous_observe_only) && n(d.accidental_transitions) === 0
      && n(d.accidental_orders) === 0,
    rollback_rehearsal: (d) => truth(d.backup_verified) && truth(d.restore_verified)
      && truth(d.idempotency_preserved) && truth(d.execution_paused_after_restore),
  }),
  F: Object.freeze({
    incubation_shadow: (d) => n(d.valid_days) >= 10 && n(d.eligible_trades) >= 67
      && n(d.critical_faults) === 0 && n(d.parity_mismatches) === 0 && truth(d.policy_replay),
    shadow_canaries: (d) => truth(d.data_canary) && truth(d.broker_read_canary)
      && truth(d.exclusions_verified) && n(d.strategy_orders) === 0,
  }),
  G: Object.freeze({
    paper_canary: (d) => n(d.symbols) >= 1 && n(d.symbols) <= 2 && n(d.max_notional_usd) <= 25
      && truth(d.reconciliation) && truth(d.idempotent_orders) && n(d.unmanaged_orders) === 0,
    close_flatten: (d) => all(d, ["normal_close", "early_close", "failure_recovery", "verified_flat"]),
    kill_switch: (d) => truth(d.cancel_verified) && truth(d.flatten_verified) && truth(d.new_risk_blocked),
  }),
  H: Object.freeze({
    long_release: (d) => n(d.strategies) >= 1 && n(d.strategy_cap) <= .005 && n(d.portfolio_gross_cap) <= .10
      && truth(d.attribution_verified) && truth(d.monitoring_active) && n(d.unresolved_incidents) === 0,
    short_safety: (d) => d.enabled === false || (truth(d.whole_share_sizing) && truth(d.easy_to_borrow)
      && truth(d.cover) && truth(d.flatten_first_reversal) && truth(d.borrow_loss_block)
      && truth(d.reconciliation) && truth(d.kill_switch)),
  }),
  I: Object.freeze({
    stability: (d) => n(d.consecutive_regular_sessions) >= 30 && n(d.unresolved_unexpected_differences) === 0
      && n(d.duplicate_transitions) === 0 && n(d.duplicate_orders) === 0,
    final_recovery: (d) => truth(d.backup_export) && truth(d.rollback_rehearsal)
      && n(d.recovery_drills_passed) >= 11 && truth(d.operator_kill_flatten_verified),
    cost: (d) => n(d.measured_days) >= 30 && n(d.projected_monthly_usd) < 50 && n(d.telemetry_gaps) === 0,
  }),
});

const iso = (value) => {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (Number.isNaN(date.getTime())) throw new TypeError("Rollout timestamp is invalid");
  return date.toISOString();
};
const isHash = (value) => /^[a-f0-9]{64}$/.test(String(value ?? ""));
const phaseIndex = (phase) => ROLLOUT_PHASES.indexOf(phase);
const SECRET_KEY = /(secret|password|authorization|token|api[_-]?key|credential|private[_-]?key)/i;

function assertSafeDetails(details) {
  const visit = (value, depth = 0) => {
    if (depth > 8) throw new TypeError("Rollout evidence details are too deeply nested");
    if (value == null || ["string", "boolean"].includes(typeof value)) return;
    if (typeof value === "number") { if (!Number.isFinite(value)) throw new TypeError("Rollout evidence details must be finite"); return; }
    if (Array.isArray(value)) { if (value.length > 100) throw new TypeError("Rollout evidence details array is too large"); value.forEach((item) => visit(item, depth + 1)); return; }
    if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError("Rollout evidence details must be plain data");
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) throw new TypeError("Rollout evidence details cannot contain credentials");
      visit(item, depth + 1);
    }
  };
  visit(details);
  if (JSON.stringify(details).length > 16_384) throw new TypeError("Rollout evidence details exceed 16 KiB");
}

export function emptyRolloutState() {
  return { schema_version: ROLLOUT_SCHEMA_VERSION, phase: "A", complete: false,
    legacy_authoritative: true, evidence: {}, transitions: [], idempotency: {}, last_evaluated_at: null };
}

export function ensureRolloutState(state) {
  state.rollout ??= emptyRolloutState();
  const rollout = state.rollout;
  rollout.schema_version = ROLLOUT_SCHEMA_VERSION;
  if (!ROLLOUT_PHASES.includes(rollout.phase)) rollout.phase = "A";
  rollout.complete = Boolean(rollout.complete); rollout.legacy_authoritative = rollout.legacy_authoritative !== false;
  rollout.evidence ??= {}; rollout.transitions ??= []; rollout.idempotency ??= {};
  rollout.domain_cutovers ??= {};
  return rollout;
}

export function recordDomainCutover(state, { domain, expected_write, expected_read, target_write, target_read,
  parity_hash, actor, at = new Date(), rollback = false } = {}) {
  const rollout = ensureRolloutState(state);
  if (rollout.phase !== "E") throw new Error("Domain cutover is available only during rollout phase E");
  if (!CUTOVER_DOMAINS.includes(domain) || !isHash(parity_hash)
      || !/^operator:[A-Za-z0-9._:@-]+$/.test(String(actor ?? ""))) throw new TypeError("Domain cutover identity is invalid");
  const current = rollout.domain_cutovers[domain] ?? { write_authority: "legacy", read_authority: "legacy" };
  if (current.write_authority !== expected_write || current.read_authority !== expected_read) throw new Error("Domain cutover compare-and-set failed");
  const forward = [
    ["legacy", "legacy", "dual_write", "legacy"],
    ["dual_write", "legacy", "dual_write", "normalized"],
    ["dual_write", "normalized", "normalized", "normalized"],
  ].some(([fromWrite, fromRead, toWrite, toRead]) => expected_write === fromWrite && expected_read === fromRead
    && target_write === toWrite && target_read === toRead);
  const reverse = rollback && target_write === "dual_write" && target_read === "legacy";
  if (!forward && !reverse) throw new Error("Unsafe domain cutover transition");
  const entry = { domain, write_authority: target_write, read_authority: target_read, parity_hash,
    rollback_mode: target_write === "normalized" ? "dual_write" : "legacy", approved_by: actor, approved_at: iso(at), rollback };
  entry.cutover_id = `RDC-${hashCanonical({ domain, current, entry }).slice(0, 32)}`;
  rollout.domain_cutovers[domain] = entry;
  return structuredClone(entry);
}

export function recordRolloutEvidence(state, { phase, gate, status, artifact_hash, observed_at = new Date(), details = {} } = {}) {
  const rollout = ensureRolloutState(state);
  if (rollout.complete || phase !== rollout.phase) throw new Error("Rollout evidence must belong to the active phase");
  if (!ROLLOUT_GATES[phase]?.[gate]) throw new TypeError("Unknown rollout gate");
  if (!isHash(artifact_hash) || !["passed", "failed"].includes(status) || !details || typeof details !== "object" || Array.isArray(details)) {
    throw new TypeError("Rollout evidence requires a result, artifact SHA-256, and details object");
  }
  assertSafeDetails(details);
  const evidence = { schema_version: ROLLOUT_SCHEMA_VERSION, phase, gate, status, artifact_hash,
    observed_at: iso(observed_at), details: structuredClone(details) };
  evidence.evidence_id = `RGE-${hashCanonical(evidence).slice(0, 32)}`;
  const prior = rollout.evidence[evidence.evidence_id];
  if (prior && hashCanonical(prior) !== hashCanonical(evidence)) throw new Error("Rollout evidence identity conflict");
  rollout.evidence[evidence.evidence_id] = prior ?? evidence;
  rollout.evidence = Object.fromEntries(Object.entries(rollout.evidence).slice(-2048));
  return { evidence: structuredClone(rollout.evidence[evidence.evidence_id]), duplicate: Boolean(prior) };
}

function latestEvidence(rollout, phase, gate) {
  return Object.values(rollout.evidence).filter((item) => item.phase === phase && item.gate === gate)
    .sort((a, b) => b.observed_at.localeCompare(a.observed_at) || b.evidence_id.localeCompare(a.evidence_id))[0] ?? null;
}

export function evaluateRolloutPhase(state, phase = ensureRolloutState(state).phase, at = new Date()) {
  const rollout = ensureRolloutState(state);
  if (!ROLLOUT_PHASES.includes(phase)) throw new TypeError("Unknown rollout phase");
  const gates = Object.entries(ROLLOUT_GATES[phase]).map(([gate, predicate]) => {
    const evidence = latestEvidence(rollout, phase, gate);
    const passed = evidence?.status === "passed" && predicate(evidence.details);
    return { gate, passed, status: evidence?.status ?? "missing", evidence_id: evidence?.evidence_id ?? null,
      artifact_hash: evidence?.artifact_hash ?? null };
  });
  const evaluation = { schema_version: ROLLOUT_SCHEMA_VERSION, phase, evaluated_at: iso(at),
    passed: gates.every((gate) => gate.passed), gates };
  evaluation.evaluation_hash = hashCanonical({ phase, passed: evaluation.passed, gates });
  rollout.last_evaluated_at = evaluation.evaluated_at;
  return evaluation;
}

export function advanceRolloutPhase(state, { expected_phase, actor, idempotency_key, at = new Date() } = {}) {
  const rollout = ensureRolloutState(state);
  if (!/^operator:[A-Za-z0-9._:@-]+$/.test(String(actor ?? ""))) throw new TypeError("Rollout advancement requires an authenticated operator");
  if (!/^[A-Za-z0-9._:-]{8,160}$/.test(String(idempotency_key ?? ""))) throw new TypeError("Rollout advancement requires an idempotency key");
  const requestHash = hashCanonical({ expected_phase, actor });
  const previous = rollout.idempotency[idempotency_key];
  if (previous) {
    if (previous.request_hash !== requestHash) throw new Error("Rollout idempotency key conflict");
    return { ...structuredClone(previous.result), duplicate: true };
  }
  if (rollout.complete || expected_phase !== rollout.phase) throw new Error("Rollout phase compare-and-set failed");
  const evaluation = evaluateRolloutPhase(state, expected_phase, at);
  if (!evaluation.passed) return { advanced: false, duplicate: false, phase: rollout.phase, evaluation };
  const index = phaseIndex(expected_phase), next = ROLLOUT_PHASES[index + 1] ?? null;
  const transition = { transition_id: `RGT-${hashCanonical({ expected_phase, next, actor, idempotency_key,
      evaluation_hash: evaluation.evaluation_hash }).slice(0, 32)}`,
    from: expected_phase, to: next ?? "complete", actor, at: iso(at), evaluation_hash: evaluation.evaluation_hash };
  transition.idempotency_key_hash = hashCanonical({ idempotency_key });
  rollout.transitions.push(transition); rollout.transitions = rollout.transitions.slice(-128);
  if (next) rollout.phase = next;
  else { rollout.complete = true; rollout.legacy_authoritative = false; }
  const result = { advanced: true, duplicate: false, phase: rollout.phase, complete: rollout.complete,
    legacy_authoritative: rollout.legacy_authoritative, transition, evaluation };
  rollout.idempotency[idempotency_key] = { request_hash: requestHash, result: structuredClone(result) };
  rollout.idempotency = Object.fromEntries(Object.entries(rollout.idempotency).slice(-256));
  return result;
}

export function publicRolloutState(state) {
  const rollout = ensureRolloutState(state), evaluation = evaluateRolloutPhase(state);
  return { schema_version: rollout.schema_version, phase: rollout.phase, complete: rollout.complete,
    legacy_authoritative: rollout.legacy_authoritative, evaluation,
    transition_count: rollout.transitions.length, last_transition: structuredClone(rollout.transitions.at(-1) ?? null),
    domain_cutovers: Object.fromEntries(CUTOVER_DOMAINS.map((domain) => [domain, {
      write_authority: rollout.domain_cutovers[domain]?.write_authority ?? "legacy",
      read_authority: rollout.domain_cutovers[domain]?.read_authority ?? "legacy" }])) };
}
