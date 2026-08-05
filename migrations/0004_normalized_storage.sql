-- Plan 8 normalized metadata schema.
--
-- D1 contains queryable metadata and immutable evidence manifests. Large payloads,
-- bars, curves, ledgers, and replay bundles remain content-addressed in R2.
-- Composite foreign keys deliberately include workspace_id so a malformed query
-- cannot connect records owned by different workspaces.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  migration_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL UNIQUE CHECK (schema_version > 0),
  checksum_sha256 TEXT NOT NULL UNIQUE CHECK (length(checksum_sha256) = 64),
  applied_at TEXT NOT NULL,
  application_version TEXT
);

CREATE TABLE IF NOT EXISTS workspaces (
  workspace_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('local', 'development', 'staging', 'production')),
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'reset_pending', 'resetting', 'reset')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS system_config_versions (
  workspace_id TEXT NOT NULL,
  config_version_id TEXT NOT NULL,
  config_kind TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  content_json TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  effective_from TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  PRIMARY KEY (workspace_id, config_version_id),
  UNIQUE (workspace_id, config_kind, content_hash),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_system_config_versions_effective
  ON system_config_versions (workspace_id, config_kind, effective_from DESC);

CREATE TABLE IF NOT EXISTS supervisor_policy_versions (
  workspace_id TEXT NOT NULL,
  policy_version_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  policy_json TEXT NOT NULL,
  policy_hash TEXT NOT NULL CHECK (length(policy_hash) = 64),
  effective_from TEXT NOT NULL,
  created_at TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  PRIMARY KEY (workspace_id, policy_version_id),
  UNIQUE (workspace_id, policy_hash),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS universe_versions (
  workspace_id TEXT NOT NULL,
  universe_version_id TEXT NOT NULL,
  feed TEXT NOT NULL,
  symbols_object_key TEXT NOT NULL,
  symbols_hash TEXT NOT NULL CHECK (length(symbols_hash) = 64),
  symbol_count INTEGER NOT NULL CHECK (symbol_count >= 0),
  effective_from TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, universe_version_id),
  UNIQUE (workspace_id, feed, symbols_hash),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS calendar_versions (
  workspace_id TEXT NOT NULL,
  calendar_version_id TEXT NOT NULL,
  market TEXT NOT NULL,
  first_session TEXT NOT NULL,
  last_session TEXT NOT NULL,
  session_count INTEGER NOT NULL CHECK (session_count >= 0),
  object_key TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, calendar_version_id),
  UNIQUE (workspace_id, market, content_hash),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS engine_versions (
  workspace_id TEXT NOT NULL,
  engine_version_id TEXT NOT NULL,
  engine_family TEXT NOT NULL,
  engine_version TEXT NOT NULL,
  container_digest TEXT,
  implementation_hash TEXT NOT NULL CHECK (length(implementation_hash) = 64),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, engine_version_id),
  UNIQUE (workspace_id, engine_family, engine_version, implementation_hash),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS compiler_versions (
  workspace_id TEXT NOT NULL,
  compiler_version_id TEXT NOT NULL,
  language_version TEXT NOT NULL,
  compiler_version TEXT NOT NULL,
  implementation_hash TEXT NOT NULL CHECK (length(implementation_hash) = 64),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, compiler_version_id),
  UNIQUE (workspace_id, language_version, compiler_version, implementation_hash),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS strategies (
  workspace_id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  strategy_name TEXT NOT NULL,
  archetype TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  current_quality_state TEXT NOT NULL,
  current_operational_state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  retired_at TEXT,
  PRIMARY KEY (workspace_id, strategy_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_strategies_state
  ON strategies (workspace_id, current_quality_state, current_operational_state, created_at);

CREATE TABLE IF NOT EXISTS strategy_dna (
  workspace_id TEXT NOT NULL,
  dna_id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  language_version TEXT NOT NULL,
  dna_json TEXT NOT NULL,
  dna_hash TEXT NOT NULL CHECK (length(dna_hash) = 64),
  compiler_version_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, dna_id),
  UNIQUE (workspace_id, strategy_id, dna_hash),
  FOREIGN KEY (workspace_id, strategy_id) REFERENCES strategies(workspace_id, strategy_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, compiler_version_id) REFERENCES compiler_versions(workspace_id, compiler_version_id)
);

CREATE INDEX IF NOT EXISTS idx_strategy_dna_strategy
  ON strategy_dna (workspace_id, strategy_id, created_at DESC);

CREATE TABLE IF NOT EXISTS lineages (
  workspace_id TEXT NOT NULL,
  lineage_id TEXT NOT NULL,
  child_strategy_id TEXT NOT NULL,
  parent_strategy_id TEXT,
  operation TEXT NOT NULL,
  mutation_seed TEXT,
  mutation_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, lineage_id),
  UNIQUE (workspace_id, child_strategy_id, parent_strategy_id, operation),
  FOREIGN KEY (workspace_id, child_strategy_id) REFERENCES strategies(workspace_id, strategy_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, parent_strategy_id) REFERENCES strategies(workspace_id, strategy_id)
);

CREATE TABLE IF NOT EXISTS cohorts (
  workspace_id TEXT NOT NULL,
  cohort_id TEXT NOT NULL,
  universe_version_id TEXT NOT NULL,
  policy_version_id TEXT NOT NULL,
  generation_seed TEXT NOT NULL,
  requested_trials INTEGER NOT NULL CHECK (requested_trials > 0),
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (workspace_id, cohort_id),
  UNIQUE (workspace_id, generation_seed, universe_version_id, policy_version_id),
  FOREIGN KEY (workspace_id, universe_version_id) REFERENCES universe_versions(workspace_id, universe_version_id),
  FOREIGN KEY (workspace_id, policy_version_id) REFERENCES supervisor_policy_versions(workspace_id, policy_version_id)
);

CREATE TABLE IF NOT EXISTS datasets (
  workspace_id TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  dataset_root_hash TEXT NOT NULL CHECK (length(dataset_root_hash) = 64),
  universe_version_id TEXT NOT NULL,
  calendar_version_id TEXT NOT NULL,
  feed TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  adjustment TEXT NOT NULL,
  range_start TEXT NOT NULL,
  range_end TEXT NOT NULL,
  manifest_object_key TEXT NOT NULL,
  manifest_hash TEXT NOT NULL CHECK (length(manifest_hash) = 64),
  row_count INTEGER NOT NULL CHECK (row_count >= 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, dataset_id),
  UNIQUE (workspace_id, dataset_root_hash),
  FOREIGN KEY (workspace_id, universe_version_id) REFERENCES universe_versions(workspace_id, universe_version_id),
  FOREIGN KEY (workspace_id, calendar_version_id) REFERENCES calendar_versions(workspace_id, calendar_version_id)
);

CREATE TABLE IF NOT EXISTS dataset_partitions (
  workspace_id TEXT NOT NULL,
  partition_id TEXT NOT NULL,
  feed TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  symbol TEXT NOT NULL,
  range_start TEXT NOT NULL,
  range_end TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  object_key TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  row_count INTEGER NOT NULL CHECK (row_count >= 0),
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  coverage REAL NOT NULL CHECK (coverage >= 0 AND coverage <= 1),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, partition_id),
  UNIQUE (workspace_id, feed, timeframe, symbol, range_start, range_end, revision, content_hash),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_dataset_partitions_symbol_time
  ON dataset_partitions (workspace_id, feed, timeframe, symbol, range_start, range_end);

CREATE TABLE IF NOT EXISTS dataset_members (
  workspace_id TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  partition_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (workspace_id, dataset_id, partition_id),
  UNIQUE (workspace_id, dataset_id, ordinal),
  FOREIGN KEY (workspace_id, dataset_id) REFERENCES datasets(workspace_id, dataset_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, partition_id) REFERENCES dataset_partitions(workspace_id, partition_id)
);

CREATE TABLE IF NOT EXISTS dataset_slices (
  workspace_id TEXT NOT NULL,
  dataset_slice_id TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  slice_kind TEXT NOT NULL CHECK (slice_kind IN ('screen', 'development', 'holdout', 'incubation', 'shadow', 'monitoring')),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  range_start TEXT NOT NULL,
  range_end TEXT NOT NULL,
  sealed INTEGER NOT NULL DEFAULT 0 CHECK (sealed IN (0, 1)),
  slice_hash TEXT NOT NULL CHECK (length(slice_hash) = 64),
  manifest_object_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, dataset_slice_id),
  UNIQUE (workspace_id, dataset_id, slice_kind, ordinal, slice_hash),
  FOREIGN KEY (workspace_id, dataset_id) REFERENCES datasets(workspace_id, dataset_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_dataset_slices_dataset
  ON dataset_slices (workspace_id, dataset_id, slice_kind, ordinal);

CREATE TABLE IF NOT EXISTS dataset_slice_partitions (
  workspace_id TEXT NOT NULL,
  dataset_slice_id TEXT NOT NULL,
  partition_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (workspace_id, dataset_slice_id, partition_id),
  UNIQUE (workspace_id, dataset_slice_id, ordinal),
  FOREIGN KEY (workspace_id, dataset_slice_id) REFERENCES dataset_slices(workspace_id, dataset_slice_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, partition_id) REFERENCES dataset_partitions(workspace_id, partition_id)
);

CREATE TABLE IF NOT EXISTS artifact_manifests (
  workspace_id TEXT NOT NULL,
  artifact_id TEXT,
  workspace_hash TEXT NOT NULL CHECK (length(workspace_hash) = 64),
  artifact_kind TEXT NOT NULL,
  object_key TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  media_type TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('public_summary', 'private', 'sealed_holdout', 'secret')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  manifest_hash TEXT NOT NULL CHECK (length(manifest_hash) = 64),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  strategy_id TEXT,
  dna_id TEXT,
  dataset_slice_id TEXT,
  policy_version_id TEXT,
  engine_version_id TEXT,
  compiler_version_id TEXT,
  config_version_id TEXT,
  input_hash TEXT,
  result_hash TEXT,
  redaction_class TEXT NOT NULL DEFAULT 'private' CHECK (redaction_class IN ('public_summary', 'private', 'sealed_holdout', 'secret')),
  verified_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, artifact_id),
  UNIQUE (artifact_id),
  UNIQUE (workspace_id, object_key),
  UNIQUE (workspace_id, content_hash, artifact_kind),
  FOREIGN KEY (workspace_id, strategy_id) REFERENCES strategies(workspace_id, strategy_id),
  FOREIGN KEY (workspace_id, dna_id) REFERENCES strategy_dna(workspace_id, dna_id),
  FOREIGN KEY (workspace_id, dataset_slice_id) REFERENCES dataset_slices(workspace_id, dataset_slice_id),
  FOREIGN KEY (workspace_id, policy_version_id) REFERENCES supervisor_policy_versions(workspace_id, policy_version_id),
  FOREIGN KEY (workspace_id, engine_version_id) REFERENCES engine_versions(workspace_id, engine_version_id),
  FOREIGN KEY (workspace_id, compiler_version_id) REFERENCES compiler_versions(workspace_id, compiler_version_id),
  FOREIGN KEY (workspace_id, config_version_id) REFERENCES system_config_versions(workspace_id, config_version_id)
);

CREATE INDEX IF NOT EXISTS idx_artifact_manifests_strategy
  ON artifact_manifests (workspace_id, strategy_id, artifact_kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_artifact_manifests_kind
  ON artifact_manifests (workspace_id, artifact_kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_artifact_manifests_verification
  ON artifact_manifests (workspace_id, verified_at, redaction_class);

-- Append-only: consumers add a new row for every access; rows have no mutable status.
CREATE TABLE IF NOT EXISTS holdout_access_ledger (
  workspace_id TEXT NOT NULL,
  access_id TEXT NOT NULL,
  dataset_slice_id TEXT,
  artifact_id TEXT,
  strategy_id TEXT,
  purpose TEXT NOT NULL,
  actor TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  decision_id TEXT,
  accessed_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, access_id),
  UNIQUE (workspace_id, request_hash, actor, purpose),
  CHECK (dataset_slice_id IS NOT NULL OR artifact_id IS NOT NULL),
  FOREIGN KEY (workspace_id, dataset_slice_id) REFERENCES dataset_slices(workspace_id, dataset_slice_id),
  FOREIGN KEY (workspace_id, artifact_id) REFERENCES artifact_manifests(workspace_id, artifact_id),
  FOREIGN KEY (workspace_id, strategy_id) REFERENCES strategies(workspace_id, strategy_id)
);

CREATE INDEX IF NOT EXISTS idx_holdout_access_strategy
  ON holdout_access_ledger (workspace_id, strategy_id, accessed_at DESC);

CREATE TABLE IF NOT EXISTS trials (
  workspace_id TEXT NOT NULL,
  trial_id TEXT NOT NULL,
  cohort_id TEXT NOT NULL,
  strategy_id TEXT,
  dna_id TEXT NOT NULL,
  dataset_slice_id TEXT NOT NULL,
  trial_seed TEXT NOT NULL,
  trial_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  result_artifact_id TEXT,
  metrics_json TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (workspace_id, trial_id),
  UNIQUE (workspace_id, cohort_id, trial_seed, dna_id, dataset_slice_id),
  FOREIGN KEY (workspace_id, cohort_id) REFERENCES cohorts(workspace_id, cohort_id),
  FOREIGN KEY (workspace_id, strategy_id) REFERENCES strategies(workspace_id, strategy_id),
  FOREIGN KEY (workspace_id, dna_id) REFERENCES strategy_dna(workspace_id, dna_id),
  FOREIGN KEY (workspace_id, dataset_slice_id) REFERENCES dataset_slices(workspace_id, dataset_slice_id),
  FOREIGN KEY (workspace_id, result_artifact_id) REFERENCES artifact_manifests(workspace_id, artifact_id)
);

CREATE INDEX IF NOT EXISTS idx_trials_cohort_status
  ON trials (workspace_id, cohort_id, status, created_at);

-- Append-only decision evidence. A correction is a new transition whose
-- supersedes_transition_id points at the earlier row.
CREATE TABLE IF NOT EXISTS lifecycle_transitions (
  workspace_id TEXT NOT NULL,
  transition_id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  from_state TEXT,
  to_state TEXT NOT NULL,
  trigger_kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  command_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  policy_version_id TEXT,
  evidence_artifact_id TEXT,
  input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
  result_hash TEXT NOT NULL CHECK (length(result_hash) = 64),
  supersedes_transition_id TEXT,
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, transition_id),
  UNIQUE (workspace_id, strategy_id, sequence),
  UNIQUE (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id, strategy_id) REFERENCES strategies(workspace_id, strategy_id),
  FOREIGN KEY (workspace_id, policy_version_id) REFERENCES supervisor_policy_versions(workspace_id, policy_version_id),
  FOREIGN KEY (workspace_id, evidence_artifact_id) REFERENCES artifact_manifests(workspace_id, artifact_id),
  FOREIGN KEY (workspace_id, supersedes_transition_id) REFERENCES lifecycle_transitions(workspace_id, transition_id)
);

CREATE INDEX IF NOT EXISTS idx_lifecycle_transitions_strategy
  ON lifecycle_transitions (workspace_id, strategy_id, sequence DESC);

CREATE TABLE IF NOT EXISTS operational_status (
  workspace_id TEXT NOT NULL,
  operational_status_id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  status TEXT NOT NULL,
  reason_code TEXT,
  source_job_id TEXT,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, operational_status_id),
  UNIQUE (workspace_id, strategy_id, sequence),
  FOREIGN KEY (workspace_id, strategy_id) REFERENCES strategies(workspace_id, strategy_id)
);

CREATE INDEX IF NOT EXISTS idx_operational_status_latest
  ON operational_status (workspace_id, strategy_id, sequence DESC);

CREATE TABLE IF NOT EXISTS incidents (
  workspace_id TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  strategy_id TEXT,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  incident_kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'acknowledged', 'resolved')),
  details_json TEXT NOT NULL,
  evidence_artifact_id TEXT,
  opened_at TEXT NOT NULL,
  acknowledged_at TEXT,
  resolved_at TEXT,
  PRIMARY KEY (workspace_id, incident_id),
  FOREIGN KEY (workspace_id, strategy_id) REFERENCES strategies(workspace_id, strategy_id),
  FOREIGN KEY (workspace_id, evidence_artifact_id) REFERENCES artifact_manifests(workspace_id, artifact_id)
);

