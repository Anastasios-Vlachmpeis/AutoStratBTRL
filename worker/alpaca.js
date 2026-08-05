import { evaluateStrategyWindow, latestSignal } from "./engine.js";
import { INITIAL_UNIVERSE_SYMBOLS } from "./universe.js";
import { evaluateLatestTarget } from "./dsl.js";

const PAPER_BASE = "https://paper-api.alpaca.markets";
const DATA_BASE = "https://data.alpaca.markets";
const SUPPORTED_SYMBOLS = [...INITIAL_UNIVERSE_SYMBOLS];

function requireCredentials(env) {
  if (!env.ALPACA_API_KEY || !env.ALPACA_API_SECRET) {
    throw new Error("Alpaca credentials are not configured");
  }
}

function headers(env, json = false) {
  const result = {
    "APCA-API-KEY-ID": env.ALPACA_API_KEY,
    "APCA-API-SECRET-KEY": env.ALPACA_API_SECRET,
  };
  if (json) result["content-type"] = "application/json";
  return result;
}

async function alpacaRequest(env, base, path, init = {}, allowNotFound = false) {
  requireCredentials(env);
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { ...headers(env, init.body != null), ...(init.headers ?? {}) },
  });
  if (allowNotFound && response.status === 404) return null;
  const requestId = response.headers.get("x-request-id");
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload.message || payload.error || response.statusText;
    throw new Error(`Alpaca ${response.status}: ${detail}${requestId ? ` [${requestId}]` : ""}`);
  }
  return payload;
}

function attachRequestCount(value, count) {
  Object.defineProperty(value, "__alpaca_request_count", {
    value: Number(count), enumerable: false, configurable: false, writable: false,
  });
  return value;
}

function cleanNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sanitizeAccount(account) {
  return {
    status: account.status,
    currency: account.currency,
    cash: cleanNumber(account.cash),
    buying_power: cleanNumber(account.buying_power),
    equity: cleanNumber(account.equity),
    last_equity: cleanNumber(account.last_equity),
    portfolio_value: cleanNumber(account.portfolio_value),
    daytrade_count: cleanNumber(account.daytrade_count),
    trading_blocked: Boolean(account.trading_blocked),
    account_blocked: Boolean(account.account_blocked),
    pattern_day_trader: Boolean(account.pattern_day_trader),
  };
}

function sanitizePosition(position) {
  return {
    symbol: position.symbol,
    asset_class: position.asset_class,
    qty: cleanNumber(position.qty),
    side: position.side,
    market_value: cleanNumber(position.market_value),
    avg_entry_price: cleanNumber(position.avg_entry_price),
    current_price: cleanNumber(position.current_price),
    unrealized_pl: cleanNumber(position.unrealized_pl),
    unrealized_plpc: cleanNumber(position.unrealized_plpc),
  };
}

function sanitizeOrder(order) {
  return {
    id: order.id,
    client_order_id: order.client_order_id,
    symbol: order.symbol,
    side: order.side,
    type: order.type,
    status: order.status,
    qty: cleanNumber(order.qty),
    notional: cleanNumber(order.notional),
    filled_qty: cleanNumber(order.filled_qty),
    submitted_at: order.submitted_at,
  };
}

function sanitizePortfolioHistory(history) {
  const timestamps = Array.isArray(history.timestamp) ? history.timestamp : [];
  const equities = Array.isArray(history.equity) ? history.equity : [];
  const profitLoss = Array.isArray(history.profit_loss) ? history.profit_loss : [];
  const profitLossPct = Array.isArray(history.profit_loss_pct) ? history.profit_loss_pct : [];
  const baseValue = cleanNumber(history.base_value);
  const points = timestamps.map((timestamp, index) => {
    const rawEquity = equities[index];
    const numericTimestamp = Number(timestamp);
    const parsedTimestamp = Number.isFinite(numericTimestamp)
      ? new Date(numericTimestamp > 1e12 ? numericTimestamp : numericTimestamp * 1000)
      : new Date(timestamp);
    if (rawEquity == null || !Number.isFinite(Number(rawEquity)) || Number.isNaN(parsedTimestamp.getTime())) return null;
    const equity = cleanNumber(rawEquity);
    const pnl = profitLoss[index] == null ? equity - baseValue : cleanNumber(profitLoss[index]);
    const pnlPct = profitLossPct[index] == null
      ? (baseValue > 0 ? equity / baseValue - 1 : 0)
      : cleanNumber(profitLossPct[index]);
    return { timestamp: parsedTimestamp.toISOString(), equity, profit_loss: pnl, profit_loss_pct: pnlPct };
  }).filter(Boolean);
  return {
    period: "3M",
    timeframe: "1D",
    base_value: baseValue,
    base_value_asof: history.base_value_asof ?? null,
    points,
  };
}

