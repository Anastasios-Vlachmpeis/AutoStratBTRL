"""Deterministic, dependency-free metrics for canonical intraday artifacts.

The functions in this module deliberately operate on the normalized artifact
ledger rather than on a Backtrader object.  This makes the definitions usable
by the authoritative engine, replay tooling and independent audits.  A
five-minute regular-session observation uses ``252 * 78`` annual periods;
end-of-day observations use ``252``.  No metric silently substitutes a
different annualisation basis.

All public numeric outputs are finite.  In particular, a constant equity
curve, an empty ledger, or a series with no downside returns produces zero
risk ratios rather than NaN or infinity.  This is intentionally conservative:
zero does not imply that a no-trade strategy has good risk-adjusted returns.
"""

from __future__ import annotations

import math
from collections import defaultdict
from datetime import datetime
from statistics import median
from typing import Any, Iterable, Mapping, Sequence


METRICS_SCHEMA_VERSION = "intraday-metrics-v2"
# Artifact consumers historically call this a definition version; the frozen
# service contract calls it a schema version. Both labels identify one set of
# formulas.
METRIC_DEFINITION_VERSION = METRICS_SCHEMA_VERSION
BAR_PERIODS_PER_YEAR_5M = 252 * 78
DAILY_PERIODS_PER_YEAR = 252


