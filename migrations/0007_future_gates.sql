-- Plan 15: future SIP and real-money gates.
-- This migration is intentionally paper-only. A future live deployment must
-- use a separately reviewed schema and resources; it must not relax these
-- checks in-place.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS feed_versions (
  workspace_id TEXT NOT NULL,
  feed_version_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider = 'alpaca'),
  feed TEXT NOT NULL CHECK (feed IN ('iex', 'sip')),
  revision TEXT NOT NULL,
  dataset_hash TEXT NOT NULL CHECK (length(dataset_hash) = 64),
  universe_hash TEXT NOT NULL CHECK (length(universe_hash) = 64),
  calendar_hash TEXT NOT NULL CHECK (length(calendar_hash) = 64),
  manifest_hash TEXT NOT NULL CHECK (length(manifest_hash) = 64),
  timeframe TEXT NOT NULL CHECK (timeframe = '5Min'),
  adjustment TEXT NOT NULL,
  session TEXT NOT NULL CHECK (session = 'regular'),
  range_start TEXT NOT NULL,
  range_end TEXT NOT NULL,
  symbol_count INTEGER NOT NULL CHECK (symbol_count > 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, feed_version_id),
  UNIQUE (workspace_id, manifest_hash),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sip_migration_assessments (
  workspace_id TEXT NOT NULL,
  assessment_id TEXT NOT NULL,
  source_feed_version_id TEXT NOT NULL,
  target_feed_version_id TEXT NOT NULL,
  assessment_hash TEXT NOT NULL CHECK (length(assessment_hash) = 64),
  decision TEXT NOT NULL CHECK (decision IN ('blocked', 'ready_for_separate_sip_rollout')),
  passed INTEGER NOT NULL CHECK (passed IN (0, 1)),
  activates_feed INTEGER NOT NULL DEFAULT 0 CHECK (activates_feed = 0),
  evidence_artifact_id TEXT,
  assessed_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, assessment_id),
  UNIQUE (workspace_id, assessment_hash),
  FOREIGN KEY (workspace_id, source_feed_version_id) REFERENCES feed_versions(workspace_id, feed_version_id),
  FOREIGN KEY (workspace_id, target_feed_version_id) REFERENCES feed_versions(workspace_id, feed_version_id),
  FOREIGN KEY (workspace_id, evidence_artifact_id) REFERENCES artifact_manifests(workspace_id, artifact_id)
);

CREATE TABLE IF NOT EXISTS real_money_readiness_assessments (
  workspace_id TEXT NOT NULL,
  assessment_id TEXT NOT NULL,
  assessment_hash TEXT NOT NULL CHECK (length(assessment_hash) = 64),
  decision TEXT NOT NULL CHECK (decision IN ('blocked', 'ready_for_separate_live_design_review')),
  passed INTEGER NOT NULL CHECK (passed IN (0, 1)),
  live_execution_implemented INTEGER NOT NULL DEFAULT 0 CHECK (live_execution_implemented = 0),
  authorizes_orders INTEGER NOT NULL DEFAULT 0 CHECK (authorizes_orders = 0),
  requires_separate_deployment INTEGER NOT NULL DEFAULT 1 CHECK (requires_separate_deployment = 1),
  evidence_artifact_id TEXT,
  assessed_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, assessment_id),
  UNIQUE (workspace_id, assessment_hash),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, evidence_artifact_id) REFERENCES artifact_manifests(workspace_id, artifact_id)
);

CREATE TABLE IF NOT EXISTS paper_broker_accounts (
  workspace_id TEXT NOT NULL,
  broker_account_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider = 'alpaca'),
  account_class TEXT NOT NULL CHECK (account_class = 'paper'),
  endpoint_class TEXT NOT NULL CHECK (endpoint_class = 'alpaca_paper_api'),
  record_schema TEXT NOT NULL CHECK (record_schema = 'axiom.paper-broker.v1'),
  registered_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, broker_account_id),
  CHECK (broker_account_id LIKE 'alpaca-paper-%'),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);

-- Safely classify only historical records that already used the frozen paper
-- account namespace. Anything else remains unregistered and cannot receive
-- new broker records after this migration.
INSERT OR IGNORE INTO paper_broker_accounts
  (workspace_id,broker_account_id,provider,account_class,endpoint_class,record_schema,registered_at)
SELECT workspace_id,broker_account_id,'alpaca','paper','alpaca_paper_api','axiom.paper-broker.v1',MIN(recorded_at)
FROM (
  SELECT workspace_id,broker_account_id,created_at AS recorded_at FROM broker_intents
  UNION ALL SELECT workspace_id,broker_account_id,COALESCE(submitted_at,'1970-01-01T00:00:00.000Z') FROM orders
  UNION ALL SELECT workspace_id,broker_account_id,received_at FROM fills
  UNION ALL SELECT workspace_id,broker_account_id,observed_at FROM positions
) WHERE broker_account_id LIKE 'alpaca-paper-%'
GROUP BY workspace_id,broker_account_id;

CREATE TRIGGER IF NOT EXISTS releases_paper_only_insert
BEFORE INSERT ON releases WHEN NEW.release_mode <> 'paper'
BEGIN
  SELECT RAISE(ABORT, 'this deployment accepts paper releases only');
END;

CREATE TRIGGER IF NOT EXISTS releases_paper_only_update
BEFORE UPDATE OF release_mode ON releases WHEN NEW.release_mode <> 'paper'
BEGIN
  SELECT RAISE(ABORT, 'this deployment accepts paper releases only');
END;

CREATE TRIGGER IF NOT EXISTS broker_intents_registered_paper_only
BEFORE INSERT ON broker_intents
WHEN NOT EXISTS (
  SELECT 1 FROM paper_broker_accounts p
  WHERE p.workspace_id = NEW.workspace_id AND p.broker_account_id = NEW.broker_account_id
)
BEGIN
  SELECT RAISE(ABORT, 'broker intent requires a registered paper account');
END;

CREATE TRIGGER IF NOT EXISTS orders_registered_paper_only
BEFORE INSERT ON orders
WHEN NOT EXISTS (
  SELECT 1 FROM paper_broker_accounts p
  WHERE p.workspace_id = NEW.workspace_id AND p.broker_account_id = NEW.broker_account_id
)
BEGIN
  SELECT RAISE(ABORT, 'order requires a registered paper account');
END;

CREATE TRIGGER IF NOT EXISTS fills_registered_paper_only
BEFORE INSERT ON fills
WHEN NOT EXISTS (
  SELECT 1 FROM paper_broker_accounts p
  WHERE p.workspace_id = NEW.workspace_id AND p.broker_account_id = NEW.broker_account_id
)
BEGIN
  SELECT RAISE(ABORT, 'fill requires a registered paper account');
END;

CREATE TRIGGER IF NOT EXISTS positions_registered_paper_only
BEFORE INSERT ON positions
WHEN NOT EXISTS (
  SELECT 1 FROM paper_broker_accounts p
  WHERE p.workspace_id = NEW.workspace_id AND p.broker_account_id = NEW.broker_account_id
)
BEGIN
  SELECT RAISE(ABORT, 'position requires a registered paper account');
END;

CREATE INDEX IF NOT EXISTS idx_feed_versions_identity
  ON feed_versions (workspace_id, feed, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sip_assessments_time
  ON sip_migration_assessments (workspace_id, assessed_at DESC);
CREATE INDEX IF NOT EXISTS idx_real_money_assessments_time
  ON real_money_readiness_assessments (workspace_id, assessed_at DESC);
