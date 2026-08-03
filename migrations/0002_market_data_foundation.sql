CREATE TABLE IF NOT EXISTS market_universe_versions (
  universe_id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  symbol_count INTEGER NOT NULL,
  feed TEXT NOT NULL,
  object_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS market_calendar_manifests (
  calendar_id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  first_session TEXT NOT NULL,
  last_session TEXT NOT NULL,
  session_count INTEGER NOT NULL,
  object_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS market_backfill_jobs (
  job_id TEXT PRIMARY KEY,
  backfill_id TEXT NOT NULL,
  universe_id TEXT NOT NULL,
  calendar_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  range_start TEXT NOT NULL,
  range_end TEXT NOT NULL,
  partition_month TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'complete', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  partition_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_market_backfill_jobs_progress
  ON market_backfill_jobs (backfill_id, status);

CREATE TABLE IF NOT EXISTS market_partitions (
  partition_id TEXT PRIMARY KEY,
  universe_id TEXT NOT NULL,
  calendar_id TEXT NOT NULL,
  feed TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  adjustment TEXT NOT NULL,
  symbol TEXT NOT NULL,
  partition_month TEXT NOT NULL,
  range_start TEXT NOT NULL,
  range_end TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  expected_bars INTEGER NOT NULL,
  missing_bars INTEGER NOT NULL,
  coverage REAL NOT NULL,
  adjustment_discontinuities INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  object_key TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (universe_id, calendar_id, symbol, partition_month, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_market_partitions_dataset
  ON market_partitions (universe_id, calendar_id, symbol, partition_month);

CREATE TABLE IF NOT EXISTS market_dataset_manifests (
  dataset_id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  universe_id TEXT NOT NULL,
  calendar_id TEXT NOT NULL,
  feed TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  range_start TEXT NOT NULL,
  range_end TEXT NOT NULL,
  symbol_count INTEGER NOT NULL,
  row_count INTEGER NOT NULL,
  missing_bars INTEGER NOT NULL,
  object_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS market_live_bar_revisions (
  revision_id TEXT PRIMARY KEY,
  feed TEXT NOT NULL,
  symbol TEXT NOT NULL,
  bar_timestamp TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  revision INTEGER NOT NULL,
  received_at TEXT NOT NULL,
  corrected INTEGER NOT NULL CHECK (corrected IN (0, 1)),
  payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_market_live_bar_revisions_symbol_time
  ON market_live_bar_revisions (symbol, bar_timestamp);

CREATE TABLE IF NOT EXISTS market_five_minute_events (
  event_id TEXT PRIMARY KEY,
  feed TEXT NOT NULL,
  symbol TEXT NOT NULL,
  session_date TEXT NOT NULL,
  bucket_start TEXT NOT NULL,
  bucket_close TEXT NOT NULL,
  revision INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  coverage REAL NOT NULL,
  health TEXT NOT NULL,
  retroactive INTEGER NOT NULL CHECK (retroactive IN (0, 1)),
  actionable INTEGER NOT NULL CHECK (actionable IN (0, 1)),
  finalized_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_market_five_minute_events_symbol_close
  ON market_five_minute_events (symbol, bucket_close);

CREATE INDEX IF NOT EXISTS idx_market_five_minute_events_session
  ON market_five_minute_events (session_date, symbol, bucket_start);

CREATE TABLE IF NOT EXISTS market_data_health (
  health_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  healthy_symbols INTEGER NOT NULL,
  symbol_count INTEGER NOT NULL,
  coverage REAL NOT NULL,
  checked_at TEXT NOT NULL,
  details_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS market_session_reconciliations (
  reconciliation_id TEXT PRIMARY KEY,
  session_date TEXT NOT NULL,
  universe_id TEXT NOT NULL,
  calendar_id TEXT NOT NULL,
  feed TEXT NOT NULL,
  status TEXT NOT NULL,
  native_hash TEXT NOT NULL,
  matched_bars INTEGER NOT NULL,
  mismatched_bars INTEGER NOT NULL,
  missing_live_bars INTEGER NOT NULL,
  extra_live_bars INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  object_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);
