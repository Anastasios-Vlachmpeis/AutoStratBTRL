"""Axiom Strategy DSL v1 reference compiler.

This module deliberately contains no I/O.  It is the deterministic, causal
implementation shared by research, replay and the Backtrader adapter.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, time, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any, Literal
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ConfigDict, Field, ValidationError

DSL_VERSION = "1.0.0"
SEMANTIC_VERSION = "1.0.0"
ET = ZoneInfo("America/New_York")
NUMERIC = "numeric"
BOOLEAN = "boolean"


def _normalise(value: Any) -> Any:
    """Match JSON.stringify's useful numeric behaviour, rejecting unsafe JSON."""
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("non-finite numbers are not valid canonical JSON")
        if value == 0:
            return 0
        if value.is_integer():
            return int(value)
        return value
    if isinstance(value, dict):
        return {str(key): _normalise(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_normalise(item) for item in value]
    return value


def _ecmascript_number(value: int | float) -> str:
    """Serialize finite JSON numbers using JSON.stringify's exponent thresholds."""
    if isinstance(value, bool):
        raise ValueError("booleans are not JSON numbers")
    if isinstance(value, int):
        return str(value)
    if not math.isfinite(value):
        raise ValueError("non-finite numbers are not valid canonical JSON")
    if value == 0:
        return "0"
    text = repr(value).lower()
    magnitude = abs(value)
    if "e" in text:
        coefficient, exponent_text = text.split("e", 1)
        exponent = int(exponent_text)
        if 1e-6 <= magnitude < 1e21:
            fixed = format(Decimal(text), "f")
            return fixed.rstrip("0").rstrip(".") if "." in fixed else fixed
        coefficient = coefficient.rstrip("0").rstrip(".")
        return f"{coefficient}e{'+' if exponent >= 0 else ''}{exponent}"
    return text[:-2] if text.endswith(".0") else text


def _canonical_text(value: Any) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return _ecmascript_number(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(_canonical_text(item) for item in value) + "]"
    if isinstance(value, dict):
        if not all(isinstance(key, str) for key in value):
            raise ValueError("canonical JSON object keys must be strings")
        return "{" + ",".join(
            f"{json.dumps(key, ensure_ascii=False)}:{_canonical_text(value[key])}"
            for key in sorted(value)
        ) + "}"
    raise ValueError(f"unsupported canonical JSON value: {type(value).__name__}")


def canonical_json(value: Any) -> bytes:
    return _canonical_text(value).encode("utf-8")


def digest(value: Any) -> str:
    return hashlib.sha256(canonical_json(value)).hexdigest()


def _dsl_root() -> Path:
    here = Path(__file__).resolve()
    for candidate in (here.parents[1] / "strategy_dsl", here.parents[2] / "strategy_dsl"):
        if candidate.is_dir():
            return candidate
    raise RuntimeError("strategy_dsl directory is not available in this compiler image")


def load_compiler_contract() -> dict[str, Any]:
    root = _dsl_root()
    manifest = json.loads((root / "compiler-manifest.json").read_text(encoding="utf-8"))
    schema_path = root / manifest["schema_file"]
    schema_bytes = schema_path.read_bytes()
    # The contract hash is semantic canonical JSON rather than raw bytes so a
    # harmless checkout line-ending change cannot alter a compiler identity.
    actual = hashlib.sha256(canonical_json(json.loads(schema_bytes))).hexdigest()
    if actual != manifest["schema_sha256"]:
        raise RuntimeError("strategy DSL schema SHA-256 does not match compiler manifest")
    if manifest["dsl_version"] != DSL_VERSION or manifest["semantic_version"] != SEMANTIC_VERSION:
        raise RuntimeError("strategy DSL/compiler version mismatch")
    semantic = hashlib.sha256(canonical_json(manifest["semantic_contract"])).hexdigest()
    if semantic != manifest["semantic_sha256"]:
        raise RuntimeError("strategy DSL semantic SHA-256 does not match compiler manifest")
    return {"manifest": manifest, "schema": json.loads(schema_bytes)}


CONTRACT = load_compiler_contract()
MANIFEST = CONTRACT["manifest"]


class Node(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    id: str = Field(pattern=r"^[a-z][a-z0-9_]{0,47}$")
    op: str
    inputs: list[str] = Field(default_factory=list, max_length=4)
    params: dict[str, float | int] = Field(default_factory=dict)


class StrategyDNA(BaseModel):
    """Strict structural model; semantic graph checks are performed below."""
    model_config = ConfigDict(extra="forbid", strict=True)
    dsl_version: Literal["1.0.0"]
    strategy_id: str = Field(pattern=r"^DSL1-[a-f0-9]{24}$")
    dna_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    compiler: dict[str, str]
    lineage: dict[str, Any]
    scope: dict[str, Any]
    features: list[Node] = Field(min_length=1, max_length=64)
    entry: dict[str, str | None]
    exit: dict[str, str | None]
    cooldown: dict[str, int]
    target: dict[str, Any]
    session: dict[str, Any]
    risk: dict[str, Any]
    warmup_bars: int = Field(ge=0, le=252)


PRICE_OPS = {"open", "high", "low", "close", "volume", "vwap_proxy", "constant", "minutes_since_open", "minutes_until_close"}
UNARY_NUMERIC = {"absolute", "negate", "safe_log", "is_finite", "is_missing"}
BINARY_NUMERIC = {"add", "subtract", "multiply", "safe_divide", "greater_than", "greater_equal", "less_than", "less_equal", "equal"}
BOOLEAN_OPS = {"and", "or", "not"}
WINDOW_OPS = {
    "simple_return", "log_return", "gap_return", "sma", "ema", "price_average_distance",
    "moving_average_difference", "slope", "zscore", "bollinger_distance", "rolling_high_distance",
    "rolling_low_distance", "rate_of_change", "true_range", "atr", "realized_volatility",
    "bar_range_percentile", "relative_volume",
}
ALL_OPS = PRICE_OPS | UNARY_NUMERIC | BINARY_NUMERIC | BOOLEAN_OPS | WINDOW_OPS


@dataclass(frozen=True)
class Operation:
    output: str
    arity: tuple[int, ...]
    window: bool = False
    required_params: tuple[str, ...] = ()


OPS: dict[str, Operation] = {
    **{op: Operation(NUMERIC, (0,)) for op in PRICE_OPS},
    "simple_return": Operation(NUMERIC, (1,), True), "log_return": Operation(NUMERIC, (1,), True),
    "gap_return": Operation(NUMERIC, (0,)), "sma": Operation(NUMERIC, (1,), True, ("window",)),
    "ema": Operation(NUMERIC, (1,), True, ("window",)), "price_average_distance": Operation(NUMERIC, (2,)),
    "moving_average_difference": Operation(NUMERIC, (2,)), "slope": Operation(NUMERIC, (1,), True, ("window",)),
    "zscore": Operation(NUMERIC, (1,), True, ("window",)), "bollinger_distance": Operation(NUMERIC, (1,), True, ("window",)),
    "rolling_high_distance": Operation(NUMERIC, (1,), True, ("window",)), "rolling_low_distance": Operation(NUMERIC, (1,), True, ("window",)),
    "rate_of_change": Operation(NUMERIC, (1,)), "true_range": Operation(NUMERIC, (0,)),
    "atr": Operation(NUMERIC, (1,), True, ("window",)), "realized_volatility": Operation(NUMERIC, (1,), True, ("window",)),
    "bar_range_percentile": Operation(NUMERIC, (1,), True, ("window",)), "relative_volume": Operation(NUMERIC, (1,), True, ("window",)),
    "absolute": Operation(NUMERIC, (1,)), "negate": Operation(NUMERIC, (1,)), "safe_log": Operation(NUMERIC, (1,)),
    "is_finite": Operation(BOOLEAN, (1,)), "is_missing": Operation(BOOLEAN, (1,)),
    "add": Operation(NUMERIC, (2,)), "subtract": Operation(NUMERIC, (2,)), "multiply": Operation(NUMERIC, (2,)), "safe_divide": Operation(NUMERIC, (2,)),
    "greater_than": Operation(BOOLEAN, (2,)), "greater_equal": Operation(BOOLEAN, (2,)), "less_than": Operation(BOOLEAN, (2,)), "less_equal": Operation(BOOLEAN, (2,)), "equal": Operation(BOOLEAN, (2,)),
    "and": Operation(BOOLEAN, (2,)), "or": Operation(BOOLEAN, (2,)), "not": Operation(BOOLEAN, (1,)),
}

SCHEMA_OPERATIONS = set(CONTRACT["schema"]["$defs"]["node"]["properties"]["op"]["enum"])
if SCHEMA_OPERATIONS != set(OPS):
    raise RuntimeError("strategy DSL schema and Python compiler operations differ")


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def _int_param(node: Node, name: str) -> int:
    value = node.params.get(name)
    _require(isinstance(value, int) and not isinstance(value, bool), f"{node.id}: {name} must be an integer")
    return value


def _semantic_document(dna: dict[str, Any]) -> dict[str, Any]:
    result = deepcopy(dna)
    result.pop("strategy_id", None)
    result.pop("dna_hash", None)
    return result


def _validate_top_level(dna: StrategyDNA, raw: dict[str, Any]) -> None:
    _require(dna.compiler == {"semantic_version": SEMANTIC_VERSION, "schema_sha256": MANIFEST["schema_sha256"], "semantic_sha256": MANIFEST["semantic_sha256"]}, "compiler identity does not match checked-in contract")
    _require(set(dna.lineage) == {"trial_id", "generation", "parent_strategy_id", "creation_seed"}, "invalid lineage fields")
    safe_identity = re.compile(r"^[A-Za-z0-9._:-]{1,120}$")
    _require(isinstance(dna.lineage["trial_id"], str) and safe_identity.fullmatch(dna.lineage["trial_id"]) is not None, "invalid lineage trial_id")
    _require(isinstance(dna.lineage["generation"], int) and 1 <= dna.lineage["generation"] <= 1000, "invalid generation")
    _require(dna.lineage["parent_strategy_id"] is None or (isinstance(dna.lineage["parent_strategy_id"], str) and safe_identity.fullmatch(dna.lineage["parent_strategy_id"]) is not None), "invalid parent_strategy_id")
    _require(isinstance(dna.lineage["creation_seed"], int) and 0 <= dna.lineage["creation_seed"] <= 4294967295, "invalid creation_seed")
    scope = dna.scope
    _require(set(scope) == {"mode", "universe_id", "universe_sha256", "symbols", "minimum_dollar_volume", "allow_long", "allow_short"}, "invalid scope fields")
    _require(scope["mode"] == "time_series" and isinstance(scope["universe_id"], str) and safe_identity.fullmatch(scope["universe_id"]) is not None, "invalid strategy scope")
    _require(isinstance(scope["universe_sha256"], str) and re.fullmatch(r"[a-f0-9]{64}", scope["universe_sha256"]), "invalid universe hash")
    symbols = scope["symbols"]
    _require(isinstance(symbols, list) and 1 <= len(symbols) <= 40 and len(set(symbols)) == len(symbols), "scope symbols must be unique, 1..40")
    _require(all(isinstance(symbol, str) and re.fullmatch(r"[A-Z][A-Z0-9.-]{0,9}", symbol) for symbol in symbols), "invalid symbol")
    _require(isinstance(scope["minimum_dollar_volume"], (int, float)) and not isinstance(scope["minimum_dollar_volume"], bool) and 0 <= scope["minimum_dollar_volume"] <= 1e12, "invalid minimum_dollar_volume")
    _require(isinstance(scope["allow_long"], bool) and isinstance(scope["allow_short"], bool) and (scope["allow_long"] or scope["allow_short"]), "a strategy must allow at least one side")
    _require(set(dna.entry) == {"long", "short"} and set(dna.exit) == {"flat"}, "invalid entry/exit fields")
    _require(set(dna.cooldown) == {"bars"} and isinstance(dna.cooldown["bars"], int) and 0 <= dna.cooldown["bars"] <= 78, "invalid cooldown")
    target = dna.target
    _require(set(target) == {"position_size", "max_strategy_gross", "per_symbol_cap", "normalization", "ranking", "reverse_on_opposite"}, "invalid target fields")
    _require(0 < float(target["position_size"]) <= 1 and 0 < float(target["max_strategy_gross"]) <= .005 and 0 < float(target["per_symbol_cap"]) <= .005, "invalid target caps")
    _require(target["normalization"] in {"equal_weight", "unit"} and target["ranking"] == "none" and isinstance(target["reverse_on_opposite"], bool), "invalid target configuration")
    session = dna.session
    _require(set(session) == {"timezone", "regular_hours_only", "entry_cutoff", "flatten_at"}, "invalid session fields")
    _require(session["timezone"] == "America/New_York" and session["regular_hours_only"] is True, "only NY regular session is supported")
    for field in ("entry_cutoff", "flatten_at"):
        _require(isinstance(session[field], str) and re.fullmatch(r"(0[9]|1[0-5]):[0-5][0-9]", session[field]) is not None, f"invalid {field}")
    _require(session["entry_cutoff"] < session["flatten_at"], "entry cutoff must precede flatten time")
    risk = dna.risk
    _require(set(risk) == {"stop_loss_bps", "max_turnover_per_day", "max_concurrent_symbols", "minimum_data_coverage", "flatten_on_unhealthy_data"}, "invalid risk fields")
    _require(risk["stop_loss_bps"] is None or 1 <= float(risk["stop_loss_bps"]) <= 1000, "invalid stop loss")
    _require(0 < float(risk["max_turnover_per_day"]) <= 20 and isinstance(risk["max_concurrent_symbols"], int) and 1 <= risk["max_concurrent_symbols"] <= 40, "invalid risk limits")
    _require(.9 <= float(risk["minimum_data_coverage"]) <= 1 and risk["flatten_on_unhealthy_data"] is True, "invalid data health policy")
    expected_hash = digest(_semantic_document(raw))
    _require(expected_hash == dna.dna_hash, "dna_hash does not match canonical DNA")
    _require(dna.strategy_id == f"DSL1-{expected_hash[:24]}", "strategy_id does not match canonical DNA")


def validate_strategy_dna(value: dict[str, Any] | StrategyDNA) -> StrategyDNA:
    raw = value.model_dump(mode="json") if isinstance(value, StrategyDNA) else deepcopy(value)
    try:
        dna = value if isinstance(value, StrategyDNA) else StrategyDNA.model_validate(value)
    except ValidationError as exc:
        raise ValueError(f"invalid strategy DSL: {exc}") from exc
    _validate_top_level(dna, raw)
    ids: set[str] = set()
    output_types: dict[str, str] = {}
    depth: dict[str, int] = {}
    node_lookbacks: dict[str, int] = {}
    lookbacks: set[int] = set()
    derived_warmup = 0
    for node in dna.features:
        _require(node.id not in ids, f"duplicate feature id: {node.id}")
        ids.add(node.id)
        _require(node.op in OPS, f"{node.id}: unsupported operation {node.op}")
        spec = OPS[node.op]
        _require(len(node.inputs) in spec.arity, f"{node.id}: {node.op} has invalid input arity")
        _require(len(set(node.inputs)) == len(node.inputs), f"{node.id}: duplicate inputs are not allowed")
        _require(all(ref in output_types for ref in node.inputs), f"{node.id}: graph must be causal and topologically ordered")
        for key, param in node.params.items():
            _require(key in {"value", "window", "lag", "annualization", "epsilon"}, f"{node.id}: unsupported parameter {key}")
            _require(isinstance(param, (int, float)) and not isinstance(param, bool) and math.isfinite(float(param)), f"{node.id}: parameters must be finite numbers")
            bounds = {"value": (-1e9, 1e9), "window": (2, 252), "lag": (0, 252), "annualization": (1, 100000), "epsilon": (0, .01)}[key]
            _require(bounds[0] <= float(param) <= bounds[1], f"{node.id}: {key} out of schema range")
        for required in spec.required_params:
            _require(required in node.params, f"{node.id}: {node.op} requires {required}")
        if node.op == "constant":
            _require(set(node.params) == {"value"}, f"{node.id}: constant requires only value")
        elif node.op in {"simple_return", "log_return", "rate_of_change"}:
            lag = int(node.params.get("lag", 1))
            _require(1 <= lag <= 252, f"{node.id}: lag must be positive and causal")
            node_lookbacks[node.id] = lag
        elif node.op == "gap_return":
            node_lookbacks[node.id] = 0
        elif spec.window:
            window = _int_param(node, "window")
            _require(2 <= window <= 252, f"{node.id}: window out of range")
            lookbacks.add(window)
            node_lookbacks[node.id] = window + 1 if node.op in {"rolling_high_distance", "rolling_low_distance"} else window
        else:
            node_lookbacks[node.id] = 0
        derived_warmup = max(derived_warmup, node_lookbacks[node.id]
                             + max((node_lookbacks[ref] for ref in node.inputs), default=0))
        if node.op == "realized_volatility":
            annualization = node.params.get("annualization", 78 * 252)
            _require(isinstance(annualization, int) and 1 <= annualization <= 100000, f"{node.id}: annualization out of range")
        if node.op == "safe_divide":
            epsilon = float(node.params.get("epsilon", 1e-12))
            _require(0 < epsilon <= .01, f"{node.id}: epsilon out of range")
        if node.op in {"and", "or", "not"}:
            _require(all(output_types[ref] == BOOLEAN for ref in node.inputs), f"{node.id}: boolean operation requires booleans")
        elif node.op not in {"is_finite", "is_missing"}:
            _require(all(output_types[ref] == NUMERIC for ref in node.inputs), f"{node.id}: numeric operation requires numeric inputs")
        output_types[node.id] = spec.output
        depth[node.id] = 1 + max((depth[ref] for ref in node.inputs), default=0)
        _require(depth[node.id] <= 12, f"{node.id}: graph exceeds depth limit")
    _require(len(lookbacks) <= 12, "strategy has too many distinct lookbacks")
    _require(dna.warmup_bars == derived_warmup, f"warmup_bars must equal derived warmup ({derived_warmup})")
    for label, ref in {**dna.entry, **dna.exit}.items():
        if ref is not None:
            _require(ref in output_types and output_types[ref] == BOOLEAN, f"{label} must reference a boolean feature")
    return dna


def build_strategy_dna(document: dict[str, Any]) -> dict[str, Any]:
    """Freeze a valid DNA document, deriving identity, compiler metadata and hash."""
    dna = deepcopy(document)
    dna["dsl_version"] = DSL_VERSION
    dna["compiler"] = {"semantic_version": SEMANTIC_VERSION, "schema_sha256": MANIFEST["schema_sha256"], "semantic_sha256": MANIFEST["semantic_sha256"]}
    dna.pop("strategy_id", None)
    dna.pop("dna_hash", None)
    frozen_hash = digest(dna)
    dna["strategy_id"] = f"DSL1-{frozen_hash[:24]}"
    dna["dna_hash"] = frozen_hash
    validate_strategy_dna(dna)
    return _normalise(dna)


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
        return None
    return float(value)


def _bool(value: Any) -> bool:
    return value is True


def _mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def _std(values: list[float]) -> float:
    if not values:
        return 0.0
    average = _mean(values)
    return math.sqrt(_mean([(value - average) ** 2 for value in values]))


def _parse_time(timestamp: str) -> datetime:
    parsed = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("bar timestamp must include a timezone")
    return parsed.astimezone(ET)


def _bar_value(bar: dict[str, Any], op: str, index: int, bars: list[dict[str, Any]]) -> float | None:
    if op == "vwap_proxy":
        high, low, close = (_number(bar.get(k)) for k in ("h", "l", "c"))
        return (high + low + close) / 3 if high is not None and low is not None and close is not None else None
    if op == "gap_return":
        if index == 0:
            return None
        current, prior = _number(bar.get("o")), _number(bars[index - 1].get("c"))
        return current / prior - 1 if current is not None and prior not in (None, 0) else None
    if op in {"true_range", "bar_range_percentile"}:
        high, low = _number(bar.get("h")), _number(bar.get("l"))
        if high is None or low is None:
            return None
        if op == "true_range" and index:
            prior = _number(bars[index - 1].get("c"))
            if prior is not None:
                return max(high - low, abs(high - prior), abs(low - prior))
        return high - low
    if op in {"minutes_since_open", "minutes_until_close"}:
        try:
            local = _parse_time(str(bar["t"]))
        except (KeyError, ValueError):
            return None
        minute = local.hour * 60 + local.minute + int(bar.get("interval_minutes", 5))
        if op == "minutes_since_open":
            return float(max(0, minute - 570))
        close = 960
        if bar.get("session_close"):
            close_local = _parse_time(str(bar["session_close"]))
            close = close_local.hour * 60 + close_local.minute
        return float(max(0, close - minute))
    field = {"open": "o", "high": "h", "low": "l", "close": "c", "volume": "v"}.get(op)
    return _number(bar.get(field)) if field else None


class TargetStateMachine:
    """Sequential reference evaluator. Decisions are always for the next bar open."""
    def __init__(self, dna: dict[str, Any] | StrategyDNA):
        self.dna = validate_strategy_dna(dna)
        self.bars: list[dict[str, Any]] = []
        self.values: dict[str, list[Any]] = {node.id: [] for node in self.dna.features}
        self.position = 0.0
        self.entry_price: float | None = None
        self.cooldown = 0
        self._turnover_day: str | None = None
        self._turnover = 0.0

    def _history(self, node_id: str, count: int) -> list[float] | None:
        series = self.values[node_id]
        values = series[-count:]
        return [float(value) for value in values] if len(values) == count and all(_number(value) is not None for value in values) else None

    def _node(self, node: Node, index: int) -> Any:
        vals = [self.values[ref][-1] for ref in node.inputs]
        op = node.op
        if op in PRICE_OPS - {"constant"}:
            return _bar_value(self.bars[-1], op, index, self.bars)
        if op == "constant":
            return float(node.params["value"])
        if op == "gap_return":
            return _bar_value(self.bars[-1], op, index, self.bars)
        if op in {"is_finite", "is_missing"}:
            valid = _number(vals[0]) is not None
            return valid if op == "is_finite" else not valid
        if op == "not": return not _bool(vals[0])
        if op == "and": return _bool(vals[0]) and _bool(vals[1])
        if op == "or": return _bool(vals[0]) or _bool(vals[1])
        if op in {"add", "subtract", "multiply", "safe_divide", "absolute", "negate", "safe_log", "greater_than", "greater_equal", "less_than", "less_equal", "equal"}:
            a = _number(vals[0])
            b = _number(vals[1]) if len(vals) > 1 else None
            if op == "absolute": return abs(a) if a is not None else None
            if op == "negate": return -a if a is not None else None
            if op == "safe_log": return math.log(a) if a is not None and a > 0 else None
            if a is None or b is None:
                return False if op in {"greater_than", "greater_equal", "less_than", "less_equal", "equal"} else None
            if op == "add": return a + b
            if op == "subtract": return a - b
            if op == "multiply": return a * b
            if op == "safe_divide": return a / b if abs(b) > float(node.params.get("epsilon", 1e-12)) else None
            return {"greater_than": a > b, "greater_equal": a >= b, "less_than": a < b, "less_equal": a <= b, "equal": a == b}[op]
        source = node.inputs[0] if node.inputs else None
        window = int(node.params.get("window", 0))
        if op in {"simple_return", "log_return", "rate_of_change"}:
            offset = int(node.params.get("lag", 1))
            current = _number(vals[0]); prior = self.values[source][-1 - offset] if len(self.values[source]) > offset else None
            prior_number = _number(prior)
            if current is None or prior_number in (None, 0): return None
            ratio = current / prior_number
            return ratio - 1 if op in {"simple_return", "rate_of_change"} else (math.log(ratio) if ratio > 0 else None)
        if op == "true_range": return _bar_value(self.bars[-1], op, index, self.bars)
        if op == "atr": return _mean(self._history(source, window) or []) if self._history(source, window) else None
        if op == "price_average_distance":
            current, average = _number(vals[0]), _number(vals[1])
            return current / average - 1 if current is not None and average not in (None, 0) else None
        if op == "moving_average_difference":
            current, other = _number(vals[0]), _number(vals[1])
            return current - other if current is not None and other is not None else None
        if op in {"rolling_high_distance", "rolling_low_distance"}:
            series = self.values[source]
            prior = series[-window - 1:-1]
            if len(prior) != window or any(_number(value) is None for value in prior) or _number(vals[0]) is None:
                return None
            extreme = max(prior) if op == "rolling_high_distance" else min(prior)
            return float(vals[0]) / float(extreme) - 1 if extreme else None
        history = self._history(source, window)
        if history is None: return None
        current = history[-1]
        if op == "sma": return _mean(history)
        if op == "ema":
            alpha = 2 / (window + 1)
            series = self.values[source]
            if len(series) == window:
                return _mean(history)
            previous = self.values[node.id][-1] if self.values[node.id] else None
            return alpha * current + (1 - alpha) * float(previous) if _number(previous) is not None else None
        if op == "slope":
            midpoint = (window - 1) / 2
            denominator = sum((offset - midpoint) ** 2 for offset in range(window))
            return sum((offset - midpoint) * value for offset, value in enumerate(history)) / denominator if denominator else None
        if op in {"zscore", "bollinger_distance"}:
            sigma = _std(history); average = _mean(history)
            return (current - average) / sigma if sigma > float(node.params.get("epsilon", 1e-12)) else None
        if op == "realized_volatility": return _std(history) * math.sqrt(int(node.params.get("annualization", 252)))
        if op == "bar_range_percentile": return sum(value <= current for value in history) / window
        if op == "relative_volume":
            average = _mean(history); return current / average if average else None
        raise ValueError(f"unimplemented DSL op {op}")

    def step(self, bar: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(bar, dict): raise ValueError("bar must be an object")
        local = _parse_time(str(bar.get("t", ""))) + timedelta(minutes=int(bar.get("interval_minutes", 5)))
        self.bars.append(deepcopy(bar)); index = len(self.bars) - 1
        for node in self.dna.features:
            value = self._node(node, index)
            self.values[node.id].append(value if _number(value) is not None or isinstance(value, bool) else None)
        target, reason = self._target(local, bar)
        decision = {"t": str(bar["t"]), "target": round(target, 10), "execute_at": "next_bar_open", "reason": reason, "features": {key: self.values[key][-1] for key in self.values}}
        previous_position = self.position
        self.position = target
        price = _number(bar.get("c"))
        if target and (not self.entry_price or target * previous_position < 0): self.entry_price = price
        if not target: self.entry_price = None
        return decision

    def _target(self, local: datetime, bar: dict[str, Any]) -> tuple[float, str]:
        session_time = local.timetz().replace(tzinfo=None)
        session_close = time(16, 0)
        if bar.get("session_close"):
            session_close = _parse_time(str(bar["session_close"])).timetz().replace(tzinfo=None)
        entry_cutoff = min(time.fromisoformat(self.dna.session["entry_cutoff"]), (datetime.combine(local.date(), session_close) - timedelta(minutes=15)).time())
        flatten_at = min(time.fromisoformat(self.dna.session["flatten_at"]), session_close)
        regular = time(9, 30) <= session_time <= session_close and local.weekday() < 5
        health = bar.get("data_health")
        coverage = _number(bar.get("data_coverage", 1.0))
        healthy = health in (None, "healthy") and coverage is not None and coverage >= float(self.dna.risk["minimum_data_coverage"])
        if not regular or not healthy:
            if self.position: self.cooldown = int(self.dna.cooldown["bars"])
            return self._finalize_target(local, 0.0, "unhealthy_data" if not healthy else "outside_regular_session", forced=True)
        if session_time >= flatten_at:
            if self.position: self.cooldown = int(self.dna.cooldown["bars"])
            return self._finalize_target(local, 0.0, "session_flatten", forced=True)
        close = _number(bar.get("c"))
        if self.entry_price and close and self.dna.risk["stop_loss_bps"] is not None:
            adverse = (close / self.entry_price - 1) * 10000 if self.position > 0 else (self.entry_price / close - 1) * 10000
            if adverse <= -float(self.dna.risk["stop_loss_bps"]):
                self.cooldown = int(self.dna.cooldown["bars"]); return self._finalize_target(local, 0.0, "stop_loss", forced=True)
        exit_ref = self.dna.exit["flat"]
        if exit_ref and _bool(self.values[exit_ref][-1]):
            if self.position: self.cooldown = int(self.dna.cooldown["bars"])
            return self._finalize_target(local, 0.0, "exit", forced=True)
        if self.cooldown:
            self.cooldown -= 1
            return self._finalize_target(local, 0.0, "cooldown")
        if session_time > entry_cutoff: return self._finalize_target(local, self.position, "entry_cutoff")
        long = _bool(self.values[self.dna.entry["long"]][-1]) if self.dna.entry["long"] else False
        short = _bool(self.values[self.dna.entry["short"]][-1]) if self.dna.entry["short"] else False
        if long and short:
            if self.position: self.cooldown = int(self.dna.cooldown["bars"])
            return self._finalize_target(local, 0.0, "conflicting_entries", forced=True)
        side = 1 if long and self.dna.scope["allow_long"] else -1 if short and self.dna.scope["allow_short"] else 0
        if side and self.position and side != (1 if self.position > 0 else -1) and not self.dna.target["reverse_on_opposite"]:
            return self._finalize_target(local, self.position, "opposite_held")
        gross_share = float(self.dna.target["max_strategy_gross"])
        if self.dna.target["normalization"] == "equal_weight":
            gross_share /= int(self.dna.risk["max_concurrent_symbols"])
        cap = min(float(self.dna.target["per_symbol_cap"]), gross_share)
        if side == 0:
            return self._finalize_target(local, self.position, "hold")
        target = side * cap * float(self.dna.target["position_size"])
        return self._finalize_target(local, target, "entry")

    def _finalize_target(self, local: datetime, target: float, reason: str, *, forced: bool = False) -> tuple[float, str]:
        day = local.date().isoformat()
        if day != self._turnover_day:
            self._turnover_day, self._turnover = day, 0.0
        turnover = abs(target - self.position)
        if not forced and self._turnover + turnover > float(self.dna.risk["max_turnover_per_day"]):
            return self.position, "turnover_limit"
        self._turnover += turnover
        return target, reason


def evaluate_strategy_targets(dna: dict[str, Any] | StrategyDNA, bars: list[dict[str, Any]]) -> list[dict[str, Any]]:
    machine = TargetStateMachine(dna)
    return [machine.step(bar) for bar in bars]


def evaluate_vector_targets(dna: dict[str, Any] | StrategyDNA, bars: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Vector compiler target. V1 deliberately delegates state transitions to reference semantics."""
    return evaluate_strategy_targets(dna, bars)


def explain_strategy_dna(value: dict[str, Any] | StrategyDNA) -> dict[str, Any]:
    dna = validate_strategy_dna(value)
    labels = {"sma": "simple moving average", "ema": "exponential moving average", "zscore": "z-score", "rate_of_change": "rate of change"}
    nodes = [{"id": node.id, "op": node.op, "label": labels.get(node.op, node.op.replace("_", " ")), "inputs": node.inputs, "params": node.params} for node in dna.features]
    gross_share = float(dna.target["max_strategy_gross"])
    if dna.target["normalization"] == "equal_weight":
        gross_share /= int(dna.risk["max_concurrent_symbols"])
    return {"strategy_id": dna.strategy_id, "dna_hash": dna.dna_hash, "summary": f"{len(nodes)} causal features; {dna.warmup_bars}-bar warmup; next-open execution.", "graph": {"nodes": nodes, "edges": [{"from": source, "to": node.id} for node in dna.features for source in node.inputs]}, "rules": {"long": dna.entry["long"], "short": dna.entry["short"], "exit": dna.exit["flat"], "flatten_at": dna.session["flatten_at"], "target_cap": min(float(dna.target["per_symbol_cap"]), gross_share)}}


def legacy_strategy_to_dsl(legacy: dict[str, Any], *, symbols: list[str] | None = None, lineage: dict[str, Any] | None = None) -> dict[str, Any]:
    """Migration-only adapters for all historical hard-coded strategy archetypes."""
    archetype = legacy.get("archetype")
    params = legacy.get("params", {})
    symbol_list = symbols or [str(legacy.get("asset", "SPY"))]
    common: dict[str, Any] = {"lineage": lineage or {"trial_id": f"legacy:{legacy.get('id', 'unknown')}", "generation": 1, "parent_strategy_id": None, "creation_seed": 0}, "scope": {"mode": "time_series", "universe_id": "legacy-import-v1", "universe_sha256": "0" * 64, "symbols": symbol_list, "minimum_dollar_volume": 0, "allow_long": True, "allow_short": True}, "cooldown": {"bars": 0}, "target": {"position_size": float(params.get("position_size", 1)), "max_strategy_gross": .005, "per_symbol_cap": .005, "normalization": "unit", "ranking": "none", "reverse_on_opposite": True}, "session": {"timezone": "America/New_York", "regular_hours_only": True, "entry_cutoff": "15:45", "flatten_at": "15:55"}, "risk": {"stop_loss_bps": None, "max_turnover_per_day": 20, "max_concurrent_symbols": 1, "minimum_data_coverage": .9, "flatten_on_unhealthy_data": True}}
    if archetype == "Momentum":
        fast, slow, threshold = int(params["fast"]), int(params["slow"]), float(params["threshold"])
        features = [{"id":"close","op":"close","inputs":[],"params":{}},{"id":"fast","op":"sma","inputs":["close"],"params":{"window":fast}},{"id":"slow","op":"sma","inputs":["close"],"params":{"window":slow}},{"id":"delta","op":"safe_divide","inputs":["fast","slow"],"params":{"epsilon":.000001}},{"id":"one","op":"constant","inputs":[],"params":{"value":1}},{"id":"ret","op":"subtract","inputs":["delta","one"],"params":{}},{"id":"threshold","op":"constant","inputs":[],"params":{"value":threshold}},{"id":"neg_threshold","op":"negate","inputs":["threshold"],"params":{}},{"id":"long","op":"greater_than","inputs":["ret","threshold"],"params":{}},{"id":"short","op":"less_than","inputs":["ret","neg_threshold"],"params":{}}]
    elif archetype == "Mean reversion":
        lookback, entry = int(params["lookback"]), float(params["entry_z"])
        features = [{"id":"close","op":"close","inputs":[],"params":{}},{"id":"z","op":"zscore","inputs":["close"],"params":{"window":lookback}},{"id":"entry","op":"constant","inputs":[],"params":{"value":entry}},{"id":"negative","op":"negate","inputs":["entry"],"params":{}},{"id":"long","op":"less_than","inputs":["z","negative"],"params":{}},{"id":"short","op":"greater_than","inputs":["z","entry"],"params":{}}]
    elif archetype == "Breakout":
        lookback, buffer = int(params["lookback"]), float(params["buffer"])
        features = [{"id":"close","op":"close","inputs":[],"params":{}},{"id":"highdist","op":"rolling_high_distance","inputs":["close"],"params":{"window":lookback}},{"id":"lowdist","op":"rolling_low_distance","inputs":["close"],"params":{"window":lookback}},{"id":"buffer","op":"constant","inputs":[],"params":{"value":buffer}},{"id":"negative","op":"negate","inputs":["buffer"],"params":{}},{"id":"long","op":"greater_than","inputs":["highdist","buffer"],"params":{}},{"id":"short","op":"less_than","inputs":["lowdist","negative"],"params":{}}]
    elif archetype == "Volatility filter":
        lookback, ceiling, threshold = int(params["lookback"]), float(params["vol_ceiling"]), float(params["threshold"])
        features = [{"id":"close","op":"close","inputs":[],"params":{}},{"id":"returns","op":"simple_return","inputs":["close"],"params":{"lag":1}},{"id":"vol","op":"realized_volatility","inputs":["returns"],"params":{"window":lookback,"annualization":252}},{"id":"roc","op":"simple_return","inputs":["close"],"params":{"lag":lookback}},{"id":"ceiling","op":"constant","inputs":[],"params":{"value":ceiling}},{"id":"threshold","op":"constant","inputs":[],"params":{"value":threshold}},{"id":"negative","op":"negate","inputs":["threshold"],"params":{}},{"id":"calm","op":"less_than","inputs":["vol","ceiling"],"params":{}},{"id":"up","op":"greater_than","inputs":["roc","threshold"],"params":{}},{"id":"down","op":"less_than","inputs":["roc","negative"],"params":{}},{"id":"long","op":"and","inputs":["calm","up"],"params":{}},{"id":"short","op":"and","inputs":["calm","down"],"params":{}}]
    else:
        raise ValueError(f"unknown legacy archetype: {archetype}")
    derived = max((int(node["params"].get("window", node["params"].get("lag", 0))) for node in features), default=0)
    if archetype in {"Breakout", "Volatility filter"}: derived += 1
    common.update({"features": features, "entry": {"long": "long", "short": "short"}, "exit": {"flat": None}, "warmup_bars": derived})
    return build_strategy_dna(common)


try:  # Backtrader is optional for evaluator-only tooling.
    import backtrader as bt

    class DSLStrategy(bt.Strategy):
        """Backtrader adapter: decisions on completed bars, orders fill next open."""
        params = (("dna", None),)
        def __init__(self) -> None:
            self.machine = TargetStateMachine(self.p.dna)
            self.pending_order = None
        def next(self) -> None:
            stamp = self.data.datetime.datetime(0).replace(tzinfo=ZoneInfo("UTC")).isoformat().replace("+00:00", "Z")
            decision = self.machine.step({"t": stamp, "o": float(self.data.open[0]), "h": float(self.data.high[0]), "l": float(self.data.low[0]), "c": float(self.data.close[0]), "v": float(self.data.volume[0])})
            if self.pending_order is None:
                value = self.broker.getvalue()
                target = decision["target"]
                current = self.position.size * self.data.close[0] / value if value else 0
                if abs(target - current) > 1e-10: self.pending_order = self.order_target_percent(target=target)
        def notify_order(self, order: Any) -> None:
            if order.status in (order.Completed, order.Canceled, order.Margin, order.Rejected): self.pending_order = None
except ImportError:  # pragma: no cover
    DSLStrategy = None  # type: ignore
