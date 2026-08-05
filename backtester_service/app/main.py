from __future__ import annotations

import hashlib
import hmac
import json
import math
import os
import time
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any, Literal

import backtrader as bt
from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .dsl import MANIFEST as DSL_COMPILER_MANIFEST, TargetStateMachine, canonical_json as dsl_canonical_json, validate_strategy_dna
from .v2 import BacktestRequestV2, run_v2

ENGINE_NAME = "backtrader"
ENGINE_VERSION = "1.9.78.123"
WARMUP_BARS = 52
INITIAL_CASH = 100_000.0
SLIPPAGE = 0.0005
REGIMES = ("Expansion", "Compression", "Stress", "Recovery")
ALLOWED_ARCHETYPES = {"Momentum", "Mean reversion", "Breakout", "Volatility filter"}
REPLAY_WINDOW_SECONDS = 300
REPLAY_CACHE: dict[str, tuple[float, str]] = {}

APPROVED_CONFIG = {
    "initial_cash": 100000, "fill": "next_bar_open", "allow_short": True,
    "slippage_bps": 5, "commission": 0, "warmup_bars": 52,
    "annualization": 252, "risk_free_rate": 0,
}


def canonical_json(value: Any) -> bytes:
    return dsl_canonical_json(value)


def digest(value: Any) -> str:
    return hashlib.sha256(canonical_json(value)).hexdigest()


def finite(value: float) -> float:
    if not math.isfinite(value):
        raise ValueError("numeric values must be finite")
    return value


class Bar(BaseModel):
    model_config = ConfigDict(extra="forbid")
    t: str
    o: float
    h: float
    l: float
    c: float
    v: float = 0
    regime: str | None = None
    session_close: str | None = None
    data_health: Literal["healthy", "delayed", "gapped", "revising", "closed", "unknown"] | None = None
    data_coverage: float | None = Field(default=None, ge=0, le=1)
    interval_minutes: int = Field(default=5, ge=1, le=1440)

    @field_validator("o", "h", "l", "c", "v")
    @classmethod
    def valid_number(cls, value: float) -> float:
        finite(value)
        if value < 0:
            raise ValueError("bar values cannot be negative")
        return value

    @model_validator(mode="after")
    def valid_ohlc(self) -> "Bar":
        if min(self.o, self.h, self.l, self.c) <= 0:
            raise ValueError("OHLC values must be positive")
        if self.h < max(self.o, self.l, self.c) or self.l > min(self.o, self.h, self.c):
            raise ValueError("invalid OHLC range")
        try:
            parsed = datetime.fromisoformat(self.t.replace("Z", "+00:00"))
        except ValueError as exc:
            raise ValueError("t must be an ISO-8601 timestamp") from exc
        if parsed.tzinfo is None:
            raise ValueError("t must include a timezone")
        return self


class DatasetManifest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    snapshot_id: str = Field(min_length=1, max_length=200)
    symbol: str = Field(min_length=1, max_length=32)
    timeframe: str = Field(min_length=1, max_length=32)
    start: str
    end: str
    bar_count: int = Field(ge=1)
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")


