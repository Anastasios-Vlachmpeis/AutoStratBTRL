import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPaperCycle,
  canReleaseStrategyToPaper,
  cancelManagedOpenOrders,
  getAccountOverview,
  getFiveMinuteHistory,
  getMarketCalendar,
  getPortfolioHistory,
  getResearchBars,
  getStockBars,
} from "./alpaca.js";

const credentials = {
  ALPACA_API_KEY: "paper-key",
  ALPACA_API_SECRET: "paper-secret",
  ALPACA_DATA_FEED: "iex",
  ALPACA_BROKER_MODE: "shadow",
  ALPACA_TRADING_ENABLED: "false",
  ALPACA_LONG_TRADING_ENABLED: "false",
  ALPACA_SHORT_TRADING_ENABLED: "false",
  ALPACA_MAX_STRATEGY_PCT: "0.005",
  ALPACA_MAX_PORTFOLIO_PCT: "0.10",
};

function momentumStrategy(asset = "SPY", size = 0.5) {
  return {
    id: `AX-${asset}-01`, name: "Trend", state: "released", asset, archetype: "Momentum",
    params: { fast: 5, slow: 20, threshold: 0.001, position_size: size },
  };
}

function stateFor(...strategies) {
  return { strategies, alpaca: { managed_symbols: [] },
    marketData: { live: { status: "healthy", coverage: 1 } } };
}

function fixtureFetch({
  existingOrder = null,
  positions = [],
  orders = [],
  fills = [],
  clock = {},
  barEnd = null,
  assets = {},
  account = {},
  descendingSymbols = [],
  portfolioHistory = {
    timestamp: [1785456000, 1785542400, 1785628800],
    equity: [100000, 100250, 100425.5],
    profit_loss: [0, 250, 425.5],
    profit_loss_pct: [0, 0.0025, 0.004255],
    base_value: 100000,
    base_value_asof: "2026-07-31T00:00:00Z",
  },
  } = {}) {
  const submitted = [];
  const requests = [];
  const mock = async (input, init = {}) => {
    const url = new URL(String(input));
    requests.push(url);
    const requestHeaders = new Headers(init.headers);
    assert.equal(requestHeaders.get("APCA-API-KEY-ID"), "paper-key");
    assert.equal(requestHeaders.get("APCA-API-SECRET-KEY"), "paper-secret");

    if (url.pathname === "/v2/account") return Response.json({
      status: "ACTIVE", currency: "USD", cash: "100000", buying_power: "200000",
      equity: "100000", last_equity: "100000", portfolio_value: "100000",
      daytrade_count: 0, trading_blocked: false, account_blocked: false, pattern_day_trader: false,
      ...account,
    });
    if (url.pathname === "/v2/positions") return Response.json(positions);
    if (url.pathname === "/v2/orders" && init.method !== "POST") return Response.json(orders);
    if (url.pathname.startsWith("/v2/orders/") && init.method === "DELETE") return Response.json({});
    if (url.pathname === "/v2/clock") return Response.json({
      is_open: true, timestamp: "2026-08-03T15:00:00Z",
      next_open: "2026-08-04T13:30:00Z", next_close: "2026-08-03T20:00:00Z",
      ...clock,
    });
    if (url.pathname === "/v2/calendar") return Response.json([
      { date: "2026-08-03", open: "09:30", close: "16:00" },
      { date: "2026-11-27", open: "09:30", close: "13:00" },
    ]);
    if (url.pathname === "/v2/account/portfolio/history") return Response.json(portfolioHistory);
    if (url.pathname === "/v2/account/activities/FILL") return Response.json(fills);
    if (url.pathname === "/v2/stocks/bars") {
      const symbols = url.searchParams.get("symbols").split(",");
      const finalBar = Date.parse(barEnd ?? clock.timestamp ?? "2026-08-03T15:00:00Z");
      const bars = Object.fromEntries(symbols.map((symbol) => [symbol, Array.from({ length: 260 }, (_, index) => ({
        t: new Date(finalBar - (259 - index) * 5 * 60_000).toISOString(),
        o: descendingSymbols.includes(symbol) ? 400 - index : 100 + index,
        h: descendingSymbols.includes(symbol) ? 401 - index : 101 + index,
        l: descendingSymbols.includes(symbol) ? 399 - index : 99 + index,
        c: descendingSymbols.includes(symbol) ? 400.5 - index : 100.5 + index, v: 1000 + index,
      }))]));
      return Response.json({ bars, next_page_token: null });
    }
    if (url.pathname.startsWith("/v2/assets/")) {
      const symbol = decodeURIComponent(url.pathname.split("/").at(-1));
      return Response.json({ tradable: true, fractionable: true, shortable: true,
        borrow_status: "easy_to_borrow", status: "active", ...(assets[symbol] ?? {}) });
    }
    if (url.pathname === "/v2/orders:by_client_order_id") {
      return existingOrder ? Response.json(existingOrder) : Response.json({ message: "not found" }, { status: 404 });
    }
    if (url.pathname === "/v2/orders" && init.method === "POST") {
      const body = JSON.parse(init.body);
      submitted.push(body);
      return Response.json({ id: "order-1", status: "accepted", filled_qty: "0", ...body });
    }
    return Response.json({ message: `Unhandled ${url.pathname}` }, { status: 500 });
  };
  mock.submitted = submitted;
  mock.requests = requests;
  return mock;
}