export async function getPortfolioHistory(env) {
  const query = new URLSearchParams({ period: "3M", timeframe: "1D" });
  const history = await alpacaRequest(env, PAPER_BASE, `/v2/account/portfolio/history?${query}`);
  return sanitizePortfolioHistory(history);
}

export async function getAccountOverview(env) {
  const [account, positions, orders, clock, portfolioHistory] = await Promise.all([
    alpacaRequest(env, PAPER_BASE, "/v2/account"),
    alpacaRequest(env, PAPER_BASE, "/v2/positions"),
    alpacaRequest(env, PAPER_BASE, "/v2/orders?status=open&limit=100&direction=desc"),
    alpacaRequest(env, PAPER_BASE, "/v2/clock"),
    getPortfolioHistory(env),
  ]);
  return {
    connected: true,
    fetched_at: new Date().toISOString(),
    account: sanitizeAccount(account),
    positions: positions.map(sanitizePosition),
    open_orders: orders.map(sanitizeOrder),
    portfolio_history: portfolioHistory,
    clock: {
      is_open: Boolean(clock.is_open),
      timestamp: clock.timestamp,
      next_open: clock.next_open,
      next_close: clock.next_close,
    },
  };
}

/** Cancel only orders created by this framework; manual account orders remain untouched. */
export async function cancelManagedOpenOrders(env) {
  const overview = await getAccountOverview(env);
  const managed = overview.open_orders.filter((order) => String(order.client_order_id ?? "").startsWith("axiom-"));
  const cancelled = [];
  for (const order of managed) {
    await alpacaRequest(env, PAPER_BASE, `/v2/orders/${encodeURIComponent(order.id)}`, { method: "DELETE" });
    cancelled.push({ id: order.id, client_order_id: order.client_order_id, symbol: order.symbol });
  }
  return { cancelled, skipped_manual_orders: overview.open_orders.length - managed.length, fetched_at: overview.fetched_at };
}

export async function getStockBars(env, symbols, {
  timeframe, start, end = new Date().toISOString(), limit = 10000,
  adjustment = "all", maxPages = 1000,
}) {
  const allowed = [...new Set(symbols)].filter((symbol) => SUPPORTED_SYMBOLS.includes(symbol));
  if (!allowed.length) return {};
  const collected = Object.fromEntries(allowed.map((symbol) => [symbol, []]));
  let pageToken = null;
  let pages = 0;
  const tokens = new Set();
  do {
    const query = new URLSearchParams({
      symbols: allowed.join(","),
      timeframe,
      start,
      end,
      limit: String(limit),
      feed: env.ALPACA_DATA_FEED || "iex",
      adjustment,
      sort: "asc",
    });
    if (pageToken) query.set("page_token", pageToken);
    const payload = await alpacaRequest(env, DATA_BASE, `/v2/stocks/bars?${query}`);
    for (const symbol of allowed) {
      const bars = payload.bars?.[symbol] ?? [];
      collected[symbol].push(...bars.map((bar) => ({
        t: bar.t,
        o: cleanNumber(bar.o),
        h: cleanNumber(bar.h),
        l: cleanNumber(bar.l),
        c: cleanNumber(bar.c),
        v: cleanNumber(bar.v),
      })));
    }
    pageToken = payload.next_page_token || null;
    if (pageToken && tokens.has(pageToken)) throw new Error("Alpaca bars pagination repeated a page token");
    if (pageToken) tokens.add(pageToken);
    pages += 1;
    if (pageToken && pages >= maxPages) throw new Error(`Alpaca bars pagination exceeded ${maxPages} pages`);
  } while (pageToken);
  return attachRequestCount(collected, pages);
}

export async function getFiveMinuteHistory(env, symbol, { start, end }) {
  return getStockBars(env, [symbol], { timeframe: "5Min", start, end, adjustment: "all", maxPages: 100 });
}

export async function getFiveMinuteBars(env, symbols, { start, end }) {
  return getStockBars(env, symbols, { timeframe: "5Min", start, end, adjustment: "all", maxPages: 20 });
}