class StrategyDNA(BaseModel):
    model_config = ConfigDict(extra="forbid")
    strategy_format: Literal["legacy-archetype-v0"] = "legacy-archetype-v0"
    id: str = Field(min_length=1, max_length=200)
    asset: str = Field(min_length=1, max_length=32)
    archetype: str
    params: dict[str, float | int]
    dna_hash: str = Field(pattern=r"^[a-f0-9]{64}$")

    @model_validator(mode="before")
    @classmethod
    def verify_frozen_hash(cls, value: Any) -> Any:
        if isinstance(value, dict):
            expected = digest({key: value.get(key) for key in ("id", "asset", "archetype", "params")})
            if not hmac.compare_digest(expected, str(value.get("dna_hash", ""))):
                raise ValueError("dna_hash does not match frozen strategy DNA")
        return value

    @model_validator(mode="after")
    def valid_strategy(self) -> "StrategyDNA":
        if self.archetype not in ALLOWED_ARCHETYPES:
            raise ValueError(f"unknown archetype: {self.archetype}")
        required = {
            "Momentum": {"fast", "slow", "threshold", "position_size"},
            "Mean reversion": {"lookback", "entry_z", "exit_z", "position_size"},
            "Breakout": {"lookback", "buffer", "position_size"},
            "Volatility filter": {"lookback", "vol_ceiling", "threshold", "position_size"},
        }[self.archetype]
        if not required.issubset(self.params):
            raise ValueError(f"missing parameters: {', '.join(sorted(required - set(self.params)))}")
        if not 0 < float(self.params["position_size"]) <= 1:
            raise ValueError("position_size must be between 0 and 1")
        for key, value in self.params.items():
            if isinstance(value, bool) or not math.isfinite(float(value)):
                raise ValueError(f"{key} must be a finite number")
        if "lookback" in self.params and int(self.params["lookback"]) < 2:
            raise ValueError("lookback must be at least 2")
        if self.archetype == "Momentum" and int(self.params["fast"]) >= int(self.params["slow"]):
            raise ValueError("Momentum fast must be less than slow")
        if self.archetype == "Momentum" and int(self.params["fast"]) < 2:
            raise ValueError("Momentum fast must be at least 2")
        for key in ("threshold", "entry_z", "exit_z", "buffer"):
            if key in self.params and float(self.params[key]) < 0:
                raise ValueError(f"{key} cannot be negative")
        if "vol_ceiling" in self.params and float(self.params["vol_ceiling"]) <= 0:
            raise ValueError("vol_ceiling must be positive")
        return self


class DSLStrategyDNA(BaseModel):
    model_config = ConfigDict(extra="forbid")
    strategy_format: Literal["dsl-v1"]
    id: str = Field(min_length=1, max_length=200)
    asset: str = Field(min_length=1, max_length=32)
    dna: dict[str, Any]
    dna_hash: str = Field(pattern=r"^[a-f0-9]{64}$")

    @model_validator(mode="after")
    def valid_dsl(self) -> "DSLStrategyDNA":
        frozen = validate_strategy_dna(self.dna)
        if not hmac.compare_digest(frozen.dna_hash, self.dna_hash):
            raise ValueError("envelope dna_hash does not match DSL document")
        if self.asset not in frozen.scope["symbols"]:
            raise ValueError("dataset asset is outside the frozen DSL scope")
        return self


class Window(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=100)
    start: int = Field(ge=0)
    end: int = Field(gt=0)


class ExecutionConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    initial_cash: float = INITIAL_CASH
    fill: Literal["next_bar_open"] = "next_bar_open"
    slippage_bps: float = 5.0
    commission: float = 0.0
    warmup_bars: int = WARMUP_BARS
    allow_short: bool = True
    annualization: int = 252
    risk_free_rate: float = 0.0

    @model_validator(mode="after")
    def defaults_only(self) -> "ExecutionConfig":
        if self.initial_cash != INITIAL_CASH or self.slippage_bps != 5 or self.commission != 0 or self.warmup_bars != WARMUP_BARS:
            raise ValueError("this service only supports the approved execution configuration")
        if not self.allow_short or self.annualization != 252 or self.risk_free_rate != 0:
            raise ValueError("allow_short=true, annualization=252 and risk_free_rate=0 are required")
        return self


class BacktestRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    job_id: str = Field(min_length=1, max_length=200)
    phase: Literal["development", "holdout", "shadow"]
    strategies: list[StrategyDNA | DSLStrategyDNA] = Field(min_length=1, max_length=12)
    dataset: DatasetManifest
    bars: list[Bar] = Field(min_length=WARMUP_BARS + 2)
    windows: list[Window] = Field(min_length=1, max_length=3)
    execution: ExecutionConfig = Field(default_factory=ExecutionConfig)

    @model_validator(mode="before")
    @classmethod
    def verify_submitted_bars_hash(cls, value: Any) -> Any:
        if isinstance(value, dict) and isinstance(value.get("dataset"), dict) and isinstance(value.get("bars"), list):
            if not hmac.compare_digest(str(value["dataset"].get("sha256", "")), digest(value["bars"])):
                raise ValueError("dataset bar count or sha256 does not match submitted bars")
        return value

    @model_validator(mode="after")
    def validate_dataset(self) -> "BacktestRequest":
        bars = self.bars
        if self.dataset.bar_count != len(bars):
            raise ValueError("dataset bar count or sha256 does not match submitted bars")
        stamps = [item.t for item in self.bars]
        if stamps != sorted(stamps) or len(set(stamps)) != len(stamps):
            raise ValueError("bars must have strictly increasing timestamps")
        if self.dataset.start != stamps[0] or self.dataset.end != stamps[-1]:
            raise ValueError("dataset bounds do not match submitted bars")
        if any(strategy.asset != self.dataset.symbol for strategy in self.strategies):
            raise ValueError("every strategy must match the sealed single-symbol dataset")
        seen: set[str] = set()
        for window in self.windows:
            if window.id in seen or window.end > len(bars) or window.end - window.start < WARMUP_BARS + 2:
                raise ValueError("invalid evaluation window")
            seen.add(window.id)
        if self.phase == "development" and len(self.windows) != 3:
            raise ValueError("development requests require exactly three rolling windows")
        if self.phase == "holdout" and (len(self.windows) != 1
                                         or self.windows[0].start != 0
                                         or self.windows[0].end != len(bars)):
            raise ValueError("holdout requests require one window covering the entire sealed slice")
        return self


class BarFeed(bt.feed.DataBase):
    params = (("bars", None),)

    def __init__(self) -> None:
        self._index = 0

    def start(self) -> None:
        super().start()
        self._index = 0

    def _load(self) -> bool:
        if self._index >= len(self.p.bars):
            return False
        row = self.p.bars[self._index]
        timestamp = datetime.fromisoformat(row["t"].replace("Z", "+00:00")).astimezone(timezone.utc).replace(tzinfo=None)
        self.lines.datetime[0] = bt.date2num(timestamp)
        self.lines.open[0] = row["o"]
        self.lines.high[0] = row["h"]
        self.lines.low[0] = row["l"]
        self.lines.close[0] = row["c"]
        self.lines.volume[0] = row["v"]
        self._index += 1
        return True


class FractionalCommissionInfo(bt.CommissionInfo):
    """Backtrader's stock sizing floors to whole shares; research targets require fractions."""
    def getsize(self, price: float, cash: float) -> float:
        return self.p.leverage * (cash / price) if price else 0.0


def mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def stdev(values: list[float]) -> float:
    if len(values) < 2:
        return 0.0
    average = mean(values)
    return math.sqrt(mean([(value - average) ** 2 for value in values]))


def strategy_signal(archetype: str, params: dict[str, float | int], prices: list[float]) -> int:
    """Exact port of worker/engine.js's signal rules; exit_z intentionally remains unused."""
    if archetype == "Momentum":
        if len(prices) < int(params["slow"]):
            return 0
        fast = mean(prices[-int(params["fast"]):])
        slow = mean(prices[-int(params["slow"]):])
        delta = fast / slow - 1
        return 1 if delta > float(params["threshold"]) else -1 if delta < -float(params["threshold"]) else 0
    if archetype == "Mean reversion":
        if len(prices) < int(params["lookback"]):
            return 0
        window = prices[-int(params["lookback"]):]
        sigma = stdev(window) or 1
        zscore = (prices[-1] - mean(window)) / sigma
        return -1 if zscore > float(params["entry_z"]) else 1 if zscore < -float(params["entry_z"]) else 0
    if archetype == "Breakout":
        lookback = int(params["lookback"])
        if len(prices) <= lookback:
            return 0
        prior = prices[-lookback - 1:-1]
        return 1 if prices[-1] > max(prior) * (1 + float(params["buffer"])) else -1 if prices[-1] < min(prior) * (1 - float(params["buffer"])) else 0
    lookback = int(params["lookback"])
    if len(prices) < lookback + 1:
        return 0
    returns = [prices[index] / prices[index - 1] - 1 for index in range(len(prices) - lookback + 1, len(prices))]
    realized = stdev(returns) * math.sqrt(252)
    trend = prices[-1] / prices[-lookback] - 1
    if realized > float(params["vol_ceiling"]):
        return 0
    return 1 if trend > float(params["threshold"]) else -1 if trend < -float(params["threshold"]) else 0


