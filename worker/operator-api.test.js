import assert from "node:assert/strict";
import test from "node:test";
import { buildOperationsReadModel, deterministicDownsample, operatorArtifacts, operatorLogs,
  operatorOrders, operatorTrades, operatorTrials, paginateOperatorItems, strategyEvidenceDto } from "./operator-api.js";

function fixture(count = 2) {
  const strategies = Array.from({ length: count }, (_, index) => ({ id: `S-${index}`, name: `Strategy ${index}`,
    state: index % 4 === 0 ? "healthy" : "generated", strategy_format: "dsl-v1", dna_hash: `${index}`.padStart(64, "a"),
    engine_family: "backtrader", metrics: { sharpe: .7, curve: [1, 1.01] },
    backtest_runs: { development: { artifact_id: `A-${index}`, engine_version: "bt-1", config_hash: "c".repeat(64),
      result_hash: "r".repeat(64), folds: [{}, {}, {}] } },
    lifecycle: { operational: { state: "ready" }, history: [{ transition_id: `T-${index}`, timestamp: "2026-08-06T14:00:00Z",
      from: "screened", target: "development", explanation: "Exact historical backtest", correlation_id: `C-${index}` }] },
  }));
  return { strategies, events: [{ id: "E-1", kind: "RELEASE", title: "Paper release", detail: "paper only",
    at: "2026-08-06T15:00:00Z", correlation_id: "C-release" }],
  orchestration: { mode: "autonomous", controls: { entries_paused: false }, incidents: [] },
  marketData: { universe: { feed: "iex", symbol_count: 40, symbols: Array.from({ length: 40 }, (_, i) => `X${i}`) },
    live: { status: "healthy", healthy_symbols: 40, symbol_count: 40, coverage: 1,
      last_poll_at: "2026-08-06T15:00:00Z", revision_events: 1 }, usage: { alpaca_requests: 12 } },
  alpaca: { connected: true, account: { equity: 100000, cash: 80000, buying_power: 160000 },
    clock: { is_open: true, timestamp: "2026-08-06T15:00:00Z" }, positions: [], managed_symbols: [],
    risk_session: { loss_fraction: .001, halted: false }, allocation: { gross_before_netting: 3000 },
    open_orders: [{ id: "O-1", symbol: "SPY", side: "buy", qty: 1, status: "new", submitted_at: "2026-08-06T14:00:00Z" }],
    known_orders: { "O-1": { allocations: [{ strategy_id: "S-0" }] } } },
  research: { paused: false, population: [], cohorts: [], novelty_archive: { dna_hashes: [] },
    trials: { secret: { trial_id: "TR-1", cohort_id: "CO-1", status: "rejected", dna: { raw: true },
      constraint_failures: ["duplicate"], created_at: "2026-08-06T13:00:00Z" } } },
  backtestArtifacts: { "A-0": { id: "A-0", phase: "development", strategy_id: "S-0", content_hash: "h".repeat(64) } } };
}

const enabled = { ORCHESTRATION_MODE: "autonomous", ALPACA_BROKER_MODE: "paper",
  ALPACA_TRADING_ENABLED: "true", ALPACA_LONG_TRADING_ENABLED: "true", BACKTEST_ENGINE: "backtrader",
  ALPACA_MAX_PORTFOLIO_PCT: ".10", ALPACA_DAILY_LOSS_HALT_PCT: ".005", AXIOM_JOBS: {} };

test("operations DTO explains whether new paper risk is possible without exposing configuration secrets", () => {
  const state = fixture(), result = buildOperationsReadModel(state, { ...enabled, ALPACA_API_SECRET: "never-return" },
    { mode: "dual_write", ready: true, bindings: { queue: true }, normalized_cutover_available: false });
  assert.equal(result.mode.new_risk_possible, true); assert.equal(result.market.feed, "IEX");
  assert.equal(result.market.consolidated_sip, false); assert.equal(result.data.expected_symbols, 40);
  assert.equal(result.rollout.phase, "A"); assert.equal(result.rollout.legacy_authoritative, true);
  assert.equal(result.future_boundary.account_class, "paper");
  assert.equal(result.future_boundary.live_money_supported, false);
  assert.equal(result.future_boundary.browser_switch_available, false);
  assert.equal(JSON.stringify(result).includes("never-return"), false);
  assert.ok(result.attention.some((item) => item.code === "iex_not_consolidated"));
});

