import hashlib
import hmac
import json
import os
import time
from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

os.environ["AXIOM_BACKTEST_SECRET"] = "test-secret"
from app.dsl import legacy_strategy_to_dsl  # noqa: E402
from app.main import DSLStrategyDNA, ExecutionConfig, StrategyDNA, app, digest, run_window, strategy_signal  # noqa: E402

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


def signed(body, timestamp=None):
    raw = json.dumps(body, separators=(",", ":")).encode()
    timestamp = str(int(time.time()) if timestamp is None else timestamp)
    signature = hmac.new(b"test-secret", timestamp.encode() + b"." + body["job_id"].encode() + b"." + raw, hashlib.sha256).hexdigest()
    return raw, {"X-Axiom-Timestamp": timestamp, "X-Axiom-Job-Id": body["job_id"], "X-Axiom-Signature": signature, "Content-Type": "application/json"}


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
    raw, headers = signed(second)
    assert client.post("/v1/backtests/batch", content=raw, headers=headers).status_code == 409


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