CREATE INDEX IF NOT EXISTS idx_incidents_open
  ON incidents (workspace_id, status, severity, opened_at);

CREATE TABLE IF NOT EXISTS research_jobs (
  workspace_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  job_kind TEXT NOT NULL,
  strategy_id TEXT,
  trial_id TEXT,
  dataset_slice_id TEXT,
  request_artifact_id TEXT NOT NULL,
  result_artifact_id TEXT,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ready', 'queued', 'running', 'retry_wait', 'completed', 'failed', 'dead_lettered')),
  priority INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  available_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (workspace_id, job_id),
  UNIQUE (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id, strategy_id) REFERENCES strategies(workspace_id, strategy_id),
  FOREIGN KEY (workspace_id, trial_id) REFERENCES trials(workspace_id, trial_id),
  FOREIGN KEY (workspace_id, dataset_slice_id) REFERENCES dataset_slices(workspace_id, dataset_slice_id),
  FOREIGN KEY (workspace_id, request_artifact_id) REFERENCES artifact_manifests(workspace_id, artifact_id),
  FOREIGN KEY (workspace_id, result_artifact_id) REFERENCES artifact_manifests(workspace_id, artifact_id)
);

CREATE INDEX IF NOT EXISTS idx_research_jobs_claim
  ON research_jobs (workspace_id, status, available_at, priority DESC);

