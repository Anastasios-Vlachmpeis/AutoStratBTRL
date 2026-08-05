-- Holdout access may identify the sealed dataset slice before an artifact is
-- produced. SQLite cannot drop a NOT NULL constraint in place, so recreate
-- this append-only ledger while preserving every existing row.
CREATE TABLE holdout_access_ledger_v2 (
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

INSERT INTO holdout_access_ledger_v2
SELECT workspace_id, access_id, dataset_slice_id, artifact_id, strategy_id,
       purpose, actor, request_hash, decision_id, accessed_at
FROM holdout_access_ledger;

DROP TABLE holdout_access_ledger;
ALTER TABLE holdout_access_ledger_v2 RENAME TO holdout_access_ledger;

CREATE INDEX idx_holdout_access_strategy
  ON holdout_access_ledger (workspace_id, strategy_id, accessed_at DESC);
