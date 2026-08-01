import assert from "node:assert/strict";
import test from "node:test";

import { buildPaperCycle, getAccountOverview, getResearchBars } from "./alpaca.js";

const credentials = {
  ALPACA_API_KEY: "paper-key",
  ALPACA_API_SECRET: "paper-secret",
  ALPACA_DATA_FEED: "iex",
  ALPACA_TRADING_ENABLED: "false",
  ALPACA_MAX_STRATEGY_PCT: "0.02",
  ALPACA_MAX_PORTFOLIO_PCT: "0.20",
};

function fixtureFetch({ existingOrder = null } = {}) {
  const submitted = [];
  const mock = async (input, init = {}) => {
    const url = new URL(String(input));
    const requestHeaders = new Headers(init.headers);
    assert.equal(requestHeaders.get("APCA-API-KEY-ID"), "paper-key");
    assert.equal(requestHeaders.get("APCA-API-SECRET-KEY"), "paper-secret");

    if (url.pathname === "/v2/account") return Response.json({
      status: "ACTIVE", currency: "USD", cash: "100000", buying_power: "200000",
      equity: "100000", last_equity: "100000", portfolio_value: "100000",
      daytrade_count: 0, trading_blocked: false, account_blocked: false, pattern_day_trader: false,
    });
    if (url.pathname === "/v2/positions") return Response.json([]);
    if (url.pathname === "/v2/orders" && init.method !== "POST") return Response.json([]);
    if (url.pathname === "/v2/clock") return Response.json({
      is_open: true, timestamp: "2026-08-03T15:00:00Z",
      next_open: "2026-08-04T13:30:00Z", next_close: "2026-08-03T20:00:00Z",
    });
    if (url.pathname === "/v2/stocks/bars") {
      const symbols = url.searchParams.get("symbols").split(",");
      const bars = Object.fromEntries(symbols.map((symbol) => [symbol, Array.from({ length: 260 }, (_, index) => ({
        t: new Date(Date.UTC(2025, 0, 1) + index * 3600000).toISOString(),
        o: 100 + index, h: 101 + index, l: 99 + index, c: 100.5 + index, v: 1000 + index,
      }))]));
      return Response.json({ bars, next_page_token: null });
    }
    if (url.pathname.startsWith("/v2/assets/")) return Response.json({ tradable: true, fractionable: true, status: "active" });
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
  return mock;
}

test("account overview is sanitized and credentials stay in headers", async () => {
  globalThis.fetch = fixtureFetch();
  const overview = await getAccountOverview(credentials);
  assert.equal(overview.connected, true);
  assert.equal(overview.account.equity, 100000);
  assert.equal(overview.account.trading_blocked, false);
  assert.deepEqual(overview.positions, []);
});

test("research bars request the configured IEX feed", async () => {
  globalThis.fetch = fixtureFetch();
  const bars = await getResearchBars(credentials, ["SPY", "QQQ"]);
  assert.equal(bars.SPY.length, 260);
  assert.equal(bars.QQQ.at(-1).c, 359.5);
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

test("explicit paper-trading enablement submits an idempotent long-only order", async () => {
  const mock = fixtureFetch();
  globalThis.fetch = mock;
  const appState = {
    strategies: [{
      id: "AX-01-001", name: "Trend", state: "released", asset: "SPY", archetype: "Momentum",
      params: { fast: 5, slow: 20, threshold: 0.001, position_size: 0.5 },
    }],
    alpaca: { managed_symbols: [] },
  };
  const cycle = await buildPaperCycle({ ...credentials, ALPACA_TRADING_ENABLED: "true" }, appState, "2026-08-03T15");
  assert.equal(cycle.can_trade_now, true);
  assert.equal(cycle.submitted_orders.length, 1);
  assert.equal(mock.submitted[0].side, "buy");
  assert.equal(mock.submitted[0].time_in_force, "day");
  assert.match(mock.submitted[0].client_order_id, /^axiom-/);
});
