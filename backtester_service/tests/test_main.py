import hashlib
import hmac
import hashlib
import json
import math
import os
import time
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

os.environ["AXIOM_BACKTEST_SECRET"] = "test-secret"
from app.dsl import legacy_strategy_to_dsl  # noqa: E402
from app.main import DSLStrategyDNA, ExecutionConfig, StrategyDNA, app, digest, run_window, strategy_signal  # noqa: E402
from app.v2 import BacktestRequestV2, V2Window, digest as digest_v2, run_v2, simulate_v2  # noqa: E402

client = TestClient(app)


def bars(count=80):
    start = datetime(2025, 1, 1, tzinfo=timezone.utc)
    payload = []
    price = 100.0
    for index in range(count):
        price *= 1.001 if index % 9 else .99
        timestamp = (start + timedelta(days=index)).isoformat().replace("+00:00", "Z")
        payload.append({"t": timestamp, "o": price * .999, "h": price * 1.01, "l": price * .99, "c": price, "v": 1000})
    return payload


def payload():
    market = bars()
    params = {"fast": 3, "slow": 10, "threshold": 0.0001, "position_size": 0.5}
    dna = {"id": "AX-1", "asset": "SPY", "archetype": "Momentum", "params": params}
    return {
        "job_id": "job-1", "phase": "development", "strategies": [{**dna, "dna_hash": digest(dna)}],
        "dataset": {"snapshot_id": "snap-1", "symbol": "SPY", "timeframe": "1Day", "start": market[0]["t"], "end": market[-1]["t"], "bar_count": len(market), "sha256": digest(market)},
        "bars": market, "windows": [
            {"id": "dev-1", "start": 0, "end": 70},
            {"id": "dev-2", "start": 0, "end": 75},
            {"id": "dev-3", "start": 0, "end": len(market)},
        ],
    }


def bind_job_id(body):
    body["job_id"] = digest({key: value for key, value in body.items() if key != "job_id"})
    return body


def signed(body, timestamp=None, *, rebind=True, secret="test-secret", key_id="current"):
    if rebind:
        bind_job_id(body)
    raw = json.dumps(body, separators=(",", ":")).encode()
    timestamp = str(int(time.time()) if timestamp is None else timestamp)
    signature = hmac.new(secret.encode(), timestamp.encode() + b"." + body["job_id"].encode() + b"." + raw, hashlib.sha256).hexdigest()
    return raw, {"X-Axiom-Timestamp": timestamp, "X-Axiom-Job-Id": body["job_id"], "X-Axiom-Key-Id": key_id,
                 "X-Axiom-Signature": signature, "Content-Type": "application/json"}


def test_health():
    assert client.get("/healthz").json()["status"] == "ok"


def test_signal_rules_support_short():
    assert strategy_signal("Momentum", {"fast": 2, "slow": 3, "threshold": .001, "position_size": .5}, [5, 4, 3]) == -1
    assert strategy_signal("Mean reversion", {"lookback": 3, "entry_z": 0.5, "exit_z": .35, "position_size": .5}, [1, 1, 2]) == -1
    assert strategy_signal("Breakout", {"lookback": 2, "buffer": 0, "position_size": .5}, [1, 2, 3]) == 1
    assert strategy_signal("Volatility filter", {"lookback": 3, "vol_ceiling": 1, "threshold": .001, "position_size": .5}, [100, 101, 102, 103]) == 1


def test_orders_fill_at_the_following_bar_open():
    market = bars(90)
    for index, bar in enumerate(market):
        close = 100 + index
        bar.update({"o": close, "h": close * 1.02, "l": close * .98, "c": close})
    dna_value = {"id": "AX-NEXT", "asset": "SPY", "archetype": "Momentum",
                 "params": {"fast": 3, "slow": 10, "threshold": .0001, "position_size": .5}}
    dna = StrategyDNA(**dna_value, dna_hash=digest(dna_value))
    result = run_window(dna, market, ExecutionConfig())
    assert result["orders"] and result["fills"]
    first_order = result["orders"][0]
    first_fill = result["fills"][0]
    signal_index = next(index for index, bar in enumerate(market) if bar["t"] == first_order["signal_time"])
    assert first_fill["t"] == market[signal_index + 1]["t"]
    assert first_fill["price"] >= market[signal_index + 1]["o"]


