"""Version 2 authoritative intraday portfolio evaluator.

Backtrader owns scheduling, orders, partial fills, cash and positions. The
returned ledger is a projection of broker notifications, never a second
post-run execution simulator.
"""
from __future__ import annotations

import hashlib
import hmac
import math
from collections import defaultdict
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from statistics import median
from typing import Any, Literal
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
import backtrader as bt

from .dsl import OPS, TargetStateMachine, build_strategy_dna, canonical_json, validate_strategy_dna
from .metrics import compute_metrics
from .replay import ARTIFACT_SCHEMA_VERSION, build_replay_metadata

INITIAL_CASH = 100_000.0
RESULT_SCHEMA_VERSION = "backtest-artifact-v2"
SAFETY_WARMUP_BARS = 2
NEW_YORK = ZoneInfo("America/New_York")


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
        local = iso(self.t).astimezone(NEW_YORK)
        if min(self.o, self.h, self.l, self.c) <= 0 or self.h < max(self.o, self.l, self.c) or self.l > min(self.o, self.h, self.c):
            raise ValueError("invalid OHLC range")
        minute = local.hour * 60 + local.minute
        if local.weekday() >= 5 or minute < 9 * 60 + 30 or minute >= 16 * 60 or minute % 5:
            raise ValueError("bar timestamp is outside the regular-session five-minute grid")
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
    shard_index: int = Field(default=0, ge=0, le=10_000)
    phase: Literal["development", "holdout", "shadow"]
    strategies: list[V2Strategy] = Field(min_length=1, max_length=12)
    dataset: DatasetManifestV2
    bars_by_symbol: dict[str, list[V2Bar]]
    windows: list[V2Window] = Field(min_length=1, max_length=6)
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
        if self.phase == "development":
            anchored = sorted(window.id for window in self.windows if window.id.startswith("anchored-"))
            rolling = sorted(window.id for window in self.windows if window.id.startswith("rolling-"))
            if len(self.windows) != 6 or anchored != ["anchored-1", "anchored-2", "anchored-3"] or rolling != ["rolling-1", "rolling-2", "rolling-3"]:
                raise ValueError("development requires exactly three anchored-* and three rolling-* windows")
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
        required_warmup = 0
        for strategy in self.strategies:
            frozen = validate_strategy_dna(strategy.dna)
            required_warmup = max(required_warmup, int(frozen.warmup_bars) + self.execution.warmup_safety_bars)
            if frozen.scope["universe_id"] != self.dataset.universe_id or frozen.scope["universe_sha256"] != self.dataset.universe_sha256:
                raise ValueError("strategy scope does not match immutable dataset universe")
            if not set(frozen.scope["symbols"]).issubset(available):
                raise ValueError("strategy scope contains a symbol missing from immutable dataset")
        if self.phase == "development":
            minimum = 2 * required_warmup + 2
            for window in self.windows:
                observations = sum(1 for stamp in sorted(set(all_stamps), key=iso) if iso(window.start) <= iso(stamp) < iso(window.end))
                if observations < minimum:
                    raise ValueError(f"development window {window.id} is too short for purge/embargo and dynamic warmup")
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


