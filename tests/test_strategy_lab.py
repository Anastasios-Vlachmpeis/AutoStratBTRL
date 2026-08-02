import math
import unittest

from strategy_lab import StrategyLab, backtest, market_series


class StrategyLabTests(unittest.TestCase):
    @staticmethod
    def rework_lab(attempt=0):
        lab = StrategyLab()
        lab.generate_batch(1)
        strategy = lab.strategies[0]
        strategy["state"] = "rework"
        strategy["metrics"] = {
            "score": 57, "annualized": 0.05, "sharpe": 0.48, "drawdown": 0.19,
            "trades": 28, "profit_factor": 1.01, "positive_regimes": 3, "robustness": 0.62,
        }
        strategy["validation"] = {"sharpe": -4, "return": -0.8, "drawdown": 0.9}
        strategy["rework"] = {
            "attempt": attempt, "max_attempts": 3, "diagnosis": "queued",
            "source_stage": "validation", "change": None, "history": [],
        }
        return lab, strategy

    @staticmethod
    def released_lab():
        lab = StrategyLab()
        lab.generate_batch(1)
        strategy = lab.strategies[0]
        strategy["state"] = "released"
        strategy["metrics"] = {"score": 70, "annualized": 0.12, "sharpe": 1.1, "drawdown": 0.08, "trades": 30}
        strategy["validation"] = {"sharpe": 0.8, "return": 0.06, "drawdown": 0.07}
        return lab, strategy

    def test_initial_state_is_deterministic_and_empty(self):
        first = StrategyLab().snapshot()
        second = StrategyLab().snapshot()
        self.assertEqual(first, second)
        self.assertEqual(first["strategies"], [])
        self.assertEqual(first["events"], [])
        self.assertEqual(first["summary"]["released"], 0)
        self.assertEqual(first["summary"]["capital"], 100_000)
        self.assertEqual(first["meta"]["cycle"], 0)

    def test_generated_cohort_waits_for_review(self):
        lab = StrategyLab()
        before = len(lab.snapshot()["strategies"])
        lab.generate_batch(4)
        snapshot = lab.snapshot()
        self.assertEqual(len(snapshot["strategies"]), before + 4)
        self.assertEqual(snapshot["summary"]["generated"], 4)

        lab.review_candidates()
        reviewed = lab.snapshot()
        self.assertEqual(reviewed["summary"]["generated"], 0)
        self.assertTrue(all(item["backtests"] == 3 for item in reviewed["strategies"][:4]))

    def test_reproduction_preserves_lineage_and_mutates_dna(self):
        lab, parent = self.released_lab()
        lab.reproduce(parent["id"])
        child = lab.snapshot()["strategies"][0]
        self.assertEqual(child["parent"], parent["id"])
        self.assertEqual(child["generation"], parent["generation"] + 1)
        self.assertNotEqual(child["params"], parent["params"])
        self.assertEqual(child["state"], "generated")

    def test_rework_archives_parent_and_changes_one_parameter(self):
        lab, parent = self.rework_lab()
        original = dict(parent["params"])
        child = lab.rework_candidates()[0]
        self.assertEqual(parent["state"], "superseded")
        self.assertEqual(child["parent"], parent["id"])
        self.assertEqual(child["state"], "generated")
        self.assertEqual(child["rework"]["attempt"], 1)
        self.assertEqual(len(child["rework"]["history"]), 1)
        self.assertIsNone(child["validation"])
        changed = [key for key in child["params"] if child["params"][key] != original[key]]
        self.assertEqual(changed, [child["rework"]["change"]["parameter"]])

    def test_rework_does_not_use_validation_values(self):
        first, _ = self.rework_lab()
        second, _ = self.rework_lab()
        second.strategies[0]["validation"] = {"sharpe": 20, "return": 5, "drawdown": 0}
        first_child = first.rework_candidates()[0]
        second_child = second.rework_candidates()[0]
        self.assertEqual(first_child["params"], second_child["params"])
        self.assertEqual(first_child["rework"]["history"][0]["development"], second_child["rework"]["history"][0]["development"])

    def test_rework_is_dropped_after_three_attempts(self):
        lab, parent = self.rework_lab(attempt=3)
        self.assertEqual(lab.rework_candidates(), [])
        self.assertEqual(parent["state"], "dropped")

    def test_supervisor_automatically_tests_rework_child(self):
        lab, parent = self.rework_lab()
        lab.review_candidates()
        child = next(item for item in lab.strategies if item["parent"] == parent["id"])
        self.assertEqual(parent["state"], "superseded")
        self.assertEqual(child["backtests"], 3)
        self.assertNotEqual(child["state"], "generated")

    def test_no_signal_backtest_stays_finite(self):
        strategy = {
            "archetype": "Breakout",
            "params": {"lookback": 10_000, "buffer": 0.5, "position_size": 0.5},
        }
        prices, regimes = market_series(41)
        result = backtest(strategy, prices, regimes)
        self.assertEqual(result["trades"], 0)
        self.assertTrue(math.isfinite(result["sharpe"]))
        self.assertTrue(math.isfinite(result["profit_factor"]))

    def test_market_advance_records_a_monitor_window(self):
        lab, _ = self.released_lab()
        active_before = [item for item in lab.snapshot()["strategies"] if item["state"] in {"released", "healthy", "watch", "adjusted"}]
        lab.advance_market()
        by_id = {item["id"]: item for item in lab.snapshot()["strategies"]}
        for item in active_before:
            self.assertGreaterEqual(len(by_id[item["id"]]["monitor"]["returns"]), 21)
            self.assertIsNotNone(by_id[item["id"]]["monitor"]["sharpe"])

    def test_supervisor_approval_requires_validation_before_release(self):
        lab = StrategyLab()
        lab.generate_batch(12)
        lab.review_candidates()
        approved = [item for item in lab.snapshot()["strategies"] if item["state"] == "validation"]
        self.assertTrue(approved)
        self.assertTrue(all(item["validation"] is None for item in approved))
        lab.validate_candidates()
        self.assertFalse(any(item["state"] == "validation" for item in lab.snapshot()["strategies"]))


if __name__ == "__main__":
    unittest.main()