def test_small_dsl_targets_use_fractional_backtest_shares() -> None:
    start = datetime(2026, 8, 3, 13, 30, tzinfo=timezone.utc)
    market = []
    for index in range(70):
        close = 100 + index
        market.append({"t": (start + timedelta(minutes=5 * index)).isoformat().replace("+00:00", "Z"),
                       "o": close, "h": close + 1, "l": close - 1, "c": close, "v": 1000,
                       "interval_minutes": 5, "data_health": "healthy", "data_coverage": 1})
    frozen = legacy_strategy_to_dsl({"id": "fractional", "asset": "SPY", "archetype": "Momentum",
                                     "params": {"fast": 2, "slow": 4, "threshold": .0001, "position_size": .05}})
    envelope = DSLStrategyDNA(strategy_format="dsl-v1", id="AX-FRACTIONAL", asset="SPY",
                              dna=frozen, dna_hash=frozen["dna_hash"])
    result = run_window(envelope, market, ExecutionConfig())
    assert result["fills"]
    assert 0 < abs(result["fills"][0]["size"]) < 1


def test_signed_batch_is_deterministic_and_has_artifacts():
    body = payload()
    raw, headers = signed(body)
    response = client.post("/v1/backtests/batch", content=raw, headers=headers)
    assert response.status_code == 200, response.text
    result = response.json()
    window = result["results"][0]["windows"][0]
    assert result["engine"]["name"] == "backtrader"
    assert result["result_hash"]
    assert window["equity_curve"] and "metrics" in window and "orders" in window
    raw, headers = signed(body)
    second = client.post("/v1/backtests/batch", content=raw, headers=headers)
    assert second.json()["result_hash"] == result["result_hash"]


def test_rejects_bad_hash_and_auth():
    body = payload()
    body["dataset"]["sha256"] = "0" * 64
    raw, headers = signed(body)
    assert client.post("/v1/backtests/batch", content=raw, headers=headers).status_code == 422
    body = payload()
    raw, headers = signed(body)
    headers["X-Axiom-Signature"] = "0" * 64
    assert client.post("/v1/backtests/batch", content=raw, headers=headers).status_code == 401


def test_hmac_rotation_accepts_previous_key_and_rejects_unknown_key(monkeypatch):
    monkeypatch.setenv("AXIOM_BACKTEST_KEY_ID", "2026-08")
    monkeypatch.setenv("AXIOM_BACKTEST_PREVIOUS_KEY_ID", "2026-07")
    monkeypatch.setenv("AXIOM_BACKTEST_PREVIOUS_SECRET", "previous-test-secret")
    body = payload()
    raw, headers = signed(body, secret="previous-test-secret", key_id="2026-07")
    assert client.post("/v1/backtests/batch", content=raw, headers=headers).status_code == 200
    other = payload()
    raw, headers = signed(other, key_id="unknown")
    assert client.post("/v1/backtests/batch", content=raw, headers=headers).status_code == 401


def test_rejects_expired_signatures_unknown_dna_and_non_monotonic_bars():
    body = payload()
    body["job_id"] = "job-expired"
    raw, headers = signed(body, int(time.time()) - 301)
    assert client.post("/v1/backtests/batch", content=raw, headers=headers).status_code == 401

    body = payload()
    body["job_id"] = "job-unknown"
    body["strategies"][0]["archetype"] = "Future leak"
    frozen = {key: body["strategies"][0][key] for key in ("id", "asset", "archetype", "params")}
    body["strategies"][0]["dna_hash"] = digest(frozen)
    raw, headers = signed(body)
    assert client.post("/v1/backtests/batch", content=raw, headers=headers).status_code == 422

    body = payload()
    body["job_id"] = "job-unsorted"
    body["bars"][60], body["bars"][61] = body["bars"][61], body["bars"][60]
    body["dataset"]["sha256"] = digest(body["bars"])
    raw, headers = signed(body)
    assert client.post("/v1/backtests/batch", content=raw, headers=headers).status_code == 422