def _simulate_v2_ledger(dna: dict[str, Any], bars_by_symbol: dict[str, list[dict[str, Any]]], window: V2Window, config: ExecutionConfigV2, *, stress: bool = False, target_multiplier: float = 1.0, gap_stress: bool = False) -> dict[str, Any]:
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
        if gap_stress: slippage += .001
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
            if gap_stress: slippage += .001
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
        # Apply execution sensitivity before collective normalisation so a
        # 1.10 scenario can never exceed the immutable 0.5% gross cap.
        gross = sum(abs(target * target_multiplier) for target, _ in desired.values())
        scale = min(1.0, available_budget / gross) if gross else 1.0
        for symbol, (target, reason) in sorted(desired.items()):
            # Robustness changes execution sizing only; the frozen DSL graph
            # and DNA hash are never modified.
            normalized = target * target_multiplier * scale
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
    """Authoritative Backtrader strategy and broker-event ledger.

    Every position, cash movement and fill below originates from a Backtrader
    order notification.  Decisions are made in ``next`` after a bar closes, so
    market orders can only execute on a later eligible bar open.
    """
    params = (("dna", None), ("bars_by_symbol", None), ("window", None), ("config", None), ("stress", False), ("target_multiplier", 1.0), ("gap_stress", False))
    def __init__(self) -> None:
        self.result: dict[str, Any] | None = None
        self.frozen = validate_strategy_dna(self.p.dna)
        self.symbols = sorted(set(self.frozen.scope["symbols"]) & {data._name for data in self.datas})
        self.by_symbol = {data._name: data for data in self.datas if data._name in self.symbols}
        self.rows = {symbol: {self._canonical_stamp(row["t"]): row for row in self.p.bars_by_symbol[symbol]
                             if iso(row["t"]) >= iso(self.p.window.start) and iso(row["t"]) < iso(self.p.window.end)}
                     for symbol in self.symbols}
        self.machines = {symbol: TargetStateMachine(self.frozen) for symbol in self.symbols}
        self.warmup = int(self.frozen.warmup_bars) + self.p.config.warmup_safety_bars
        self.seen = defaultdict(int)
        self.active_orders: dict[str, Any] = {}
        self.order_sequence = 0
        self.order_meta: dict[int, dict[str, Any]] = {}
        self.order_records: dict[int, dict[str, Any]] = {}
        self.processed_bits = defaultdict(int)
        self.reversal_targets: dict[str, float] = {}
        self.latest_targets: dict[str, float] = {}
        self.signals: list[dict[str, Any]] = []; self.targets: list[dict[str, Any]] = []
        self.fills: list[dict[str, Any]] = []; self.closed: list[dict[str, Any]] = []
        self.rejected: list[dict[str, Any]] = []; self.flatten_events: list[dict[str, Any]] = []
        self.curve: list[dict[str, Any]] = []
        self.symbol_curves = {symbol: [] for symbol in self.symbols}
        self.symbol_cash = {symbol: 0.0 for symbol in self.symbols}
        self.entry_size = defaultdict(float)
        self.entry_direction = defaultdict(int)
        self.trade_extra_cost = defaultdict(float)
        self.last_signal: dict[str, tuple[float, str]] = {}
        self.last_target: dict[str, tuple[float, str]] = {}
        self.boundary_decisions: dict[str, set[str]] = {}
        self.session_final_bars: dict[str, set[str]] = {}
        for symbol, records in self.rows.items():
            grouped: dict[str, list[str]] = defaultdict(list)
            for stamp in sorted(records, key=iso): grouped[iso(stamp).date().isoformat()].append(stamp)
            # Submit a close after the penultimate completed bar; Backtrader
            # then fills it at the final regular bar's open.
            self.boundary_decisions[symbol] = {stamps[-2] for stamps in grouped.values() if len(stamps) >= 2}
            self.session_final_bars[symbol] = {stamps[-1] for stamps in grouped.values() if stamps}

    @staticmethod
    def _canonical_stamp(value: Any) -> str:
        parsed = value if isinstance(value, datetime) else iso(str(value))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")

    @staticmethod
    def _stamp(data: Any, value: float | None = None) -> str:
        number = data.datetime[0] if value is None else value
        return _V2PortfolioAdapter._canonical_stamp(bt.num2date(number).replace(tzinfo=timezone.utc))

    def _submit(self, symbol: str, target: float, stamp: str, reason: str) -> None:
        forced = reason in {"session_flatten", "unhealthy_data", "outside_regular_session", "sealed_session_forced_close"}
        if symbol in self.active_orders:
            if forced:
                self.cancel(self.active_orders.pop(symbol))
            else:
                self.latest_targets[symbol] = target
                return
        data = self.by_symbol[symbol]
        position = float(self.getposition(data).size)
        if position and target and position * target < 0:
            self.reversal_targets[symbol] = target
            target = 0.0
            reason = "flatten_first_reversal"
        # Backtrader's stocklike target-percent helper rounds through the
        # commission-info sizer. Submit the exact fractional delta explicitly;
        # the Backtrader broker still owns acceptance, partial fills, cash and
        # the resulting position.
        mark = float(data.close[0])
        desired_size = target * float(self.broker.getvalue()) / mark if mark > 0 else position
        delta = desired_size - position
        if abs(delta) < 1e-12: return
        order = self.buy(data=data, size=delta) if delta > 0 else self.sell(data=data, size=abs(delta))
        if order is None: return
        self.order_sequence += 1
        local_order_id = f"bt-order-{self.order_sequence}"
        order.addinfo(axiom_reason=reason, axiom_target=round(target, 10), axiom_order_id=local_order_id)
        self.active_orders[symbol] = order
        self.order_meta[order.ref] = {"symbol": symbol, "submitted_at": stamp, "target": target,
            "reason": reason, "order_id": local_order_id, "sequence": self.order_sequence}
        self.order_records[order.ref] = {"order_id": local_order_id, "t": stamp, "symbol": symbol,
            "target": round(target, 10), "requested_size": round(float(order.created.size), 10), "status": "submitted"}

    def notify_order(self, order: Any) -> None:
        meta = self.order_meta.get(order.ref)
        if meta is None: return
        symbol = meta["symbol"]
        bits = list(order.executed.exbits or [])
        for bit in bits[self.processed_bits[order.ref]:]:
            size = float(bit.size); broker_price = float(bit.price); broker_commission = float(bit.comm)
            stamp = self._stamp(order.data, float(bit.dt))
            row = self.rows[symbol].get(stamp, {})
            volume = max(float(row.get("v", order.data.volume[0] or 0)), 1e-12)
            participation = abs(size) / volume
            opening_price = max(float(row.get("o", broker_price)), 1e-12)
            bar_range = max(0.0, (float(row.get("h", opening_price)) - float(row.get("l", opening_price))) / opening_price)
            slip_scale = self.p.config.stress_slippage_multiplier if self.p.stress else 1.0
            required_slippage = slip_scale * (self.p.config.base_slippage_bps / 10_000
                + self.p.config.range_slippage_multiplier * bar_range
                + self.p.config.participation_slippage_multiplier * participation * .0001)
            if self.p.gap_stress: required_slippage += .001
            broker_slippage = abs(broker_price / opening_price - 1)
            extra_cost = abs(size * opening_price) * max(0.0, required_slippage - broker_slippage)
            if extra_cost:
                self.broker.add_cash(-extra_cost)
            self.trade_extra_cost[symbol] += extra_cost
            commission = broker_commission
            price = broker_price + (extra_cost / abs(size) if size > 0 else -extra_cost / abs(size))
            self.fills.append({"order_id": meta["order_id"], "t": stamp, "symbol": symbol,
                "side": "buy" if size > 0 else "sell", "size": round(size, 10), "price": round(price, 10),
                "notional": round(abs(size * price), 10), "commission": round(commission, 10),
                "supplemental_slippage_cost": round(extra_cost, 10),
                "slippage": round(abs(price / opening_price - 1), 10),
                "participation": round(participation, 10), "bar_volume": volume,
                "max_participation": self.p.config.max_participation})
            self.symbol_cash[symbol] -= size * broker_price + broker_commission + extra_cost
            self.entry_size[symbol] = max(self.entry_size[symbol], abs(float(self.getposition(order.data).size)))
        self.processed_bits[order.ref] = len(bits)
        record = self.order_records[order.ref]
        if order.status == order.Partial:
            record["status"] = "partial"
        elif order.status == order.Completed:
            record["status"] = "filled"
            if self.active_orders.get(symbol) is order:
                self.active_orders.pop(symbol, None)
            if meta["reason"] in {"session_flatten", "unhealthy_data", "outside_regular_session", "sealed_session_forced_close"}:
                self.flatten_events.append({"t": self._stamp(order.data), "symbol": symbol, "reason": meta["reason"]})
        elif order.status in {order.Canceled, order.Margin, order.Rejected, order.Expired}:
            record["status"] = order.getstatusname().lower()
            if self.active_orders.get(symbol) is order:
                self.active_orders.pop(symbol, None)
            self.rejected.append({"t": self._stamp(order.data), "symbol": symbol,
                                  "reason": f"broker_{order.getstatusname().lower()}"})

    def notify_trade(self, trade: Any) -> None:
        symbol = trade.data._name
        if trade.justopened:
            self.entry_size[symbol] = abs(float(trade.size))
            self.entry_direction[symbol] = 1 if float(trade.size) > 0 else -1
        if trade.isclosed:
            self.closed.append({"symbol": symbol,
                "opened": self._stamp(trade.data, float(trade.dtopen)),
                "closed": self._stamp(trade.data, float(trade.dtclose)),
                "size": round(self.entry_size[symbol] * self.entry_direction[symbol], 10), "pnl": round(float(trade.pnl), 10),
                "pnl_after_costs": round(float(trade.pnlcomm) - self.trade_extra_cost[symbol], 10), "bar_length": int(trade.barlen)})
            self.entry_size[symbol] = 0.0
            self.entry_direction[symbol] = 0
            self.trade_extra_cost[symbol] = 0.0

    def prenext(self) -> None: self.next()

    def next(self) -> None:
        now = max(self._stamp(data) for data in self.datas)
        available = {symbol: self.rows[symbol][now] for symbol in self.symbols if now in self.rows[symbol]}
        desired: dict[str, tuple[float, str]] = {}
        for symbol, row in available.items():
            self.seen[symbol] += 1
            decision = self.machines[symbol].step(row)
            signal = (round(float(decision["target"]), 10), str(decision["reason"]))
            if self.last_signal.get(symbol) != signal:
                self.signals.append({"t": now, "symbol": symbol, "target": signal[0], "reason": signal[1]})
                self.last_signal[symbol] = signal
            if self.seen[symbol] >= self.warmup:
                desired[symbol] = (float(decision["target"]), str(decision["reason"]))
            if now in self.boundary_decisions[symbol]:
                desired[symbol] = (0.0, "sealed_session_forced_close")
            elif now in self.session_final_bars[symbol]:
                # The flatten submitted after the penultimate close has just
                # executed at this bar's open. Never create a new position on
                # the final regular-session bar with no same-session exit.
                desired[symbol] = (0.0, "outside_regular_session")
        value_before_orders = float(self.broker.getvalue())
        unavailable_gross = sum(abs(float(self.getposition(data).size) * float(data.close[0]))
            for symbol, data in self.by_symbol.items() if symbol not in available) / max(value_before_orders, 1)
        available_budget = max(0.0, self.p.config.strategy_gross_limit - unavailable_gross)
        gross = sum(abs(target * self.p.target_multiplier) for target, _ in desired.values())
        scale = min(1.0, available_budget / gross) if gross else 1.0
        for symbol, (target, reason) in sorted(desired.items()):
            normalized = target * self.p.target_multiplier * scale
            state = (round(normalized, 10), reason)
            if self.last_target.get(symbol) != state:
                self.targets.append({"t": now, "symbol": symbol, "target": state[0], "reason": reason,
                    "execute_at": "next_eligible_bar_open"})
                self.last_target[symbol] = state
            if symbol in self.reversal_targets and self.getposition(self.by_symbol[symbol]).size:
                normalized = 0.0
            elif symbol in self.reversal_targets:
                normalized = self.reversal_targets.pop(symbol)
            self._submit(symbol, normalized, now, reason)
        value = float(self.broker.getvalue())
        exposures = {symbol: float(self.getposition(data).size) * float(data.close[0])
                     for symbol, data in self.by_symbol.items()}
        gross_exposure = sum(abs(item) for item in exposures.values()) / max(value, 1)
        signed_exposure = sum(exposures.values()) / max(value, 1)
        self.curve.append({"t": now, "value": round(value, 10), "exposure": round(gross_exposure, 10),
                           "signed_exposure": round(signed_exposure, 10)})
        allocation = self.p.config.initial_cash / max(len(self.symbols), 1)
        for symbol, data in self.by_symbol.items():
            position = float(self.getposition(data).size)
            self.symbol_curves[symbol].append({"t": now,
                "value": round(allocation + self.symbol_cash[symbol] + position * float(data.close[0]), 10),
                "exposure": round(exposures[symbol] / max(value, 1), 10)})

    def stop(self) -> None:
        for symbol, order in self.active_orders.items():
            record = self.order_records.get(order.ref)
            if record and record.get("status") == "submitted":
                record["status"] = "expired_no_next_open"
            self.rejected.append({"t": self._stamp(order.data), "symbol": symbol,
                "reason": "no_next_eligible_open_for_pending_order"})
        for symbol, data in self.by_symbol.items():
            if abs(float(self.getposition(data).size)) > 1e-10:
                self.rejected.append({"t": self._stamp(data), "symbol": symbol,
                    "reason": "no_next_eligible_open_for_forced_flatten"})
        indexed = {symbol: dict(rows) for symbol, rows in self.rows.items()}
        capacity = min((float(row["v"]) * float(row["c"]) * self.p.config.max_participation
                        for rows in indexed.values() for row in rows.values()), default=0.0)
        legacy_metrics = _metrics(self.curve, self.closed, self.fills, self.p.config.initial_cash, capacity)
        exposure_curve = [{"t": point["t"], "value": point["signed_exposure"]} for point in self.curve]
        orders = [self.order_records[key] for key in sorted(self.order_records)]
        computed = compute_metrics([{"t": point["t"], "value": point["value"]} for point in self.curve],
            self.closed, self.fills, orders, exposure_curve, per_symbol_equity=self.symbol_curves, interval_minutes=5)
        drawdown_curve = computed.pop("drawdown_curve"); turnover_curve = computed.pop("turnover_curve")
        metrics = {**legacy_metrics, **computed, "return": computed["net_return"],
            "annualized": computed["annualized_return"], "volatility": computed["bar_volatility"],
            "sharpe": computed["daily_sharpe"], "sortino": computed["daily_sortino"],
            "drawdown": computed["max_drawdown"], "win_rate": computed["hit_rate"],
            "trades": computed["closed_trades"], "drawdown_duration": computed["drawdown_duration_bars"],
            "average_trade_duration_bars": computed["mean_trade_duration_bars"],
            "capacity_proxy": computed["capacity_proxy_notional"], "exposure": computed["average_abs_exposure"]}
        metrics["regimes"] = _regime_summary(self.curve, indexed)
        metrics["positive_regimes"] = sum(1 for item in metrics["regimes"].values() if item["score"] > 0)
        metrics["concentration"] = metrics["symbol_concentration_hhi"]
        per_symbol = {symbol: {**values, "trades": sum(1 for trade in self.closed if trade.get("symbol") == symbol)}
                      for symbol, values in metrics["per_symbol_stability"].items()}
        sampled = _sample_curve(self.curve, 512)
        sampled_exposure = [{"t": point["t"], "value": point["signed_exposure"]} for point in sampled]
        self.result = {"metrics": metrics, "portfolio_curve": sampled,
            "equity_curve": [{"t": point["t"], "value": point["value"]} for point in sampled],
            "exposure_curve": sampled_exposure, "signed_exposure_curve": sampled_exposure,
            "drawdown_curve": _sample_curve(drawdown_curve, 512), "turnover_curve": _sample_curve(turnover_curve, 512),
            "per_symbol_curves": {symbol: _sample_curve(rows, 128) for symbol, rows in self.symbol_curves.items()},
            "per_symbol": per_symbol, "signals": self.signals, "targets": self.targets, "orders": orders,
            "fills": self.fills, "closed_trades": self.closed, "rejected_fills": self.rejected,
            "session_flatten_events": self.flatten_events, "warmup_bars": self.warmup,
            "broker": {"cash": round(float(self.broker.getcash()), 10),
                "value": round(float(self.broker.getvalue()), 10),
                "positions": {symbol: round(float(self.getposition(data).size), 10)
                              for symbol, data in self.by_symbol.items()}},
            "warnings": (["No closed trades in this window."] if not self.closed else [])
                + (["Partial or rejected fills occurred."] if self.rejected else [])}


