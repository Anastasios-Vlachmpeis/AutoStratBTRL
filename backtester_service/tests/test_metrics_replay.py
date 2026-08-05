from __future__ import annotations

from backtester_service.app.metrics import BAR_PERIODS_PER_YEAR_5M, METRICS_SCHEMA_VERSION, compute_metrics
from backtester_service.app.replay import ARTIFACT_SCHEMA_VERSION, build_artifact, result_hash


def test_five_minute_metrics_use_explicit_bases_and_are_finite() -> None:
    curve = [
        {"t": "2026-01-02T14:30:00Z", "value": 100_000},
        {"t": "2026-01-02T14:35:00Z", "value": 101_000},
        {"t": "2026-01-02T14:40:00Z", "value": 99_000},
        {"t": "2026-01-05T14:30:00Z", "value": 102_000},
    ]
    metrics = compute_metrics(
        curve,
        exposure_curve=[{"t": point["t"], "value": .25} for point in curve],
        fills=[{"t": curve[1]["t"], "symbol": "SPY", "size": 10, "price": 100, "bar_volume": 1000, "max_participation": .05}],
        closed_trades=[{"pnl_after_costs": 200, "bar_length": 3}, {"pnl_after_costs": -50, "bar_length": 2}],
    )
    assert metrics["metrics_schema_version"] == METRICS_SCHEMA_VERSION
    assert metrics["observation_basis"] == {"bar_periods_per_year": BAR_PERIODS_PER_YEAR_5M, "daily_periods_per_year": 252, "interval_minutes": 5}
    assert metrics["net_return"] == .02
    assert metrics["max_drawdown"] > 0
    assert metrics["drawdown_duration_bars"] == 1
    assert metrics["turnover"] > 0
    assert metrics["capacity_proxy_notional"] == 5000
    assert metrics["profit_factor"] == 4
    assert metrics["hit_rate"] == .5
    assert all(isinstance(item["value"], float) for item in metrics["drawdown_curve"])


def test_constant_no_trade_series_is_finite_and_conservative() -> None:
    curve = [{"t": "2026-01-02T14:30:00Z", "value": 100_000}, {"t": "2026-01-02T14:35:00Z", "value": 100_000}]
    metrics = compute_metrics(curve)
    for key in ("net_return", "annualized_return", "bar_sharpe", "bar_sortino", "daily_sharpe", "daily_sortino", "calmar", "profit_factor", "turnover", "hit_rate", "tail_loss"):
        assert metrics[key] == 0
    assert metrics["closed_trades"] == 0
    assert metrics["drawdown_curve"][-1]["value"] == 0


def test_symbol_concentration_and_stability_are_deterministic() -> None:
    curve = [{"t": "2026-01-02T14:30:00Z", "value": 100}, {"t": "2026-01-02T14:35:00Z", "value": 101}]
    metrics = compute_metrics(
        curve,
        fills=[{"symbol": "A", "value": 100}, {"symbol": "B", "value": 100}],
        per_symbol_equity={"B": curve, "A": curve},
    )
    assert metrics["symbol_concentration_hhi"] == .5
    assert list(metrics["per_symbol_stability"]) == ["A", "B"]


def test_artifact_hash_and_replay_metadata_are_order_stable() -> None:
    result = {"metrics": {"net_return": .01}, "windows": [{"id": "a"}]}
    first = build_artifact(result, input_hash="a" * 64, dataset_hash="b" * 64, dna_hashes=["z", "a"], compiler_hash="c" * 64, engine_version="1", configuration_hash="d" * 64, evaluation_windows=[{"id": "dev-1", "start": 0, "end": 100}])
    second = build_artifact({"windows": [{"id": "a"}], "metrics": {"net_return": .01}}, input_hash="a" * 64, dataset_hash="b" * 64, dna_hashes=["a", "z"], compiler_hash="c" * 64, engine_version="1", configuration_hash="d" * 64, evaluation_windows=[{"id": "dev-1", "start": 0, "end": 100}])
    assert first["artifact_schema_version"] == ARTIFACT_SCHEMA_VERSION
    assert first["artifact_hash"] == second["artifact_hash"]
    assert first["replay"]["command"].startswith("axiom-backtest replay --replay-id ")
    assert result_hash({**result, "result_hash": "ignored"}) == result_hash(result)
