/**
 * Pure lifecycle contract v1.  Persistence/queues deliberately live outside
 * this module: callers store the returned state using their own CAS primitive.
 */
import { hashCanonical } from "./dsl.js";

export const LIFECYCLE_SCHEMA_VERSION = 1;
export const QUALITY_STATES = Object.freeze(["proposed", "compiled", "screened", "development", "supervisor_approved", "sealed_validation", "incubation", "released_paper", "healthy", "watch", "quarantined", "retired", "structural_reject", "development_reject", "holdout_reject", "inconclusive", "superseded", "capacity_wait", "release_blocked_short", "operator_paused"]);
export const OPERATIONAL_STATES = Object.freeze(["ready", "queued", "running", "retry_wait", "service_unavailable", "data_blocked", "broker_blocked", "operational_blocked", "dead_lettered"]);

const TERMINAL = new Set(["structural_reject", "development_reject", "holdout_reject", "inconclusive", "superseded", "retired"]);
const ACTIVE = QUALITY_STATES.filter((state) => !TERMINAL.has(state) && !["operator_paused", "quarantined"].includes(state));
const direct = {
  proposed: ["compiled", "structural_reject"], compiled: ["screened", "structural_reject"],
  screened: ["development", "structural_reject"], development: ["supervisor_approved", "development_reject"],
  supervisor_approved: ["sealed_validation", "capacity_wait"], capacity_wait: ["sealed_validation"],
  sealed_validation: ["incubation", "holdout_reject", "inconclusive"], incubation: ["released_paper", "release_blocked_short", "development", "development_reject"],
  release_blocked_short: ["released_paper", "development_reject"], released_paper: ["healthy", "watch", "quarantined"],
  healthy: ["watch", "quarantined", "retired"], watch: ["healthy", "quarantined", "retired"],
  quarantined: ["retired"], operator_paused: [],
};
/** Immutable, explicit quality transition table.  Pause/resume is expanded below. */
export const QUALITY_TRANSITIONS = Object.freeze(Object.fromEntries(QUALITY_STATES.map((from) => {
  const targets = new Set(direct[from] ?? []);
  if (ACTIVE.includes(from)) { targets.add("operator_paused"); targets.add("superseded"); }
  if (ACTIVE.includes(from) && from !== "quarantined") targets.add("quarantined");
  if (ACTIVE.includes(from)) targets.add("retired");
  // A paused strategy can resume only to its remembered prior state; the
  // runtime check below narrows this explicit superset.
  if (from === "operator_paused") for (const target of ACTIVE) targets.add(target);
  return [from, Object.freeze([...targets].sort())];
})));
const operationalDirect = {
  ready: ["queued", "data_blocked", "broker_blocked", "service_unavailable", "operational_blocked", "dead_lettered"],
  queued: ["running", "retry_wait", "data_blocked", "broker_blocked", "service_unavailable", "operational_blocked", "dead_lettered"],
  running: ["ready", "retry_wait", "data_blocked", "broker_blocked", "service_unavailable", "operational_blocked", "dead_lettered"],
  retry_wait: ["queued", "operational_blocked", "dead_lettered"], service_unavailable: ["queued", "operational_blocked", "dead_lettered"],
  data_blocked: ["queued", "operational_blocked", "dead_lettered"], broker_blocked: ["queued", "operational_blocked", "dead_lettered"],
  operational_blocked: ["ready", "queued", "dead_lettered"],
  dead_lettered: ["queued"],
};
export const OPERATIONAL_TRANSITIONS = Object.freeze(Object.fromEntries(OPERATIONAL_STATES.map((from) => [from,
  Object.freeze([...(operationalDirect[from] ?? [])])])));
export const LIFECYCLE_COMMAND_SCHEMA = Object.freeze({ schema_version: LIFECYCLE_SCHEMA_VERSION, required: ["strategy_id", "kind", "expected", "target", "transition_id", "trigger", "artifact_id", "event_id", "policy_hash", "actor", "timestamp", "reason_code", "explanation", "correlation_id", "provenance"] });
export const LIFECYCLE_EVENT_SCHEMA = Object.freeze({ schema_version: LIFECYCLE_SCHEMA_VERSION, required: ["event_type", "transition_id", "strategy_id", "command"] });
export const LIFECYCLE_RESULT_SCHEMA = Object.freeze({ schema_version: LIFECYCLE_SCHEMA_VERSION, required: ["status", "transition_id", "strategy_id", "version"] });

