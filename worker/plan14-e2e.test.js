import assert from "node:assert/strict";
import test from "node:test";
import { applyAlpacaCycle, createDemoState } from "./engine.js";
import { buildGeneratedStrategyDNA } from "./dsl-generation.js";
import { applyLifecycleCommand, initialLifecycle, transitionId } from "./lifecycle.js";
import { evaluateIncubationGate, startIncubation } from "./incubation.js";
import { recordHealthObservation, startReleaseMonitoring } from "./monitoring.js";

const H = (char) => char.repeat(64);
const SYMBOLS = ["AAPL", "AMD", "MSFT", "NVDA", "SPY"];

function transition(lifecycle, target, index) {
  const value = { schema_version: 1, strategy_id: lifecycle.strategy_id, kind: "quality",
    expected: { quality_state: lifecycle.quality.state, version: lifecycle.quality.version }, target,
    trigger: `plan14:${target}`, artifact_id: `artifact-${target}`, event_id: `event-${target}`,
    policy_hash: H("d"), actor: "system", timestamp: `2026-08-${String(index + 1).padStart(2, "0")}T12:00:00.000Z`,
    reason_code: target, explanation: `Verified ${target} evidence`, correlation_id: `plan14:${target}`,
    provenance: { dna_hash: lifecycle.provenance.dna_hash, dataset_hash: H("b"), configuration_hash: H("c") } };
  return applyLifecycleCommand(lifecycle, { ...value, transition_id: transitionId(value) }).state;
}

function trade(index) {
  const symbol = SYMBOLS[index % SYMBOLS.length], day = String(index % 10 + 1).padStart(2, "0");
  return { trade_id: `T-${index}`, trade_key: `${symbol}:${index}`, symbol, direction: "long", signed_units: 1,
    entry_price: 100, exit_price: 100.2, entry_at: `2026-08-${day}T14:00:00Z`,
    exit_at: `2026-08-${day}T14:05:00Z`, holding_bars: 1, fill_count: 2, gross_pnl: .2,
    cost: .01, pnl: .19, net_return: .0019, session_date: `2026-08-${day}`, eligible: true, exclusion_reasons: [] };
}

test("typed generation evidence flows through validation, incubation, paper attribution, and monitoring", () => {
  const { dna } = buildGeneratedStrategyDNA({ family: "Dual average trend", params: { fast: 5, slow: 20, threshold: .001,
    position_size: .005 }, seed: 14, trialId: "TR-plan14", symbols: SYMBOLS });
  let lifecycle = initialLifecycle({ strategy_id: dna.strategy_id, dna_hash: dna.dna_hash,
    dataset_hash: H("b"), configuration_hash: H("c"), policy_hash: H("d") });
  for (const [index, stage] of ["compiled", "screened", "development", "supervisor_approved", "sealed_validation", "incubation"].entries()) {
    lifecycle = transition(lifecycle, stage, index);
  }
  const strategy = { id: dna.strategy_id, name: "Plan 14 finalist", state: "incubation", strategy_format: "dsl-v1",
    strategy_dna: dna, dna_hash: dna.dna_hash, behavior_hash: H("e"), lifecycle,
    metrics: { daily_sharpe: 1, drawdown: .03 }, validation: { daily_sharpe: .8, drawdown: .04 } };
  startIncubation(strategy, { startedAt: "2026-08-01T12:00:00Z" });
  for (let index = 0; index < 10; index += 1) {
    const date = `2026-08-${String(index + 1).padStart(2, "0")}`;
    strategy.incubation.sessions[date] = { session_date: date, completed: true, valid: true, observations: 78,
      observed_bars: 78, expected_bars: 78, coverage: 1, active_before_open: true, critical_fault: false,
      critical_faults: [], exclusions: [], event_ids: [] };
  }
  strategy.incubation.closed_trade_ledger.push(...Array.from({ length: 67 }, (_, index) => trade(index)));
  const incubation = evaluateIncubationGate(strategy.incubation);
  assert.equal(incubation.outcome, "released_paper");
  lifecycle = transition(lifecycle, "released_paper", 7); strategy.lifecycle = lifecycle; strategy.state = "released";
  startReleaseMonitoring(strategy, { releaseId: "REL-plan14", startedAt: "2026-08-11T20:01:00Z" });

  const state = createDemoState(); state.strategies.push(strategy);
  const fill = { broker_fill_id: "F-plan14", symbol: "SPY", side: "buy", qty: 2, price: 100,
    transaction_time: "2026-08-12T14:05:00Z", allocations: [{ strategy_id: strategy.id, signed_notional: 200 }] };
  applyAlpacaCycle(state, { scheduled_bucket: "2026-08-12T14:05:00Z", fetched_at: "2026-08-12T14:05:01Z",
    feed: "iex", trading_enabled: true, short_trading_enabled: false, can_trade_now: true,
    account: { equity: 100000 }, positions: [{ symbol: "SPY", qty: "2", side: "long", market_value: "200" }],
    open_orders: [], proposed_orders: [], submitted_orders: [{ id: "O-plan14", symbol: "SPY", side: "buy",
      status: "filled", client_order_id: "axiom-plan14", allocations: fill.allocations }], order_errors: [], safety_reasons: [],
    evaluations: {}, fills: [fill], clock: { is_open: true, timestamp: "2026-08-12T14:05:00Z" } });
  assert.equal(state.alpaca.position_attribution.SPY.by_strategy[strategy.id], 2);
  assert.equal(state.alpaca.managed_symbols.includes("SPY"), true);

  const monitored = recordHealthObservation(strategy, { clock: { timestamp: "2026-08-12T14:10:00Z" },
    fetched_at: "2026-08-12T14:10:01Z", account: { equity: 100000 }, evaluations: { [strategy.id]: { symbols: {
      SPY: { latest_price: 100.1, latest_open: 100.1, bar_time: "2026-08-12T14:10:00Z" } } } },
    allocation: { contributions: [{ strategy_id: strategy.id, symbol: "SPY", notional: 200 }] },
    fills: [], safety_reasons: [] }, { eventId: "monitor-plan14", sessionDate: "2026-08-12" });
  assert.equal(monitored.observation.event_id, "monitor-plan14");
  assert.equal(strategy.health.observations.length, 1);
  assert.equal(strategy.lifecycle.quality.state, "released_paper");
});