-- Append-only attempt history; retries create another attempt row.
CREATE TABLE IF NOT EXISTS job_attempts (
  workspace_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  worker_id TEXT,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  result_hash TEXT,
  outcome TEXT NOT NULL,
  error_code TEXT,
  error_details_json TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  PRIMARY KEY (workspace_id, attempt_id),
  UNIQUE (workspace_id, job_id, attempt_number),
  FOREIGN KEY (workspace_id, job_id) REFERENCES research_jobs(workspace_id, job_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS job_leases (
  workspace_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  lease_token TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  renewed_at TEXT,
  PRIMARY KEY (workspace_id, job_id),
  UNIQUE (workspace_id, lease_token),
  FOREIGN KEY (workspace_id, job_id) REFERENCES research_jobs(workspace_id, job_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_job_leases_expiry
  ON job_leases (workspace_id, expires_at);

CREATE TABLE IF NOT EXISTS market_sessions (
  workspace_id TEXT NOT NULL,
  market_session_id TEXT NOT NULL,
  calendar_version_id TEXT NOT NULL,
  universe_version_id TEXT NOT NULL,
  session_date TEXT NOT NULL,
  opens_at TEXT NOT NULL,
  closes_at TEXT NOT NULL,
  session_kind TEXT NOT NULL CHECK (session_kind IN ('regular', 'early_close', 'closed')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, market_session_id),
  UNIQUE (workspace_id, calendar_version_id, session_date),
  FOREIGN KEY (workspace_id, calendar_version_id) REFERENCES calendar_versions(workspace_id, calendar_version_id),
  FOREIGN KEY (workspace_id, universe_version_id) REFERENCES universe_versions(workspace_id, universe_version_id)
);

CREATE TABLE IF NOT EXISTS bar_events (
  workspace_id TEXT NOT NULL,
  bar_event_id TEXT NOT NULL,
  market_session_id TEXT NOT NULL,
  feed TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  symbol TEXT NOT NULL,
  bucket_start TEXT NOT NULL,
  bucket_close TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  payload_artifact_id TEXT NOT NULL,
  coverage REAL NOT NULL CHECK (coverage >= 0 AND coverage <= 1),
  health TEXT NOT NULL,
  actionable INTEGER NOT NULL CHECK (actionable IN (0, 1)),
  retroactive INTEGER NOT NULL CHECK (retroactive IN (0, 1)),
  finalized_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, bar_event_id),
  UNIQUE (workspace_id, feed, timeframe, symbol, bucket_start, revision, content_hash),
  FOREIGN KEY (workspace_id, market_session_id) REFERENCES market_sessions(workspace_id, market_session_id),
  FOREIGN KEY (workspace_id, payload_artifact_id) REFERENCES artifact_manifests(workspace_id, artifact_id)
);

CREATE INDEX IF NOT EXISTS idx_bar_events_actionable
  ON bar_events (workspace_id, market_session_id, actionable, bucket_close, symbol);

CREATE TABLE IF NOT EXISTS data_health (
  workspace_id TEXT NOT NULL,
  data_health_id TEXT NOT NULL,
  market_session_id TEXT,
  scope_kind TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  status TEXT NOT NULL,
  coverage REAL NOT NULL CHECK (coverage >= 0 AND coverage <= 1),
  critical_faults INTEGER NOT NULL DEFAULT 0 CHECK (critical_faults >= 0),
  details_json TEXT NOT NULL,
  evidence_artifact_id TEXT,
  checked_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, data_health_id),
  FOREIGN KEY (workspace_id, market_session_id) REFERENCES market_sessions(workspace_id, market_session_id),
  FOREIGN KEY (workspace_id, evidence_artifact_id) REFERENCES artifact_manifests(workspace_id, artifact_id)
);

CREATE INDEX IF NOT EXISTS idx_data_health_scope
  ON data_health (workspace_id, scope_kind, scope_id, checked_at DESC);

CREATE TABLE IF NOT EXISTS incubations (
  workspace_id TEXT NOT NULL,
  incubation_id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  policy_version_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  minimum_completed_trades INTEGER NOT NULL DEFAULT 67 CHECK (minimum_completed_trades >= 0),
  minimum_trading_days INTEGER NOT NULL DEFAULT 10 CHECK (minimum_trading_days >= 0),
  maximum_trading_days INTEGER NOT NULL DEFAULT 20 CHECK (maximum_trading_days > 0),
  status TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (workspace_id, incubation_id),
  UNIQUE (workspace_id, strategy_id, started_at),
  FOREIGN KEY (workspace_id, strategy_id) REFERENCES strategies(workspace_id, strategy_id),
  FOREIGN KEY (workspace_id, policy_version_id) REFERENCES supervisor_policy_versions(workspace_id, policy_version_id)
);

CREATE TABLE IF NOT EXISTS incubation_days (
  workspace_id TEXT NOT NULL,
  incubation_day_id TEXT NOT NULL,
  incubation_id TEXT NOT NULL,
  session_date TEXT NOT NULL,
  eligible INTEGER NOT NULL CHECK (eligible IN (0, 1)),
  coverage REAL NOT NULL CHECK (coverage >= 0 AND coverage <= 1),
  critical_faults INTEGER NOT NULL DEFAULT 0 CHECK (critical_faults >= 0),
  metrics_json TEXT NOT NULL,
  evidence_artifact_id TEXT,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, incubation_day_id),
  UNIQUE (workspace_id, incubation_id, session_date),
  FOREIGN KEY (workspace_id, incubation_id) REFERENCES incubations(workspace_id, incubation_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, evidence_artifact_id) REFERENCES artifact_manifests(workspace_id, artifact_id)
);

CREATE TABLE IF NOT EXISTS incubation_trades (
  workspace_id TEXT NOT NULL,
  incubation_trade_id TEXT NOT NULL,
  incubation_id TEXT NOT NULL,
  trade_key TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('long', 'short')),
  opened_at TEXT NOT NULL,
  closed_at TEXT NOT NULL,
  quantity REAL NOT NULL CHECK (quantity > 0),
  realized_pnl REAL NOT NULL,
  evidence_artifact_id TEXT,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, incubation_trade_id),
  UNIQUE (workspace_id, incubation_id, trade_key),
  FOREIGN KEY (workspace_id, incubation_id) REFERENCES incubations(workspace_id, incubation_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, evidence_artifact_id) REFERENCES artifact_manifests(workspace_id, artifact_id)
);

