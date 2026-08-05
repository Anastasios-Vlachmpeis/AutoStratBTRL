-- Authoritative orchestration state.  R2 holds result bytes; D1 holds their
-- immutable manifests and the state machine that makes those bytes visible.
CREATE TABLE IF NOT EXISTS orchestration_strategy_lifecycle (
  workspace_id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  state TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, strategy_id)
);

CREATE TABLE IF NOT EXISTS orchestration_commands (
  command_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  command_kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_orchestration_commands_strategy ON orchestration_commands(workspace_id, strategy_id, created_at);

CREATE TABLE IF NOT EXISTS orchestration_transitions (
  transition_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  command_id TEXT,
  from_state TEXT,
  to_state TEXT NOT NULL,
  version INTEGER NOT NULL,
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orchestration_outbox (
  outbox_id TEXT PRIMARY KEY,
  command_id TEXT NOT NULL UNIQUE,
  message_kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  available_at TEXT NOT NULL,
  sent_at TEXT,
  claim_token TEXT,
  claim_expires_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orchestration_outbox_dispatch ON orchestration_outbox(sent_at, available_at, claim_expires_at);

CREATE TABLE IF NOT EXISTS orchestration_jobs (
  job_id TEXT PRIMARY KEY,
  command_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  job_kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','completed','retrying','dead_lettered')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  available_at TEXT NOT NULL,
  claim_token TEXT,
  lease_expires_at TEXT,
  result_manifest_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orchestration_jobs_claim ON orchestration_jobs(status, available_at, lease_expires_at);

CREATE TABLE IF NOT EXISTS orchestration_result_manifests (
  manifest_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE,
  object_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  byte_length INTEGER,
  metadata_json TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orchestration_incidents (
  incident_id TEXT PRIMARY KEY,
  job_id TEXT,
  workspace_id TEXT NOT NULL,
  strategy_id TEXT,
  incident_kind TEXT NOT NULL,
  details_json TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS orchestration_operator_approvals (
  approval_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  strategy_id TEXT,
  approval_kind TEXT NOT NULL,
  subject_hash TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('approved','rejected')),
  rationale TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(workspace_id, approval_kind, subject_hash)
);

CREATE TABLE IF NOT EXISTS orchestration_config_approvals (
  approval_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  config_key TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('approved','rejected')),
  expires_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(workspace_id, config_key, config_hash)
);
