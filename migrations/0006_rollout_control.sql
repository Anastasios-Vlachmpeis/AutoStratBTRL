-- Plan 14: evidence-bound rollout and rollback rehearsal metadata.
-- Full private backup bytes live in R2; D1 stores only immutable identity and status.

CREATE TABLE IF NOT EXISTS rollout_phase_state (
  workspace_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  current_phase TEXT NOT NULL CHECK (current_phase IN ('A','B','C','D','E','F','G','H','I')),
  complete INTEGER NOT NULL DEFAULT 0 CHECK (complete IN (0,1)),
  legacy_authoritative INTEGER NOT NULL DEFAULT 1 CHECK (legacy_authoritative IN (0,1)),
  transition_count INTEGER NOT NULL DEFAULT 0,
  state_hash TEXT NOT NULL CHECK (length(state_hash)=64),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rollout_gate_evidence (
  workspace_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('A','B','C','D','E','F','G','H','I')),
  gate_code TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('passed','failed')),
  artifact_hash TEXT NOT NULL CHECK (length(artifact_hash)=64),
  details_hash TEXT NOT NULL CHECK (length(details_hash)=64),
  observed_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id,evidence_id)
);

CREATE INDEX IF NOT EXISTS idx_rollout_gate_latest
  ON rollout_gate_evidence (workspace_id,phase,gate_code,observed_at DESC);

CREATE TABLE IF NOT EXISTS rollout_transitions (
  workspace_id TEXT NOT NULL,
  transition_id TEXT NOT NULL,
  from_phase TEXT NOT NULL,
  to_phase TEXT NOT NULL,
  actor TEXT NOT NULL,
  evaluation_hash TEXT NOT NULL CHECK (length(evaluation_hash)=64),
  idempotency_key_hash TEXT NOT NULL CHECK (length(idempotency_key_hash)=64),
  transitioned_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id,transition_id),
  UNIQUE (workspace_id,idempotency_key_hash)
);

CREATE TABLE IF NOT EXISTS rollback_backup_manifests (
  workspace_id TEXT NOT NULL,
  backup_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  state_hash TEXT NOT NULL CHECK (length(state_hash)=64),
  manifest_hash TEXT NOT NULL CHECK (length(manifest_hash)=64),
  strategy_count INTEGER NOT NULL,
  artifact_count INTEGER NOT NULL,
  verified INTEGER NOT NULL CHECK (verified IN (0,1)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id,backup_id),
  UNIQUE (workspace_id,object_key)
);

CREATE TABLE IF NOT EXISTS rollback_rehearsals (
  workspace_id TEXT NOT NULL,
  rehearsal_id TEXT NOT NULL,
  backup_id TEXT NOT NULL,
  report_hash TEXT NOT NULL CHECK (length(report_hash)=64),
  passed INTEGER NOT NULL CHECK (passed IN (0,1)),
  execution_paused INTEGER NOT NULL CHECK (execution_paused IN (0,1)),
  broker_reconciliation_required INTEGER NOT NULL CHECK (broker_reconciliation_required IN (0,1)),
  rehearsed_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id,rehearsal_id),
  FOREIGN KEY (workspace_id,backup_id) REFERENCES rollback_backup_manifests(workspace_id,backup_id)
);

CREATE TABLE IF NOT EXISTS rollout_domain_cutovers (
  workspace_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  write_authority TEXT NOT NULL CHECK (write_authority IN ('legacy','dual_write','normalized')),
  read_authority TEXT NOT NULL CHECK (read_authority IN ('legacy','normalized')),
  parity_hash TEXT NOT NULL CHECK (length(parity_hash)=64),
  rollback_mode TEXT NOT NULL CHECK (rollback_mode IN ('legacy','dual_write')),
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id,domain)
);