CREATE INDEX IF NOT EXISTS idx_incubation_trades_progress
  ON incubation_trades (workspace_id, incubation_id, closed_at);

CREATE TABLE IF NOT EXISTS releases (
  workspace_id TEXT NOT NULL,
  release_id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  policy_version_id TEXT NOT NULL,
  decision_artifact_id TEXT NOT NULL,
  release_mode TEXT NOT NULL CHECK (release_mode IN ('paper', 'live')),
  status TEXT NOT NULL,
  released_at TEXT NOT NULL,
  ended_at TEXT,
  PRIMARY KEY (workspace_id, release_id),
  UNIQUE (workspace_id, strategy_id, released_at),
  FOREIGN KEY (workspace_id, strategy_id) REFERENCES strategies(workspace_id, strategy_id),
  FOREIGN KEY (workspace_id, policy_version_id) REFERENCES supervisor_policy_versions(workspace_id, policy_version_id),
  FOREIGN KEY (workspace_id, decision_artifact_id) REFERENCES artifact_manifests(workspace_id, artifact_id)
);

CREATE TABLE IF NOT EXISTS strategy_health (
  workspace_id TEXT NOT NULL,
  strategy_health_id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  release_id TEXT,
  bar_event_id TEXT,
  health_state TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  reason_codes_json TEXT NOT NULL,
  policy_version_id TEXT NOT NULL,
  evidence_artifact_id TEXT,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, strategy_health_id),
  UNIQUE (workspace_id, strategy_id, observed_at),
  FOREIGN KEY (workspace_id, strategy_id) REFERENCES strategies(workspace_id, strategy_id),
  FOREIGN KEY (workspace_id, release_id) REFERENCES releases(workspace_id, release_id),
  FOREIGN KEY (workspace_id, bar_event_id) REFERENCES bar_events(workspace_id, bar_event_id),
  FOREIGN KEY (workspace_id, policy_version_id) REFERENCES supervisor_policy_versions(workspace_id, policy_version_id),
  FOREIGN KEY (workspace_id, evidence_artifact_id) REFERENCES artifact_manifests(workspace_id, artifact_id)
);

