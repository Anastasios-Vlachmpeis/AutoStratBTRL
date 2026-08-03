-- Compatibility mirrors. Durable Object state remains authoritative.
CREATE TABLE IF NOT EXISTS architecture_state_checkpoints (
  workspace_id TEXT NOT NULL,
  checkpoint_id TEXT NOT NULL,
  state_hash TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  strategy_count INTEGER NOT NULL,
  event_count INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, checkpoint_id)
);

CREATE INDEX IF NOT EXISTS idx_architecture_state_checkpoints_created
  ON architecture_state_checkpoints (workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS architecture_artifact_mirrors (
  workspace_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  object_kind TEXT NOT NULL,
  object_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  mirrored_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, object_id, object_kind)
);

CREATE TABLE IF NOT EXISTS architecture_queue_receipts (
  receipt_id TEXT PRIMARY KEY,
  job_kind TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  verified_at TEXT NOT NULL
);