def simulate_v2(dna: dict[str, Any], bars_by_symbol: dict[str, list[dict[str, Any]]], window: V2Window, config: ExecutionConfigV2, *, stress: bool = False, target_multiplier: float = 1.0, gap_stress: bool = False) -> dict[str, Any]:
    """Run the sealed multi-data request through Backtrader's authoritative lifecycle."""
    cerebro = bt.Cerebro(stdstats=False)
    for symbol in sorted(bars_by_symbol):
        rows = [row for row in bars_by_symbol[symbol] if iso(row["t"]) >= iso(window.start) and iso(row["t"]) < iso(window.end)]
        if rows: cerebro.adddata(_V2BarFeed(bars=rows), name=symbol)
    cerebro.broker.setcash(config.initial_cash)
    cerebro.broker.setcommission(commission=config.costs.commission_bps / 10_000)
    slip = (config.base_slippage_bps / 10_000) * (config.stress_slippage_multiplier if stress else 1.0)
    if gap_stress: slip += .001
    cerebro.broker.set_slippage_perc(slip, slip_open=True, slip_match=True, slip_out=False)
    row_maps = {symbol: {_V2PortfolioAdapter._canonical_stamp(row["t"]): row for row in rows}
                for symbol, rows in bars_by_symbol.items()}
    delayed: dict[int, int] = defaultdict(int)
    def participation_filler(order: Any, price: float, ago: int) -> float:
        stamp = _V2PortfolioAdapter._stamp(order.data, float(order.data.datetime[ago]))
        row = row_maps.get(order.data._name, {}).get(stamp)
        if row is None or not _healthy(row, float(validate_strategy_dna(dna).risk["minimum_data_coverage"])):
            return 0.0
        forced = order.info.get("axiom_reason") in {
            "session_flatten", "unhealthy_data", "outside_regular_session", "sealed_session_forced_close"}
        if stress and not forced and delayed[order.ref] < config.stress.delayed_bars:
            delayed[order.ref] += 1; return 0.0
        if stress and not forced:
            miss_key = int(digest({"symbol": order.data._name, "t": stamp,
                "target": order.info.get("axiom_target"),
                "order_id": order.info.get("axiom_order_id")})[:8], 16) / 0xFFFFFFFF
            if miss_key < config.stress.missed_fill_probability:
                return 0.0
        remaining = abs(float(order.executed.remsize))
        if forced: return remaining
        return min(remaining, float(row["v"]) * config.max_participation)
    cerebro.broker.set_filler(participation_filler)
    cerebro.addstrategy(_V2PortfolioAdapter, dna=dna, bars_by_symbol=bars_by_symbol, window=window, config=config, stress=stress, target_multiplier=target_multiplier, gap_stress=gap_stress)
    result = cerebro.run(runonce=False, preload=True)[0].result
    if result is None: raise RuntimeError("Backtrader v2 adapter produced no artifact")
    result["execution_adapter"] = "backtrader-broker-authoritative-v2"
    return result