def test_holdout_must_cover_the_entire_submitted_slice():
    body = payload()
    body["job_id"] = "job-holdout-partial"
    body["phase"] = "holdout"
    body["windows"] = [{"id": "holdout", "start": 1, "end": len(body["bars"])}]
    raw, headers = signed(body)
    assert client.post("/v1/backtests/batch", content=raw, headers=headers).status_code == 422

    body["job_id"] = "job-holdout-complete"
    body["windows"] = [{"id": "holdout", "start": 0, "end": len(body["bars"])}]
    raw, headers = signed(body)
    response = client.post("/v1/backtests/batch", content=raw, headers=headers)
    assert response.status_code == 200, response.text


def test_rejects_duplicate_job_with_different_payload():
    first = payload()
    raw, headers = signed(first)
    assert client.post("/v1/backtests/batch", content=raw, headers=headers).status_code == 200
    second = payload()
    second["strategies"][0]["params"]["threshold"] = .0002
    dna = {key: second["strategies"][0][key] for key in ("id", "asset", "archetype", "params")}
    second["strategies"][0]["dna_hash"] = digest(dna)
    second["job_id"] = first["job_id"]
    raw, headers = signed(second, rebind=False)
    assert client.post("/v1/backtests/batch", content=raw, headers=headers).status_code == 409


def test_job_identity_is_statelessly_bound_to_the_complete_payload():
    body = payload()
    bind_job_id(body)
    original = body["job_id"]
    body["windows"][0]["end"] -= 1
    raw, headers = signed(body, rebind=False)
    response = client.post("/v1/backtests/batch", content=raw, headers=headers)
    assert response.status_code == 409
    assert body["job_id"] == original


def test_twelve_strategy_batch_completes_within_normal_target():
    body = payload()
    template = body["strategies"][0]
    body["job_id"] = "job-twelve"
    body["strategies"] = []
    for index in range(12):
        dna = {**template, "id": f"AX-{index + 1}"}
        frozen = {key: dna[key] for key in ("id", "asset", "archetype", "params")}
        dna["dna_hash"] = digest(frozen)
        body["strategies"].append(dna)
    raw, headers = signed(body)
    started = time.monotonic()
    response = client.post("/v1/backtests/batch", content=raw, headers=headers)
    assert response.status_code == 200, response.text
    assert time.monotonic() - started < 30
    assert len(response.json()["results"]) == 12


def v2_market(symbol: str, count: int = 70, volume: float = 1000):
    start = datetime(2026, 8, 3, 13, 30, tzinfo=timezone.utc)
    result = []
    for index in range(count):
        price = 100 + index * .2
        result.append({"t": (start + timedelta(minutes=index * 5)).isoformat().replace("+00:00", "Z"),
                       "o": price, "h": price + 1, "l": price - 1, "c": price + .1, "v": volume,
                       "interval_minutes": 5, "data_health": "healthy", "data_coverage": 1})
    return result