class FrozenDNA(bt.Strategy):
    params = (("dna", None), ("bars", None), ("warmup", WARMUP_BARS))

    def __init__(self) -> None:
        self.closes: list[float] = []
        self.orders: list[dict[str, Any]] = []
        self.fills: list[dict[str, Any]] = []
        self.closed_trades: list[dict[str, Any]] = []
        self.equity_curve: list[dict[str, Any]] = []
        self.exposure_curve: list[dict[str, Any]] = []
        self.pending_order: bt.Order | None = None
        self.target_exposure = 0.0
        self.dsl_machine = TargetStateMachine(self.p.dna["dna"]) if self.p.dna.get("strategy_format") == "dsl-v1" else None

    def next(self) -> None:
        self.closes.append(float(self.data.close[0]))
        current_index = len(self.closes) - 1
        target = 0.0
        signal = 0
        if self.dsl_machine is not None:
            decision = self.dsl_machine.step(dict(self.p.bars[current_index]))
            if current_index >= self.p.warmup:
                target = float(decision["target"])
                signal = 1 if target > 0 else -1 if target < 0 else 0
        elif current_index >= self.p.warmup:
            signal = strategy_signal(self.p.dna["archetype"], self.p.dna["params"], self.closes)
            target = signal * float(self.p.dna["params"]["position_size"])
        value = self.broker.getvalue()
        if current_index >= self.p.warmup and self.pending_order is None and abs(target - self.target_exposure) > 0.0001:
            order = self.order_target_percent(target=target)
            if order:
                self.pending_order = order
                self.target_exposure = target
                self.orders.append({
                    "order_ref": order.ref, "signal_time": self.data.datetime.datetime(0).replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z"),
                    "signal": signal, "target_exposure": round(target, 8), "status": "submitted",
                })
        timestamp = self.data.datetime.datetime(0).replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")
        exposure = (self.position.size * self.data.close[0] / value) if value else 0.0
        self.equity_curve.append({"t": timestamp, "value": round(value, 8)})
        self.exposure_curve.append({"t": timestamp, "value": round(exposure, 8)})

    def notify_order(self, order: bt.Order) -> None:
        if order.status not in (order.Completed, order.Canceled, order.Margin, order.Rejected):
            return
        status = order.getstatusname().lower()
        for record in self.orders:
            if record["order_ref"] == order.ref:
                record["status"] = status
                record["completed_time"] = self.data.datetime.datetime(0).replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")
                break
        if order.status == order.Completed:
            self.fills.append({
                "order_ref": order.ref,
                "t": self.data.datetime.datetime(0).replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z"),
                "side": "buy" if order.isbuy() else "sell",
                "size": round(float(order.executed.size), 8),
                "price": round(float(order.executed.price), 8),
                "value": round(float(order.executed.value), 8),
                "commission": round(float(order.executed.comm), 8),
            })
        elif order.status in (order.Canceled, order.Margin, order.Rejected):
            value = self.broker.getvalue()
            self.target_exposure = (self.position.size * self.data.close[0] / value) if value else 0.0
        if self.pending_order is not None and order.ref == self.pending_order.ref:
            self.pending_order = None

    def notify_trade(self, trade: bt.Trade) -> None:
        if trade.isclosed:
            self.closed_trades.append({
                "opened": bt.num2date(trade.dtopen).replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z"),
                "closed": bt.num2date(trade.dtclose).replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z"),
                "size": round(float(trade.size), 8),
                "pnl": round(float(trade.pnl), 8),
                "pnl_after_costs": round(float(trade.pnlcomm), 8),
                "bar_length": trade.barlen,
            })


