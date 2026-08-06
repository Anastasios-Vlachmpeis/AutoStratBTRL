import { hashCanonical } from "./dsl.js";

export const ROLLBACK_SCHEMA_VERSION = 1;
const SECRET_KEY = /(secret|password|authorization|api[_-]?key|private[_-]?key|credential)/i;
const SECRET_VALUE = /((?:authorization|bearer|token|api[-_ ]?key|secret|password|credential)\s*[:=]\s*)[^\s,;]+/ig;

function safeClone(value, seen = new WeakSet()) {
  if (typeof value === "string") return value.replace(SECRET_VALUE, "$1[REDACTED]");
  if (value == null || typeof value !== "object") return value;
  if (seen.has(value)) throw new TypeError("Rollback state cannot contain cycles");
  seen.add(value);
  const output = Array.isArray(value) ? value.map((item) => safeClone(item, seen))
    : Object.fromEntries(Object.entries(value).filter(([key]) => !SECRET_KEY.test(key))
      .map(([key, item]) => [key, safeClone(item, seen)]));
  seen.delete(value);
  return output;
}

const iso = (value) => {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (Number.isNaN(date.getTime())) throw new TypeError("Rollback timestamp is invalid");
  return date.toISOString();
};

export function createRollbackBundle(state, { workspace_id = "axiom-singleton", created_at = new Date() } = {}) {
  if (!/^[A-Za-z0-9._:-]{3,128}$/.test(workspace_id)) throw new TypeError("Rollback workspace ID is invalid");
  const snapshot = safeClone(state);
  const state_hash = hashCanonical(snapshot), timestamp = iso(created_at);
  const manifest = { schema_version: ROLLBACK_SCHEMA_VERSION, workspace_id, created_at: timestamp,
    source_schema_version: Number(snapshot.schemaVersion ?? snapshot.schema_version ?? 0), state_hash,
    strategy_count: snapshot.strategies?.length ?? 0, artifact_count: Object.keys(snapshot.backtestArtifacts ?? {}).length,
    requires_broker_reconciliation: true, restores_execution_paused: true };
  const manifest_hash = hashCanonical(manifest);
  return Object.freeze({ ...manifest, manifest_hash,
    backup_id: `RBK-${hashCanonical({ workspace_id, timestamp, state_hash, manifest_hash }).slice(0, 32)}`, snapshot });
}

export function verifyRollbackBundle(bundle) {
  if (!bundle || bundle.schema_version !== ROLLBACK_SCHEMA_VERSION || !/^RBK-[a-f0-9]{32}$/.test(String(bundle.backup_id ?? ""))) {
    throw new TypeError("Unsupported rollback bundle");
  }
  const { snapshot, manifest_hash, backup_id, ...manifest } = bundle;
  if (hashCanonical(snapshot) !== bundle.state_hash) throw new Error("Rollback state hash mismatch");
  if (hashCanonical(manifest) !== manifest_hash) throw new Error("Rollback manifest hash mismatch");
  const expected = `RBK-${hashCanonical({ workspace_id: bundle.workspace_id, timestamp: bundle.created_at,
    state_hash: bundle.state_hash, manifest_hash }).slice(0, 32)}`;
  if (expected !== backup_id) throw new Error("Rollback bundle identity mismatch");
  return true;
}

export function restoreRollbackBundle(bundle, { restored_at = new Date() } = {}) {
  verifyRollbackBundle(bundle);
  const restored = structuredClone(bundle.snapshot);
  restored.orchestration ??= {};
  restored.orchestration.controls = { ...(restored.orchestration.controls ?? {}), execution_paused: true,
    entries_paused: true, research_paused: true, release_paused: true, global_paused: true,
    flatten_requested: false };
  restored.rollback = { schema_version: ROLLBACK_SCHEMA_VERSION, backup_id: bundle.backup_id,
    restored_at: iso(restored_at), source_state_hash: bundle.state_hash, broker_reconciliation_required: true,
    execution_resume_requires_operator: true };
  return restored;
}

export function rehearseRollback(currentState, bundle, { rehearsed_at = new Date() } = {}) {
  const restored = restoreRollbackBundle(bundle, { restored_at: rehearsed_at });
  const sourceIds = (bundle.snapshot.strategies ?? []).map((item) => item.id).sort();
  const restoredIds = (restored.strategies ?? []).map((item) => item.id).sort();
  const currentManaged = Object.keys(currentState?.alpaca?.strategy_positions ?? {}).sort();
  const report = { schema_version: ROLLBACK_SCHEMA_VERSION, backup_id: bundle.backup_id,
    rehearsed_at: iso(rehearsed_at), backup_verified: true,
    strategy_identity_verified: hashCanonical(sourceIds) === hashCanonical(restoredIds),
    idempotency_preserved: hashCanonical(bundle.snapshot.orchestration?.command_results ?? {})
      === hashCanonical(restored.orchestration?.command_results ?? {}),
    execution_paused_after_restore: restored.orchestration.controls.execution_paused === true,
    broker_reconciliation_required: restored.rollback.broker_reconciliation_required,
    current_managed_position_count: currentManaged.length };
  report.passed = report.strategy_identity_verified && report.idempotency_preserved
    && report.execution_paused_after_restore && report.broker_reconciliation_required;
  report.report_hash = hashCanonical(report);
  return { report, restored };
}
