import { hashCanonical } from "./dsl.js";
import { ensureRolloutState } from "./rollout.js";
import { verifyRollbackBundle } from "./rollback.js";

export class RolloutStore {
  constructor(db) {
    if (!db) throw new Error("AXIOM_DB is required for rollout persistence");
    this.db = db;
  }

  statement(sql, ...values) { return this.db.prepare(sql).bind(...values); }

  async persistRollout(workspaceId, state, at = new Date().toISOString()) {
    const rollout = ensureRolloutState(state), statements = [];
    for (const evidence of Object.values(rollout.evidence)) statements.push(this.statement(`
      INSERT INTO rollout_gate_evidence
        (workspace_id,evidence_id,phase,gate_code,status,artifact_hash,details_hash,observed_at,recorded_at)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,evidence_id) DO NOTHING`,
    workspaceId, evidence.evidence_id, evidence.phase, evidence.gate, evidence.status, evidence.artifact_hash,
    hashCanonical(evidence.details), evidence.observed_at, at));
    for (const transition of rollout.transitions) statements.push(this.statement(`
      INSERT INTO rollout_transitions
        (workspace_id,transition_id,from_phase,to_phase,actor,evaluation_hash,idempotency_key_hash,transitioned_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,transition_id) DO NOTHING`,
    workspaceId, transition.transition_id, transition.from, transition.to, transition.actor,
    transition.evaluation_hash, transition.idempotency_key_hash, transition.at));
    for (const cutover of Object.values(rollout.domain_cutovers)) statements.push(this.statement(`
      INSERT INTO rollout_domain_cutovers
        (workspace_id,domain,write_authority,read_authority,parity_hash,rollback_mode,approved_by,approved_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,domain) DO UPDATE SET
        write_authority=excluded.write_authority,read_authority=excluded.read_authority,
        parity_hash=excluded.parity_hash,rollback_mode=excluded.rollback_mode,
        approved_by=excluded.approved_by,approved_at=excluded.approved_at`, workspaceId, cutover.domain,
    cutover.write_authority, cutover.read_authority, cutover.parity_hash, cutover.rollback_mode,
    cutover.approved_by, cutover.approved_at));
    const stateHash = hashCanonical({ phase: rollout.phase, complete: rollout.complete,
      legacy_authoritative: rollout.legacy_authoritative, evidence: rollout.evidence, transitions: rollout.transitions,
      domain_cutovers: rollout.domain_cutovers });
    statements.push(this.statement(`
      INSERT INTO rollout_phase_state
        (workspace_id,schema_version,current_phase,complete,legacy_authoritative,transition_count,state_hash,updated_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET
        schema_version=excluded.schema_version,current_phase=excluded.current_phase,complete=excluded.complete,
        legacy_authoritative=excluded.legacy_authoritative,transition_count=excluded.transition_count,
        state_hash=excluded.state_hash,updated_at=excluded.updated_at`, workspaceId, rollout.schema_version,
    rollout.phase, rollout.complete ? 1 : 0, rollout.legacy_authoritative ? 1 : 0,
    rollout.transitions.length, stateHash, at));
    for (let offset = 0; offset < statements.length; offset += 50) await this.db.batch(statements.slice(offset, offset + 50));
    return { state_hash: stateHash, statement_count: statements.length,
      batch_count: Math.ceil(statements.length / 50) };
  }

  async persistBackupManifest(workspaceId, bundle, objectKey) {
    verifyRollbackBundle(bundle);
    if (!String(objectKey ?? "").startsWith("workspaces/")) throw new TypeError("Rollback object key must be workspace scoped");
    await this.statement(`INSERT INTO rollback_backup_manifests
      (workspace_id,backup_id,object_key,state_hash,manifest_hash,strategy_count,artifact_count,verified,created_at)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,backup_id) DO UPDATE SET verified=excluded.verified`,
    workspaceId, bundle.backup_id, objectKey, bundle.state_hash, bundle.manifest_hash,
    bundle.strategy_count, bundle.artifact_count, 1, bundle.created_at).run();
    return { backup_id: bundle.backup_id, object_key: objectKey, verified: true };
  }

  async persistRehearsal(workspaceId, report) {
    if (!report?.passed || !/^[a-f0-9]{64}$/.test(String(report.report_hash ?? ""))) {
      throw new TypeError("Only a passing verified rollback rehearsal may be persisted");
    }
    const rehearsalId = `RBR-${hashCanonical({ workspaceId, backup_id: report.backup_id,
      report_hash: report.report_hash }).slice(0, 32)}`;
    await this.statement(`INSERT INTO rollback_rehearsals
      (workspace_id,rehearsal_id,backup_id,report_hash,passed,execution_paused,broker_reconciliation_required,rehearsed_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,rehearsal_id) DO NOTHING`, workspaceId, rehearsalId,
    report.backup_id, report.report_hash, 1, report.execution_paused_after_restore ? 1 : 0,
    report.broker_reconciliation_required ? 1 : 0, report.rehearsed_at).run();
    return { rehearsal_id: rehearsalId, duplicate_safe: true };
  }
}