def regimes_for(bars: list[dict[str, Any]]) -> list[str]:
    prices = [float(bar["c"]) for bar in bars]
    values: list[str] = []
    for index, price in enumerate(prices):
        if bars[index].get("regime") in REGIMES:
            values.append(bars[index]["regime"])
        elif index < 20:
            values.append("Compression")
        else:
            window = prices[index - 20:index + 1]
            returns = [window[i] / window[i - 1] - 1 for i in range(1, len(window))]
            trend = price / window[0] - 1
            volatility = stdev(returns) * math.sqrt(252)
            values.append("Expansion" if trend > .04 else "Stress" if trend < -.04 else "Compression" if volatility < .13 else "Recovery")
    return values


def run_window(dna: StrategyDNA | DSLStrategyDNA, bars: list[dict[str, Any]], config: ExecutionConfig) -> dict[str, Any]:
    feed = BarFeed(bars=bars)
    cerebro = bt.Cerebro(stdstats=False)
    cerebro.adddata(feed)
    cerebro.addstrategy(FrozenDNA, dna=dna.model_dump(exclude={"dna_hash"}), bars=bars, warmup=config.warmup_bars)
    cerebro.broker.setcash(config.initial_cash)
    cerebro.broker.addcommissioninfo(FractionalCommissionInfo(commission=config.commission))
    cerebro.broker.set_slippage_perc(perc=config.slippage_bps / 10_000, slip_open=True, slip_match=True, slip_out=False)
    strategy = cerebro.run()[0]
    curve = strategy.equity_curve
    values = [point["value"] for point in curve]
    all_returns = [values[i] / values[i - 1] - 1 for i in range(1, len(values)) if values[i - 1] > 0]
    returns = all_returns[config.warmup_bars:]
    equity = values[-1] if values else config.initial_cash
    peak = config.initial_cash
    max_drawdown = 0.0
    for value in values:
        peak = max(peak, value)
        max_drawdown = max(max_drawdown, 1 - value / peak)
    closed = strategy.closed_trades
    winners = [trade["pnl_after_costs"] for trade in closed if trade["pnl_after_costs"] > 0]
    losers = [trade["pnl_after_costs"] for trade in closed if trade["pnl_after_costs"] < 0]
    profit_factor = sum(winners) / max(abs(sum(losers)), 0.0001)
    interval_minutes = float(bars[0].get("interval_minutes", 5 if isinstance(dna, DSLStrategyDNA) else 1440)) if bars else 1440
    periods_per_year = config.annualization * (390 / interval_minutes if interval_minutes <= 390 else 1)
    regimes = regimes_for(bars)
    regime_returns: dict[str, list[float]] = defaultdict(list)
    for i, value in enumerate(returns):
        regime_returns[regimes[min(config.warmup_bars + i + 1, len(regimes) - 1)]].append(value)
    regime_summary = {}
    for regime in REGIMES:
        entries = regime_returns[regime]
        local = math.prod(1 + item for item in entries) if entries else 1.0
        local_equity = 1.0
        local_peak = 1.0
        local_drawdown = 0.0
        for item in entries:
            local_equity *= 1 + item
            local_peak = max(local_peak, local_equity)
            local_drawdown = max(local_drawdown, 1 - local_equity / local_peak)
        regime_sharpe = mean(entries) / max(stdev(entries), .0001) * math.sqrt(periods_per_year)
        regime_return = local - 1
        score = .48 * max(-1, min(1, regime_sharpe / 2)) \
            + .30 * max(-1, min(1, regime_return / .10)) \
            + .22 * max(-1, min(1, (.18 - local_drawdown) / .18))
        regime_summary[regime] = {
            "return": round(regime_return, 5), "sharpe": round(regime_sharpe, 3),
            "drawdown": round(local_drawdown, 5), "score": round(score, 4),
        }
    positive_regimes = sum(1 for item in regime_summary.values() if item["score"] > 0)
    annualized_log_growth = math.log(max(equity / config.initial_cash, .01)) * periods_per_year / max(len(returns), 1)
    annualized_return = math.expm1(min(annualized_log_growth, math.log(1000)))
    metrics = {
        "return": round(equity / config.initial_cash - 1, 5),
        "annualized": round(annualized_return, 5),
        "volatility": round(stdev(returns) * math.sqrt(periods_per_year), 5),
        "sharpe": round(mean(returns) / max(stdev(returns), .0001) * math.sqrt(periods_per_year), 3),
        "drawdown": round(max_drawdown, 5),
        "win_rate": round(len(winners) / max(len(closed), 1), 4),
        "profit_factor": round(min(profit_factor, 9.99), 3),
        "trades": len(closed),
        "regimes": regime_summary,
        "positive_regimes": positive_regimes,
    }
    warnings = []
    if not closed:
        warnings.append("No closed trades in this window.")
    order_ids = {record["order_ref"]: f"order-{index + 1}" for index, record in enumerate(strategy.orders)}
    orders = [{**record, "order_ref": order_ids[record["order_ref"]]} for record in strategy.orders]
    fills = [{**record, "order_ref": order_ids.get(record["order_ref"], "untracked-order")} for record in strategy.fills]
    return {"metrics": metrics, "equity_curve": curve, "exposure_curve": strategy.exposure_curve, "orders": orders, "fills": fills, "closed_trades": closed, "warnings": warnings}


