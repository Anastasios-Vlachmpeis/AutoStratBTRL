"""Deterministic strategy generation, backtesting, supervision, and monitoring."""

from __future__ import annotations

import math
import random
import statistics
import threading
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from typing import Any


REGIMES = ("Expansion", "Compression", "Stress", "Recovery")
ASSETS = ("BTC/USD", "ETH/USD", "SPY", "EUR/USD")
NAMES = (
    "Orion Pulse", "Kestrel Drift", "Helix Break", "Cobalt Revert",
    "Nimbus Edge", "Atlas Flux", "Vega Current", "Sable Vector",
    "Aster Signal", "Parallax Run", "Ion Cascade", "Morrow Wave",
)
ARCHETYPES = ("Momentum", "Mean reversion", "Breakout", "Volatility filter")


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def mean(values: list[float]) -> float:
    return statistics.fmean(values) if values else 0.0


def stdev(values: list[float]) -> float:
    return statistics.pstdev(values) if len(values) > 1 else 0.0


def market_series(seed: int, length: int = 420, asset_index: int = 0) -> tuple[list[float], list[str]]:
    """Build repeatable synthetic prices spanning four distinct regimes."""
    rng = random.Random(seed * 97 + asset_index * 7_919)
    price = (31_800.0, 1_850.0, 420.0, 1.08)[asset_index]
    prices = [price]
    labels: list[str] = []
    regime_specs = {
        "Expansion": (0.00125, 0.0080),
        "Compression": (0.00005, 0.0055),
        "Stress": (-0.00085, 0.0175),
        "Recovery": (0.00095, 0.0105),
    }
    segment = max(1, length // 4)
    asset_vol = (1.00, 1.15, 0.62, 0.35)[asset_index]
    memory = 0.0
    for index in range(length - 1):
        regime = REGIMES[min(index // segment, 3)]
        drift, volatility = regime_specs[regime]
        noise = sum(rng.random() for _ in range(12)) - 6.0
        if regime == "Compression":
            memory = -0.42 * memory + noise
        else:
            memory = 0.12 * memory + noise
        cyclical = math.sin(index / 17.0 + asset_index) * 0.0007
        daily_return = drift + cyclical + volatility * asset_vol * memory
        price = max(0.01, price * (1.0 + clamp(daily_return, -0.16, 0.16)))
        prices.append(price)
        labels.append(regime)
    labels.append(labels[-1])
    return prices, labels


def _rolling_mean(values: list[float]) -> float:
    return mean(values)


def _signal(strategy: dict[str, Any], prices: list[float]) -> int:
    params = strategy["params"]
    archetype = strategy["archetype"]
    if archetype == "Momentum":
        fast, slow = params["fast"], params["slow"]
        if len(prices) < slow:
            return 0
        delta = _rolling_mean(prices[-fast:]) / _rolling_mean(prices[-slow:]) - 1.0
        return 1 if delta > params["threshold"] else -1 if delta < -params["threshold"] else 0
    if archetype == "Mean reversion":
        lookback = params["lookback"]
        if len(prices) < lookback:
            return 0
        window = prices[-lookback:]
        sigma = stdev(window) or 1.0
        zscore = (prices[-1] - mean(window)) / sigma
        return -1 if zscore > params["entry_z"] else 1 if zscore < -params["entry_z"] else 0
    if archetype == "Breakout":
        lookback = params["lookback"]
        if len(prices) <= lookback:
            return 0
        prior = prices[-lookback - 1:-1]
        buffer = params["buffer"]
        return 1 if prices[-1] > max(prior) * (1 + buffer) else -1 if prices[-1] < min(prior) * (1 - buffer) else 0
    lookback = params["lookback"]
    if len(prices) < lookback + 1:
        return 0
    returns = [prices[i] / prices[i - 1] - 1 for i in range(len(prices) - lookback + 1, len(prices))]
    realized = stdev(returns) * math.sqrt(252)
    trend = prices[-1] / prices[-lookback] - 1
    if realized > params["vol_ceiling"]:
        return 0
    return 1 if trend > params["threshold"] else -1 if trend < -params["threshold"] else 0


def backtest(strategy: dict[str, Any], prices: list[float], regimes: list[str]) -> dict[str, Any]:
    size = strategy["params"]["position_size"]
    equity = 1.0
    curve = [equity]
    returns: list[float] = []
    trade_returns: list[float] = []
    regime_returns: dict[str, list[float]] = {name: [] for name in REGIMES}
    prior_position = 0.0
    warmup = 52
    for index in range(warmup, len(prices) - 1):
        position = _signal(strategy, prices[: index + 1]) * size
        market_return = prices[index + 1] / prices[index] - 1.0
        cost = abs(position - prior_position) * 0.0005
        daily = position * market_return - cost
        equity *= max(0.01, 1.0 + daily)
        curve.append(equity)
        returns.append(daily)
        regime_returns[regimes[index]].append(daily)
        if position != prior_position:
            trade_returns.append(daily)
        prior_position = position

    peak = curve[0]
    max_drawdown = 0.0
    for point in curve:
        peak = max(peak, point)
        max_drawdown = max(max_drawdown, 1.0 - point / peak)
    total_return = equity - 1.0
    annualized = (max(equity, 0.01) ** (252 / max(len(returns), 1))) - 1.0
    volatility = stdev(returns) * math.sqrt(252)
    sharpe = mean(returns) / max(stdev(returns), 0.0001) * math.sqrt(252)
    wins = [value for value in trade_returns if value > 0]
    losses = [value for value in trade_returns if value < 0]
    profit_factor = sum(wins) / max(abs(sum(losses)), 0.0001)
    regime_summary: dict[str, dict[str, float]] = {}
    for name, values in regime_returns.items():
        regime_equity = math.prod(1 + value for value in values) if values else 1.0
        regime_total = regime_equity - 1.0
        regime_sharpe = mean(values) / max(stdev(values), 0.0001) * math.sqrt(252)
        local_equity = 1.0
        local_peak = 1.0
        local_dd = 0.0
        for value in values:
            local_equity *= 1 + value
            local_peak = max(local_peak, local_equity)
            local_dd = max(local_dd, 1 - local_equity / local_peak)
        score = (
            0.48 * clamp(regime_sharpe / 2.0, -1, 1)
            + 0.30 * clamp(regime_total / 0.10, -1, 1)
            + 0.22 * clamp((0.18 - local_dd) / 0.18, -1, 1)
        )
        regime_summary[name] = {
            "return": round(regime_total, 5), "sharpe": round(regime_sharpe, 3),
            "drawdown": round(local_dd, 5), "score": round(score, 4),
        }
    return {
        "return": round(total_return, 5), "annualized": round(annualized, 5),
        "volatility": round(volatility, 5), "sharpe": round(sharpe, 3),
        "drawdown": round(max_drawdown, 5), "win_rate": round(len(wins) / max(len(trade_returns), 1), 4),
        "profit_factor": round(min(profit_factor, 9.99), 3), "trades": len(trade_returns),
        "regimes": regime_summary,
        "curve": [round(point, 5) for point in curve[:: max(1, len(curve) // 80)]],
    }


def aggregate_results(results: list[dict[str, Any]]) -> dict[str, Any]:
    metrics = ("return", "annualized", "volatility", "sharpe", "drawdown", "win_rate", "profit_factor", "trades")
    summary = {metric: round(mean([float(result[metric]) for result in results]), 4) for metric in metrics}
    regime_scores = {
        regime: mean([result["regimes"][regime]["score"] for result in results]) for regime in REGIMES
    }
    score_values = list(regime_scores.values())
    robustness = min(score_values) - 0.18 * stdev(score_values)
    raw_score = 58 + 34 * (0.72 * mean(score_values) + 0.28 * robustness)
    summary["score"] = round(clamp(raw_score, 0, 100), 1)
    summary["robustness"] = round(clamp(0.58 + robustness * 0.35, 0, 1), 3)
    summary["positive_regimes"] = sum(value > 0 for value in score_values)
    summary["regime_scores"] = {key: round(value, 3) for key, value in regime_scores.items()}
    summary["curve"] = results[0]["curve"]
    return summary


class StrategyLab:
    """Thread-safe, in-memory paper strategy foundry."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self.reset()

    def reset(self) -> None:
        with getattr(self, "_lock", threading.RLock()):
            self.seed = 20_260_801
            self.cycle = 0
            self.market_clock = 0
            self.next_id = 1
            self.strategies: list[dict[str, Any]] = []
            self.events: list[dict[str, str]] = []

    def _event(self, kind: str, title: str, detail: str) -> None:
        timestamp = datetime(2026, 8, 1, 9, 20, tzinfo=timezone.utc) + timedelta(minutes=self.market_clock)
        self.events.insert(0, {"kind": kind, "title": title, "detail": detail, "time": timestamp.strftime("%H:%M")})
        self.events = self.events[:28]

    def _params(self, archetype: str, rng: random.Random) -> dict[str, Any]:
        size = round(rng.uniform(0.42, 0.90), 2)
        if archetype == "Momentum":
            fast = rng.randint(5, 14)
            return {"fast": fast, "slow": rng.randint(fast + 12, fast + 38), "threshold": round(rng.uniform(0.001, 0.008), 4), "position_size": size}
        if archetype == "Mean reversion":
            return {"lookback": rng.randint(12, 34), "entry_z": round(rng.uniform(0.75, 1.75), 2), "exit_z": 0.35, "position_size": size}
        if archetype == "Breakout":
            return {"lookback": rng.randint(12, 38), "buffer": round(rng.uniform(0.0005, 0.006), 4), "position_size": size}
        return {"lookback": rng.randint(9, 24), "vol_ceiling": round(rng.uniform(0.16, 0.42), 2), "threshold": round(rng.uniform(0.004, 0.018), 3), "position_size": size}

    def _new_strategy(self, parent: dict[str, Any] | None = None) -> dict[str, Any]:
        strategy_id = f"AX-{self.cycle:02d}-{self.next_id:03d}"
        rng = random.Random(self.seed + self.next_id * 103 + self.cycle)
        self.next_id += 1
        archetype = parent["archetype"] if parent else ARCHETYPES[rng.randrange(len(ARCHETYPES))]
        asset = parent["asset"] if parent else ASSETS[rng.randrange(len(ASSETS))]
        params = deepcopy(parent["params"]) if parent else self._params(archetype, rng)
        if parent:
            mutable = [key for key in params if key != "position_size"]
            key = mutable[rng.randrange(len(mutable))]
            if isinstance(params[key], int):
                params[key] = max(3, round(params[key] * rng.choice((0.84, 1.16))))
            else:
                params[key] = round(params[key] * rng.choice((0.88, 1.12)), 4)
            params["position_size"] = round(clamp(params["position_size"] * 0.92, 0.2, 1.0), 2)
        name = f"{NAMES[(self.next_id - 1) % len(NAMES)]} {chr(65 + self.cycle % 26)}{self.next_id % 10}"
        return {
            "id": strategy_id, "name": name, "archetype": archetype, "asset": asset,
            "params": params, "state": "generated", "generation": 1 if not parent else parent["generation"] + 1,
            "parent": parent["id"] if parent else None, "backtests": 0, "metrics": None, "validation": None,
            "monitor": {"returns": [], "streak": 0, "adjustments": 0, "sharpe": None, "drawdown": None, "ratio": None},
        }

    def generate_batch(self, count: int = 6, bootstrap: bool = False) -> None:
        with self._lock:
            self.cycle += 1
            created = [self._new_strategy() for _ in range(count)]
            self.strategies = created + self.strategies
            self._event("GENERATE", f"Generation {self.cycle} seeded", f"{count} new strategy DNAs created across {len(set(item['asset'] for item in created))} markets.")
            if not bootstrap:
                self.market_clock += 3

    def _decision(self, metrics: dict[str, Any]) -> tuple[str, str]:
        hard_fail = metrics["drawdown"] > 0.25 or metrics["trades"] < 12 or metrics["positive_regimes"] < 2
        release = (
            metrics["score"] >= 61 and metrics["sharpe"] >= 0.55 and metrics["annualized"] >= 0.04
            and metrics["drawdown"] <= 0.20 and metrics["profit_factor"] >= 1.02
            and metrics["trades"] >= 18 and metrics["positive_regimes"] >= 3
        )
        if release:
            return "validation", f"score {metrics['score']:.1f} · Sharpe {metrics['sharpe']:.2f} · {metrics['positive_regimes']}/4 regimes"
        if hard_fail or metrics["score"] < 48:
            return "dropped", f"hard gate failed · DD {metrics['drawdown'] * 100:.1f}% · {metrics['trades']:.0f} trades"
        return "rework", f"evidence incomplete · score {metrics['score']:.1f} · robustness {metrics['robustness']:.2f}"

    def review_candidates(self, bootstrap: bool = False) -> None:
        with self._lock:
            candidates = [item for item in self.strategies if item["state"] in ("generated", "rework")]
            if not candidates:
                if not bootstrap:
                    self._event("REVIEW", "No candidates waiting", "Generate a new cohort or reproduce a released strategy first.")
                return
            validation_pool: list[dict[str, Any]] = []
            for strategy in candidates:
                asset_index = ASSETS.index(strategy["asset"])
                results = []
                for seed_offset in (0, 41, 83):
                    prices, regimes = market_series(self.seed + seed_offset + int(strategy["id"].split("-")[-1]), asset_index=asset_index)
                    results.append(backtest(strategy, prices, regimes))
                strategy["backtests"] += 3
                strategy["metrics"] = aggregate_results(results)
                state, reason = self._decision(strategy["metrics"])
                strategy["state"] = state
                if state == "validation":
                    validation_pool.append(strategy)
                self._event("PROMOTE" if state == "validation" else "DROP" if state == "dropped" else "REWORK", f"{strategy['name']} → {state}", reason)
            for strategy in sorted(validation_pool, key=lambda item: item["metrics"]["score"], reverse=True)[3:]:
                strategy["state"] = "rework"
                self._event("REWORK", f"{strategy['name']} held", "Release cap reached; retained for the next evidence cycle.")
            self.market_clock += 8

    def _validation_verdict(self, strategy: dict[str, Any], result: dict[str, Any]) -> tuple[str, str]:
        development = strategy["metrics"]
        retention = result["sharpe"] / max(development["sharpe"], 0.30)
        result["score"] = round(clamp(
            50 + 20 * clamp(result["sharpe"] / 2, -1, 1)
            + 15 * clamp(result["return"] / 0.10, -1, 1)
            + 10 * clamp((0.15 - result["drawdown"]) / 0.15, -1, 1)
            + 5 * clamp(result["profit_factor"] - 1, -1, 1), 0, 100), 1)
        result["robustness"] = round(clamp(
            0.50 + 0.25 * clamp(retention, -1, 1)
            + 0.15 * clamp((0.15 - result["drawdown"]) / 0.15, -1, 1), 0, 1), 3)
        result["sharpe_retention"] = round(retention, 3)
        result["overfit_warning"] = retention < 0.40 or result["drawdown"] > development["drawdown"] * 1.50
        hard_failure = (result["return"] <= 0 or result["sharpe"] <= 0 or result["profit_factor"] < 0.90
                        or result["drawdown"] > 0.20 or result["trades"] < 4)
        required_trades = max(4, math.ceil(development["trades"] * 0.20))
        required_sharpe = max(0.30, development["sharpe"] * 0.35)
        drawdown_limit = min(0.20, max(0.12, development["drawdown"] * 1.50, development["drawdown"] + 0.025))
        passes = (not hard_failure and not result["overfit_warning"] and result["trades"] >= required_trades
                  and result["sharpe"] >= required_sharpe and result["drawdown"] <= drawdown_limit
                  and result["score"] >= development["score"] * 0.55 and result["robustness"] >= 0.45)
        if passes:
            return "released", f"unseen Sharpe {result['sharpe']:.2f} · {result['return'] * 100:.1f}% return · {result['trades']} trades"
        if hard_failure:
            return "dropped", f"unseen data failed hard gate · Sharpe {result['sharpe']:.2f} · DD {result['drawdown'] * 100:.1f}%"
        return "rework", f"unseen evidence did not generalize · Sharpe retention {retention * 100:.0f}%"

    def validate_candidates(self, bootstrap: bool = False) -> None:
        with self._lock:
            candidates = [item for item in self.strategies if item["state"] == "validation"]
            if not candidates:
                if not bootstrap:
                    self._event("VALIDATE", "No strategies awaiting validation", "Supervisor approval is required before holdout testing.")
                return
            for strategy in candidates:
                asset_index = ASSETS.index(strategy["asset"])
                numeric_id = int(strategy["id"].split("-")[-1])
                prices, regimes = market_series(self.seed + 10_007 + numeric_id, asset_index=asset_index)
                result = backtest(strategy, prices, regimes)
                strategy["backtests"] += 1
                strategy["validation"] = result
                state, reason = self._validation_verdict(strategy, result)
                strategy["state"] = state
                self._event("RELEASE" if state == "released" else "DROP" if state == "dropped" else "REWORK", f"{strategy['name']} → {state}", reason)
            self.market_clock += 5

    def reproduce(self, strategy_id: str) -> None:
        with self._lock:
            parent = next((item for item in self.strategies if item["id"] == strategy_id), None)
            if not parent:
                raise ValueError("Strategy not found")
            if parent["state"] not in ("released", "healthy", "watch", "adjusted"):
                raise ValueError("Only a released strategy can reproduce")
            child = self._new_strategy(parent)
            self.strategies.insert(0, child)
            changed = [key for key in child["params"] if child["params"][key] != parent["params"].get(key)]
            self._event("REPRODUCE", f"{child['name']} born from {parent['name']}", f"Lineage {parent['id']} · mutated {', '.join(changed)}.")
            self.market_clock += 2

    def advance_market(self, periods: int = 1, bootstrap: bool = False) -> None:
        with self._lock:
            active_states = ("released", "healthy", "watch", "adjusted")
            evaluated_ids: set[str] = set()
            for _ in range(periods):
                self.market_clock += 21
                active = [item for item in self.strategies if item["state"] in active_states]
                for strategy in active:
                    evaluated_ids.add(strategy["id"])
                    rng = random.Random(self.seed + self.market_clock * 17 + int(strategy["id"].split("-")[-1]))
                    quality = ((strategy["metrics"] or {}).get("score", 55) - 55) / 10_000
                    returns = [quality + rng.gauss(0.00015, 0.009) for _ in range(21)]
                    monitor = strategy["monitor"]
                    monitor["returns"] = (monitor["returns"] + returns)[-63:]
                    observed = monitor["returns"][-42:]
                    sharpe = mean(observed) / max(stdev(observed), 0.0001) * math.sqrt(252)
                    equity = peak = 1.0
                    drawdown = 0.0
                    for value in observed:
                        equity *= 1 + value
                        peak = max(peak, equity)
                        drawdown = max(drawdown, 1 - equity / peak)
                    expected = max(((strategy["metrics"] or {}).get("annualized", 0.03)) / 252, 0.0001)
                    ratio = mean(observed) / expected
                    monitor.update({"sharpe": round(sharpe, 2), "drawdown": round(drawdown, 4), "ratio": round(ratio, 2)})
                    failing = sharpe < 0.30 or drawdown > 0.08 or ratio < 0.45
                    monitor["streak"] = monitor["streak"] + 1 if failing else 0
                    if drawdown > 0.12 or (monitor["streak"] >= 2 and (sharpe < -0.50 or ratio < 0.10)) or monitor["adjustments"] >= 3:
                        strategy["state"] = "dropped"
                        self._event("DROP", f"{strategy['name']} retired", f"monitor Sharpe {sharpe:.2f} · rolling DD {drawdown * 100:.1f}%")
                    elif monitor["streak"] >= 2:
                        strategy["state"] = "adjusted"
                        strategy["params"]["position_size"] = round(strategy["params"]["position_size"] * 0.80, 2)
                        monitor["adjustments"] += 1
                        monitor["streak"] = 0
                        self._event("ADJUST", f"{strategy['name']} risk reduced", f"position size cut 20% after two weak monitor windows.")
                    elif failing:
                        strategy["state"] = "watch"
                    else:
                        if strategy["state"] != "healthy":
                            self._event("HEALTHY", f"{strategy['name']} cleared monitor", f"rolling Sharpe {sharpe:.2f} · DD {drawdown * 100:.1f}%")
                        strategy["state"] = "healthy"
            if evaluated_ids and not bootstrap:
                self._event("MARKET", f"Paper market advanced {periods * 21} sessions", f"Supervisor evaluated {len(evaluated_ids)} released strategies.")
            elif not evaluated_ids and not bootstrap:
                self._event("MARKET", "No strategies in market", "Release a candidate before advancing the paper market.")

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            strategies = deepcopy(self.strategies)
            active_states = {"released", "healthy", "watch", "adjusted"}
            released = [item for item in strategies if item["state"] in active_states]
            avg_score = mean([item["metrics"]["score"] for item in strategies if item["metrics"]])
            capital = 100_000 * math.prod(1 + clamp(mean(item["monitor"]["returns"]), -0.02, 0.02) for item in released) if released else 100_000
            return {
                "meta": {"cycle": self.cycle, "clock": self.market_clock, "environment": "PAPER", "seed": self.seed},
                "summary": {
                    "generated": sum(item["state"] == "generated" for item in strategies),
                    "testing": sum(item["state"] in ("rework",) for item in strategies),
                    "validation": sum(item["state"] == "validation" for item in strategies),
                    "released": len(released), "dropped": sum(item["state"] == "dropped" for item in strategies),
                    "average_score": round(avg_score, 1), "capital": round(capital, 2),
                },
                "strategies": strategies, "events": deepcopy(self.events),
                "policy": {"release_score": 61, "min_sharpe": 0.55, "max_drawdown": 0.20,
                           "validation_min_sharpe": 0.30, "validation_max_drawdown": 0.20,
                           "monitor_window": 21},
            }