test("account overview is sanitized and credentials stay in headers", async () => {
  globalThis.fetch = fixtureFetch();
  const overview = await getAccountOverview(credentials);
  assert.equal(overview.connected, true);
  assert.equal(overview.account.equity, 100000);
  assert.equal(overview.account.trading_blocked, false);
  assert.deepEqual(overview.positions, []);
  assert.equal(overview.portfolio_history.points.length, 3);
});

test("portfolio history requests three months of daily data and sanitizes aligned points", async () => {
  globalThis.fetch = fixtureFetch({
    portfolioHistory: {
      timestamp: [1785456000, "invalid", 1785628800],
      equity: [100000, 100100, 100425.5],
      profit_loss: [0, 100, 425.5],
      profit_loss_pct: [0, 0.001, 0.004255],
      base_value: "100000",
    },
  });
  const history = await getPortfolioHistory(credentials);
  assert.equal(history.period, "3M");
  assert.equal(history.timeframe, "1D");
  assert.equal(history.base_value, 100000);
  assert.equal(history.points.length, 2);
  assert.equal(history.points.at(-1).profit_loss, 425.5);
  assert.match(history.points[0].timestamp, /^2026-/);
});

test("account overview returns sanitized positions and open orders without trading", async () => {
  const mock = fixtureFetch({
    positions: [{
      symbol: "SPY", asset_class: "us_equity", qty: "3.5", side: "long", market_value: "1800",
      avg_entry_price: "500", current_price: "514.28", unrealized_pl: "50", unrealized_plpc: "0.02857",
      secret_internal_field: "must-not-leak",
    }],
    orders: [{
      id: "order-manual", client_order_id: "manual-order", symbol: "QQQ", side: "buy", type: "limit",
      status: "new", qty: "2", notional: null, filled_qty: "0", submitted_at: "2026-08-03T15:00:00Z",
      extended_internal_payload: "must-not-leak",
    }],
  });
  globalThis.fetch = mock;
  const overview = await getAccountOverview({ ...credentials, ALPACA_TRADING_ENABLED: "true" });
  assert.equal(overview.positions[0].qty, 3.5);
  assert.equal(overview.positions[0].unrealized_pl, 50);
  assert.equal(overview.open_orders[0].client_order_id, "manual-order");
  assert.equal("secret_internal_field" in overview.positions[0], false);
  assert.equal("extended_internal_payload" in overview.open_orders[0], false);
  assert.equal(mock.submitted.length, 0);
});

test("safety cancellation removes only framework-owned open orders", async () => {
  const mock = fixtureFetch({ orders: [
    { id: "managed-1", client_order_id: "axiom-bucket-spy-buy", symbol: "SPY", side: "buy", type: "market", status: "new", qty: "1" },
    { id: "manual-1", client_order_id: "my-manual-order", symbol: "QQQ", side: "buy", type: "limit", status: "new", qty: "2" },
  ] });
  globalThis.fetch = mock;
  const result = await cancelManagedOpenOrders(credentials);
  assert.equal(result.cancelled.length, 1);
  assert.equal(result.cancelled[0].id, "managed-1");
  assert.equal(result.skipped_manual_orders, 1);
  assert.equal(mock.requests.some((url) => url.pathname === "/v2/orders/managed-1"), true);
  assert.equal(mock.requests.some((url) => url.pathname === "/v2/orders/manual-1"), false);
});

