import sqlite3
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class MigrationTests(unittest.TestCase):
    def test_complete_migration_chain_applies_to_an_empty_database(self):
        connection = sqlite3.connect(":memory:")
        connection.execute("PRAGMA foreign_keys=ON")
        paths = sorted((ROOT / "migrations").glob("*.sql"))
        for path in paths:
            connection.executescript(path.read_text(encoding="utf-8"))
        self.assertGreaterEqual(len(paths), 8)
        self.assertIsNotNone(connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='rollout_phase_state'").fetchone())

    def test_rollout_migration_applies_and_enforces_phase_checks(self):
        connection = sqlite3.connect(":memory:")
        connection.execute("PRAGMA foreign_keys=ON")
        sql = (ROOT / "migrations" / "0006_rollout_control.sql").read_text(encoding="utf-8")
        connection.executescript(sql)
        tables = {row[0] for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")}
        expected = {"rollout_phase_state", "rollout_gate_evidence", "rollout_transitions",
                    "rollback_backup_manifests", "rollback_rehearsals", "rollout_domain_cutovers"}
        self.assertTrue(expected.issubset(tables))
        with self.assertRaises(sqlite3.IntegrityError):
            connection.execute("""INSERT INTO rollout_phase_state
                (workspace_id,schema_version,current_phase,complete,legacy_authoritative,transition_count,state_hash,updated_at)
                VALUES ('ws',1,'Z',0,1,0,?,?)""", ("a" * 64, "2026-08-06T00:00:00Z"))

    def test_rollout_schema_stores_no_secret_or_raw_evidence_columns(self):
        sql = (ROOT / "migrations" / "0006_rollout_control.sql").read_text(encoding="utf-8").lower()
        for forbidden in ["api_secret", "admin_token", "holdout_bars", "raw_bars", "payload_json"]:
            self.assertNotIn(forbidden, sql)

    def test_future_gate_migration_is_non_activating_and_paper_only(self):
        connection = sqlite3.connect(":memory:")
        connection.execute("PRAGMA foreign_keys=ON")
        for path in sorted((ROOT / "migrations").glob("*.sql")):
            connection.executescript(path.read_text(encoding="utf-8"))
        tables = {row[0] for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")}
        self.assertTrue({"feed_versions", "sip_migration_assessments",
                         "real_money_readiness_assessments", "paper_broker_accounts"}.issubset(tables))
        with self.assertRaisesRegex(sqlite3.IntegrityError, "paper releases only"):
            connection.execute("""INSERT INTO releases
              (workspace_id,release_id,strategy_id,policy_version_id,decision_artifact_id,
               release_mode,status,released_at,ended_at)
              VALUES ('ws','r','s','p','a','live','active','2026-08-06T00:00:00Z',NULL)""")
        with self.assertRaises(sqlite3.IntegrityError):
            connection.execute("""INSERT INTO real_money_readiness_assessments
              (workspace_id,assessment_id,assessment_hash,decision,passed,live_execution_implemented,
               authorizes_orders,requires_separate_deployment,assessed_at)
              VALUES ('ws','a',?,'ready_for_separate_live_design_review',1,0,1,1,'2026-08-06T00:00:00Z')""",
                               ("a" * 64,))
        connection.execute("""INSERT INTO workspaces
          (workspace_id,display_name,environment,status,created_at,updated_at)
          VALUES ('paper-ws','Paper','development','active','2026-08-06T00:00:00Z','2026-08-06T00:00:00Z')""")
        intent_sql = """INSERT INTO broker_intents
          (workspace_id,broker_intent_id,broker_account_id,strategy_id,bar_event_id,symbol,
           target_signed_notional,target_signed_quantity,intent_kind,status,idempotency_key,request_hash,created_at)
          VALUES ('paper-ws','intent-1','alpaca-paper-primary',NULL,NULL,'SPY',100,NULL,
                  'rebalance','planned','key-1',?,'2026-08-06T00:00:00Z')"""
        with self.assertRaisesRegex(sqlite3.IntegrityError, "registered paper account"):
            connection.execute(intent_sql, ("b" * 64,))
        connection.execute("""INSERT INTO paper_broker_accounts
          (workspace_id,broker_account_id,provider,account_class,endpoint_class,record_schema,registered_at)
          VALUES ('paper-ws','alpaca-paper-primary','alpaca','paper','alpaca_paper_api',
                  'axiom.paper-broker.v1','2026-08-06T00:00:00Z')""")
        connection.execute(intent_sql, ("b" * 64,))

    def test_future_gate_schema_contains_no_credentials_or_raw_market_data(self):
        sql = (ROOT / "migrations" / "0007_future_gates.sql").read_text(encoding="utf-8").lower()
        for forbidden in ["api_secret", "api_key", "access_token", "raw_bars", "holdout_bars"]:
            self.assertNotIn(forbidden, sql)
        self.assertIn("check (authorizes_orders = 0)", sql)
        self.assertIn("check (live_execution_implemented = 0)", sql)

    def test_backtester_contracts_are_source_pinned_to_iex(self):
        v1 = (ROOT / "backtester_service" / "app" / "main.py").read_text(encoding="utf-8")
        v2 = (ROOT / "backtester_service" / "app" / "v2.py").read_text(encoding="utf-8")
        self.assertIn('feed: Literal["iex"] = "iex"', v1)
        self.assertIn('feed: Literal["iex"] = "iex"', v2)


if __name__ == "__main__":
    unittest.main()