ROBUSTNESS_EVIDENCE_VERSION = "development-robustness-v1"


def _window_stamps(bars_by_symbol: dict[str, list[dict[str, Any]]], window: V2Window) -> list[str]:
    return sorted({row["t"] for rows in bars_by_symbol.values() for row in rows
                   if iso(row["t"]) >= iso(window.start) and iso(row["t"]) < iso(window.end)}, key=iso)


def fold_manifest(dna: dict[str, Any], bars_by_symbol: dict[str, list[dict[str, Any]]], window: V2Window, config: ExecutionConfigV2) -> tuple[dict[str, Any], V2Window]:
    """Create a self-contained fold with no inherited indicator/position state."""
    warmup = int(validate_strategy_dna(dna).warmup_bars) + config.warmup_safety_bars
    stamps = _window_stamps(bars_by_symbol, window)
    purge = warmup
    embargo = warmup
    # Purge all observations that could carry a feature dependency from the
    # preceding fold.  The embargo is recorded explicitly even though each
    # fold starts a fresh strategy/broker instance and has no train state.
    start_index = min(len(stamps) - 1, purge + embargo) if stamps else 0
    effective_start = stamps[start_index] if stamps else window.start
    effective = V2Window(id=window.id, start=effective_start, end=window.end)
    manifest = {"schema_version": "fold-manifest-v1", "id": window.id,
                "requested": window.model_dump(), "effective": effective.model_dump(),
                "warmup_bars": warmup, "purge_bars": purge, "embargo_bars": embargo,
                "state_reset": {"indicator": True, "target": True, "portfolio": True, "broker": True},
                "observations_before": len(stamps), "observations_after": max(0, len(stamps) - start_index),
                "hash": ""}
    manifest["hash"] = digest({key: value for key, value in manifest.items() if key != "hash"})
    return manifest, effective