test("kill, stale data, and disabled switches enumerate exact independent risk blocks", () => {
  const state = fixture(); state.orchestration.controls.kill_switch = true; state.marketData.live.coverage = .5;
  const result = buildOperationsReadModel(state, { ...enabled, ALPACA_TRADING_ENABLED: "false" });
  assert.equal(result.mode.code, "kill_flatten"); assert.equal(result.mode.new_risk_possible, false);
  for (const code of ["kill_switch", "market_data_unhealthy", "paper_trading_disabled"]) assert.ok(result.mode.blocked_reasons.includes(code));
});

test("opaque pagination is deterministic, bounded, and rejects stale cursors", () => {
  const items = Array.from({ length: 250 }, (_, index) => ({ id: `I-${index}` }));
  const first = paginateOperatorItems(items, { limit: 100, kind: "fixture" });
  const second = paginateOperatorItems(items, { limit: 100, kind: "fixture", cursor: first.next_cursor });
  assert.equal(first.count, 100); assert.equal(second.items[0].id, "I-100");
  assert.throws(() => paginateOperatorItems([...items, { id: "new" }], { cursor: first.next_cursor, kind: "fixture" }), /stale/);
});

test("trial, order, trade, log, and artifact DTOs are summaries, never private payloads", () => {
  const state = fixture(); state.strategies[0].health = { closed_trades: [{ trade_id: "P-1", symbol: "SPY",
    direction: "long", entry_at: "2026-08-06T14:00:00Z", exit_at: "2026-08-06T14:10:00Z", pnl: 2, net_return: .001 }] };
  const output = { trials: operatorTrials(state), orders: operatorOrders(state), trades: operatorTrades(state),
    logs: operatorLogs(state), artifacts: operatorArtifacts(state) };
  const serialized = JSON.stringify(output);
  assert.equal(output.trials[0].id, "TR-1"); assert.equal(output.orders[0].source, "axiom");
  assert.equal(output.trades[0].source, "alpaca_paper"); assert.equal(output.logs[0].correlation_id, "C-release");
  for (const forbidden of ["raw_bars", "holdout_bars", "object_key", "payload_bytes", "\"dna\""]) assert.equal(serialized.includes(forbidden), false);
});

test("strategy evidence uses honest stage language and never exposes sealed bars", () => {
  const strategy = fixture().strategies[0]; strategy.state = "validation";
  const dto = strategyEvidenceDto(strategy), serialized = JSON.stringify(dto);
  assert.equal(dto.evidence_context, "sealed_validation_pending");
  assert.equal(dto.provenance.validation.raw_bars_exposed, false);
  assert.equal(serialized.includes("bars"), true); assert.equal(serialized.includes("holdout_bars"), false);
});

test("deterministic display sampling preserves endpoints and important spikes", () => {
  const values = Array.from({ length: 1000 }, (_, index) => index === 501 ? 100 : Math.sin(index / 20));
  const first = deterministicDownsample(values, 80), second = deterministicDownsample(values, 80);
  assert.deepEqual(first, second); assert.equal(first.length, 80);
  assert.equal(first[0].x, 0); assert.equal(first.at(-1).x, 999);
  assert.ok(first.some((item) => item.y === 100));
});

test("hundreds of strategies and a 40-symbol universe remain bounded", () => {
  const state = fixture(500), started = performance.now();
  const operations = buildOperationsReadModel(state, enabled);
  const page = paginateOperatorItems(operatorArtifacts(state), { limit: 100, kind: "artifacts" });
  assert.equal(operations.data.expected_symbols, 40); assert.equal(page.count, 100);
  assert.ok(performance.now() - started < 250);
});