test("research bars request the configured IEX feed", async () => {
  globalThis.fetch = fixtureFetch();
  const bars = await getResearchBars(credentials, ["SPY", "QQQ"]);
  assert.equal(bars.SPY.length, 260);
  assert.equal(bars.QQQ.at(-1).c, 359.5);
});

test("five-minute history and calendar requests freeze explicit source parameters", async () => {
  const mock = fixtureFetch();
  globalThis.fetch = mock;
  const bars = await getFiveMinuteHistory(credentials, "SPY", {
    start: "2026-07-01T00:00:00Z", end: "2026-08-01T00:00:00Z",
  });
  const calendar = await getMarketCalendar(credentials, "2026-07-01", "2026-08-01");
  assert.equal(bars.SPY.length, 260);
  const request = mock.requests.find((url) => url.pathname === "/v2/stocks/bars");
  assert.equal(request.searchParams.get("timeframe"), "5Min");
  assert.equal(request.searchParams.get("feed"), "iex");
  assert.equal(request.searchParams.get("adjustment"), "all");
  assert.equal(calendar[1].close, "13:00");
});

test("stock-bar pagination follows deterministic tokens beyond one response", async () => {
  let calls = 0;
  globalThis.fetch = async (input, init = {}) => {
    const headers = new Headers(init.headers);
    assert.equal(headers.get("APCA-API-KEY-ID"), "paper-key");
    const url = new URL(String(input));
    calls += 1;
    const second = url.searchParams.get("page_token") === "page-2";
    return Response.json({ bars: { SPY: [barFixture(second ? 2 : 1)] }, next_page_token: second ? null : "page-2" });
  };
  function barFixture(day) {
    return { t: `2026-08-0${day}T13:30:00Z`, o: 100, h: 101, l: 99, c: 100.5, v: 1000 };
  }
  const bars = await getStockBars(credentials, ["SPY"], {
    timeframe: "5Min", start: "2026-08-01T00:00:00Z", end: "2026-08-03T00:00:00Z",
  });
  assert.equal(calls, 2);
  assert.equal(bars.SPY.length, 2);
});

test("paper cycle proposes but does not submit while trading is disabled", async () => {
  const mock = fixtureFetch();
  globalThis.fetch = mock;
  const appState = {
    strategies: [{
      id: "AX-01-001", name: "Trend", state: "released", asset: "SPY", archetype: "Momentum",
      params: { fast: 5, slow: 20, threshold: 0.001, position_size: 0.5 },
    }],
    alpaca: { managed_symbols: [] },
  };
  const cycle = await buildPaperCycle(credentials, appState, "2026-08-03T15");
  assert.equal(cycle.trading_enabled, false);
  assert.equal(cycle.proposed_orders.length, 1);
  assert.equal(cycle.submitted_orders.length, 0);
  assert.equal(mock.submitted.length, 0);
});

test("explicit paper-trading enablement submits an idempotent long order", async () => {
  const mock = fixtureFetch();
  globalThis.fetch = mock;
  const appState = {
    strategies: [{
      id: "AX-01-001", name: "Trend", state: "released", asset: "SPY", archetype: "Momentum",
      params: { fast: 5, slow: 20, threshold: 0.001, position_size: 0.5 },
    }],
    alpaca: { managed_symbols: [] },
  };
  const cycle = await buildPaperCycle({ ...credentials, ALPACA_BROKER_MODE: "paper",
    ALPACA_TRADING_ENABLED: "true", ALPACA_LONG_TRADING_ENABLED: "true" }, appState, "2026-08-03T15");
  assert.equal(cycle.can_trade_now, true);
  assert.equal(cycle.submitted_orders.length, 1);
  assert.equal(mock.submitted[0].side, "buy");
  assert.equal(mock.submitted[0].time_in_force, "day");
  assert.ok("notional" in mock.submitted[0]);
  assert.equal("qty" in mock.submitted[0], false);
  assert.match(mock.submitted[0].client_order_id, /^axiom-/);
});