def v2_payload(symbols=("SPY", "QQQ")):
    markets = {symbol: v2_market(symbol) for symbol in symbols}
    frozen = legacy_strategy_to_dsl({"id": "v2", "asset": symbols[0], "archetype": "Momentum",
                                     "params": {"fast": 2, "slow": 4, "threshold": .0001, "position_size": 1}}, symbols=list(symbols))
    snapshot = {symbol: markets[symbol] for symbol in sorted(markets)}
    manifests = [{"symbol": symbol, "start": rows[0]["t"], "end": rows[-1]["t"], "bar_count": len(rows), "sha256": digest_v2(rows)} for symbol, rows in sorted(markets.items())]
    end = (datetime.fromisoformat(markets[symbols[0]][-1]["t"].replace("Z", "+00:00")) + timedelta(minutes=5)).isoformat().replace("+00:00", "Z")
    return {"schema_version": "backtest-request-v2", "job_id": "v2-job", "phase": "holdout",
            "strategies": [{"strategy_format": "dsl-v1", "id": "v2-dsl", "dna": frozen, "dna_hash": frozen["dna_hash"]}],
            "dataset": {"schema_version": 2, "snapshot_id": "v2-snap", "timeframe": "5Min", "feed": "iex", "adjustment": "all", "session": "regular", "universe_id": frozen["scope"]["universe_id"], "universe_sha256": frozen["scope"]["universe_sha256"], "calendar_id": "nyse-v1", "calendar_sha256": "2" * 64, "symbols": manifests, "sha256": digest_v2(snapshot)},
            "bars_by_symbol": snapshot, "windows": [{"id": "sealed", "start": markets[symbols[0]][0]["t"], "end": end}],
            "execution": {"version": "execution-v2", "initial_cash": 100000, "strategy_gross_limit": .005,
                          "fill": "next_tradable_bar_open", "allow_short": True, "no_overnight": True,
                          "annualization": {"bar": 19656, "daily": 252, "risk_free_rate": 0},
                          "warmup": {"mode": "dsl_derived", "safety_bars": 8},
                          "costs": {"commission_bps": 0, "base_slippage_bps": 5, "range_slippage_bps": 2,
                                    "participation_slippage_bps": 8},
                          "participation": {"max_bar_volume_fraction": .10, "fill_policy": "partial_or_reject"},
                          "stress": {"enabled": True, "slippage_multiplier": 2, "delayed_bars": 1,
                                     "missed_fill_probability": .05, "force_session_flatten": True},
                          "session": {"timezone": "America/New_York", "regular_hours_only": True,
                                      "missing_data_blocks_entries": True}}}


def test_v2_multi_symbol_is_deterministic_has_ideal_and_stress_artifacts():
    body = v2_payload()
    raw, headers = signed(body)
    response = client.post("/v1/backtests/batch", content=raw, headers=headers)
    assert response.status_code == 200, response.text
    result = response.json()
    window = result["results"][0]["windows"][0]
    assert result["schema_version"] == "backtest-artifact-v2"
    assert result["artifact_schema_version"] == "backtest-artifact-v2"
    assert result["engine"]["configuration_hash"] == digest_v2(body["execution"])
    assert result["input_hash"] == digest_v2(body)
    assert result["replay"]["metrics_schema_version"] == "intraday-metrics-v2"
    assert window["approved_artifact"] == "stress"
    assert window["ideal"]["portfolio_curve"] and "stress" in window
    assert "daily_sharpe" in window["metrics"]
    assert window["metrics"]["observation_basis"]["bar_periods_per_year"] == 252 * 78
    assert max(point["exposure"] for point in window["ideal"]["portfolio_curve"]) <= .0050001
    raw, headers = signed(body)
    assert client.post("/v1/backtests/batch", content=raw, headers=headers).json()["result_hash"] == result["result_hash"]


def test_v2_partial_fill_and_no_trade_metrics_are_finite():
    body = v2_payload(("SPY",))
    body["bars_by_symbol"]["SPY"] = v2_market("SPY", volume=.001)
    body["dataset"]["symbols"][0]["sha256"] = digest_v2(body["bars_by_symbol"]["SPY"])
    body["dataset"]["sha256"] = digest_v2({"SPY": body["bars_by_symbol"]["SPY"]})
    request = BacktestRequestV2.model_validate(body)
    run = simulate_v2(request.strategies[0].dna, {"SPY": [x.model_dump(exclude_none=True) for x in request.bars_by_symbol["SPY"]]}, request.windows[0], request.execution)
    assert all(math.isfinite(float(value)) for value in run["metrics"].values() if isinstance(value, (int, float)))
    assert run["rejected_fills"]


