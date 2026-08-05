import assert from "node:assert/strict";
import test from "node:test";
import { championReplacementAssessment, createHealthPolicy, evaluateHealthDecision,
  finalizeHealthSession, healthMultiplier, portfolioRiskOverlays, publicHealthState,
  recordHealthObservation, replayHealthDecision, startReleaseMonitoring } from "./monitoring.js";

function strategy(id = "S-1", state = "healthy") {
  const value = { id, name: id, state, asset: "SPY", dna_hash: "d".repeat(64),
    behavior_hash: `behavior-${id}`, strategy_dna: { compiler: { schema_sha256: "s".repeat(64),
      semantic_sha256: "m".repeat(64) }, scope: { universe_sha256: "u".repeat(64), symbols: ["SPY"] } },
    metrics: { daily_sharpe: .8, drawdown: .05 }, validation: { daily_sharpe: .6, drawdown: .06 } };
  startReleaseMonitoring(value, { releaseId: `release-${id}`, startedAt: "2026-08-01T00:00:00Z" });
  return value;
}

function cycle({ price = 100, target = 500, safety = [], timestamp = "2026-08-03T14:00:00Z" } = {}) {
  return { clock: { timestamp }, fetched_at: timestamp, account: { equity: 100_000 },
    evaluations: { "S-1": { symbols: { SPY: { latest_price: price, latest_open: price,
      bar_time: timestamp } } } }, allocation: { contributions: target == null ? []
      : [{ strategy_id: "S-1", symbol: "SPY", notional: target }] },
    fills: [], safety_reasons: safety };
}

function addDay(evidence, index, classification = "healthy", value = .001) {
  const date = `2026-08-${String(index + 1).padStart(2, "0")}`;
  evidence.sessions[date] = { session_date: date, completed: true, valid: true,
    classification, return: value, coverage: 1, operational_faults: [], hard_findings: [],
    reason_codes: classification === "weak" ? ["expectancy_degradation"] : [], observations: 78 };
}

function addTrades(evidence, count, pnl = 1) {
  for (let index = 0; index < count; index += 1) evidence.closed_trades.push({
    trade_id: `T-${index}`, symbol: "SPY", pnl, gross_pnl: pnl, cost: .01,
    net_return: pnl > 0 ? .001 : -.001, holding_bars: 5, session_date: "2026-08-01" });
}

test("one ordinary noisy five-minute bar records evidence but cannot change quality", () => {
  const value = strategy(); const originalDna = structuredClone(value.strategy_dna);
  recordHealthObservation(value, cycle({ price: 100 }), { eventId: "e1", sessionDate: "2026-08-03" });
  const result = recordHealthObservation(value, cycle({ price: 99 }), { eventId: "e2", sessionDate: "2026-08-03" });
  assert.equal(result.decision, null); assert.equal(value.health.status, "healthy");
  assert.deepEqual(value.strategy_dna, originalDna);
});

test("hard provenance failure quarantines immediately", () => {
  const value = strategy(); value.dna_hash = "x".repeat(64);
  const result = recordHealthObservation(value, cycle(), { eventId: "bad-dna", sessionDate: "2026-08-03" });
  assert.equal(result.decision.quality_outcome, "quarantined");
  assert.ok(result.decision.findings.includes("dna_hash_mismatch"));
});

test("rolling live drawdown is an immediate hard quarantine", () => {
  const value = strategy();
  recordHealthObservation(value, cycle({ price: 100, target: 100_000 }),
    { eventId: "peak", sessionDate: "2026-08-03" });
  const result = recordHealthObservation(value, cycle({ price: 80, target: 100_000 }),
    { eventId: "drawdown", sessionDate: "2026-08-03" });
  assert.equal(result.decision.quality_outcome, "quarantined");
  assert.ok(result.decision.findings.includes("rolling_drawdown_limit"));
});

test("fills produce attributed costs, holding bars, and target turnover", () => {
  const value = strategy();
  const entry = cycle({ price: 100, target: 500, timestamp: "2026-08-03T14:00:00Z" });
  entry.fills = [{ broker_fill_id: "F-1", symbol: "SPY", side: "buy", qty: 5, price: 100,
    transaction_time: "2026-08-03T14:00:00Z", allocations: [{ strategy_id: "S-1", signed_notional: 500 }] }];
  const first = recordHealthObservation(value, entry, { eventId: "fill-entry", sessionDate: "2026-08-03" });
  const exit = cycle({ price: 101, target: null, timestamp: "2026-08-03T14:15:00Z" });
  exit.fills = [{ broker_fill_id: "F-2", symbol: "SPY", side: "sell", qty: 5, price: 101,
    transaction_time: "2026-08-03T14:15:00Z", allocations: [{ strategy_id: "S-1", signed_notional: -505 }] }];
  const second = recordHealthObservation(value, exit, { eventId: "fill-exit", sessionDate: "2026-08-03" });
  assert.equal(value.health.closed_trades.length, 1);
  assert.equal(value.health.closed_trades[0].holding_bars, 3);
  assert.equal(first.observation.turnover, .005);
  assert.equal(second.observation.turnover, .005);
});