test("signed signals propose a whole-share ETB short but do not submit it by default", async () => {
  const mock = fixtureFetch({ descendingSymbols: ["SPY"] });
  globalThis.fetch = mock;
  const cycle = await buildPaperCycle({ ...credentials, ALPACA_BROKER_MODE: "paper",
    ALPACA_TRADING_ENABLED: "true", ALPACA_LONG_TRADING_ENABLED: "true" }, stateFor(momentumStrategy()), "2026-08-03T16");
  assert.equal(cycle.evaluations["AX-SPY-01"].signal, -1);
  assert.equal(cycle.proposed_orders[0].side, "sell");
  assert.ok(cycle.proposed_orders[0].qty > 0);
  assert.equal(cycle.submitted_orders.length, 0);
  assert.match(cycle.safety_reasons[0].reason, /short_trading_disabled/);
});

test("incubation evaluation exposes the next-open price and can never submit orders", async () => {
  const mock = fixtureFetch(); globalThis.fetch = mock;
  const strategy = { ...momentumStrategy(), state: "incubation" };
  const cycle = await buildPaperCycle({ ...credentials, ALPACA_TRADING_ENABLED: "true" }, stateFor(strategy),
    "2026-08-03T16", "2026-08-03T16", { scope: "incubation", tradingEnabled: false });
  assert.ok(cycle.evaluations[strategy.id].latest_open > 0);
  assert.equal(cycle.trading_enabled, false); assert.deepEqual(cycle.submitted_orders, []);
  assert.equal(mock.submitted.length, 0);
});

test("ETB shorts submit only with explicit short enablement", async () => {
  const mock = fixtureFetch({ descendingSymbols: ["SPY"] });
  globalThis.fetch = mock;
  const cycle = await buildPaperCycle({ ...credentials, ALPACA_BROKER_MODE: "paper",
    ALPACA_TRADING_ENABLED: "true", ALPACA_SHORT_TRADING_ENABLED: "true" }, stateFor(momentumStrategy()), "2026-08-03T17");
  assert.equal(cycle.submitted_orders.length, 1);
  assert.equal(mock.submitted[0].side, "sell");
  assert.ok("qty" in mock.submitted[0]);
  assert.equal("notional" in mock.submitted[0], false);
});

test("borrow loss blocks a new short while preserving the safety reason", async () => {
  globalThis.fetch = fixtureFetch({ descendingSymbols: ["SPY"], assets: { SPY: { borrow_status: "hard_to_borrow" } } });
  const cycle = await buildPaperCycle(credentials, stateFor(momentumStrategy()), "2026-08-03T18");
  assert.equal(cycle.proposed_orders.length, 0);
  assert.deepEqual(cycle.safety_reasons, [{ symbol: "SPY", reason: "short_borrow_unavailable" }]);
});

test("existing short can be covered after borrow eligibility is lost", async () => {
  globalThis.fetch = fixtureFetch({
    positions: [{ symbol: "SPY", side: "short", qty: "5", market_value: "-725", current_price: "145" }],
    assets: { SPY: { borrow_status: "hard_to_borrow" } },
  });
  const appState = stateFor(momentumStrategy());
  appState.alpaca.managed_symbols = ["SPY"];
  const cycle = await buildPaperCycle(credentials, appState, "2026-08-03T19");
  assert.equal(cycle.proposed_orders[0].side, "buy");
  assert.equal(cycle.proposed_orders[0].qty, 5);
});

test("operator flatten overrides strategy targets but closes only managed exposure", async () => {
  const mock = fixtureFetch({
    positions: [{ symbol: "SPY", side: "long", qty: "4", market_value: "1000", current_price: "250" }],
  });
  globalThis.fetch = mock;
  const appState = stateFor(momentumStrategy());
  appState.alpaca.managed_symbols = ["SPY"];
  appState.orchestration = { controls: { flatten_requested: true } };
  const cycle = await buildPaperCycle({ ...credentials, ALPACA_TRADING_ENABLED: "true" }, appState, "2026-08-03T19:05");
  assert.equal(cycle.force_flatten, true);
  assert.equal(cycle.evaluations["AX-SPY-01"], undefined);
  assert.equal(cycle.submitted_orders.length, 1);
  assert.equal(mock.submitted[0].side, "sell");
  assert.equal(mock.submitted[0].qty, "4");
});