def verify_auth(request: Request, raw: bytes, job_id: str) -> None:
    secret = os.environ.get("AXIOM_BACKTEST_SECRET")
    if not secret:
        raise HTTPException(503, "AXIOM_BACKTEST_SECRET is not configured")
    timestamp = request.headers.get("X-Axiom-Timestamp", "")
    signature = request.headers.get("X-Axiom-Signature", "")
    request_job_id = request.headers.get("X-Axiom-Job-Id", "")
    try:
        parsed_timestamp = int(timestamp)
    except ValueError:
        raise HTTPException(401, "missing or invalid timestamp")
    if request_job_id != job_id or abs(time.time() - parsed_timestamp) > REPLAY_WINDOW_SECONDS:
        raise HTTPException(401, "expired request or job id mismatch")
    expected = hmac.new(secret.encode(), timestamp.encode() + b"." + job_id.encode() + b"." + raw, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature):
        raise HTTPException(401, "invalid request signature")
    now = time.time()
    for cached_job, (expires, _) in list(REPLAY_CACHE.items()):
        if expires < now:
            del REPLAY_CACHE[cached_job]
    body_hash = hashlib.sha256(raw).hexdigest()
    previous = REPLAY_CACHE.get(job_id)
    if previous and previous[1] != body_hash:
        raise HTTPException(409, "job id was already used with a different payload")
    REPLAY_CACHE[job_id] = (now + REPLAY_WINDOW_SECONDS, body_hash)


app = FastAPI(title="Axiom Backtester", version=ENGINE_VERSION)


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok", "engine": ENGINE_NAME, "version": ENGINE_VERSION}