test("infrastructure outage blocks operations without changing quality classification", () => {
  const value = strategy();
  const result = recordHealthObservation(value, cycle({ safety: [{ strategy_id: "S-1",
    reason: "service_unavailable" }] }), { eventId: "outage", sessionDate: "2026-08-03" });
  assert.equal(result.decision.outcome, "healthy");
  assert.equal(result.decision.quality_outcome, "healthy");
  assert.equal(result.decision.operational_outcome, "operational_blocked");
  assert.equal(healthMultiplier(result.decision, value.health.policy), 0);
});

test("watch and sustained recovery decisions replay deterministically", () => {
  const value = strategy(); addDay(value.health, 0, "weak", -.01); addDay(value.health, 1, "weak", -.01);
  const watch = evaluateHealthDecision(value.health, { evidenceEventId: "day-2" });
  assert.equal(watch.quality_outcome, "watch");
  assert.equal(replayHealthDecision(value.health, { evidenceEventId: "day-2" }).decision_id, watch.decision_id);
  value.health.status = "watch";
  addDay(value.health, 2); addDay(value.health, 3); addDay(value.health, 4);
  const recovered = evaluateHealthDecision(value.health, { evidenceEventId: "day-5" });
  assert.equal(recovered.quality_outcome, "healthy");
  assert.ok(recovered.findings.includes("sustained_recovery"));
});

test("quarantined strategy retires only after persistent daily and trade evidence", () => {
  const value = strategy("S-1", "quarantined"); value.health.status = "quarantined";
  for (let index = 0; index < 7; index += 1) addDay(value.health, index, "weak", -.01);
  addTrades(value.health, 20, -1);
  assert.equal(evaluateHealthDecision(value.health, { evidenceEventId: "retire" }).quality_outcome, "retired");
});

test("invalid daily evidence blocks rather than becoming alpha degradation", () => {
  const value = strategy(); value.health.sessions["2026-08-03"] = { session_date: "2026-08-03",
    event_ids: ["one"], observations: 1, expected_events: 78, return: -.10, costs: 0,
    operational_faults: ["feed_timeout"], hard_findings: [], completed: false };
  const decision = finalizeHealthSession(value, "2026-08-03");
  assert.equal(decision.operational_outcome, "operational_blocked");
  assert.equal(decision.quality_outcome, "healthy");
});

test("portfolio concentration reduces allocation without changing strategy evidence", () => {
  const left = strategy("S-1"), right = strategy("S-2");
  const before = JSON.stringify(left.health);
  const overlays = portfolioRiskOverlays([left, right], { contributions: [
    { strategy_id: "S-1", symbol: "SPY", notional: 900 },
    { strategy_id: "S-2", symbol: "MSFT", notional: 100 },
  ] });
  assert.ok(overlays["S-1"].multiplier < 1); assert.equal(overlays["S-2"].multiplier, 1);
  assert.equal(JSON.stringify(left.health), before);
});

test("challenger replacement requires diverse and improved validation evidence", () => {
  const champion = strategy("C"); champion.validation = { daily_sharpe: .5, drawdown: .1 };
  const challenger = strategy("N"); challenger.validation = { daily_sharpe: .6, drawdown: .09 };
  assert.equal(championReplacementAssessment(challenger, champion).eligible, true);
  challenger.behavior_hash = champion.behavior_hash;
  assert.equal(championReplacementAssessment(challenger, champion).eligible, false);
});

test("public health projection omits observations, trades, fills, positions, baselines, and provenance", () => {
  const value = strategy(); recordHealthObservation(value, cycle(), { eventId: "private", sessionDate: "2026-08-03" });
  finalizeHealthSession(value, "2026-08-03", { expectedEvents: 1 });
  const publicState = publicHealthState(value.health), serialized = JSON.stringify(publicState);
  for (const key of ["observations", "closed_trades", "processed_fill_ids", "positions", "baseline", "provenance", "event_ids"]) {
    assert.equal(serialized.includes(key), false);
  }
});

test("release provenance freezes development, validation, and incubation metric distributions", () => {
  const prior = strategy();
  const value = { ...prior, id: "distribution", health: null,
    backtest_runs: { development: { folds: [
      { sharpe: .3, max_drawdown: .08, expectancy: .001 },
      { sharpe: .7, max_drawdown: .05, expectancy: .002 },
    ] } } };
  startReleaseMonitoring(value, { releaseId: "R-distribution" });
  assert.deepEqual(value.health.provenance.baseline.distributions.daily_sharpe, [.8, .6, .3, .7]);
  assert.deepEqual(value.health.provenance.baseline.distributions.drawdown, [.05, .06, .08, .05]);
});

test("frozen monitoring policy cannot be changed after release", () => {
  const value = strategy(); const policy = createHealthPolicy({ hard: { daily_loss: .003 } });
  const fresh = { ...value, id: "frozen", health: null }; startReleaseMonitoring(fresh, { policy, releaseId: "R" });
  const tampered = structuredClone(fresh.health); tampered.policy.hard.daily_loss = .9;
  assert.throws(() => evaluateHealthDecision(tampered), /policy hash mismatch/);
});