test("safety flatten can close managed exposure after normal trading is disabled", async () => {
  const mock = fixtureFetch({
    positions: [{ symbol: "SPY", side: "long", qty: "4", market_value: "1000", current_price: "250" }],
  });
  globalThis.fetch = mock;
  const appState = stateFor(momentumStrategy());
  appState.alpaca.managed_symbols = ["SPY"];
  appState.orchestration = { controls: { flatten_requested: true, entries_paused: true } };
  const cycle = await buildPaperCycle(credentials, appState, "2026-08-03T19:55",
    "2026-08-03T19:55", { safetyFlatten: true });
  assert.equal(cycle.trading_enabled, true);
  assert.equal(cycle.submitted_orders.length, 1);
  assert.equal(mock.submitted[0].side, "sell");
  assert.equal(mock.submitted[0].qty, "4");
});

test("direction flips flatten the managed position before opening the opposite side", async () => {
  globalThis.fetch = fixtureFetch({
    positions: [{ symbol: "SPY", side: "long", qty: "4", market_value: "1000", current_price: "250" }],
    descendingSymbols: ["SPY"],
  });
  const appState = stateFor(momentumStrategy());
  appState.alpaca.managed_symbols = ["SPY"];
  const cycle = await buildPaperCycle(credentials, appState, "2026-08-03T20");
  assert.equal(cycle.proposed_orders.length, 1);
  assert.equal(cycle.proposed_orders[0].side, "sell");
  assert.equal(cycle.proposed_orders[0].qty, 4);
  assert.match(cycle.proposed_orders[0].client_order_id, /^axiom-[a-f0-9]{36}$/);
});

test("unmanaged positions and blocked accounts cannot receive automated orders", async () => {
  globalThis.fetch = fixtureFetch({ positions: [{ symbol: "SPY", side: "long", qty: "2", market_value: "500", current_price: "250" }] });
  let cycle = await buildPaperCycle({ ...credentials, ALPACA_BROKER_MODE: "paper",
    ALPACA_TRADING_ENABLED: "true", ALPACA_LONG_TRADING_ENABLED: "true" }, stateFor(momentumStrategy()), "2026-08-03T21");
  assert.equal(cycle.proposed_orders.length, 0);
  assert.equal(cycle.safety_reasons[0].reason, "unmanaged_existing_position");

  const mock = fixtureFetch({ account: { trading_blocked: true } });
  globalThis.fetch = mock;
  cycle = await buildPaperCycle({ ...credentials, ALPACA_BROKER_MODE: "paper",
    ALPACA_TRADING_ENABLED: "true", ALPACA_LONG_TRADING_ENABLED: "true" }, stateFor(momentumStrategy()), "2026-08-03T22");
  assert.equal(cycle.can_trade_now, false);
  assert.equal(cycle.submitted_orders.length, 0);
  assert.equal(cycle.proposed_orders.length, 1);
});

test("gross portfolio cap scales opposing and same-direction strategy targets by absolute exposure", async () => {
  const mock = fixtureFetch();
  globalThis.fetch = mock;
  const strategies = [momentumStrategy("SPY", 1), momentumStrategy("QQQ", 1), momentumStrategy("IWM", 1)];
  const cycle = await buildPaperCycle({ ...credentials, ALPACA_MAX_STRATEGY_PCT: "0.05", ALPACA_MAX_PORTFOLIO_PCT: "0.05" }, stateFor(...strategies), "2026-08-03T23");
  assert.equal(cycle.proposed_orders.length, 3);
  assert.ok(cycle.proposed_orders.reduce((sum, order) => sum + order.notional, 0) <= 5000);
});