CREATE INDEX IF NOT EXISTS idx_strategy_health_latest
  ON strategy_health (workspace_id, strategy_id, observed_at DESC);

-- Append-only risk decisions; reversals are represented by a later action.
CREATE TABLE IF NOT EXISTS risk_actions (
  workspace_id TEXT NOT NULL,
  risk_action_id TEXT NOT NULL,
  strategy_id TEXT,
  release_id TEXT,
  action_kind TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  target_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  evidence_artifact_id TEXT,
  actor TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, risk_action_id),
  UNIQUE (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id, strategy_id) REFERENCES strategies(workspace_id, strategy_id),
  FOREIGN KEY (workspace_id, release_id) REFERENCES releases(workspace_id, release_id),
  FOREIGN KEY (workspace_id, evidence_artifact_id) REFERENCES artifact_manifests(workspace_id, artifact_id)
);

CREATE TABLE IF NOT EXISTS broker_intents (
  workspace_id TEXT NOT NULL,
  broker_intent_id TEXT NOT NULL,
  broker_account_id TEXT NOT NULL,
  strategy_id TEXT,
  bar_event_id TEXT,
  symbol TEXT NOT NULL,
  target_signed_notional REAL NOT NULL,
  target_signed_quantity REAL,
  intent_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, broker_intent_id),
  UNIQUE (workspace_id, broker_account_id, idempotency_key),
  FOREIGN KEY (workspace_id, strategy_id) REFERENCES strategies(workspace_id, strategy_id),
  FOREIGN KEY (workspace_id, bar_event_id) REFERENCES bar_events(workspace_id, bar_event_id)
);