def _flat_baseline(window: V2Window, bars_by_symbol: dict[str, list[dict[str, Any]]], initial_cash: float) -> dict[str, Any]:
    curve = [{"t": stamp, "value": initial_cash} for stamp in _window_stamps(bars_by_symbol, window)]
    metrics = compute_metrics(curve, [], [], [], [], interval_minutes=5)
    return {"name": "flat_cash_precommitted", "metrics": metrics,
            "activity": {"signals": 0, "targets": 0, "fills": 0, "closed_trades": 0}}


def _permuted_return_null(base: dict[str, Any], dna_hash: str, window: V2Window, initial_cash: float) -> dict[str, Any]:
    """A bounded, drift-free null built from completed development returns.

    A plain permutation preserves mean/volatility and therefore preserves
    Sharpe exactly. Centering before the deterministic cyclic permutation
    removes the observed drift while retaining its volatility and tail shape.
    """
    points = base.get("equity_curve", [])
    returns = [points[index]["value"] / points[index - 1]["value"] - 1 for index in range(1, len(points))
               if points[index - 1]["value"] > 0]
    seed = digest({"dna_hash": dna_hash, "window": window.model_dump(), "null": "cyclic-return-permutation-v1"})
    offset = int(seed[:8], 16) % len(returns) if returns else 0
    average = sum(returns) / len(returns) if returns else 0.0
    shuffled = [item - average for item in (returns[offset:] + returns[:offset])]
    curve = []
    value = initial_cash
    stamps = [point["t"] for point in points]
    if stamps: curve.append({"t": stamps[0], "value": value})
    for index, item in enumerate(shuffled, 1):
        value *= 1 + item
        curve.append({"t": stamps[min(index, len(stamps) - 1)], "value": value})
    return {"name": "centered_cyclic_permuted_return_null_precommitted", "seed_hash": seed,
            "metrics": compute_metrics(curve, [], [], [], [], interval_minutes=5),
            "activity": {"signals": 0, "targets": 0, "fills": 0, "closed_trades": 0}}