test("frozen default risk caps are 0.5% per strategy and 10% portfolio gross", async () => {
  globalThis.fetch = fixtureFetch();
  const env = { ...credentials };
  delete env.ALPACA_MAX_STRATEGY_PCT;
  delete env.ALPACA_MAX_PORTFOLIO_PCT;
  const cycle = await buildPaperCycle(env, stateFor(momentumStrategy("SPY", 1)), "2026-08-03T24");
  assert.equal(cycle.proposed_orders.length, 1);
  assert.ok(Number(cycle.proposed_orders[0].notional) <= 500);
});

test("the entry cutoff blocks new risk and the close window flattens managed risk", async () => {
  globalThis.fetch = fixtureFetch({ clock: { timestamp: "2026-08-03T19:31:00Z" } });
  let cycle = await buildPaperCycle(credentials, stateFor(momentumStrategy()), "cutoff");
  assert.equal(cycle.session_risk.status, "reduce_only");
  assert.equal(cycle.block_new_risk, true);
  assert.equal(cycle.proposed_orders.length, 0);

  globalThis.fetch = fixtureFetch({
    clock: { timestamp: "2026-08-03T19:51:00Z" },
    positions: [{ symbol: "SPY", side: "long", qty: "4", market_value: "1000", current_price: "250" }],
  });
  const state = stateFor(momentumStrategy()); state.alpaca.managed_symbols = ["SPY"];
  cycle = await buildPaperCycle(credentials, state, "close-flatten");
  assert.equal(cycle.force_flatten, true);
  assert.equal(cycle.submitted_orders.length, 1);
  assert.equal(cycle.submitted_orders[0].side, "sell");
});

test("daily loss halt is sticky, cancels managed orders, and flattens positions", async () => {
  const mock = fixtureFetch({
    account: { equity: "99400", portfolio_value: "99400" },
    positions: [{ symbol: "SPY", side: "long", qty: "2", market_value: "500", current_price: "250" }],
    orders: [{ id: "open-1", client_order_id: "axiom-existing", symbol: "SPY", side: "buy",
      type: "market", status: "new", qty: "1" }],
  });
  globalThis.fetch = mock;
  const state = stateFor(momentumStrategy());
  state.alpaca = { managed_symbols: ["SPY"], risk_session: { session_date: "2026-08-03",
    baseline_equity: 100000, halted: false } };
  const cycle = await buildPaperCycle(credentials, state, "daily-halt");
  assert.equal(cycle.daily_risk.halted, true);
  assert.equal(cycle.force_flatten, true);
  assert.equal(cycle.cancelled_orders.length, 1);
  assert.equal(cycle.submitted_orders.length, 1);
});

test("fill polling attaches only known framework attribution", async () => {
  globalThis.fetch = fixtureFetch({ fills: [{ id: "fill-1", order_id: "broker-order-1", symbol: "SPY",
    side: "buy", qty: "1.25", price: "400", transaction_time: "2026-08-03T14:59:00Z",
    type: "partial_fill", cum_qty: "1.25", leaves_qty: "0.25" }] });
  const state = stateFor(momentumStrategy());
  state.alpaca.known_orders = { "broker-order-1": { client_order_id: "axiom-known",
    allocations: [{ strategy_id: "AX-SPY-01", signed_notional: 500 }] } };
  const cycle = await buildPaperCycle(credentials, state, "fill-poll");
  assert.equal(cycle.fills[0].qty, 1.25);
  assert.equal(cycle.fills[0].client_order_id, "axiom-known");
  assert.equal(cycle.fills[0].allocations[0].strategy_id, "AX-SPY-01");
});

test("a bounded canary is the only order allowed in canary mode", async () => {
  const mock = fixtureFetch(); globalThis.fetch = mock;
  const cycle = await buildPaperCycle({ ...credentials, ALPACA_BROKER_MODE: "canary",
    ALPACA_CANARY_TRADING_ENABLED: "true" }, stateFor(), "canary", "canary",
  { canary: { symbol: "SPY", side: "buy", notional: 25 } });
  assert.equal(cycle.submitted_orders.length, 1);
  assert.equal(mock.submitted[0].notional, "25");
});

