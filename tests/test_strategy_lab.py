import math
import unittest

from strategy_lab import StrategyLab, backtest, market_series


class StrategyLabTests(unittest.TestCase):
    def test_demo_state_is_deterministic_and_has_a_release_book(self):
        first = StrategyLab().snapshot()
        second = StrategyLab().snapshot()
        self.assertEqual(first, second)
        self.assertGreaterEqual(first["summary"]["released"], 1)
        self.assertTrue(all(item["backtests"] == 3 for item in first["strategies"]))

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
        lab = StrategyLab()
        parent = next(item for item in lab.snapshot()["strategies"] if item["state"] in {"released", "healthy", "watch", "adjusted"})
        lab.reproduce(parent["id"])
        child = lab.snapshot()["strategies"][0]
        self.assertEqual(child["parent"], parent["id"])
        self.assertEqual(child["generation"], parent["generation"] + 1)
        self.assertNotEqual(child["params"], parent["params"])
        self.assertEqual(child["state"], "generated")

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
        lab = StrategyLab()
        active_before = [item for item in lab.snapshot()["strategies"] if item["state"] in {"released", "healthy", "watch", "adjusted"}]
        lab.advance_market()
        by_id = {item["id"]: item for item in lab.snapshot()["strategies"]}
        for item in active_before:
            self.assertGreaterEqual(len(by_id[item["id"]]["monitor"]["returns"]), 21)
            self.assertIsNotNone(by_id[item["id"]]["monitor"]["sharpe"])


if __name__ == "__main__":
    unittest.main()