CREATE INDEX IF NOT EXISTS idx_broker_intents_status
  ON broker_intents (workspace_id, broker_account_id, status, created_at);

CREATE TABLE IF NOT EXISTS orders (
  workspace_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  broker_intent_id TEXT NOT NULL,
  broker_account_id TEXT NOT NULL,
  broker_order_id TEXT,
  client_order_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  order_type TEXT NOT NULL,
  time_in_force TEXT NOT NULL,
  requested_quantity REAL,
  requested_notional REAL,
  status TEXT NOT NULL,
  submitted_at TEXT,
  terminal_at TEXT,
  PRIMARY KEY (workspace_id, order_id),
  UNIQUE (workspace_id, broker_account_id, client_order_id),
  UNIQUE (workspace_id, broker_account_id, broker_order_id),
  FOREIGN KEY (workspace_id, broker_intent_id) REFERENCES broker_intents(workspace_id, broker_intent_id)
);

CREATE INDEX IF NOT EXISTS idx_orders_open
  ON orders (workspace_id, broker_account_id, status, symbol);

-- Append-only broker evidence.
CREATE TABLE IF NOT EXISTS fills (
  workspace_id TEXT NOT NULL,
  fill_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  broker_account_id TEXT NOT NULL,
  broker_fill_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  quantity REAL NOT NULL CHECK (quantity > 0),
  price REAL NOT NULL CHECK (price >= 0),
  fee REAL NOT NULL DEFAULT 0,
  filled_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  raw_artifact_id TEXT,
  PRIMARY KEY (workspace_id, fill_id),
  UNIQUE (workspace_id, broker_account_id, broker_fill_id),
  FOREIGN KEY (workspace_id, order_id) REFERENCES orders(workspace_id, order_id),
  FOREIGN KEY (workspace_id, raw_artifact_id) REFERENCES artifact_manifests(workspace_id, artifact_id)
);

