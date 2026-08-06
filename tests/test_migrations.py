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
        self.assertGreaterEqual(len(paths), 7)
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


if __name__ == "__main__":
    unittest.main()