def _deterministic_gap_bars(bars_by_symbol: dict[str, list[dict[str, Any]]]) -> dict[str, list[dict[str, Any]]]:
    """Remove sparse fixed bars and mark the following observation unhealthy.

    The schedule is a precommitted index rule (every 37th interior bar), not a
    response to returns or strategy performance.  It models a modest feed gap
    without creating an unbounded alternate dataset.
    """
    output: dict[str, list[dict[str, Any]]] = {}
    for symbol in sorted(bars_by_symbol):
        result = []
        for index, source in enumerate(bars_by_symbol[symbol]):
            if index > 0 and index % 37 == 18:
                continue
            row = dict(source)
            if index > 0 and (index - 1) % 37 == 18:
                row["data_health"], row["data_coverage"] = "gapped", .89
            result.append(row)
        output[symbol] = result
    return output


def _compact_evidence(run: dict[str, Any]) -> dict[str, Any]:
    """Keep evidence bounded; raw bars are never copied into a robustness artifact."""
    return {"metrics": run["metrics"], "activity": {"signals": len(run["signals"]), "targets": len(run["targets"]),
            "fills": len(run["fills"]), "closed_trades": len(run["closed_trades"]),
            "rejected_fills": len(run["rejected_fills"])}, "warnings": run["warnings"],
            "per_symbol": run.get("per_symbol", {})}