CREATE INDEX IF NOT EXISTS idx_fills_symbol_time
  ON fills (workspace_id, broker_account_id, symbol, filled_at);

CREATE TABLE IF NOT EXISTS positions (
  workspace_id TEXT NOT NULL,
  position_snapshot_id TEXT NOT NULL,
  broker_account_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  signed_quantity REAL NOT NULL,
  market_value REAL NOT NULL,
  average_entry_price REAL,
  managed INTEGER NOT NULL CHECK (managed IN (0, 1)),
  source_hash TEXT NOT NULL CHECK (length(source_hash) = 64),
  observed_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, position_snapshot_id),
  UNIQUE (workspace_id, broker_account_id, symbol, observed_at),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_positions_latest
  ON positions (workspace_id, broker_account_id, symbol, observed_at DESC);

-- Append-only allocation evidence tying fills/P&L back to strategies.
CREATE TABLE IF NOT EXISTS attribution (
  workspace_id TEXT NOT NULL,
  attribution_id TEXT NOT NULL,
  fill_id TEXT,
  strategy_id TEXT NOT NULL,
  release_id TEXT,
  symbol TEXT NOT NULL,
  signed_quantity REAL NOT NULL,
  allocated_notional REAL NOT NULL,
  realized_pnl REAL,
  allocation_hash TEXT NOT NULL CHECK (length(allocation_hash) = 64),
  attributed_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, attribution_id),
  UNIQUE (workspace_id, allocation_hash),
  FOREIGN KEY (workspace_id, fill_id) REFERENCES fills(workspace_id, fill_id),
  FOREIGN KEY (workspace_id, strategy_id) REFERENCES strategies(workspace_id, strategy_id),
  FOREIGN KEY (workspace_id, release_id) REFERENCES releases(workspace_id, release_id)
);

CREATE INDEX IF NOT EXISTS idx_attribution_strategy
  ON attribution (workspace_id, strategy_id, attributed_at DESC);