def test_v2_rejects_extended_hours_bars():
    body = v2_payload(("SPY",))
    body["bars_by_symbol"]["SPY"][0]["t"] = "2026-08-03T12:00:00Z"
    body["dataset"]["symbols"][0]["start"] = body["bars_by_symbol"]["SPY"][0]["t"]
    body["dataset"]["symbols"][0]["sha256"] = digest_v2(body["bars_by_symbol"]["SPY"])
    body["dataset"]["sha256"] = digest_v2({"SPY": body["bars_by_symbol"]["SPY"]})
    with pytest.raises(Exception, match="regular-session"):
        BacktestRequestV2.model_validate(body)


def test_v2_next_open_reversal_and_forced_eod_flatten_are_explicit():
    body = v2_payload(("SPY",))
    market = body["bars_by_symbol"]["SPY"]
    for index, row in enumerate(market):
        # A trend reversal forces a long-to-short target change after warmup.
        price = 100 + index if index < 35 else 170 - index
        row.update({"o": price, "h": price + 1, "l": price - 1, "c": price})
    body["dataset"]["symbols"][0]["sha256"] = digest_v2(market)
    body["dataset"]["sha256"] = digest_v2({"SPY": market})
    request = BacktestRequestV2.model_validate(body)
    run = simulate_v2(request.strategies[0].dna, {"SPY": [x.model_dump(exclude_none=True) for x in request.bars_by_symbol["SPY"]]}, request.windows[0], request.execution)
    assert run["fills"]
    first_signal = run["targets"][0]["t"]
    first_fill = run["fills"][0]["t"]
    assert first_fill > first_signal
    assert run["session_flatten_events"]
    assert run["execution_adapter"] == "backtrader-broker-authoritative-v2"
    assert all(order["order_id"].startswith("bt-order-") for order in run["orders"])
    assert all(order["status"] != "submitted" for order in run["orders"])
    assert all(fill["order_id"].startswith("bt-order-") for fill in run["fills"])
    fill_times = {fill["t"] for fill in run["fills"]}
    assert all(event["t"] in fill_times for event in run["session_flatten_events"])
    forced_targets = [item for item in run["targets"] if item["reason"] == "sealed_session_forced_close"]
    assert forced_targets
    assert all(item["execute_at"] == "next_eligible_bar_open" for item in forced_targets)
    assert all(event["t"] > forced_targets[0]["t"] for event in run["session_flatten_events"])
    assert all(abs(size) < 1e-10 for size in run["broker"]["positions"].values())
    assert run["broker"]["value"] == run["portfolio_curve"][-1]["value"]


def test_v2_never_calls_the_deprecated_post_cerebro_simulator(monkeypatch):
    import app.v2 as module
    body = v2_payload(("SPY",))
    request = BacktestRequestV2.model_validate(body)
    monkeypatch.setattr(module, "_simulate_v2_ledger", lambda *args, **kwargs: (_ for _ in ()).throw(
        AssertionError("post-Cerebro simulator was invoked")))
    run = simulate_v2(request.strategies[0].dna,
        {"SPY": [row.model_dump(exclude_none=True) for row in request.bars_by_symbol["SPY"]]},
        request.windows[0], request.execution)
    assert run["execution_adapter"] == "backtrader-broker-authoritative-v2"


def test_v2_flat_strategy_has_finite_no_trade_artifact():
    body = v2_payload(("SPY",))
    dna = body["strategies"][0]["dna"]
    # Re-freeze a migrated strategy with a threshold too high to trade.
    frozen = legacy_strategy_to_dsl({"id": "flat", "asset": "SPY", "archetype": "Momentum",
                                     "params": {"fast": 2, "slow": 4, "threshold": 10, "position_size": 1}}, symbols=["SPY"])
    body["strategies"][0].update({"dna": frozen, "dna_hash": frozen["dna_hash"]})
    request = BacktestRequestV2.model_validate(body)
    run = simulate_v2(request.strategies[0].dna, {"SPY": [x.model_dump(exclude_none=True) for x in request.bars_by_symbol["SPY"]]}, request.windows[0], request.execution)
    assert not run["closed_trades"]
    assert all(math.isfinite(float(value)) for value in run["metrics"].values() if isinstance(value, (int, float)))


