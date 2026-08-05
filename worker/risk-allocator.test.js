import assert from "node:assert/strict";
import test from "node:test";

import { allocatePortfolioRisk, dailyRiskState, DEFAULT_RISK_POLICY, riskReducingTarget,
  sessionRiskPolicy } from "./risk-allocator.js";

test("multi-symbol strategy gross is capped once across its complete scope", () => {
  const allocation = allocatePortfolioRisk({ equity: 100_000, buyingPower: 200_000,
    strategies: [{ id: "A", state: "released" }], rawTargets: { A: { AAPL: 1, MSFT: -1, SPY: 1 } } });
  assert.ok(allocation.gross_before_netting <= 500 && allocation.gross_before_netting >= 499.9);
  assert.ok(Object.values(allocation.targets).reduce((sum, value) => sum + Math.abs(value), 0) <= 500);
});

test("opposing strategies consume pre-net gross even when the broker target is flat", () => {
  const allocation = allocatePortfolioRisk({ equity: 100_000, buyingPower: 200_000,
    strategies: [{ id: "A", state: "released" }, { id: "B", state: "released" }],
    rawTargets: { A: { SPY: 1 }, B: { SPY: -1 } } });
  assert.equal(allocation.gross_before_netting, 1_000);
  assert.equal(allocation.targets.SPY, 0);
  assert.equal(allocation.contributions.length, 2);
});

test("symbol, cluster and portfolio overlays scale risk before netting", () => {
  const strategies = Array.from({ length: 30 }, (_, index) => ({ id: `S${index}`, state: "released" }));
  const rawTargets = Object.fromEntries(strategies.map((strategy, index) => [strategy.id,
    { [index % 2 ? "AAPL" : "MSFT"]: 1 }]));
  const allocation = allocatePortfolioRisk({ equity: 100_000, buyingPower: 200_000, strategies, rawTargets });
  assert.ok(allocation.gross_before_netting <= 4_000);
  assert.ok(Math.abs(allocation.targets.AAPL) <= 2_000);
  assert.ok(Math.abs(allocation.targets.MSFT) <= 2_000);
});

test("session policy derives entry and flatten boundaries from the broker close", () => {
  const open = sessionRiskPolicy({ is_open: true, timestamp: "2026-11-27T16:00:00Z", next_close: "2026-11-27T18:00:00Z" });
  const cutoff = sessionRiskPolicy({ is_open: true, timestamp: "2026-11-27T17:31:00Z", next_close: "2026-11-27T18:00:00Z" });
  const flatten = sessionRiskPolicy({ is_open: true, timestamp: "2026-11-27T17:51:00Z", next_close: "2026-11-27T18:00:00Z" });
  assert.equal(open.allow_increase, true); assert.equal(cutoff.allow_increase, false);
  assert.equal(flatten.force_flatten, true);
  assert.equal(sessionRiskPolicy({ is_open: true, timestamp: "bad", next_close: "bad" }).critical, true);
});

test("daily loss halt is sticky within a session and resets only on a new session", () => {
  const first = dailyRiskState(null, { equity: 100_000, timestamp: "2026-08-03T14:00:00Z" });
  const halted = dailyRiskState(first, { equity: 99_499, timestamp: "2026-08-03T18:00:00Z" });
  const recovered = dailyRiskState(halted, { equity: 100_100, timestamp: "2026-08-03T19:00:00Z" });
  const next = dailyRiskState(recovered, { equity: 100_100, timestamp: "2026-08-04T14:00:00Z" });
  assert.equal(halted.halted, true); assert.equal(recovered.halted, true); assert.equal(next.halted, false);
  assert.equal(halted.loss_fraction >= DEFAULT_RISK_POLICY.daily_loss_halt_pct, true);
});

test("reduce-only state permits covers and reductions but blocks increases and flips", () => {
  assert.equal(riskReducingTarget(1_000, 2_000, true), 1_000);
  assert.equal(riskReducingTarget(1_000, 400, true), 400);
  assert.equal(riskReducingTarget(-1_000, 500, true), 0);
  assert.equal(riskReducingTarget(0, 500, true), 0);
});