CREATE TABLE IF NOT EXISTS outbox (
  workspace_id TEXT NOT NULL,
  outbox_id TEXT NOT NULL,
  aggregate_kind TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  message_kind TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  available_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  claim_token TEXT,
  claim_expires_at TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, outbox_id),
  UNIQUE (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_outbox_dispatch
  ON outbox (workspace_id, sent_at, available_at, claim_expires_at);

CREATE TABLE IF NOT EXISTS idempotency_records (
  workspace_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  operation_kind TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  response_hash TEXT,
  response_artifact_id TEXT,
  outcome TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  expires_at TEXT,
  PRIMARY KEY (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id, response_artifact_id) REFERENCES artifact_manifests(workspace_id, artifact_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_idempotency_records_expiry
  ON idempotency_records (workspace_id, expires_at);

-- Append-only security and operator audit evidence. Details must be redacted by
-- the application before insertion; secrets never belong in this table.
CREATE TABLE IF NOT EXISTS audit_events (
  workspace_id TEXT NOT NULL,
  audit_event_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  subject_kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  request_id TEXT,
  source_ip_hash TEXT,
  details_json TEXT NOT NULL,
  previous_event_hash TEXT,
  event_hash TEXT NOT NULL CHECK (length(event_hash) = 64),
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, audit_event_id),
  UNIQUE (workspace_id, event_hash),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_audit_events_subject
  ON audit_events (workspace_id, subject_kind, subject_id, occurred_at DESC);

-- Exact, resumable import bookkeeping for the schema-v5 Durable Object migration.
CREATE TABLE IF NOT EXISTS workspace_migration_manifests (
  workspace_id TEXT NOT NULL,
  migration_manifest_id TEXT NOT NULL,
  source_schema_version INTEGER NOT NULL CHECK (source_schema_version > 0),
  target_schema_version INTEGER NOT NULL CHECK (target_schema_version > 0),
  source_export_object_key TEXT NOT NULL,
  source_export_hash TEXT NOT NULL CHECK (length(source_export_hash) = 64),
  manifest_object_key TEXT NOT NULL,
  manifest_hash TEXT NOT NULL CHECK (length(manifest_hash) = 64),
  status TEXT NOT NULL CHECK (status IN ('prepared', 'importing', 'verifying', 'soaking', 'complete', 'failed')),
  counts_json TEXT NOT NULL,
  prepared_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (workspace_id, migration_manifest_id),
  UNIQUE (workspace_id, source_export_hash, target_schema_version),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS workspace_migration_steps (
  workspace_id TEXT NOT NULL,
  migration_manifest_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  step_kind TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'complete', 'failed')),
  input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
  result_hash TEXT,
  details_json TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  PRIMARY KEY (workspace_id, migration_manifest_id, step_id),
  UNIQUE (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id, migration_manifest_id) REFERENCES workspace_migration_manifests(workspace_id, migration_manifest_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workspace_migration_steps_resume
  ON workspace_migration_steps (workspace_id, migration_manifest_id, status, step_id);

-- A reset is prepared and authorized before any target is deleted. These rows
-- enumerate exact D1/R2/DO targets and preserve their pre-reset hashes.
CREATE TABLE IF NOT EXISTS workspace_reset_manifests (
  workspace_id TEXT NOT NULL,
  reset_manifest_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  authorized_by TEXT,
  authorization_hash TEXT,
  manifest_object_key TEXT NOT NULL,
  manifest_hash TEXT NOT NULL CHECK (length(manifest_hash) = 64),
  status TEXT NOT NULL CHECK (status IN ('prepared', 'authorized', 'executing', 'complete', 'failed', 'cancelled')),
  recoverable_until TEXT,
  prepared_at TEXT NOT NULL,
  authorized_at TEXT,
  completed_at TEXT,
  PRIMARY KEY (workspace_id, reset_manifest_id),
  UNIQUE (workspace_id, manifest_hash),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS workspace_reset_targets (
  workspace_id TEXT NOT NULL,
  reset_manifest_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  storage_kind TEXT NOT NULL CHECK (storage_kind IN ('d1', 'r2', 'durable_object')),
  target_kind TEXT NOT NULL,
  target_locator TEXT NOT NULL,
  content_hash TEXT,
  byte_length INTEGER,
  deletion_order INTEGER NOT NULL CHECK (deletion_order >= 0),
  deleted_at TEXT,
  deletion_receipt_hash TEXT,
  PRIMARY KEY (workspace_id, reset_manifest_id, target_id),
  UNIQUE (workspace_id, reset_manifest_id, storage_kind, target_locator),
  FOREIGN KEY (workspace_id, reset_manifest_id) REFERENCES workspace_reset_manifests(workspace_id, reset_manifest_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workspace_reset_targets_progress
  ON workspace_reset_targets (workspace_id, reset_manifest_id, deleted_at, deletion_order);

-- Versioned normalized read model used to compare with the legacy DO response
-- before the feature-flagged read cutover.
CREATE TABLE IF NOT EXISTS normalized_read_models (
  workspace_id TEXT NOT NULL,
  read_model_id TEXT NOT NULL,
  source_checkpoint_hash TEXT NOT NULL CHECK (length(source_checkpoint_hash) = 64),
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  response_json TEXT NOT NULL,
  response_hash TEXT NOT NULL CHECK (length(response_hash) = 64),
  comparison_status TEXT NOT NULL CHECK (comparison_status IN ('pending', 'matched', 'mismatched')),
  comparison_artifact_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, read_model_id),
  UNIQUE (workspace_id, source_checkpoint_hash, schema_version),
  FOREIGN KEY (workspace_id, comparison_artifact_id) REFERENCES artifact_manifests(workspace_id, artifact_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);
