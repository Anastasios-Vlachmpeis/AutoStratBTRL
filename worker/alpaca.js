import { evaluateStrategyWindow, latestSignal } from "./engine.js";

const PAPER_BASE = "https://paper-api.alpaca.markets";
const DATA_BASE = "https://data.alpaca.markets";
const SUPPORTED_SYMBOLS = ["SPY", "QQQ", "IWM", "TLT"];

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

export async function getStockBars(env, symbols, { timeframe, start, end = new Date().toISOString(), limit = 10000 }) {
  const allowed = [...new Set(symbols)].filter((symbol) => SUPPORTED_SYMBOLS.includes(symbol));
  if (!allowed.length) return {};
  const collected = Object.fromEntries(allowed.map((symbol) => [symbol, []]));
  let pageToken = null;
  let pages = 0;
  do {
    const query = new URLSearchParams({
      symbols: allowed.join(","),
      timeframe,
      start,
      end,
      limit: String(limit),
      feed: env.ALPACA_DATA_FEED || "iex",
      adjustment: "all",
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
    pages += 1;
  } while (pageToken && pages < 8);
  return collected;
}

export async function getResearchBars(env, symbols) {
  const start = new Date(Date.now() - 3 * 366 * 24 * 60 * 60 * 1000).toISOString();
  return getStockBars(env, symbols, { timeframe: "1Day", start });
}

export async function getMonitoringBars(env, symbols) {
  const start = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
  return getStockBars(env, symbols, { timeframe: "1Hour", start });
}

async function getAssets(env, symbols) {
  const entries = await Promise.all(symbols.map(async (symbol) => {
    const asset = await alpacaRequest(env, PAPER_BASE, `/v2/assets/${encodeURIComponent(symbol)}`);
    return [symbol, {
      tradable: Boolean(asset.tradable),
      fractionable: Boolean(asset.fractionable),
      status: asset.status,
    }];
  }));
  return Object.fromEntries(entries);
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

export async function buildPaperCycle(env, appState, scheduledBucket, orderBucket = scheduledBucket) {
  const overview = await getAccountOverview(env);
  const active = appState.strategies.filter((strategy) => ["released", "healthy", "watch", "adjusted"].includes(strategy.state));
  const symbols = [...new Set(active.map((strategy) => strategy.asset).filter((symbol) => SUPPORTED_SYMBOLS.includes(symbol)))];
  const bars = await getMonitoringBars(env, symbols.length ? symbols : SUPPORTED_SYMBOLS);
  const evaluations = {};
  const desiredBySymbol = Object.fromEntries(SUPPORTED_SYMBOLS.map((symbol) => [symbol, 0]));
  const equity = overview.account.equity;
  const strategyCap = equity * Math.min(Math.max(Number(env.ALPACA_MAX_STRATEGY_PCT || 0.02), 0), 0.05);
  const portfolioCap = Math.min(
    equity * Math.min(Math.max(Number(env.ALPACA_MAX_PORTFOLIO_PCT || 0.20), 0), 0.50),
    overview.account.buying_power * 0.50,
  );

  for (const strategy of active) {
    const symbolBars = bars[strategy.asset] ?? [];
    const prices = symbolBars.map((bar) => bar.c);
    if (prices.length < 60) continue;
    const evaluation = evaluateStrategyWindow(strategy, prices, 21);
    evaluations[strategy.id] = {
      ...evaluation,
      latest_price: prices.at(-1),
      bar_time: symbolBars.at(-1).t,
    };
    if (evaluation.signal > 0) {
      desiredBySymbol[strategy.asset] += strategyCap * strategy.params.position_size;
    }
  }

  const desiredTotal = Object.values(desiredBySymbol).reduce((sum, value) => sum + value, 0);
  const scale = desiredTotal > portfolioCap && desiredTotal > 0 ? portfolioCap / desiredTotal : 1;
  const positionBySymbol = Object.fromEntries(overview.positions.map((position) => [position.symbol, position]));
  const openSymbols = new Set(overview.open_orders.map((order) => order.symbol));
  const managedSymbols = new Set(appState.alpaca?.managed_symbols ?? []);
  const candidateSymbols = SUPPORTED_SYMBOLS.filter((symbol) => desiredBySymbol[symbol] > 0 || managedSymbols.has(symbol));
  const assets = candidateSymbols.length ? await getAssets(env, candidateSymbols) : {};
  const proposed = [];

  for (const symbol of candidateSymbols) {
    if (openSymbols.has(symbol)) continue;
    const target = desiredBySymbol[symbol] * scale;
    const position = positionBySymbol[symbol];
    const current = position?.market_value ?? 0;
    const difference = target - current;
    if (Math.abs(difference) < 25) continue;
    if (difference > 0) {
      if (!assets[symbol]?.tradable || !assets[symbol]?.fractionable) continue;
      proposed.push({
        symbol,
        notional: String(Math.floor(difference * 100) / 100),
        side: "buy",
        type: "market",
        time_in_force: "day",
        extended_hours: false,
        client_order_id: orderId(orderBucket, symbol, "buy"),
      });
    } else if (managedSymbols.has(symbol) && position?.qty > 0 && current > 0) {
      const fraction = Math.min(Math.abs(difference) / current, 1);
      const quantity = Math.floor(position.qty * fraction * 1e6) / 1e6;
      if (quantity > 0) proposed.push({
        symbol,
        qty: String(quantity),
        side: "sell",
        type: "market",
        time_in_force: "day",
        extended_hours: false,
        client_order_id: orderId(orderBucket, symbol, "sell"),
      });
    }
  }

  const tradingEnabled = env.ALPACA_TRADING_ENABLED === "true";
  const canTrade = tradingEnabled && overview.clock.is_open
    && !overview.account.trading_blocked && !overview.account.account_blocked;
  const submitted = [];
  const order_errors = [];
  if (canTrade) {
    for (const order of proposed) {
      try {
        submitted.push(await submitOrder(env, order));
      } catch (error) {
        order_errors.push({ symbol: order.symbol, message: error instanceof Error ? error.message : "Order failed" });
      }
    }
  }

  return {
    ...overview,
    feed: env.ALPACA_DATA_FEED || "iex",
    trading_enabled: tradingEnabled,
    can_trade_now: canTrade,
    evaluations,
    proposed_orders: proposed.map((order) => ({ ...order, notional: cleanNumber(order.notional), qty: cleanNumber(order.qty) })),
    submitted_orders: submitted,
    order_errors,
    scheduled_bucket: scheduledBucket,
  };
}

export { SUPPORTED_SYMBOLS };
