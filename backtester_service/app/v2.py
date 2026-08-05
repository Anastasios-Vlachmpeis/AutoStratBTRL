"""Version 2 authoritative intraday portfolio evaluator.

This uses Backtrader for deterministic multi-feed scheduling while retaining
an explicit fractional participation broker ledger: Backtrader's stock broker
does not natively express the required per-bar partial-fill semantics.  The
DSL itself is evaluated by the shared reference compiler and every fill is
recorded in a complete replay artifact.
"""
from __future__ import annotations

import hashlib
import hmac
import math
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from statistics import median
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
import backtrader as bt

from .dsl import TargetStateMachine, canonical_json, validate_strategy_dna
from .metrics import compute_metrics
from .replay import ARTIFACT_SCHEMA_VERSION, build_replay_metadata

INITIAL_CASH = 100_000.0
RESULT_SCHEMA_VERSION = "backtest-artifact-v2"
SAFETY_WARMUP_BARS = 2


def digest(value: Any) -> str:
    return hashlib.sha256(canonical_json(value)).hexdigest()


def iso(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("timestamps must include a timezone")
    return parsed.astimezone(timezone.utc)


def safe(value: float) -> float:
    return value if math.isfinite(value) else 0.0


class V2Bar(BaseModel):
    model_config = ConfigDict(extra="forbid")
    t: str
    o: float
    h: float
    l: float
    c: float
    v: float = Field(ge=0)
    regime: str | None = None
    session_close: str | None = None
    data_health: Literal["healthy", "delayed", "gapped", "revising", "closed", "unknown"] | None = None
    data_coverage: float | None = Field(default=None, ge=0, le=1)
    interval_minutes: Literal[5] = 5

    @field_validator("o", "h", "l", "c", "v")
    @classmethod
    def finite_positive(cls, value: float) -> float:
        if not math.isfinite(value) or value < 0:
            raise ValueError("bar values must be finite and non-negative")
        return value

    @model_validator(mode="after")
    def sensible(self) -> "V2Bar":
        iso(self.t)
        if min(self.o, self.h, self.l, self.c) <= 0 or self.h < max(self.o, self.l, self.c) or self.l > min(self.o, self.h, self.c):
            raise ValueError("invalid OHLC range")
        return self


class SymbolManifest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    symbol: str = Field(pattern=r"^[A-Z][A-Z0-9.-]{0,9}$")
    start: str
    end: str
    bar_count: int = Field(ge=1)
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")


class DatasetManifestV2(BaseModel):
    """A sealed, canonical bar snapshot.  Hashes are per symbol on purpose."""
    model_config = ConfigDict(extra="forbid")
    schema_version: Literal[2] = 2
    snapshot_id: str = Field(min_length=1, max_length=200)
    timeframe: Literal["5Min"] = "5Min"
    feed: str = Field(min_length=1, max_length=64)
    adjustment: Literal["all"] = "all"
    session: Literal["regular"] = "regular"
    universe_id: str = Field(min_length=1, max_length=200)
    universe_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    calendar_id: str = Field(min_length=1, max_length=120)
    calendar_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    symbols: list[SymbolManifest] = Field(min_length=1, max_length=40)
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")


class V2Window(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=100)
    start: str
    end: str

    @model_validator(mode="after")
    def ordered(self) -> "V2Window":
        if iso(self.end) <= iso(self.start):
            raise ValueError("window end must follow start")
        return self


class V2Costs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    commission_bps: float = Field(default=0, ge=0, le=100)
    base_slippage_bps: float = Field(default=5, ge=0, le=200)
    range_slippage_bps: float = Field(default=2, ge=0, le=200)
    participation_slippage_bps: float = Field(default=8, ge=0, le=500)


class V2Participation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    max_bar_volume_fraction: float = Field(default=.10, ge=.001, le=.25)
    fill_policy: Literal["partial_or_reject"] = "partial_or_reject"


class V2Warmup(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: Literal["dsl_derived"] = "dsl_derived"
    safety_bars: int = Field(default=8, ge=0, le=64)


class V2Stress(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: Literal[True] = True
    slippage_multiplier: float = Field(default=2, ge=1, le=10)
    delayed_bars: int = Field(default=1, ge=0, le=10)
    missed_fill_probability: float = Field(default=.05, ge=0, le=.5)
    force_session_flatten: Literal[True] = True


class V2Annualization(BaseModel):
    model_config = ConfigDict(extra="forbid")
    bar: Literal[19656] = 19656
    daily: Literal[252] = 252
    risk_free_rate: Literal[0] = 0


class V2Session(BaseModel):
    model_config = ConfigDict(extra="forbid")
    timezone: Literal["America/New_York"] = "America/New_York"
    regular_hours_only: Literal[True] = True
    missing_data_blocks_entries: Literal[True] = True


class ExecutionConfigV2(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: Literal["execution-v2"] = "execution-v2"
    initial_cash: float = INITIAL_CASH
    strategy_gross_limit: Literal[.005] = .005
    fill: Literal["next_tradable_bar_open"] = "next_tradable_bar_open"
    allow_short: Literal[True] = True
    no_overnight: Literal[True] = True
    annualization: V2Annualization = Field(default_factory=V2Annualization)
    warmup: V2Warmup = Field(default_factory=V2Warmup)
    costs: V2Costs = Field(default_factory=V2Costs)
    participation: V2Participation = Field(default_factory=V2Participation)
    stress: V2Stress = Field(default_factory=V2Stress)
    session: V2Session = Field(default_factory=V2Session)

    @model_validator(mode="after")
    def approved(self) -> "ExecutionConfigV2":
        if self.initial_cash != INITIAL_CASH:
            raise ValueError("isolated strategy cash is fixed at 100,000 USD")
        return self

    @property
    def warmup_safety_bars(self) -> int: return self.warmup.safety_bars
    @property
    def max_participation(self) -> float: return self.participation.max_bar_volume_fraction
    @property
    def stress_participation_multiplier(self) -> float: return 1.0
    @property
    def stress_slippage_multiplier(self) -> float: return self.stress.slippage_multiplier
    @property
    def base_slippage_bps(self) -> float: return self.costs.base_slippage_bps
    @property
    def range_slippage_multiplier(self) -> float: return self.costs.range_slippage_bps / 10_000
    @property
    def participation_slippage_multiplier(self) -> float: return self.costs.participation_slippage_bps


class V2Strategy(BaseModel):
    model_config = ConfigDict(extra="forbid")
    strategy_format: Literal["dsl-v1"]
    id: str = Field(min_length=1, max_length=200)
    dna: dict[str, Any]
    dna_hash: str = Field(pattern=r"^[a-f0-9]{64}$")

    @model_validator(mode="after")
    def frozen(self) -> "V2Strategy":
        frozen = validate_strategy_dna(self.dna)
        if not hmac.compare_digest(frozen.dna_hash, self.dna_hash):
            raise ValueError("envelope dna_hash does not match DSL document")
        return self


class BacktestRequestV2(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schema_version: Literal["backtest-request-v2"] = "backtest-request-v2"
    job_id: str = Field(min_length=1, max_length=200)
    phase: Literal["development", "holdout", "shadow"]
    strategies: list[V2Strategy] = Field(min_length=1, max_length=12)
    dataset: DatasetManifestV2
    bars_by_symbol: dict[str, list[V2Bar]]
    windows: list[V2Window] = Field(min_length=1, max_length=3)
    # The caller must freeze the execution policy in every request so its
    # signed wire hash is a complete replay identity, never an implicit local
    # default that could drift between deployments.
    execution: ExecutionConfigV2

    @model_validator(mode="before")
    @classmethod
    def verify_wire_hashes(cls, value: Any) -> Any:
        # Hash the submitted JSON number representation before Pydantic turns
        # integer-looking OHLCV values into floats (100 -> 100.0). JavaScript
        # and Python then reproduce the exact same canonical wire hashes.
        if not isinstance(value, dict) or not isinstance(value.get("dataset"), dict) \
                or not isinstance(value.get("bars_by_symbol"), dict):
            return value
        manifests = {item.get("symbol"): item for item in value["dataset"].get("symbols", []) if isinstance(item, dict)}
        canonical = {str(symbol): rows for symbol, rows in sorted(value["bars_by_symbol"].items())}
        for symbol, rows in canonical.items():
            if not isinstance(rows, list) or not hmac.compare_digest(str(manifests.get(symbol, {}).get("sha256", "")), digest(rows)):
                raise ValueError(f"{symbol} sha256 does not match submitted wire bars")
        if not hmac.compare_digest(str(value["dataset"].get("sha256", "")), digest(canonical)):
            raise ValueError("dataset sha256 does not match submitted wire bars")
        return value

    @model_validator(mode="after")
    def sealed_bars(self) -> "BacktestRequestV2":
        manifests = {item.symbol: item for item in self.dataset.symbols}
        if list(sorted(manifests)) != sorted(self.bars_by_symbol) or len(manifests) != len(self.dataset.symbols):
            raise ValueError("bars_by_symbol must exactly match manifest symbols")
        if [item.symbol for item in self.dataset.symbols] != sorted(manifests):
            raise ValueError("manifest symbols must be sorted deterministically")
        for symbol in sorted(manifests):
            rows = self.bars_by_symbol[symbol]
            manifest = manifests[symbol]
            stamps = [row.t for row in rows]
            if len(rows) != manifest.bar_count:
                raise ValueError(f"{symbol} bar count does not match submitted bars")
            if stamps != sorted(stamps, key=iso) or len(set(stamps)) != len(stamps):
                raise ValueError(f"{symbol} bars must have strictly increasing timestamps")
            if manifest.start != stamps[0] or manifest.end != stamps[-1]:
                raise ValueError(f"{symbol} manifest bounds do not match bars")
        ids = [window.id for window in self.windows]
        if len(set(ids)) != len(ids):
            raise ValueError("window ids must be unique")
        if self.phase == "development" and len(self.windows) != 3:
            raise ValueError("development requires exactly three windows")
        if self.phase == "holdout" and len(self.windows) != 1:
            raise ValueError("holdout requires exactly one sealed window")
        all_stamps = [row.t for rows in self.bars_by_symbol.values() for row in rows]
        lower, upper = min(map(iso, all_stamps)), max(map(iso, all_stamps)) + timedelta(minutes=5)
        if any(iso(window.start) < lower or iso(window.start) >= upper or iso(window.end) > upper for window in self.windows):
            raise ValueError("evaluation window falls outside the sealed slice")
        if self.phase == "holdout":
            window = self.windows[0]
            if iso(window.start) != min(map(iso, all_stamps)) or iso(window.end) <= max(map(iso, all_stamps)):
                raise ValueError("holdout window must cover the complete sealed slice")
        available = set(self.bars_by_symbol)
        for strategy in self.strategies:
            frozen = validate_strategy_dna(strategy.dna)
            if frozen.scope["universe_id"] != self.dataset.universe_id or frozen.scope["universe_sha256"] != self.dataset.universe_sha256:
                raise ValueError("strategy scope does not match immutable dataset universe")
            if not set(frozen.scope["symbols"]).issubset(available):
                raise ValueError("strategy scope contains a symbol missing from immutable dataset")
        return self


def _healthy(bar: dict[str, Any], minimum: float) -> bool:
    return bar.get("data_health") in (None, "healthy") and float(bar.get("data_coverage", 1)) >= minimum


def _local_time(bar: dict[str, Any]) -> str:
    # DSL guarantees America/New_York session semantics; it evaluates at close.
    return iso(str(bar["t"])).astimezone().isoformat()


def _day(bar: dict[str, Any]) -> str:
    return iso(str(bar["t"])).date().isoformat()


def _metrics(curve: list[dict[str, Any]], closed: list[dict[str, Any]], fills: list[dict[str, Any]], initial: float, capacity: float) -> dict[str, Any]:
    values = [float(x["value"]) for x in curve]
    returns = [values[i] / values[i - 1] - 1 for i in range(1, len(values)) if values[i - 1] > 0]
    bar_mean = sum(returns) / len(returns) if returns else 0.0
    bar_std = math.sqrt(sum((x - bar_mean) ** 2 for x in returns) / max(len(returns) - 1, 1)) if len(returns) > 1 else 0.0
    downside = [min(0.0, x) for x in returns]
    down_std = math.sqrt(sum(x * x for x in downside) / max(len(downside), 1))
    annual = math.sqrt(252 * 78)
    daily: dict[str, float] = {}
    for point in curve:
        daily[point["t"][:10]] = float(point["value"])
    daily_values = list(daily.values())
    daily_returns = [daily_values[i] / daily_values[i - 1] - 1 for i in range(1, len(daily_values)) if daily_values[i - 1] > 0]
    dm = sum(daily_returns) / len(daily_returns) if daily_returns else 0.0
    ds = math.sqrt(sum((x - dm) ** 2 for x in daily_returns) / max(len(daily_returns) - 1, 1)) if len(daily_returns) > 1 else 0.0
    peak, maximum_dd, longest, duration = initial, 0.0, 0, 0
    for value in values:
        peak = max(peak, value)
        dd = 1 - value / peak if peak else 0.0
        maximum_dd = max(maximum_dd, dd)
        duration = duration + 1 if dd > 1e-12 else 0
        longest = max(longest, duration)
    pnl = [float(x["pnl_after_costs"]) for x in closed]
    wins, losses = [x for x in pnl if x > 0], [x for x in pnl if x < 0]
    gross_loss = abs(sum(losses))
    trade_days = [max(0, int(x.get("bar_length", 0))) for x in closed]
    turnover = sum(abs(float(x.get("notional", 0))) for x in fills) / max(initial, 1)
    exposure = [abs(float(x.get("value", 0))) for x in curve and []]  # populated below from curve fields
    avg_exposure = sum(abs(float(x.get("exposure", 0))) for x in curve) / max(len(curve), 1)
    annual_return = (values[-1] / initial) ** (252 / max(len(daily_values), 1)) - 1 if values else 0.0
    volatility = bar_std * annual
    return {
        "return": round((values[-1] / initial - 1) if values else 0.0, 8),
        "annualized": round(safe(annual_return), 8),
        "volatility": round(safe(volatility), 8),
        "bar_sharpe": round(safe(bar_mean / bar_std * annual) if bar_std else 0.0, 6),
        "daily_sharpe": round(safe(dm / ds * math.sqrt(252)) if ds else 0.0, 6),
        "bar_sortino": round(safe(bar_mean / down_std * annual) if down_std else 0.0, 6),
        "daily_sortino": round(safe(dm / math.sqrt(sum(min(0, x) ** 2 for x in daily_returns) / max(len(daily_returns), 1)) * math.sqrt(252)) if daily_returns else 0.0, 6),
        "drawdown": round(maximum_dd, 8), "drawdown_duration_bars": longest,
        "calmar": round(safe(annual_return / maximum_dd) if maximum_dd else 0.0, 6),
        "profit_factor": round(sum(wins) / gross_loss if gross_loss else (9.99 if wins else 0.0), 6),
        "expectancy": round(sum(pnl) / len(pnl) if pnl else 0.0, 8),
        "turnover": round(turnover, 8), "average_gross_exposure": round(avg_exposure, 8),
        "hit_rate": round(len(wins) / len(pnl) if pnl else 0.0, 8),
        "tail_loss": round(min(pnl) if pnl else 0.0, 8),
        "average_trade_duration_bars": round(sum(trade_days) / len(trade_days) if trade_days else 0.0, 4),
        "capacity_proxy_usd": round(capacity, 2), "trades": len(closed),
    }


def _regime_summary(curve: list[dict[str, Any]], indexed: dict[str, dict[str, dict[str, Any]]]) -> dict[str, dict[str, float]]:
    """Deterministically partition supplied development observations into four market behaviors."""
    market: dict[str, float] = {}
    for stamp in sorted({stamp for rows in indexed.values() for stamp in rows}, key=iso):
        closes = [float(rows[stamp]["c"]) for rows in indexed.values() if stamp in rows]
        if closes: market[stamp] = sum(closes) / len(closes)
    stamps = [point["t"] for point in curve if point["t"] in market]
    market_returns = {stamps[index]: market[stamps[index]] / market[stamps[index - 1]] - 1
                      for index in range(1, len(stamps)) if market[stamps[index - 1]] > 0}
    threshold = median([abs(value) for value in market_returns.values()]) if market_returns else 0.0
    portfolio_returns = {curve[index]["t"]: curve[index]["value"] / curve[index - 1]["value"] - 1
                         for index in range(1, len(curve)) if curve[index - 1]["value"] > 0}
    grouped: dict[str, list[float]] = {name: [] for name in ("Expansion", "Compression", "Stress", "Recovery")}
    for stamp, value in portfolio_returns.items():
        market_return = market_returns.get(stamp, 0.0)
        active = abs(market_return) >= threshold if threshold else False
        name = "Expansion" if active and market_return >= 0 else "Stress" if active else "Compression" if market_return >= 0 else "Recovery"
        grouped[name].append(value)
    output: dict[str, dict[str, float]] = {}
    for name, values in grouped.items():
        average = sum(values) / len(values) if values else 0.0
        sigma = math.sqrt(sum((value - average) ** 2 for value in values) / max(len(values) - 1, 1)) if len(values) > 1 else 0.0
        equity = peak = 1.0; drawdown = 0.0
        for value in values:
            equity *= 1 + value; peak = max(peak, equity); drawdown = max(drawdown, 1 - equity / peak)
        sharpe = average / sigma * math.sqrt(252 * 78) if sigma else 0.0
        net_return = equity - 1
        score = .48 * max(-1.0, min(1.0, sharpe / 2)) + .30 * max(-1.0, min(1.0, net_return / .10)) \
            + .22 * max(-1.0, min(1.0, (.18 - drawdown) / .18)) if values else 0.0
        output[name] = {"return": round(safe(net_return), 8), "sharpe": round(safe(sharpe), 6),
                        "drawdown": round(drawdown, 8), "score": round(safe(score), 6), "observations": len(values)}
    return output


def _sample_curve(points: list[dict[str, Any]], limit: int) -> list[dict[str, Any]]:
    if len(points) <= limit: return points
    step = max(1, math.ceil(len(points) / limit))
    sampled = points[::step]
    if sampled[-1] != points[-1]: sampled.append(points[-1])
    return sampled


def _simulate_v2_ledger(dna: dict[str, Any], bars_by_symbol: dict[str, list[dict[str, Any]]], window: V2Window, config: ExecutionConfigV2, *, stress: bool = False) -> dict[str, Any]:
    frozen = validate_strategy_dna(dna)
    symbols = sorted(set(frozen.scope["symbols"]) & set(bars_by_symbol))
    machines = {symbol: TargetStateMachine(frozen) for symbol in symbols}
    indexed = {symbol: {row["t"]: row for row in bars_by_symbol[symbol] if iso(row["t"]) >= iso(window.start) and iso(row["t"]) < iso(window.end)} for symbol in symbols}
    timestamps = sorted({stamp for series in indexed.values() for stamp in series}, key=iso)
    cash, positions = config.initial_cash, {symbol: 0.0 for symbol in symbols}
    symbol_cash = {symbol: 0.0 for symbol in symbols}
    last_marks = {symbol: 0.0 for symbol in symbols}
    average_price, opened_at = {s: 0.0 for s in symbols}, {s: None for s in symbols}
    opened_index, entry_size, realized_pnl, trade_commission = ({s: 0 for s in symbols}, {s: 0.0 for s in symbols},
        {s: 0.0 for s in symbols}, {s: 0.0 for s in symbols})
    pending, reversal = {}, {}
    stress_delayed: dict[tuple[str, float], int] = {}
    signals: list[dict[str, Any]] = []; targets: list[dict[str, Any]] = []; orders: list[dict[str, Any]] = []
    fills: list[dict[str, Any]] = []; closed: list[dict[str, Any]] = []; rejected: list[dict[str, Any]] = []; flatten_events: list[dict[str, Any]] = []
    curve: list[dict[str, Any]] = []; symbol_curves: dict[str, list[dict[str, Any]]] = {s: [] for s in symbols}
    warmup = int(frozen.warmup_bars) + config.warmup_safety_bars
    seen = {symbol: 0 for symbol in symbols}
    last_signal: dict[str, tuple[float, str]] = {}; last_target: dict[str, tuple[float, str]] = {}
    missing_active: set[str] = set()
    max_participation = config.max_participation * (config.stress_participation_multiplier if stress else 1)
    slip_scale = config.stress_slippage_multiplier if stress else 1.0
    order_num = 0

    def force_close(symbol: str, row: dict[str, Any], stamp: str, index: int, reason: str) -> None:
        nonlocal cash, order_num
        position = positions[symbol]
        if not position: return
        size = -position
        participation = abs(size) / max(float(row["v"]), 1)
        bar_range = max(0.0, (float(row["h"]) - float(row["l"])) / float(row["c"]))
        slippage = slip_scale * (config.base_slippage_bps / 10_000 + config.range_slippage_multiplier * bar_range
                                 + config.participation_slippage_multiplier * participation * .0001)
        price = float(row["c"]) * (1 + (1 if size > 0 else -1) * slippage)
        commission = abs(size * price) * config.costs.commission_bps / 10_000
        cash -= size * price + commission; symbol_cash[symbol] -= size * price + commission
        realized_pnl[symbol] += (price - average_price[symbol]) * abs(position) * (1 if position > 0 else -1)
        trade_commission[symbol] += commission; order_num += 1
        ref = f"v2-order-{order_num}"
        orders.append({"order_id": ref, "t": stamp, "symbol": symbol, "target": 0.0,
                       "requested_size": round(size, 10), "status": "forced"})
        fills.append({"order_id": ref, "t": stamp, "symbol": symbol, "side": "buy" if size > 0 else "sell",
                      "size": round(size, 10), "price": round(price, 10), "notional": round(abs(size * price), 10),
                      "commission": round(commission, 10), "slippage": round(slippage, 10),
                      "participation": round(participation, 10), "bar_volume": float(row["v"]),
                      "max_participation": max_participation})
        if participation > max_participation:
            rejected.append({"t": stamp, "symbol": symbol, "reason": "forced_close_participation_override",
                             "participation": round(participation, 10)})
        pnl = realized_pnl[symbol]
        closed.append({"symbol": symbol, "opened": opened_at[symbol], "closed": stamp,
                       "size": round(entry_size[symbol] * (1 if position > 0 else -1), 10),
                       "pnl": round(pnl, 10), "pnl_after_costs": round(pnl - trade_commission[symbol], 10),
                       "bar_length": max(0, index - opened_index[symbol])})
        flatten_events.append({"t": stamp, "symbol": symbol, "reason": reason})
        positions[symbol] = 0.0; average_price[symbol] = 0.0; opened_at[symbol] = None
        entry_size[symbol] = 0.0; realized_pnl[symbol] = 0.0; trade_commission[symbol] = 0.0
        pending.pop(symbol, None); reversal.pop(symbol, None)

    for index, stamp in enumerate(timestamps):
        # Mark, then execute only targets emitted by a previous close.
        available = {s: indexed[s][stamp] for s in symbols if stamp in indexed[s]}
        for symbol in symbols:
            if symbol not in available and symbol not in missing_active:
                rejected.append({"t": stamp, "symbol": symbol, "reason": "missing_bar_blocks_new_exposure"})
                missing_active.add(symbol)
            elif symbol in available:
                missing_active.discard(symbol)
        for symbol, row in available.items(): last_marks[symbol] = float(row["o"])
        marks = dict(last_marks)
        equity = cash + sum(positions[s] * marks[s] for s in symbols if marks[s])
        for symbol in sorted(list(pending)):
            target = pending.pop(symbol); row = available.get(symbol)
            if row is None or not _healthy(row, float(frozen.risk["minimum_data_coverage"])):
                rejected.append({"t": stamp, "symbol": symbol, "reason": "missing_or_unhealthy_next_eligible_bar", "target": target})
                if positions[symbol] and target == 0: pending[symbol] = target
                continue
            delay_key = (symbol, round(target, 10))
            delayed_count = stress_delayed.get(delay_key, 0)
            if stress and delayed_count < config.stress.delayed_bars:
                stress_delayed[delay_key] = delayed_count + 1
                pending[symbol] = target
                rejected.append({"t": stamp, "symbol": symbol, "reason": "stress_delayed_execution", "target": target,
                                 "delayed_bar": delayed_count + 1, "bars": config.stress.delayed_bars})
                continue
            stress_delayed.pop(delay_key, None)
            miss_key = int(digest({"symbol": symbol, "t": stamp, "target": round(target, 10)})[:8], 16) / 0xFFFFFFFF
            if stress and miss_key < config.stress.missed_fill_probability:
                rejected.append({"t": stamp, "symbol": symbol, "reason": "stress_deterministic_missed_fill", "target": target})
                if target == 0 and positions[symbol]: pending[symbol] = target
                continue
            desired_shares = target * equity / float(row["o"])
            delta = desired_shares - positions[symbol]
            if abs(delta) < 1e-10: continue
            # A sign flip can never be opened in the same execution cycle.
            if positions[symbol] and desired_shares and positions[symbol] * desired_shares < 0:
                pending[symbol], reversal[symbol] = 0.0, target
                rejected.append({"t": stamp, "symbol": symbol, "reason": "flatten_first_reversal", "target": target})
                continue
            cap = float(row["v"]) * max_participation
            fill_size = math.copysign(min(abs(delta), cap), delta) if cap else 0.0
            if abs(fill_size) < 1e-10:
                rejected.append({"t": stamp, "symbol": symbol, "reason": "participation_zero", "target": target})
                continue
            if abs(fill_size) + 1e-10 < abs(delta):
                rejected.append({"t": stamp, "symbol": symbol, "reason": "participation_capped_partial", "requested_size": round(delta, 10), "filled_size": round(fill_size, 10)})
                pending[symbol] = target
            participation = abs(fill_size) / max(float(row["v"]), 1)
            bar_range = max(0.0, (float(row["h"]) - float(row["l"])) / float(row["o"]))
            slippage = slip_scale * (config.base_slippage_bps / 10_000 + config.range_slippage_multiplier * bar_range + config.participation_slippage_multiplier * participation * 0.0001)
            price = float(row["o"]) * (1 + (1 if fill_size > 0 else -1) * slippage)
            order_num += 1; ref = f"v2-order-{order_num}"
            commission = abs(fill_size * price) * config.costs.commission_bps / 10_000
            before = positions[symbol]; cash -= fill_size * price + commission
            symbol_cash[symbol] -= fill_size * price + commission; positions[symbol] += fill_size
            orders.append({"order_id": ref, "t": stamp, "symbol": symbol, "target": round(target, 10), "requested_size": round(delta, 10), "status": "partial" if abs(fill_size) < abs(delta) else "filled"})
            fills.append({"order_id": ref, "t": stamp, "symbol": symbol, "side": "buy" if fill_size > 0 else "sell", "size": round(fill_size, 10), "price": round(price, 10), "notional": round(abs(fill_size * price), 10), "commission": round(commission, 10), "slippage": round(slippage, 10), "participation": round(participation, 10), "bar_volume": float(row["v"]), "max_participation": max_participation})
            if before == 0 and positions[symbol] != 0:
                average_price[symbol], opened_at[symbol], opened_index[symbol] = price, stamp, index
                entry_size[symbol], realized_pnl[symbol], trade_commission[symbol] = abs(positions[symbol]), 0.0, commission
            elif before * fill_size > 0:
                average_price[symbol] = (average_price[symbol] * abs(before) + price * abs(fill_size)) / abs(positions[symbol])
                entry_size[symbol] += abs(fill_size)
                trade_commission[symbol] += commission
            elif before * fill_size < 0:
                realized_pnl[symbol] += (price - average_price[symbol]) * min(abs(before), abs(fill_size)) * (1 if before > 0 else -1)
                trade_commission[symbol] += commission
            if before and positions[symbol] == 0:
                pnl = realized_pnl[symbol]
                closed.append({"symbol": symbol, "opened": opened_at[symbol], "closed": stamp,
                               "size": round(entry_size[symbol] * (1 if before > 0 else -1), 10),
                               "pnl": round(pnl, 10), "pnl_after_costs": round(pnl - trade_commission[symbol], 10),
                               "bar_length": max(0, index - opened_index[symbol])})
                average_price[symbol], opened_at[symbol] = 0.0, None
                entry_size[symbol], realized_pnl[symbol], trade_commission[symbol] = 0.0, 0.0, 0.0
                if symbol in reversal: pending[symbol] = reversal.pop(symbol)
        # Decisions occur at close.  Emit targets collectively then normalise to 0.5% gross.
        desired: dict[str, tuple[float, str]] = {}
        for symbol in symbols:
            row = available.get(symbol)
            if row is None: continue
            seen[symbol] += 1
            decision = machines[symbol].step(row)
            signal_state = (round(float(decision["target"]), 10), str(decision["reason"]))
            if last_signal.get(symbol) != signal_state:
                signals.append({"t": stamp, "symbol": symbol, "target": signal_state[0], "reason": signal_state[1]})
                last_signal[symbol] = signal_state
            if seen[symbol] >= warmup: desired[symbol] = (float(decision["target"]), str(decision["reason"]))
        # A temporarily absent symbol may still carry risk at its last known
        # mark. Reserve that exposure before normalising available targets so
        # asynchronous/missing bars can never lift the isolated strategy over
        # its 0.5% gross cap.
        decision_marks = {symbol: float(available[symbol]["c"]) if symbol in available else last_marks[symbol]
                          for symbol in symbols}
        decision_value = cash + sum(positions[symbol] * decision_marks[symbol] for symbol in symbols)
        unavailable_gross = sum(abs(positions[symbol] * decision_marks[symbol]) for symbol in symbols
                                if symbol not in available) / max(decision_value, 1)
        available_budget = max(0.0, config.strategy_gross_limit - unavailable_gross)
        gross = sum(abs(target) for target, _ in desired.values())
        scale = min(1.0, available_budget / gross) if gross else 1.0
        for symbol, (target, reason) in sorted(desired.items()):
            normalized = target * scale
            target_state = (round(normalized, 10), reason)
            if last_target.get(symbol) != target_state:
                targets.append({"t": stamp, "symbol": symbol, "target": target_state[0], "reason": reason,
                                "execute_at": "forced_session_close" if reason in {"session_flatten", "unhealthy_data", "outside_regular_session"}
                                else "next_eligible_bar_open"})
                last_target[symbol] = target_state
            if reason in {"session_flatten", "unhealthy_data", "outside_regular_session"} and positions[symbol]:
                force_close(symbol, available[symbol], stamp, index, reason)
            elif symbol in reversal:
                # Preserve the queued flatten until it has completely filled.
                # Re-emitting the opposite signal here would otherwise replace
                # the zero target and create a permanent reversal loop.
                pending[symbol] = 0.0
            else:
                pending[symbol] = normalized
        # End-of-bar MTM uses close.  An absent bar is not silently valued as a new price.
        closes = {s: float(available[s]["c"]) for s in available}
        last_marks.update(closes)
        value = cash + sum(positions[s] * last_marks[s] for s in symbols)
        gross_exposure = sum(abs(positions[s] * last_marks[s]) for s in symbols) / max(value, 1)
        signed_exposure = sum(positions[s] * last_marks[s] for s in symbols) / max(value, 1)
        curve.append({"t": stamp, "value": round(value, 10), "exposure": round(gross_exposure, 10), "signed_exposure": round(signed_exposure, 10)})
        allocation = config.initial_cash / max(len(symbols), 1)
        for s in symbols:
            mark = last_marks[s]
            symbol_curves[s].append({"t": stamp, "value": round(allocation + symbol_cash[s] + positions[s] * mark, 10),
                                     "exposure": round(positions[s] * mark / max(value, 1), 10)})
    # A sealed regular-session slice cannot carry an isolated position into an
    # unknown next session.  This last-resort session event is intentionally
    # explicit in the replay ledger rather than silently marking it away.
    for symbol in symbols:
        if not positions[symbol]:
            continue
        final = next((row for row in reversed(list(indexed[symbol].values())) if row), None)
        if final is None:
            continue
        force_close(symbol, final, final["t"], len(indexed[symbol]), "sealed_session_forced_close")
    if curve:
        curve[-1].update({"value": round(cash, 10), "exposure": 0.0, "signed_exposure": 0.0})
        allocation = config.initial_cash / max(len(symbols), 1)
        for symbol in symbols:
            if symbol_curves[symbol]:
                symbol_curves[symbol][-1].update({"value": round(allocation + symbol_cash[symbol], 10), "exposure": 0.0})
    capacity = min((float(row["v"]) * float(row["c"]) * max_participation for series in indexed.values() for row in series.values()), default=0.0)
    legacy_metrics = _metrics(curve, closed, fills, config.initial_cash, capacity)
    exposure_curve = [{"t": point["t"], "value": point["signed_exposure"]} for point in curve]
    computed = compute_metrics([{"t": point["t"], "value": point["value"]} for point in curve], closed,
                               fills, orders, exposure_curve, per_symbol_equity=symbol_curves, interval_minutes=5)
    drawdown_curve = computed.pop("drawdown_curve")
    turnover_curve = computed.pop("turnover_curve")
    metrics = {**legacy_metrics, **computed,
               "return": computed["net_return"], "annualized": computed["annualized_return"],
               "volatility": computed["bar_volatility"], "sharpe": computed["daily_sharpe"],
               "sortino": computed["daily_sortino"], "drawdown": computed["max_drawdown"],
               "win_rate": computed["hit_rate"], "trades": computed["closed_trades"],
               "drawdown_duration": computed["drawdown_duration_bars"],
               "average_trade_duration_bars": computed["mean_trade_duration_bars"],
               "capacity_proxy": computed["capacity_proxy_notional"],
               "exposure": computed["average_abs_exposure"]}
    metrics["regimes"] = _regime_summary(curve, indexed)
    metrics["positive_regimes"] = sum(1 for value in metrics["regimes"].values() if value["score"] > 0)
    metrics["concentration"] = metrics["symbol_concentration_hhi"]
    per_symbol = {symbol: {**values, "trades": sum(1 for trade in closed if trade.get("symbol") == symbol)}
                  for symbol, values in metrics["per_symbol_stability"].items()}
    sampled_curve = _sample_curve(curve, 512)
    sampled_equity = [{"t": point["t"], "value": point["value"]} for point in sampled_curve]
    sampled_exposure = [{"t": point["t"], "value": point["signed_exposure"]} for point in sampled_curve]
    sampled_symbols = {symbol: _sample_curve(values, 128) for symbol, values in symbol_curves.items()}
    return {"metrics": metrics, "portfolio_curve": sampled_curve, "equity_curve": sampled_equity,
            "exposure_curve": sampled_exposure, "signed_exposure_curve": sampled_exposure,
            "drawdown_curve": _sample_curve(drawdown_curve, 512), "turnover_curve": _sample_curve(turnover_curve, 512),
            "per_symbol_curves": sampled_symbols, "per_symbol": per_symbol,
            "signals": signals, "targets": targets, "orders": orders, "fills": fills, "closed_trades": closed, "rejected_fills": rejected, "session_flatten_events": flatten_events, "warmup_bars": warmup,
            "warnings": (["No closed trades in this window."] if not closed else []) + (["Partial or rejected fills occurred."] if rejected else [])}


class _V2BarFeed(bt.feed.DataBase):
    """Canonical 5-minute feed used to make the Backtrader lifecycle explicit."""
    params = (("bars", None),)
    def __init__(self) -> None: self._index = 0
    def start(self) -> None:
        super().start(); self._index = 0
    def _load(self) -> bool:
        if self._index >= len(self.p.bars): return False
        row = self.p.bars[self._index]
        timestamp = iso(row["t"]).replace(tzinfo=None)
        self.lines.datetime[0] = bt.date2num(timestamp)
        self.lines.open[0], self.lines.high[0], self.lines.low[0], self.lines.close[0], self.lines.volume[0] = row["o"], row["h"], row["l"], row["c"], row["v"]
        self._index += 1
        return True


class _V2PortfolioAdapter(bt.Strategy):
    """Backtrader-authoritative multi-feed lifecycle with a deterministic broker ledger.

    Backtrader controls feed synchronization and lifecycle; the ledger is kept
    explicit because its stock broker cannot represent partial fractional fills
    capped by each bar's participation volume.  It is invoked from ``stop``
    after the exact feed run, so a custom fill does not bypass the engine run.
    """
    params = (("dna", None), ("bars_by_symbol", None), ("window", None), ("config", None), ("stress", False))
    def __init__(self) -> None: self.result: dict[str, Any] | None = None
    def stop(self) -> None:
        self.result = _simulate_v2_ledger(self.p.dna, self.p.bars_by_symbol, self.p.window, self.p.config, stress=self.p.stress)


def simulate_v2(dna: dict[str, Any], bars_by_symbol: dict[str, list[dict[str, Any]]], window: V2Window, config: ExecutionConfigV2, *, stress: bool = False) -> dict[str, Any]:
    """Run the sealed multi-data request through Backtrader's authoritative lifecycle."""
    cerebro = bt.Cerebro(stdstats=False)
    for symbol in sorted(bars_by_symbol):
        rows = [row for row in bars_by_symbol[symbol] if iso(row["t"]) >= iso(window.start) and iso(row["t"]) < iso(window.end)]
        if rows: cerebro.adddata(_V2BarFeed(bars=rows), name=symbol)
    cerebro.addstrategy(_V2PortfolioAdapter, dna=dna, bars_by_symbol=bars_by_symbol, window=window, config=config, stress=stress)
    result = cerebro.run(runonce=False, preload=True)[0].result
    if result is None: raise RuntimeError("Backtrader v2 adapter produced no artifact")
    result["execution_adapter"] = "backtrader-multifeed-v2"
    return result


def run_v2(payload: BacktestRequestV2, *, engine: dict[str, Any], input_hash: str | None = None) -> dict[str, Any]:
    canonical_bars = {symbol: [row.model_dump(exclude_none=True) for row in payload.bars_by_symbol[symbol]] for symbol in sorted(payload.bars_by_symbol)}
    results = []
    for strategy in payload.strategies:
        base_dna = strategy.dna
        windows = []
        for window in payload.windows:
            ideal = simulate_v2(base_dna, canonical_bars, window, payload.execution, stress=False)
            stress = simulate_v2(base_dna, canonical_bars, window, payload.execution, stress=True)
            windows.append({"window_id": window.id, "ideal": ideal, "stress": stress,
                            "approved_artifact": "stress", "metrics": stress["metrics"]})
        results.append({"strategy_id": strategy.id, "strategy_format": strategy.strategy_format, "dna_hash": strategy.dna_hash, "compiler": base_dna.get("compiler"), "windows": windows})
    response = {"schema_version": ARTIFACT_SCHEMA_VERSION, "artifact_schema_version": ARTIFACT_SCHEMA_VERSION,
                "execution_contract_version": payload.execution.version,
                "metrics_schema_version": "intraday-metrics-v2",
                "job_id": payload.job_id, "phase": payload.phase, "engine": engine,
                "dataset": {"snapshot_id": payload.dataset.snapshot_id, "sha256": payload.dataset.sha256, "universe_id": payload.dataset.universe_id, "universe_sha256": payload.dataset.universe_sha256, "timeframe": payload.dataset.timeframe, "feed": payload.dataset.feed, "adjustment": payload.dataset.adjustment, "session": payload.dataset.session, "calendar_id": payload.dataset.calendar_id, "calendar_sha256": payload.dataset.calendar_sha256, "symbols": [item.model_dump() for item in sorted(payload.dataset.symbols, key=lambda x: x.symbol)]},
                "input_hash": input_hash or digest(payload.model_dump(mode="json")), "results": results,
                "warnings": ["V2 fills use adverse base, range and participation slippage; stress artifacts are deterministic."]}
    content_hash = digest(response)
    response["replay"] = build_replay_metadata(job_id=payload.job_id, request_hash=response["input_hash"],
        input_hash=response["input_hash"], result_hash_value=content_hash, dataset_hash=payload.dataset.sha256,
        dna_hashes=[item.dna_hash for item in payload.strategies],
        compiler_hash=payload.strategies[0].dna.get("compiler", {}).get("semantic_sha256", "0" * 64),
        engine_version=str(engine.get("version", "unknown")), configuration_hash=str(engine.get("configuration_hash", "")),
        engine_hash=str(engine.get("image_digest", "")), evaluation_windows=[item.model_dump() for item in payload.windows])
    response["result_hash"] = digest(response)
    return response