export async function getRecentMinuteBars(env, symbols, { start, end }) {
  return getStockBars(env, symbols, { timeframe: "1Min", start, end, adjustment: "all", maxPages: 10 });
}

export async function getMarketCalendar(env, start, end) {
  const query = new URLSearchParams({ start, end });
  const rows = await alpacaRequest(env, PAPER_BASE, `/v2/calendar?${query}`);
  return attachRequestCount((rows ?? []).map((row) => ({
    date: String(row.date), open: String(row.open), close: String(row.close),
  })), 1);
}

export async function getResearchBars(env, symbols) {
  const start = new Date(Date.now() - 3 * 366 * 24 * 60 * 60 * 1000).toISOString();
  return getStockBars(env, symbols, { timeframe: "1Day", start });
}

export async function getDslResearchBars(env, symbols) {
  const start = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  return getStockBars(env, symbols, { timeframe: "5Min", start, adjustment: "all", maxPages: 200 });
}

export async function getMonitoringBars(env, symbols) {
  const start = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
  return getStockBars(env, symbols, { timeframe: "1Hour", start });
}

export async function getDslMonitoringBars(env, symbols) {
  const start = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
  return getStockBars(env, symbols, { timeframe: "5Min", start, adjustment: "all", maxPages: 50 });
}

export async function getAssets(env, symbols) {
  const entries = [];
  const unique = [...new Set(symbols)];
  // Keep outbound concurrency bounded for Workers while still avoiding a slow
  // fully serial validation of the 40-symbol universe.
  for (let index = 0; index < unique.length; index += 5) {
    const batch = await Promise.all(unique.slice(index, index + 5).map(async (symbol) => {
      const asset = await alpacaRequest(env, PAPER_BASE, `/v2/assets/${encodeURIComponent(symbol)}`);
      return [symbol, {
        tradable: Boolean(asset.tradable),
        fractionable: Boolean(asset.fractionable),
        shortable: Boolean(asset.shortable),
        // `easy_to_borrow` is retained while Alpaca transitions clients to
        // `borrow_status`.  Do not infer borrowability when neither is present.
        borrow_status: asset.borrow_status ?? null,
        easy_to_borrow: asset.easy_to_borrow === true,
        status: asset.status,
      }];
    }));
    entries.push(...batch);
  }
  return attachRequestCount(Object.fromEntries(entries), unique.length);
}

async function findOrderByClientId(env, clientOrderId) {
  const query = new URLSearchParams({ client_order_id: clientOrderId });
  return alpacaRequest(env, PAPER_BASE, `/v2/orders:by_client_order_id?${query}`, {}, true);
}

async function submitOrder(env, order) {
  const existing = await findOrderByClientId(env, order.client_order_id);
  if (existing) return sanitizeOrder(existing);
  const created = await alpacaRequest(env, PAPER_BASE, "/v2/orders", {
    method: "POST",
    body: JSON.stringify(order),
  });
  return sanitizeOrder(created);
}

function orderId(bucket, symbol, side) {
  return `axiom-${bucket.replace(/[^0-9]/g, "").slice(0, 12)}-${symbol.toLowerCase()}-${side}`;
}

function signedPositionValue(position) {
  if (!position) return 0;
  const magnitude = Math.abs(cleanNumber(position.market_value))
    || Math.abs(cleanNumber(position.qty) * cleanNumber(position.current_price));
  return position.side === "short" || cleanNumber(position.qty) < 0 ? -magnitude : magnitude;
}

function shortBorrowable(asset) {
  return Boolean(asset?.tradable && asset?.shortable
    && (asset.borrow_status === "easy_to_borrow" || asset.easy_to_borrow));
}

function wholeSharesForNotional(notional, position) {
  const price = Math.abs(cleanNumber(position?.current_price))
    || Math.abs(cleanNumber(position?.market_value) / cleanNumber(position?.qty));
  return price > 0 ? Math.floor(Math.abs(notional) / price) : 0;
}