def v2_development_payload():
    body = v2_payload()
    market = body["bars_by_symbol"]["SPY"]
    body["phase"] = "development"
    body["windows"] = [
        {"id": "anchored-1", "start": market[0]["t"], "end": market[35]["t"]},
        {"id": "anchored-2", "start": market[0]["t"], "end": market[52]["t"]},
        {"id": "anchored-3", "start": market[0]["t"], "end": (datetime.fromisoformat(market[-1]["t"].replace("Z", "+00:00")) + timedelta(minutes=5)).isoformat().replace("+00:00", "Z")},
        {"id": "rolling-1", "start": market[20]["t"], "end": market[55]["t"]},
        {"id": "rolling-2", "start": market[15]["t"], "end": market[65]["t"]},
        {"id": "rolling-3", "start": market[10]["t"], "end": (datetime.fromisoformat(market[-1]["t"].replace("Z", "+00:00")) + timedelta(minutes=5)).isoformat().replace("+00:00", "Z")},
    ]
    return body


def test_v2_development_folds_are_purged_reset_and_deterministic():
    request = BacktestRequestV2.model_validate(v2_development_payload())
    engine = {"version": "test", "configuration_hash": digest_v2(request.execution.model_dump(mode="json")), "image_digest": "test"}
    first = run_v2(request, engine=engine)
    second = run_v2(request, engine=engine)
    assert first["result_hash"] == second["result_hash"]
    windows = first["results"][0]["windows"]
    assert all(item["fold_manifest"]["purge_bars"] == item["fold_manifest"]["warmup_bars"] for item in windows)
    assert all(item["fold_manifest"]["state_reset"]["portfolio"] for item in windows)
    final_effective = V2Window(**windows[-1]["fold_manifest"]["effective"])
    isolated = simulate_v2(request.strategies[0].dna,
        {symbol: [row.model_dump(exclude_none=True) for row in rows] for symbol, rows in request.bars_by_symbol.items()},
        final_effective, request.execution)
    assert isolated["equity_curve"] == windows[-1]["ideal"]["equity_curve"]
    evidence = windows[-1]["development_evidence"]
    assert evidence["protocol"]["candidate_dna_mutated"] is False
    assert evidence["moderate_gap_stress"]["gap_schedule"]
    assert evidence["permuted_return_null"]["seed_hash"]
    assert evidence["parameter_perturbations"]
    assert all(item["original_dna_hash"] == request.strategies[0].dna_hash for item in evidence["parameter_perturbations"])
    assert all(item["variant_dna_hash"] != request.strategies[0].dna_hash for item in evidence["parameter_perturbations"])
    assert evidence["hash"]


def test_v2_rejects_development_window_too_short_for_purge_and_embargo():
    body = v2_development_payload()
    body["windows"][0]["end"] = body["bars_by_symbol"]["SPY"][10]["t"]
    with pytest.raises(ValueError, match="too short"):
        BacktestRequestV2.model_validate(body)


def test_v2_holdout_has_no_adaptive_perturbation_and_flat_evidence_is_finite():
    body = v2_payload(("SPY",))
    frozen = legacy_strategy_to_dsl({"id": "flat-holdout", "asset": "SPY", "archetype": "Momentum",
                                     "params": {"fast": 2, "slow": 4, "threshold": 10, "position_size": 1}}, symbols=["SPY"])
    body["strategies"][0].update({"dna": frozen, "dna_hash": frozen["dna_hash"]})
    request = BacktestRequestV2.model_validate(body)
    engine = {"version": "test", "configuration_hash": digest_v2(request.execution.model_dump(mode="json")), "image_digest": "test"}
    result = run_v2(request, engine=engine)
    window = result["results"][0]["windows"][0]
    assert window["holdout_evidence"]["adaptive_robustness"] is False
    assert "parameter_perturbations" not in window["holdout_evidence"]
    assert math.isfinite(window["holdout_evidence"]["base"]["metrics"]["net_return"])