const HASH = /^[a-f0-9]{64}$/;
const plain = (value) => value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const copy = (value) => JSON.parse(JSON.stringify(value));
const fail = (message) => { throw new TypeError(`Lifecycle v${LIFECYCLE_SCHEMA_VERSION}: ${message}`); };
const requireHash = (value, name) => { if (typeof value !== "string" || !HASH.test(value)) fail(`${name} must be a SHA-256 hex hash`); return value; };
const requireId = (value, name) => { if (typeof value !== "string" || !value.trim()) fail(`${name} is required`); return value; };

export function transitionId(command) {
  const source = command?.expected ?? {};
  return `TRN-${hashCanonical({ schema_version: LIFECYCLE_SCHEMA_VERSION, strategy_id: command?.strategy_id, kind: command?.kind,
    from: source.quality_state ?? source.operational_state, version: source.version, target: command?.target,
    trigger: command?.trigger, artifact_id: command?.artifact_id ?? null, event_id: command?.event_id ?? null,
    policy_hash: command?.policy_hash, correlation_id: command?.correlation_id }).slice(0, 32)}`;
}

export function initialLifecycle({ strategy_id, dna_hash, dataset_hash, configuration_hash, policy_hash, timestamp = "1970-01-01T00:00:00.000Z" } = {}) {
  requireId(strategy_id, "strategy_id");
  const provenance = { dna_hash: requireHash(dna_hash, "dna_hash"), dataset_hash: requireHash(dataset_hash, "dataset_hash"), configuration_hash: requireHash(configuration_hash, "configuration_hash"), policy_hash: requireHash(policy_hash, "policy_hash") };
  return Object.freeze({ schema_version: LIFECYCLE_SCHEMA_VERSION, strategy_id, quality: { state: "proposed", version: 0 }, operational: { state: "ready", version: 0 }, provenance, history: [], results: {}, created_at: timestamp });
}

/** Bind the final frozen dataset/config before development begins. */
export function bindLifecycleProvenance(current, provenance, timestamp = new Date().toISOString()) {
  if (!plain(current) || current.schema_version !== LIFECYCLE_SCHEMA_VERSION) fail("state schema_version is unsupported");
  if (!new Set(["proposed", "compiled", "screened"]).has(current.quality?.state)) fail("provenance can only be bound before development");
  const next = copy(current);
  next.provenance = { dna_hash: requireHash(provenance?.dna_hash, "dna_hash"),
    dataset_hash: requireHash(provenance?.dataset_hash, "dataset_hash"),
    configuration_hash: requireHash(provenance?.configuration_hash, "configuration_hash"),
    policy_hash: requireHash(provenance?.policy_hash, "policy_hash") };
  next.provenance_bound_at = timestamp;
  return Object.freeze(next);
}

/** Validate the versioned wire command and return a defensive canonical copy. */
export function validateLifecycleCommand(value) {
  if (!plain(value) || value.schema_version !== LIFECYCLE_SCHEMA_VERSION) fail("command schema_version is unsupported");
  const command = copy(value);
  requireId(command.strategy_id, "strategy_id");
  if (!["quality", "operational"].includes(command.kind)) fail("command kind must be quality or operational");
  if (!plain(command.expected) || !Number.isInteger(command.expected.version) || command.expected.version < 0) fail("expected predecessor/version is required");
  const predecessor = command.kind === "quality" ? command.expected.quality_state : command.expected.operational_state;
  const states = command.kind === "quality" ? QUALITY_STATES : OPERATIONAL_STATES;
  if (!states.includes(predecessor) || !states.includes(command.target)) fail("command has an invalid predecessor or target");
  requireId(command.trigger, "trigger"); requireId(command.actor, "actor"); requireId(command.timestamp, "timestamp");
  if (command.actor !== "system" && !/^operator:[A-Za-z0-9._:@-]+$/.test(command.actor)) fail("actor must be system or an authenticated operator identity");
  requireId(command.reason_code, "reason_code"); requireId(command.explanation, "explanation"); requireId(command.correlation_id, "correlation_id");
  requireId(command.artifact_id, "artifact_id"); requireId(command.event_id, "event_id"); requireHash(command.policy_hash, "policy_hash");
  if (!plain(command.provenance)) fail("command provenance is required");
  for (const key of ["dna_hash", "dataset_hash", "configuration_hash"]) requireHash(command.provenance[key], `provenance.${key}`);
  const id = command.transition_id ?? command.command_id;
  if (!id) fail("transition_id or command_id is required");
  requireId(id, "transition_id");
  if (id !== transitionId(command)) fail("transition_id is not deterministic");
  command.transition_id = id;
  return Object.freeze(command);
}