def _finite(value: Any, default: float = 0.0) -> float:
    """Return ``value`` as a finite float, otherwise a deterministic default."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


def _round(value: float, places: int = 10) -> float:
    """Round a metric and guarantee that the serialized result stays finite."""
    return round(_finite(value), places)


def _timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _points(points: Sequence[Mapping[str, Any]] | None, value_key: str = "value") -> list[dict[str, Any]]:
    """Copy only ordered, finite points; malformed points never poison metrics."""
    result: list[dict[str, Any]] = []
    for index, point in enumerate(points or []):
        if not isinstance(point, Mapping):
            continue
        value = _finite(point.get(value_key), float("nan"))
        if not math.isfinite(value):
            continue
        result.append({"t": str(point.get("t", index)), "value": value})
    return result


def returns_from_equity(equity_curve: Sequence[Mapping[str, Any]] | None) -> list[float]:
    """Compute simple sequential returns, skipping non-positive denominators."""
    values = [point["value"] for point in _points(equity_curve)]
    return [values[index] / values[index - 1] - 1 for index in range(1, len(values)) if values[index - 1] > 0]


def end_of_day_equity(equity_curve: Sequence[Mapping[str, Any]] | None) -> list[dict[str, Any]]:
    """Return the last valid equity observation for each ISO calendar date.

    Canonical bars are UTC timestamped.  The engine must already have assigned
    the desired session calendar; this function groups by the ISO date embedded
    in each timestamp, which keeps replay independent of the host timezone.
    """
    daily: dict[str, dict[str, Any]] = {}
    for point in _points(equity_curve):
        stamp = _timestamp(point["t"])
        day = stamp.date().isoformat() if stamp else point["t"][:10]
        daily[day] = point
    return [daily[key] for key in sorted(daily)]


def drawdown_curve(equity_curve: Sequence[Mapping[str, Any]] | None) -> list[dict[str, Any]]:
    """Produce a peak-to-trough drawdown curve (fractions, never percentages)."""
    peak = 0.0
    curve: list[dict[str, Any]] = []
    for point in _points(equity_curve):
        value = point["value"]
        peak = max(peak, value)
        drawdown = 1.0 - value / peak if peak > 0 else 0.0
        curve.append({"t": point["t"], "value": _round(max(0.0, drawdown))})
    return curve


def drawdown_statistics(equity_curve: Sequence[Mapping[str, Any]] | None) -> dict[str, float | int]:
    """Return maximum drawdown and longest contiguous underwater run in bars."""
    curve = drawdown_curve(equity_curve)
    longest = current = 0
    for point in curve:
        if point["value"] > 0:
            current += 1
            longest = max(longest, current)
        else:
            current = 0
    return {"max_drawdown": _round(max((item["value"] for item in curve), default=0.0)), "drawdown_duration_bars": longest}


def _mean(values: Iterable[float]) -> float:
    values = list(values)
    return sum(values) / len(values) if values else 0.0


def _sample_stdev(values: Sequence[float]) -> float:
    if len(values) < 2:
        return 0.0
    average = _mean(values)
    return math.sqrt(sum((item - average) ** 2 for item in values) / (len(values) - 1))


def _risk_ratios(returns: Sequence[float], periods_per_year: int) -> tuple[float, float, float]:
    """Return volatility, Sharpe and Sortino with a zero risk-free rate."""
    sigma = _sample_stdev(returns)
    volatility = sigma * math.sqrt(periods_per_year)
    sharpe = (_mean(returns) / sigma * math.sqrt(periods_per_year)) if sigma > 0 else 0.0
    downside = [min(0.0, item) for item in returns]
    downside_deviation = math.sqrt(_mean([item * item for item in downside]))
    sortino = (_mean(returns) / downside_deviation * math.sqrt(periods_per_year)) if downside_deviation > 0 else 0.0
    return _round(volatility), _round(sharpe), _round(sortino)


def _annualized_return(net_return: float, observations: int, periods_per_year: int) -> float:
    if observations <= 0 or net_return <= -1:
        return 0.0
    exponent = periods_per_year / observations
    # exp() avoids platform-specific behaviour from very large pow() calls.
    try:
        return _round(math.expm1(math.log1p(net_return) * exponent))
    except (ValueError, OverflowError):
        return 0.0


def _trade_duration_bars(trade: Mapping[str, Any], interval_minutes: int) -> float:
    explicit = _finite(trade.get("bar_length"), float("nan"))
    if math.isfinite(explicit) and explicit >= 0:
        return explicit
    opened, closed = _timestamp(trade.get("opened")), _timestamp(trade.get("closed"))
    if opened is None or closed is None:
        return 0.0
    return max(0.0, (closed - opened).total_seconds() / 60 / max(interval_minutes, 1))


def _trade_metrics(closed_trades: Sequence[Mapping[str, Any]] | None, interval_minutes: int) -> dict[str, float | int]:
    trades = [item for item in (closed_trades or []) if isinstance(item, Mapping)]
    pnl = [_finite(item.get("pnl_after_costs", item.get("pnl"))) for item in trades]
    winners = [value for value in pnl if value > 0]
    losers = [value for value in pnl if value < 0]
    # Profit factor is deliberately zero when there are no losses: infinity is
    # not a robust result and should never cause an automatic promotion.
    profit_factor = sum(winners) / abs(sum(losers)) if losers else 0.0
    ordered = sorted(pnl)
    tail_count = max(1, math.ceil(len(ordered) * .05)) if ordered else 0
    durations = [_trade_duration_bars(item, interval_minutes) for item in trades]
    return {
        "closed_trades": len(trades),
        "profit_factor": _round(profit_factor),
        "expectancy": _round(_mean(pnl)),
        "hit_rate": _round(len(winners) / len(trades) if trades else 0.0),
        "tail_loss": _round(_mean(ordered[:tail_count]) if tail_count else 0.0),
        "mean_trade_duration_bars": _round(_mean(durations)),
        "median_trade_duration_bars": _round(float(median(durations)) if durations else 0.0),
    }


def turnover_from_fills(
    fills: Sequence[Mapping[str, Any]] | None,
    equity_curve: Sequence[Mapping[str, Any]] | None,
) -> tuple[float, list[dict[str, Any]]]:
    """Return gross-notional turnover and its cumulative curve.

    Turnover is total absolute filled notional divided by the mean available
    equity.  A fill may supply ``value`` directly or ``size * price``.  The
    curve is cumulative turnover on fill timestamps, so it remains meaningful
    for sparse/partial fills.
    """
    denominator = _mean([item["value"] for item in _points(equity_curve)])
    gross = 0.0
    curve: list[dict[str, Any]] = []
    for index, fill in enumerate(fills or []):
        if not isinstance(fill, Mapping):
            continue
        value = _finite(fill.get("value"), float("nan"))
        if not math.isfinite(value):
            value = _finite(fill.get("size")) * _finite(fill.get("price"))
        gross += abs(value)
        curve.append({"t": str(fill.get("t", index)), "value": _round(gross / denominator if denominator > 0 else 0.0)})
    return _round(gross / denominator if denominator > 0 else 0.0), curve


def _exposure(exposure_curve: Sequence[Mapping[str, Any]] | None) -> tuple[float, float]:
    exposures = [abs(point["value"]) for point in _points(exposure_curve)]
    return _round(_mean(exposures)), _round(max(exposures, default=0.0))


def _symbol_metrics(
    fills: Sequence[Mapping[str, Any]] | None,
    per_symbol_equity: Mapping[str, Sequence[Mapping[str, Any]]] | None,
    periods_per_year: int,
) -> tuple[float, dict[str, dict[str, float]]]:
    gross_by_symbol: defaultdict[str, float] = defaultdict(float)
    for fill in fills or []:
        if not isinstance(fill, Mapping):
            continue
        symbol = str(fill.get("symbol", "UNATTRIBUTED"))
        value = _finite(fill.get("value"), float("nan"))
        if not math.isfinite(value):
            value = _finite(fill.get("size")) * _finite(fill.get("price"))
        gross_by_symbol[symbol] += abs(value)
    total = sum(gross_by_symbol.values())
    concentration = sum((value / total) ** 2 for value in gross_by_symbol.values()) if total else 0.0
    stability: dict[str, dict[str, float]] = {}
    for symbol in sorted((per_symbol_equity or {}).keys()):
        returns = returns_from_equity((per_symbol_equity or {})[symbol])
        _, sharpe, _ = _risk_ratios(returns, periods_per_year)
        net = 0.0
        points = _points((per_symbol_equity or {})[symbol])
        if len(points) >= 2 and points[0]["value"] > 0:
            net = points[-1]["value"] / points[0]["value"] - 1
        # The stability score is intentionally bounded and interpretable:
        # positive return times non-negative Sharpe quality, both clipped.
        score = max(-1.0, min(1.0, net / .10)) * max(0.0, min(1.0, sharpe / 2.0))
        stability[symbol] = {"net_return": _round(net), "sharpe": sharpe, "stability": _round(score)}
    return _round(concentration), stability


def _capacity_proxy(fills: Sequence[Mapping[str, Any]] | None) -> dict[str, float]:
    """Estimate tradable notional from observed bar-volume participation.

    A fill can provide ``bar_volume`` and ``max_participation``.  For each such
    fill we estimate ``price * bar_volume * max_participation``; the median is
    reported so one exceptional bar cannot inflate capacity.  Missing volume is
    represented as zero, never an invented capacity estimate.
    """
    estimates: list[float] = []
    participations: list[float] = []
    for fill in fills or []:
        if not isinstance(fill, Mapping):
            continue
        price, volume = _finite(fill.get("price")), _finite(fill.get("bar_volume"))
        participation = _finite(fill.get("max_participation", fill.get("participation")))
        if price > 0 and volume > 0 and participation > 0:
            estimates.append(price * volume * participation)
            participations.append(participation)
    return {
        "capacity_proxy_notional": _round(float(median(estimates)) if estimates else 0.0),
        "max_observed_participation": _round(max(participations, default=0.0)),
    }


def compute_metrics(
    equity_curve: Sequence[Mapping[str, Any]] | None,
    closed_trades: Sequence[Mapping[str, Any]] | None = None,
    fills: Sequence[Mapping[str, Any]] | None = None,
    orders: Sequence[Mapping[str, Any]] | None = None,
    exposure_curve: Sequence[Mapping[str, Any]] | None = None,
    turnover_curve: Sequence[Mapping[str, Any]] | None = None,
    per_symbol: Mapping[str, Sequence[Mapping[str, Any]]] | None = None,
    *,
    per_symbol_equity: Mapping[str, Sequence[Mapping[str, Any]]] | None = None,
    interval_minutes: int = 5,
) -> dict[str, Any]:
    """Calculate versioned five-minute and EOD metrics from immutable ledgers.

    The input curves must already be canonical and ordered by the engine.  The
    return value is JSON-safe and deterministic for equivalent input order.  It
    includes the generated drawdown and cumulative-turnover curves required by
    the artifact contract.
    """
    interval_minutes = max(1, int(interval_minutes))
    bar_periods = 252 * max(1, round(390 / interval_minutes))
    bars = _points(equity_curve)
    bar_returns = returns_from_equity(bars)
    daily_curve = end_of_day_equity(bars)
    daily_returns = returns_from_equity(daily_curve)
    net_return = bars[-1]["value"] / bars[0]["value"] - 1 if len(bars) >= 2 and bars[0]["value"] > 0 else 0.0
    bar_vol, bar_sharpe, bar_sortino = _risk_ratios(bar_returns, bar_periods)
    daily_vol, daily_sharpe, daily_sortino = _risk_ratios(daily_returns, DAILY_PERIODS_PER_YEAR)
    drawdown = drawdown_statistics(bars)
    annualized = _annualized_return(net_return, len(bar_returns), bar_periods)
    calmar = annualized / float(drawdown["max_drawdown"]) if drawdown["max_drawdown"] else 0.0
    # Orders are accepted for a normalized engine-facing signature, but only
    # completed fills create turnover. An audited engine turnover curve wins.
    del orders
    turnover, computed_turnover_curve = turnover_from_fills(fills, bars)
    supplied_turnover_curve = _points(turnover_curve)
    if supplied_turnover_curve:
        computed_turnover_curve = supplied_turnover_curve
        turnover = _round(supplied_turnover_curve[-1]["value"])
    average_exposure, max_exposure = _exposure(exposure_curve)
    concentration, stability = _symbol_metrics(fills, per_symbol if per_symbol is not None else per_symbol_equity, bar_periods)
    return {
        "metrics_schema_version": METRICS_SCHEMA_VERSION,
        "metric_definition_version": METRIC_DEFINITION_VERSION,
        "observation_basis": {"bar_periods_per_year": bar_periods, "daily_periods_per_year": DAILY_PERIODS_PER_YEAR, "interval_minutes": interval_minutes},
        "net_return": _round(net_return),
        "annualized_return": annualized,
        "bar_volatility": bar_vol,
        "bar_sharpe": bar_sharpe,
        "bar_sortino": bar_sortino,
        "daily_volatility": daily_vol,
        "daily_sharpe": daily_sharpe,
        "daily_sortino": daily_sortino,
        **drawdown,
        "calmar": _round(calmar),
        **_trade_metrics(closed_trades, interval_minutes),
        "turnover": turnover,
        "average_abs_exposure": average_exposure,
        "max_abs_exposure": max_exposure,
        "symbol_concentration_hhi": concentration,
        **_capacity_proxy(fills),
        "per_symbol_stability": stability,
        "drawdown_curve": drawdown_curve(bars),
        "turnover_curve": computed_turnover_curve,
    }


# Early Plan 05 readers can retain this spelling while integrations use the
# concise, frozen ``compute_metrics`` API.
compute_intraday_metrics = compute_metrics
