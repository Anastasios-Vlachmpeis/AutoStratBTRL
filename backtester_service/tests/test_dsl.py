from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path

import pytest

from app.dsl import (
    canonical_json,
    build_strategy_dna,
    digest,
    evaluate_strategy_targets,
    evaluate_vector_targets,
    explain_strategy_dna,
    legacy_strategy_to_dsl,
    validate_strategy_dna,
)


def test_shared_golden_fixture_matches_javascript_identity_and_targets() -> None:
    fixture_path = Path(__file__).resolve().parents[2] / "strategy_dsl" / "fixtures" / "golden-v1.json"
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    dna = build_strategy_dna(fixture["document"])
    assert dna["dna_hash"] == fixture["expected_dna_hash"]
    assert [item["target"] for item in evaluate_strategy_targets(dna, fixture["bars"])] == fixture["expected_targets"]


def test_every_operation_matches_the_shared_javascript_feature_fixture() -> None:
    fixture_path = Path(__file__).resolve().parents[2] / "strategy_dsl" / "fixtures" / "operations-v1.json"
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    dna = build_strategy_dna(fixture["document"])
    assert dna["dna_hash"] == fixture["expected_dna_hash"]
    last = evaluate_strategy_targets(dna, fixture["bars"])[-1]["features"]
    for key, expected in fixture["expected_last_features"].items():
        if isinstance(expected, bool):
            assert last[key] is expected
        else:
            assert last[key] == pytest.approx(expected, rel=1e-12, abs=1e-12)


def bars(count: int = 16) -> list[dict]:
    start = datetime(2026, 8, 3, 13, 30, tzinfo=timezone.utc)
    return [{"t": (start + timedelta(minutes=5 * index)).isoformat().replace("+00:00", "Z"), "o": 100 + index, "h": 101 + index, "l": 99 + index, "c": 100 + index, "v": 1000 + index} for index in range(count)]


def momentum() -> dict:
    return legacy_strategy_to_dsl({"id": "legacy-momentum", "asset": "SPY", "archetype": "Momentum", "params": {"fast": 2, "slow": 4, "threshold": 0.001, "position_size": 1}})


def test_canonical_json_normalises_integral_float_and_rejects_nonfinite() -> None:
    assert canonical_json({"b": 1.0, "a": -0.0}) == b'{"a":0,"b":1}'
    assert digest({"value": 1}) == digest({"value": 1.0})
    numeric_boundary = {"tiny": 1e-7, "micro": 1e-6, "large": 1e20, "huge": 1e21}
    assert canonical_json(numeric_boundary) == b'{"huge":1e+21,"large":100000000000000000000,"micro":0.000001,"tiny":1e-7}'
    assert digest(numeric_boundary) == "1d8e1d426a4b7de0a1b6e93916a94391dcdbf142bd68d993ceaddbe54d2d887e"
    with pytest.raises(ValueError): canonical_json({"bad": float("nan")})


def test_legacy_adapters_build_all_archetypes() -> None:
    cases = [
        ("Momentum", {"fast": 2, "slow": 4, "threshold": .01, "position_size": 1}),
        ("Mean reversion", {"lookback": 4, "entry_z": 1, "exit_z": .5, "position_size": 1}),
        ("Breakout", {"lookback": 4, "buffer": .01, "position_size": 1}),
        ("Volatility filter", {"lookback": 4, "vol_ceiling": 1, "threshold": .01, "position_size": 1}),
    ]
    for archetype, params in cases:
        dna = legacy_strategy_to_dsl({"id": archetype, "asset": "SPY", "archetype": archetype, "params": params})
        assert validate_strategy_dna(dna).strategy_id.startswith("DSL1-")


def test_reference_and_vector_targets_are_identical() -> None:
    dna = momentum()
    reference = evaluate_strategy_targets(dna, bars())
    vector = evaluate_vector_targets(dna, bars())
    assert reference == vector
    assert all(item["execute_at"] == "next_bar_open" for item in reference)
    assert reference[-1]["target"] > 0


def test_invalid_hash_and_lookahead_are_rejected() -> None:
    dna = momentum()
    dna["features"][1]["inputs"] = ["slow"]  # forward graph reference
    dna["dna_hash"] = digest({key: value for key, value in dna.items() if key not in {"strategy_id", "dna_hash"}})
    with pytest.raises(ValueError, match="causal"):
        validate_strategy_dna(dna)
    dna = momentum()
    dna["features"][1]["params"]["window"] = 999
    dna["dna_hash"] = digest({key: value for key, value in dna.items() if key not in {"strategy_id", "dna_hash"}})
    with pytest.raises(ValueError):
        validate_strategy_dna(dna)
    dna = momentum()
    dna["dna_hash"] = "0" * 64
    with pytest.raises(ValueError, match="dna_hash"):
        validate_strategy_dna(dna)


def test_session_close_missing_data_and_reversal_semantics() -> None:
    dna = momentum()
    data = bars(8)
    data[-1]["t"] = "2026-08-03T19:51:00Z"  # bar ends 15:56 NY, flatten
    assert evaluate_strategy_targets(dna, data)[-1]["reason"] == "session_flatten"
    unhealthy = bars(8); unhealthy[-1]["data_coverage"] = .5
    assert evaluate_strategy_targets(dna, unhealthy)[-1]["reason"] == "unhealthy_data"
    # Conflicting long/short is always a flat decision even when reverse is enabled.
    conflict = deepcopy(dna)
    conflict["entry"]["short"] = conflict["entry"]["long"]
    # Freeze the changed document correctly by using the public builder through adapter shape.
    from app.dsl import build_strategy_dna
    conflict.pop("dna_hash")
    conflict["dna_hash"] = digest({key: value for key, value in conflict.items() if key not in {"strategy_id", "dna_hash"}})
    conflict = build_strategy_dna(conflict)
    assert evaluate_strategy_targets(conflict, bars(8))[-1]["reason"] == "conflicting_entries"


def test_explanation_is_public_graph_only_and_hash_is_deterministic() -> None:
    dna = momentum()
    explanation = explain_strategy_dna(dna)
    assert explanation["graph"]["nodes"]
    assert explanation["dna_hash"] == dna["dna_hash"]
    assert legacy_strategy_to_dsl({"id": "legacy-momentum", "asset": "SPY", "archetype": "Momentum", "params": {"fast": 2, "slow": 4, "threshold": .001, "position_size": 1}})["dna_hash"] == dna["dna_hash"]