def _development_coverage(bars_by_symbol: dict[str, list[dict[str, Any]]], window: V2Window) -> float:
    values = [float(row.get("data_coverage", 1.0))
              for rows in bars_by_symbol.values() for row in rows
              if iso(row["t"]) >= iso(window.start) and iso(row["t"]) < iso(window.end)]
    return round(sum(values) / len(values), 10) if values else 0.0


def _derived_warmup(features: list[dict[str, Any]]) -> int:
    """Recompute the DSL warmup after a bounded parameter perturbation."""
    lookbacks: dict[str, int] = {}
    derived = 0
    for node in features:
        op = node["op"]
        params = node.get("params", {})
        if op in {"simple_return", "log_return", "rate_of_change"}:
            own = int(params.get("lag", 1))
        elif op == "gap_return":
            own = 0
        elif OPS[op].window:
            own = int(params["window"]) + (1 if op in {"rolling_high_distance", "rolling_low_distance"} else 0)
        else:
            own = 0
        lookbacks[node["id"]] = own
        derived = max(derived, own + max((lookbacks[source] for source in node.get("inputs", [])), default=0))
    return derived


def _strategy_parameter_variants(dna: dict[str, Any]) -> list[dict[str, Any]]:
    """Build two frozen, deterministic variants of the first tunable alpha parameter.

    Variants are evidence only: the candidate DNA, hash and supervisor input
    remain unchanged. Window/lag parameters are preferred over constants so
    this measures rule sensitivity instead of merely rescaling exposure.
    """
    original = validate_strategy_dna(dna)
    selected: tuple[int, str] | None = None
    for key in ("window", "lag"):
        selected = next(((index, key) for index, node in enumerate(dna["features"]) if key in node.get("params", {})), None)
        if selected:
            break
    if selected is None:
        return []
    index, key = selected
    current = int(dna["features"][index]["params"][key])
    low = 2 if key == "window" else 1
    candidates = [max(low, current - max(1, round(current * .10))), min(252, current + max(1, round(current * .10)))]
    variants = []
    for value in dict.fromkeys(candidates):
        if value == current:
            continue
        document = deepcopy(dna)
        document["features"][index]["params"][key] = value
        document["warmup_bars"] = _derived_warmup(document["features"])
        frozen = build_strategy_dna(document)
        variants.append({"node_id": document["features"][index]["id"], "parameter": key,
                         "original_value": current, "perturbed_value": value,
                         "original_dna_hash": original.dna_hash, "variant": frozen})
    return variants


def development_evidence(dna: dict[str, Any], bars_by_symbol: dict[str, list[dict[str, Any]]], window: V2Window, config: ExecutionConfigV2, base: dict[str, Any], stress: dict[str, Any]) -> dict[str, Any]:
    """Precommitted, bounded development-only robustness evidence.

    This runs only for a selected completed development fold.  It never edits
    DNA and has no holdout branch, preventing the evidence from becoming a
    tuning loop over sealed performance.
    """
    symbols = sorted(set(validate_strategy_dna(dna).scope["symbols"]) & set(bars_by_symbol))
    target_sensitivity = []
    for multiplier in (.90, 1.10):
        run = simulate_v2(dna, bars_by_symbol, window, config, target_multiplier=multiplier)
        target_sensitivity.append({"name": f"execution_target_scale_{multiplier:.2f}", "target_multiplier": multiplier,
                              "frozen_dna_hash": validate_strategy_dna(dna).dna_hash, "result": _compact_evidence(run)})
    parameter_perturbations = []
    for variant in _strategy_parameter_variants(dna):
        run = simulate_v2(variant["variant"], bars_by_symbol, window, config)
        parameter_perturbations.append({key: value for key, value in variant.items() if key != "variant"}
                                       | {"variant_dna_hash": variant["variant"]["dna_hash"], "result": _compact_evidence(run)})
    groups = [symbols[::2], symbols[1::2]]
    leave_group_out = []
    for index, group in enumerate(groups):
        remaining = {symbol: rows for symbol, rows in bars_by_symbol.items() if symbol not in group}
        if not group or not remaining: continue
        run = simulate_v2(dna, remaining, window, config)
        leave_group_out.append({"group_id": f"deterministic-parity-{index + 1}", "excluded_symbols": group,
                                "remaining_symbols": sorted(remaining), "result": _compact_evidence(run)})
    gap = simulate_v2(dna, _deterministic_gap_bars(bars_by_symbol), window, config, gap_stress=True)
    evidence = {"schema_version": ROBUSTNESS_EVIDENCE_VERSION, "scope": "development_only_final_fold",
                "coverage": _development_coverage(bars_by_symbol, window), "critical_faults": [],
                "base": _compact_evidence(base), "stress": _compact_evidence(stress),
                "null_baseline": _flat_baseline(window, bars_by_symbol, config.initial_cash),
                "permuted_return_null": _permuted_return_null(base, validate_strategy_dna(dna).dna_hash, window, config.initial_cash),
                "execution_target_sensitivity": target_sensitivity, "parameter_perturbations": parameter_perturbations,
                "leave_symbol_group_out": leave_group_out,
                "moderate_gap_stress": {"adverse_open_gap_bps": 10, "gap_schedule": "drop_every_37th_interior_bar_mark_next_gapped", "result": _compact_evidence(gap)},
                "protocol": {"candidate_dna_mutated": False, "adaptive_selection": False,
                             "strategy_parameter_perturbations": "up to two deterministic frozen evidence-only variants of the first tunable alpha parameter",
                             "max_symbol_groups": 2,
                             "deterministic_symbol_order": symbols}, "hash": ""}
    evidence["hash"] = digest({key: value for key, value in evidence.items() if key != "hash"})
    return evidence