test("short-capable DNA cannot release until the independent paper-short switch is active", () => {
  const strategy = { strategy_format: "dsl-v1", strategy_dna: { entry: { short: "short-signal" } } };
  assert.equal(canReleaseStrategyToPaper(credentials, strategy), false);
  assert.equal(canReleaseStrategyToPaper({ ...credentials, ALPACA_BROKER_MODE: "paper",
    ALPACA_TRADING_ENABLED: "true", ALPACA_SHORT_TRADING_ENABLED: "true" }, strategy), true);
  assert.equal(canReleaseStrategyToPaper(credentials,
    { strategy_format: "dsl-v1", strategy_dna: { entry: { short: null } } }), true);
});

test("stale market bars fail closed without disturbing existing flat state", async () => {
  globalThis.fetch = fixtureFetch({ barEnd: "2026-08-03T12:00:00Z" });
  const cycle = await buildPaperCycle(credentials, stateFor(momentumStrategy()), "stale-data");
  assert.equal(cycle.proposed_orders.length, 0);
  assert.equal(cycle.evaluations["AX-SPY-01"].critical_fault, "stale_or_insufficient_market_data");
});

test("retries reuse the deterministic client ID and never duplicate broker exposure", async () => {
  const existing = { id: "existing-1", status: "accepted", filled_qty: "0",
    client_order_id: "existing-client", symbol: "SPY", side: "buy", type: "market", notional: "500" };
  const mock = fixtureFetch({ existingOrder: existing }); globalThis.fetch = mock;
  const cycle = await buildPaperCycle({ ...credentials, ALPACA_BROKER_MODE: "paper",
    ALPACA_TRADING_ENABLED: "true", ALPACA_LONG_TRADING_ENABLED: "true" },
  stateFor(momentumStrategy()), "same-finalized-bar", "same-finalized-bar");
  assert.equal(cycle.submitted_orders[0].id, "existing-1");
  assert.equal(mock.submitted.length, 0);
});

test("malformed buying power, clock uncertainty, and broker failures fail closed", async () => {
  globalThis.fetch = fixtureFetch({ account: { buying_power: "not-a-number" } });
  await assert.rejects(buildPaperCycle(credentials, stateFor(momentumStrategy()), "bad-account"),
    /equity\/buying power/);

  const mock = fixtureFetch({ clock: { next_close: "not-a-date" } }); globalThis.fetch = mock;
  const uncertain = await buildPaperCycle({ ...credentials, ALPACA_BROKER_MODE: "paper",
    ALPACA_TRADING_ENABLED: "true", ALPACA_LONG_TRADING_ENABLED: "true" },
  stateFor(momentumStrategy()), "bad-clock");
  assert.equal(uncertain.session_risk.critical, true);
  assert.equal(uncertain.submitted_orders.length, 0);

  globalThis.fetch = fixtureFetch({ clock: { is_open: false },
    positions: [{ symbol: "SPY", side: "long", qty: "1", market_value: "250", current_price: "250" }] });
  const closedState = stateFor(momentumStrategy()); closedState.alpaca.managed_symbols = ["SPY"];
  const closed = await buildPaperCycle(credentials, closedState, "closed-market");
  assert.ok(closed.safety_reasons.some((item) => item.reason === "managed_position_outside_regular_session"));

  globalThis.fetch = async () => { throw new DOMException("timed out", "TimeoutError"); };
  await assert.rejects(buildPaperCycle(credentials, stateFor(momentumStrategy()), "timeout"), /timed out/);
});

test("position-attribution divergence forces broker-authoritative flatten", async () => {
  globalThis.fetch = fixtureFetch({
    positions: [{ symbol: "SPY", side: "long", qty: "2", market_value: "500", current_price: "250" }],
  });
  const state = stateFor(momentumStrategy());
  state.alpaca = { managed_symbols: ["SPY"], position_attribution: {
    SPY: { signed_quantity: 1, by_strategy: { "AX-SPY-01": 1 } },
  } };
  const cycle = await buildPaperCycle(credentials, state, "divergence");
  assert.equal(cycle.force_flatten, true);
  assert.equal(cycle.submitted_orders[0].side, "sell");
  assert.ok(cycle.safety_reasons.some((item) => item.reason === "broker_position_attribution_divergence"));
});
