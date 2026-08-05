-- Durable strategy allocation for broker intents. This permits fill
-- attribution to recover after a Worker/DO restart between submit and save.
CREATE TABLE IF NOT EXISTS broker_intent_allocations (
  workspace_id TEXT NOT NULL,
  broker_intent_id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  signed_notional REAL NOT NULL,
  allocation_hash TEXT NOT NULL CHECK (length(allocation_hash) = 64),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, broker_intent_id, strategy_id),
  UNIQUE (workspace_id, allocation_hash),
  FOREIGN KEY (workspace_id, broker_intent_id)
    REFERENCES broker_intents(workspace_id, broker_intent_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, strategy_id)
    REFERENCES strategies(workspace_id, strategy_id)
);

CREATE INDEX IF NOT EXISTS idx_broker_intent_allocations_intent
  ON broker_intent_allocations (workspace_id, broker_intent_id);