def run_v2(payload: BacktestRequestV2, *, engine: dict[str, Any], input_hash: str | None = None) -> dict[str, Any]:
    canonical_bars = {symbol: [row.model_dump(exclude_none=True) for row in payload.bars_by_symbol[symbol]] for symbol in sorted(payload.bars_by_symbol)}
    results = []
    for strategy in payload.strategies:
        base_dna = strategy.dna
        windows = []
        for window in payload.windows:
            if payload.phase == "development":
                manifest, effective_window = fold_manifest(base_dna, canonical_bars, window, payload.execution)
            else:
                effective_window = window
                manifest = {"schema_version": "fold-manifest-v1", "id": window.id,
                            "requested": window.model_dump(), "effective": window.model_dump(),
                            "warmup_bars": int(validate_strategy_dna(base_dna).warmup_bars) + payload.execution.warmup_safety_bars,
                            "purge_bars": 0, "embargo_bars": 0,
                            "state_reset": {"indicator": True, "target": True, "portfolio": True, "broker": True},
                            "observations_before": len(_window_stamps(canonical_bars, window)),
                            "observations_after": len(_window_stamps(canonical_bars, window)), "hash": ""}
                manifest["hash"] = digest({key: value for key, value in manifest.items() if key != "hash"})
            ideal = simulate_v2(base_dna, canonical_bars, effective_window, payload.execution, stress=False)
            stress = simulate_v2(base_dna, canonical_bars, effective_window, payload.execution, stress=True)
            windows.append({"window_id": window.id, "fold_manifest": manifest, "ideal": ideal, "stress": stress,
                            "approved_artifact": "stress", "metrics": stress["metrics"]})
        if payload.phase == "development" and windows:
            # Bounded by one final fold per strategy: 12 strategies x at most
            # 40 symbols remains tractable while evidence stays comparable.
            final = windows[-1]
            final["development_evidence"] = development_evidence(base_dna, canonical_bars,
                V2Window(**final["fold_manifest"]["effective"]), payload.execution, final["ideal"], final["stress"])
        elif windows:
            # Holdout only reports precommitted, non-adaptive base/stress facts.
            sealed = windows[0]
            sealed["holdout_evidence"] = {"schema_version": "holdout-evidence-v1", "adaptive_robustness": False,
                "base": _compact_evidence(sealed["ideal"]), "stress": _compact_evidence(sealed["stress"]),
                "degradation": {"net_return_delta": round(sealed["stress"]["metrics"]["return"] - sealed["ideal"]["metrics"]["return"], 10),
                                "sharpe_delta": round(sealed["stress"]["metrics"]["daily_sharpe"] - sealed["ideal"]["metrics"]["daily_sharpe"], 10)},
                "hash": ""}
            sealed["holdout_evidence"]["hash"] = digest({key: value for key, value in sealed["holdout_evidence"].items() if key != "hash"})
        results.append({"strategy_id": strategy.id, "strategy_format": strategy.strategy_format, "dna_hash": strategy.dna_hash, "compiler": base_dna.get("compiler"), "windows": windows})
    response = {"schema_version": ARTIFACT_SCHEMA_VERSION, "artifact_schema_version": ARTIFACT_SCHEMA_VERSION,
                "execution_contract_version": payload.execution.version,
                "metrics_schema_version": "intraday-metrics-v2", "robustness_evidence_version": ROBUSTNESS_EVIDENCE_VERSION,
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