@app.post("/v1/backtests/batch")
async def run_backtests(request: Request) -> dict[str, Any]:
    raw = await request.body()
    # V1 and V2 deliberately share the authenticated endpoint.  The explicit
    # request schema marker avoids interpreting a sealed multi-symbol payload
    # as a legacy single-feed request.
    try:
        raw_object = json.loads(raw)
    except Exception:
        raw_object = None
    if isinstance(raw_object, dict) and raw_object.get("schema_version") == "backtest-request-v2":
        try:
            payload_v2 = BacktestRequestV2.model_validate(raw_object)
        except Exception as exc:
            raise HTTPException(422, str(exc)) from exc
        verify_auth(request, raw, payload_v2.job_id)
        engine = {"name": ENGINE_NAME, "version": ENGINE_VERSION,
                  "image_digest": os.environ.get("BACKTEST_IMAGE_DIGEST", os.environ.get("K_REVISION", "local")),
                  # Hash the exact signed wire object. Pydantic intentionally
                  # coerces 100000 to 100000.0, which must not break the
                  # JavaScript/Python provenance comparison.
                  "configuration_hash": digest(raw_object.get("execution", {})),
                  "dsl_compiler": {"dsl_version": DSL_COMPILER_MANIFEST["dsl_version"], "semantic_version": DSL_COMPILER_MANIFEST["semantic_version"], "schema_sha256": DSL_COMPILER_MANIFEST["schema_sha256"], "semantic_sha256": DSL_COMPILER_MANIFEST["semantic_sha256"]}}
        return run_v2(payload_v2, engine=engine, input_hash=digest(raw_object))
    try:
        payload = BacktestRequest.model_validate_json(raw)
    except Exception as exc:
        raise HTTPException(422, str(exc)) from exc
    verify_auth(request, raw, payload.job_id)
    payload_without_auth = payload.model_dump(mode="json")
    input_hash = digest(payload_without_auth)
    bars = [bar.model_dump(exclude_none=True) for bar in payload.bars]
    results = []
    for dna in payload.strategies:
        windows = []
        for window in payload.windows:
            result = run_window(dna, bars[window.start:window.end], payload.execution)
            result["window_id"] = window.id
            windows.append(result)
        results.append({"strategy_id": dna.id, "strategy_format": dna.strategy_format,
                        "dna_hash": dna.dna_hash,
                        "compiler": dna.dna.get("compiler") if isinstance(dna, DSLStrategyDNA) else None,
                        "windows": windows})
    response = {
        "job_id": payload.job_id,
        "phase": payload.phase,
        "engine": {"name": ENGINE_NAME, "version": ENGINE_VERSION, "image_digest": os.environ.get("BACKTEST_IMAGE_DIGEST", os.environ.get("K_REVISION", "local")), "config_hash": digest(APPROVED_CONFIG),
                   "dsl_compiler": {"dsl_version": DSL_COMPILER_MANIFEST["dsl_version"],
                                    "semantic_version": DSL_COMPILER_MANIFEST["semantic_version"],
                                    "schema_sha256": DSL_COMPILER_MANIFEST["schema_sha256"],
                                    "semantic_sha256": DSL_COMPILER_MANIFEST["semantic_sha256"]}},
        "dataset": {"snapshot_id": payload.dataset.snapshot_id, "sha256": payload.dataset.sha256, "bar_count": payload.dataset.bar_count},
        "input_hash": input_hash,
        "results": results,
        "warnings": ["Backtrader uses next-bar-open order execution; this intentionally differs from the legacy close-to-close engine."],
    }
    response["result_hash"] = digest(response)
    return response


@app.post("/v2/backtests/batch")
async def run_backtests_v2(request: Request) -> dict[str, Any]:
    """Authoritative sealed multi-symbol five-minute backtest contract."""
    raw = await request.body()
    try:
        raw_object = json.loads(raw)
        payload = BacktestRequestV2.model_validate(raw_object)
    except Exception as exc:
        raise HTTPException(422, str(exc)) from exc
    verify_auth(request, raw, payload.job_id)
    engine = {
        "name": ENGINE_NAME, "version": ENGINE_VERSION,
        "image_digest": os.environ.get("BACKTEST_IMAGE_DIGEST", os.environ.get("K_REVISION", "local")),
        "configuration_hash": digest(raw_object.get("execution", {})),
        "dsl_compiler": {"dsl_version": DSL_COMPILER_MANIFEST["dsl_version"],
                         "semantic_version": DSL_COMPILER_MANIFEST["semantic_version"],
                         "schema_sha256": DSL_COMPILER_MANIFEST["schema_sha256"],
                         "semantic_sha256": DSL_COMPILER_MANIFEST["semantic_sha256"]},
    }
    return run_v2(payload, engine=engine, input_hash=digest(raw_object))