export async function buildPaperCycle(env, appState, scheduledBucket, orderBucket = scheduledBucket, options = {}) {
  const overview = await getAccountOverview(env);
  const forceFlatten = Boolean(appState.orchestration?.controls?.flatten_requested);
  const permittedStates = options.scope === "incubation"
    ? new Set(["incubation"]) : new Set(["released", "healthy", "watch", "adjusted"]);
  const active = forceFlatten ? [] : appState.strategies.filter((strategy) => permittedStates.has(strategy.state));
  const symbols = [...new Set(active.map((strategy) => strategy.asset).filter((symbol) => SUPPORTED_SYMBOLS.includes(symbol)))];
  const dslSymbols = [...new Set(active.filter((strategy) => strategy.strategy_format === "dsl-v1")
    .map((strategy) => strategy.asset).filter((symbol) => SUPPORTED_SYMBOLS.includes(symbol)))];
  const legacySymbols = symbols.filter((symbol) => !dslSymbols.includes(symbol)
    || active.some((strategy) => strategy.asset === symbol && strategy.strategy_format !== "dsl-v1"));
  const [legacyBars, dslBars] = await Promise.all([
    legacySymbols.length ? getMonitoringBars(env, legacySymbols) : {},
    dslSymbols.length ? getDslMonitoringBars(env, dslSymbols) : {},
  ]);
  const evaluations = {};
  const desiredBySymbol = Object.fromEntries(SUPPORTED_SYMBOLS.map((symbol) => [symbol, 0]));
  const equity = overview.account.equity;
  const strategyCap = equity * Math.min(Math.max(Number(env.ALPACA_MAX_STRATEGY_PCT || 0.005), 0), 0.05);
  const portfolioCap = Math.min(
    equity * Math.min(Math.max(Number(env.ALPACA_MAX_PORTFOLIO_PCT || 0.10), 0), 0.50),
    overview.account.buying_power * 0.50,
  );

  for (const strategy of active) {
    const isDsl = strategy.strategy_format === "dsl-v1" && strategy.strategy_dna;
    const symbolBars = (isDsl ? dslBars : legacyBars)[strategy.asset] ?? [];
    const prices = symbolBars.map((bar) => bar.c);
    if (prices.length < 60) continue;
    const evaluation = evaluateStrategyWindow(strategy, isDsl ? symbolBars : prices, 21);
    // Keep execution explicitly tied to the frozen strategy's signed signal.
    const rawTarget = isDsl ? evaluateLatestTarget(strategy.strategy_dna, symbolBars) : null;
    const signal = isDsl ? Math.sign(rawTarget) : latestSignal(strategy, prices);
    evaluations[strategy.id] = {
      ...evaluation,
      signal,
      latest_price: prices.at(-1),
      latest_open: symbolBars.at(-1)?.o ?? prices.at(-1),
      bar_time: symbolBars.at(-1).t,
    };
    const desired = isDsl
      ? equity * rawTarget * Number(strategy.risk_multiplier ?? 1)
      : strategyCap * Number(strategy.params.position_size || 0) * signal;
    desiredBySymbol[strategy.asset] += Math.max(-strategyCap, Math.min(strategyCap, desired));
  }

  const desiredGross = Object.values(desiredBySymbol).reduce((sum, value) => sum + Math.abs(value), 0);
  const scale = desiredGross > portfolioCap && desiredGross > 0 ? portfolioCap / desiredGross : 1;
  const positionBySymbol = Object.fromEntries(overview.positions.map((position) => [position.symbol, position]));
  const openSymbols = new Set(overview.open_orders.map((order) => order.symbol));
  const managedSymbols = new Set(appState.alpaca?.managed_symbols ?? []);
  const candidateSymbols = SUPPORTED_SYMBOLS.filter((symbol) => desiredBySymbol[symbol] !== 0
    || (options.scope !== "incubation" && managedSymbols.has(symbol)));
  const assets = candidateSymbols.length ? await getAssets(env, candidateSymbols) : {};
  const proposed = [];
  const safety_reasons = [];

  for (const symbol of candidateSymbols) {
    if (openSymbols.has(symbol)) {
      safety_reasons.push({ symbol, reason: "open_order_pending" });
      continue;
    }
    const target = desiredBySymbol[symbol] * scale;
    const position = positionBySymbol[symbol];
    const current = signedPositionValue(position);
    if (position && !managedSymbols.has(symbol)) {
      safety_reasons.push({ symbol, reason: "unmanaged_existing_position" });
      continue;
    }
    const difference = target - current;
    if (Math.abs(difference) < 25) continue;
    const asset = assets[symbol];
    const baseOrder = {
      symbol, type: "market", time_in_force: "day", extended_hours: false,
    };

    // Crossing zero is deliberately two-phase.  This avoids accidentally
    // submitting an oversized order that both closes and opens a short/long.
    if (current > 0 && target < 0) {
      const quantity = Math.abs(cleanNumber(position?.qty));
      if (quantity > 0) proposed.push({ ...baseOrder, qty: String(quantity), side: "sell",
        client_order_id: orderId(orderBucket, symbol, "flatten-long") });
      continue;
    }
    if (current < 0 && target > 0) {
      const quantity = Math.abs(cleanNumber(position?.qty));
      if (quantity > 0) proposed.push({ ...baseOrder, qty: String(quantity), side: "buy",
        client_order_id: orderId(orderBucket, symbol, "cover-short") });
      continue;
    }

    if (current < 0) {
      // Increasing an existing short requires borrow eligibility; reducing it
      // is always a cover and therefore remains permitted after borrow loss.
      if (Math.abs(target) > Math.abs(current) && !shortBorrowable(asset)) {
        safety_reasons.push({ symbol, reason: "short_borrow_unavailable" });
        continue;
      }
      const increasingShort = Math.abs(target) > Math.abs(current);
      const quantity = !increasingShort && target === 0
        ? Math.abs(cleanNumber(position?.qty))
        : wholeSharesForNotional(difference, position);
      if (quantity > 0) proposed.push({ ...baseOrder, qty: String(quantity),
        side: increasingShort ? "sell" : "buy",
        _opens_short: increasingShort,
        client_order_id: orderId(orderBucket, symbol, increasingShort ? "short-increase" : "cover") });
    } else if (difference > 0) {
      if (!asset?.tradable || !asset?.fractionable) {
        safety_reasons.push({ symbol, reason: "asset_not_fractionable_for_long" });
        continue;
      }
      proposed.push({
        ...baseOrder,
        notional: String(Math.floor(difference * 100) / 100),
        side: "buy",
        client_order_id: orderId(orderBucket, symbol, "buy"),
      });
    } else if (current > 0) {
      const fraction = Math.min(Math.abs(difference) / Math.abs(current), 1);
      const quantity = Math.floor(Math.abs(position.qty) * fraction * 1e6) / 1e6;
      if (quantity > 0) proposed.push({
        ...baseOrder,
        qty: String(quantity),
        side: "sell",
        client_order_id: orderId(orderBucket, symbol, "sell"),
      });
    } else {
      if (!shortBorrowable(asset)) {
        safety_reasons.push({ symbol, reason: "short_borrow_unavailable" });
        continue;
      }
      const quantity = wholeSharesForNotional(difference, { current_price: evaluations[
        active.find((strategy) => strategy.asset === symbol)?.id
      ]?.latest_price });
      if (quantity > 0) proposed.push({ ...baseOrder, qty: String(quantity), side: "sell",
        _opens_short: true,
        client_order_id: orderId(orderBucket, symbol, "short") });
    }
  }

  // A verified safety flatten contains only closes of framework-managed
  // positions. It must remain available after entries/trading are disabled;
  // otherwise the pre-close stop-entry phase can strand open exposure.
  const tradingEnabled = options.tradingEnabled === false ? false
    : options.safetyFlatten === true && forceFlatten ? true
      : env.ALPACA_TRADING_ENABLED === "true";
  const shortTradingEnabled = env.ALPACA_SHORT_TRADING_ENABLED === "true";
  const canTrade = tradingEnabled && overview.clock.is_open
    && String(overview.account.status || "").toUpperCase() === "ACTIVE"
    && !overview.account.trading_blocked && !overview.account.account_blocked;
  const submitted = [];
  const order_errors = [];
  if (canTrade) {
    for (const order of proposed) {
      if (order._opens_short && !shortTradingEnabled) {
        safety_reasons.push({ symbol: order.symbol, reason: "short_trading_disabled" });
        continue;
      }
      try {
        const { _opens_short, ...submitPayload } = order;
        submitted.push(await submitOrder(env, submitPayload));
      } catch (error) {
        order_errors.push({ symbol: order.symbol, message: error instanceof Error ? error.message : "Order failed" });
      }
    }
  }

  return {
    ...overview,
    feed: env.ALPACA_DATA_FEED || "iex",
    trading_enabled: tradingEnabled,
    force_flatten: forceFlatten,
    short_trading_enabled: shortTradingEnabled,
    can_trade_now: canTrade,
    evaluations,
    proposed_orders: proposed.map(({ _opens_short, ...order }) => ({ ...order, notional: cleanNumber(order.notional), qty: cleanNumber(order.qty) })),
    submitted_orders: submitted,
    order_errors,
    safety_reasons,
    scheduled_bucket: scheduledBucket,
  };
}

export { SUPPORTED_SYMBOLS };