export function lifecycleEvent(command) {
  const checked = validateLifecycleCommand(command);
  return Object.freeze({ schema_version: LIFECYCLE_SCHEMA_VERSION, event_type: "lifecycle.transition.requested", transition_id: checked.transition_id, strategy_id: checked.strategy_id, command: checked });
}

export function validateLifecycleEvent(value) {
  if (!plain(value) || value.schema_version !== LIFECYCLE_SCHEMA_VERSION || value.event_type !== "lifecycle.transition.requested") fail("event schema_version or type is unsupported");
  const command = validateLifecycleCommand(value.command);
  if (value.strategy_id !== command.strategy_id || value.transition_id !== command.transition_id) fail("event identity does not match command");
  return Object.freeze(copy(value));
}

export function validateLifecycleResult(value) {
  if (!plain(value) || value.schema_version !== LIFECYCLE_SCHEMA_VERSION) fail("result schema_version is unsupported");
  if (!["applied", "rejected"].includes(value.status)) fail("result status is unsupported");
  requireId(value.transition_id, "result.transition_id"); requireId(value.strategy_id, "result.strategy_id");
  if (!Number.isInteger(value.version) || value.version < 0) fail("result.version is invalid");
  return Object.freeze(copy(value));
}

function reject(state, command, code) {
  return Object.freeze({ schema_version: LIFECYCLE_SCHEMA_VERSION, status: "rejected", code, transition_id: command.transition_id, strategy_id: command.strategy_id, state, version: state[command.kind].version });
}

/**
 * Apply one command without side effects.  A caller must persist `state` only
 * when status is `applied`; a repeated command returns the byte-for-byte prior
 * result stored in state.results.
 */
export function applyLifecycleCommand(current, rawCommand) {
  if (!plain(current) || current.schema_version !== LIFECYCLE_SCHEMA_VERSION) fail("state schema_version is unsupported");
  const command = validateLifecycleCommand(rawCommand);
  if (current.strategy_id !== command.strategy_id) return reject(current, command, "strategy_mismatch");
  const prior = current.results?.[command.transition_id];
  // `results` stores the wire result, not a state snapshot, so state remains
  // serialisable and retries can return the exact original decision.
  if (prior) return Object.freeze({ ...prior, state: current });
  const expected = command.kind === "quality" ? command.expected.quality_state : command.expected.operational_state;
  const branch = current[command.kind];
  if (branch.state !== expected || branch.version !== command.expected.version) return reject(current, command, "unexpected_predecessor");
  if (command.policy_hash !== current.provenance.policy_hash) return reject(current, command, "policy_hash_mismatch");
  for (const key of ["dna_hash", "dataset_hash", "configuration_hash"]) if (command.provenance[key] !== current.provenance[key]) return reject(current, command, `provenance_${key}_mismatch`);
  const legal = command.kind === "quality"
    ? (branch.state === "operator_paused" ? command.target === current.paused_from : QUALITY_TRANSITIONS[branch.state].includes(command.target))
    : OPERATIONAL_TRANSITIONS[branch.state].includes(command.target);
  if (!legal) return reject(current, command, "illegal_transition");
  const next = copy(current);
  const transition = { schema_version: LIFECYCLE_SCHEMA_VERSION, transition_id: command.transition_id, strategy_id: command.strategy_id,
    kind: command.kind, from: branch.state, from_version: branch.version, target: command.target, version: branch.version + 1,
    trigger: command.trigger, artifact_id: command.artifact_id, event_id: command.event_id, policy_hash: command.policy_hash,
    actor: command.actor, timestamp: command.timestamp, reason_code: command.reason_code, explanation: command.explanation,
    correlation_id: command.correlation_id, provenance: command.provenance };
  next[command.kind] = { state: command.target, version: transition.version };
  if (command.kind === "quality") {
    if (command.target === "operator_paused") next.paused_from = branch.state;
    else delete next.paused_from;
  }
  next.history.push(transition);
  const result = Object.freeze({ schema_version: LIFECYCLE_SCHEMA_VERSION, status: "applied", transition_id: command.transition_id,
    strategy_id: command.strategy_id, version: transition.version, transition });
  next.results[command.transition_id] = result;
  return Object.freeze({ ...result, state: Object.freeze(next) });
}

export const applyLifecycleTransition = applyLifecycleCommand;
