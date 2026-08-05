import { evaluateStrategyWindow, latestSignal } from "./engine.js";
import { INITIAL_UNIVERSE_SYMBOLS } from "./universe.js";
import { evaluateLatestTarget, hashCanonical } from "./dsl.js";
import { allocatePortfolioRisk, dailyRiskState, riskPolicy, riskReducingTarget,
  sessionRiskPolicy } from "./risk-allocator.js";

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
    signal: init.signal ?? AbortSignal.timeout(Math.min(Math.max(Number(env.ALPACA_TIMEOUT_MS ?? 10_000), 1_000), 30_000)),
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
  const equity = Number(account.equity), buyingPower = Number(account.buying_power);
  if (!(equity > 0) || !Number.isFinite(buyingPower) || buyingPower < 0 || !account.status) {
    throw new Error("Alpaca returned stale or malformed account equity/buying power");
  }
  return {
    status: account.status,
    currency: account.currency,
    cash: cleanNumber(account.cash),
    buying_power: buyingPower,
    equity,
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
    filled_avg_price: cleanNumber(order.filled_avg_price),
    submitted_at: order.submitted_at,
    filled_at: order.filled_at ?? null,
    updated_at: order.updated_at ?? null,
    canceled_at: order.canceled_at ?? null,
  };
}

function sanitizeFill(activity) {
  const quantity = Number(activity.qty), price = Number(activity.price);
  if (!activity.id || !activity.order_id || !activity.symbol || !(quantity > 0) || !(price >= 0)
      || !["buy", "sell"].includes(activity.side) || Number.isNaN(new Date(activity.transaction_time).getTime())) {
    throw new Error("Alpaca returned a malformed fill activity");
  }
  const transactionTime = new Date(activity.transaction_time).toISOString();
  return { broker_fill_id: String(activity.id), broker_order_id: String(activity.order_id),
    symbol: String(activity.symbol), side: activity.side, qty: quantity, quantity, price,
    transaction_time: transactionTime, filled_at: transactionTime, type: activity.type ?? "fill",
    cumulative_quantity: cleanNumber(activity.cum_qty), leaves_quantity: cleanNumber(activity.leaves_qty) };
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

/** Poll the authoritative Trading API fill ledger. The cursor is persisted by
 * the Durable Object; D1 uniqueness makes overlapping pages harmless. */
export async function getFillActivities(env, { after, maxPages = 10 } = {}) {
  const fills = []; let pageToken = null; const tokens = new Set();
  for (let page = 0; page < maxPages; page += 1) {
    const query = new URLSearchParams({ direction: "asc", page_size: "100" });
    if (after) query.set("after", new Date(after).toISOString());
    if (pageToken) query.set("page_token", pageToken);
    const activities = await alpacaRequest(env, PAPER_BASE, `/v2/account/activities/FILL?${query}`);
    if (!Array.isArray(activities)) throw new Error("Alpaca fill activity response is malformed");
    fills.push(...activities.map(sanitizeFill));
    if (activities.length < 100) break;
    pageToken = String(activities.at(-1)?.id ?? "");
    if (!pageToken || tokens.has(pageToken)) throw new Error("Alpaca fill pagination did not advance");
    tokens.add(pageToken);
    if (page === maxPages - 1) throw new Error(`Alpaca fill pagination exceeded ${maxPages} pages`);
  }
  return fills;
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

function orderId(brokerIntentId, symbol, leg) {
  return `axiom-${hashCanonical({ broker_intent_id: brokerIntentId, symbol, leg }).slice(0, 36)}`;
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

export function brokerActivation(env = {}, options = {}) {
  const mode = ["off", "shadow", "canary", "paper"].includes(String(env.ALPACA_BROKER_MODE).toLowerCase())
    ? String(env.ALPACA_BROKER_MODE).toLowerCase() : "shadow";
  const global = env.ALPACA_TRADING_ENABLED === "true";
  return { mode, targets_enabled: mode !== "off", shadow_enabled: ["shadow", "canary", "paper"].includes(mode),
    canary_enabled: mode === "canary" && env.ALPACA_CANARY_TRADING_ENABLED === "true" && Boolean(options.canary),
    long_enabled: mode === "paper" && global && env.ALPACA_LONG_TRADING_ENABLED === "true",
    short_enabled: mode === "paper" && global && env.ALPACA_SHORT_TRADING_ENABLED === "true",
    global_trading_enabled: global };
}

export function canReleaseStrategyToPaper(env = {}, strategy = {}) {
  const needsShort = strategy.strategy_format === "dsl-v1" && strategy.strategy_dna?.entry?.short != null;
  return !needsShort || brokerActivation(env).short_enabled;
}

function strategySymbols(strategy) {
  if (strategy.strategy_format !== "dsl-v1" || !strategy.strategy_dna) return [strategy.asset];
  return [...new Set(strategy.strategy_dna.scope?.symbols ?? [strategy.asset])]
    .filter((symbol) => SUPPORTED_SYMBOLS.includes(symbol)).sort();
}

function freshBar(rows, clockTimestamp, intervalMinutes) {
  const latest = rows?.at(-1); const barTime = new Date(latest?.t).getTime(); const clock = new Date(clockTimestamp).getTime();
  if (!latest || !Number.isFinite(barTime) || !Number.isFinite(clock)) return false;
  const age = clock - barTime;
  return age >= -60_000 && age <= Math.max(15, intervalMinutes * 2 + 5) * 60_000;
}

function publicOrder(order) {
  const { _opens_short, _risk_reducing, _broker_intent_id, _allocations, ...safe } = order;
  return { ...safe, notional: cleanNumber(order.notional), qty: cleanNumber(order.qty),
    broker_intent_id: _broker_intent_id, risk_reducing: Boolean(_risk_reducing) };
}

async function cancelOrder(env, order) {
  await alpacaRequest(env, PAPER_BASE, `/v2/orders/${encodeURIComponent(order.id)}`, { method: "DELETE" });
  return { ...order, status: "cancel_requested", canceled_at: new Date().toISOString() };
}

/** Execute a previously frozen broker plan. Runtime callers persist the plan
 * before invoking this function, so a crash can replay by client order ID. */
export async function executePaperPlan(env, plan) {
  const activation = plan.activation ?? brokerActivation(env, { canary: plan.canary });
  const safety = Boolean(plan.force_flatten || plan.daily_risk?.halted || plan.kill_switch);
  const cancelled = [];
  for (const order of plan.cancel_plans ?? []) cancelled.push(await cancelOrder(env, order));
  const submitted = []; const orderErrors = []; const safetyReasons = [...(plan.safety_reasons ?? [])];
  const accountReady = plan.clock?.is_open && String(plan.account?.status ?? "").toUpperCase() === "ACTIVE"
    && !plan.account?.trading_blocked && !plan.account?.account_blocked && !plan.session_risk?.critical;
  for (const order of plan.order_plans ?? []) {
    const permitted = safety || (activation.canary_enabled && plan.canary)
      || (order._risk_reducing && activation.mode === "paper" && activation.global_trading_enabled)
      || (order._opens_short ? activation.short_enabled : activation.long_enabled);
    if (!permitted) {
      safetyReasons.push({ symbol: order.symbol, reason: order._opens_short
        ? "short_trading_disabled" : plan.canary ? "canary_trading_disabled" : "long_trading_disabled" });
      continue;
    }
    if (!accountReady) {
      safetyReasons.push({ symbol: order.symbol, reason: "account_or_market_unavailable" });
      continue;
    }
    try {
      const { _opens_short, _risk_reducing, _broker_intent_id, _allocations, ...submitPayload } = order;
      const result = await submitOrder(env, submitPayload);
      submitted.push({ ...result, broker_intent_id: _broker_intent_id,
        risk_reducing: Boolean(_risk_reducing), allocations: _allocations ?? [] });
    } catch (error) {
      orderErrors.push({ symbol: order.symbol, broker_intent_id: order._broker_intent_id,
        message: error instanceof Error ? error.message : "Order failed" });
    }
  }
  return { ...plan, trading_enabled: safety || activation.long_enabled || activation.short_enabled || activation.canary_enabled,
    short_trading_enabled: activation.short_enabled, can_trade_now: Boolean(accountReady),
    proposed_orders: (plan.order_plans ?? []).map(publicOrder), submitted_orders: submitted,
    cancelled_orders: cancelled, order_errors: orderErrors, safety_reasons: safetyReasons };
}

export async function buildPaperCycle(env, appState, scheduledBucket, orderBucket = scheduledBucket, options = {}) {
  const fillAfter = appState.alpaca?.last_fill_at ?? new Date(Date.now() - 2 * 86400_000).toISOString();
  const [overview, observedFills] = await Promise.all([getAccountOverview(env), getFillActivities(env, { after: fillAfter })]);
  const policy = riskPolicy(env); const controls = appState.orchestration?.controls ?? {};
  const sessionRisk = sessionRiskPolicy(overview.clock, policy);
  const dailyRisk = dailyRiskState(appState.alpaca?.risk_session, {
    equity: overview.account.equity, timestamp: overview.clock.timestamp, policy,
  });
  const requestedFlatten = Boolean(options.safetyFlatten || controls.flatten_requested || controls.kill_switch);
  let forceFlatten = requestedFlatten || dailyRisk.halted || sessionRisk.force_flatten;
  const permittedStates = options.scope === "incubation"
    ? new Set(["incubation"]) : new Set(["released", "healthy", "watch", "quarantined"]);
  const active = (forceFlatten && options.scope !== "incubation") || options.canary ? []
    : appState.strategies.filter((strategy) => permittedStates.has(strategy.state));
  const scoped = new Map(active.map((strategy) => [strategy.id, strategySymbols(strategy)]));
  const symbols = [...new Set([...scoped.values()].flat())].filter((symbol) => SUPPORTED_SYMBOLS.includes(symbol)).sort();
  const dslSymbols = [...new Set(active.filter((strategy) => strategy.strategy_format === "dsl-v1")
    .flatMap((strategy) => scoped.get(strategy.id) ?? []))].sort();
  const legacySymbols = symbols.filter((symbol) => !dslSymbols.includes(symbol)
    || active.some((strategy) => strategy.asset === symbol && strategy.strategy_format !== "dsl-v1"));
  const [legacyBars, dslBars] = await Promise.all([
    legacySymbols.length ? getMonitoringBars(env, legacySymbols) : {},
    dslSymbols.length ? getDslMonitoringBars(env, dslSymbols) : {},
  ]);
  const evaluations = {}; const evaluationsBySymbol = {}; const rawTargets = {}; const safety_reasons = [];
  const equity = overview.account.equity;
  for (const strategy of active) {
    const isDsl = strategy.strategy_format === "dsl-v1" && strategy.strategy_dna;
    const perSymbol = {}; rawTargets[strategy.id] = {};
    for (const symbol of scoped.get(strategy.id) ?? []) {
      const symbolBars = (isDsl ? dslBars : legacyBars)[symbol] ?? []; const prices = symbolBars.map((bar) => bar.c);
      const interval = isDsl ? 5 : 60;
      if (prices.length < 60 || !freshBar(symbolBars, overview.clock.timestamp, interval)) {
        perSymbol[symbol] = { signal: 0, critical_fault: "stale_or_insufficient_market_data",
          latest_price: prices.at(-1) ?? null, latest_open: symbolBars.at(-1)?.o ?? null,
          bar_time: symbolBars.at(-1)?.t ?? null };
        safety_reasons.push({ symbol, strategy_id: strategy.id, reason: "stale_or_insufficient_market_data" });
        continue;
      }
      const evaluation = evaluateStrategyWindow(strategy, isDsl ? symbolBars : prices, 21);
      const target = isDsl ? evaluateLatestTarget(strategy.strategy_dna, symbolBars)
        : Number(strategy.params.position_size || 0) * latestSignal(strategy, prices);
      perSymbol[symbol] = { ...evaluation, signal: Math.sign(target), target,
        latest_price: prices.at(-1), latest_open: symbolBars.at(-1)?.o ?? prices.at(-1), bar_time: symbolBars.at(-1).t };
      evaluationsBySymbol[symbol] ??= perSymbol[symbol]; rawTargets[strategy.id][symbol] = target;
    }
    const primary = perSymbol[strategy.asset] ?? Object.values(perSymbol)[0] ?? {};
    evaluations[strategy.id] = { ...primary, signal: Math.sign(Object.values(rawTargets[strategy.id]).reduce((sum, value) => sum + value, 0)),
      symbols: perSymbol };
  }
  let allocation = allocatePortfolioRisk({ equity, buyingPower: overview.account.buying_power,
    strategies: active, rawTargets, policy });
  if (options.canary) {
    const symbol = String(options.canary.symbol ?? "SPY").toUpperCase();
    if (!SUPPORTED_SYMBOLS.includes(symbol) || !["buy", "sell"].includes(options.canary.side)) throw new Error("Canary symbol/side is invalid");
    const amount = Math.min(Math.max(Number(options.canary.notional ?? 25), 1), Number(env.ALPACA_CANARY_MAX_NOTIONAL ?? 25));
    allocation = { schema_version: 1, targets: { [symbol]: options.canary.side === "buy" ? amount : -amount },
      contributions: [], gross_before_netting: amount, net_gross: amount, limits: { canary: amount }, portfolio_scale: 1 };
  }
  const positionBySymbol = Object.fromEntries(overview.positions.map((position) => [position.symbol, position]));
  const managedSymbols = new Set(appState.alpaca?.managed_symbols ?? []);
  const unmanaged = overview.positions.filter((position) => !managedSymbols.has(position.symbol));
  for (const position of unmanaged) safety_reasons.push({ symbol: position.symbol, reason: "unmanaged_existing_position", severity: "critical" });
  if (sessionRisk.critical) safety_reasons.push({ reason: "broker_clock_uncertain", severity: "critical" });
  if (!overview.clock.is_open) for (const position of overview.positions.filter((item) => managedSymbols.has(item.symbol))) {
    safety_reasons.push({ symbol: position.symbol, reason: "managed_position_outside_regular_session", severity: "critical" });
  }
  const attribution = appState.alpaca?.position_attribution ?? {};
  const attributionDivergence = [];
  for (const [symbol, expected] of Object.entries(attribution)) {
    const actual = positionBySymbol[symbol] ? (positionBySymbol[symbol].side === "short"
      ? -Math.abs(positionBySymbol[symbol].qty) : Math.abs(positionBySymbol[symbol].qty)) : 0;
    const expectedQuantity = Number(expected.signed_quantity ?? 0);
    const tolerance = Math.max(.000001, Math.abs(actual) * .001);
    if (Math.abs(actual - expectedQuantity) > tolerance) attributionDivergence.push({ symbol,
      reason: "broker_position_attribution_divergence", severity: "critical",
      expected_quantity: expectedQuantity, actual_quantity: actual });
  }
  if (attributionDivergence.length) {
    safety_reasons.push(...attributionDivergence);
    forceFlatten = true;
  }
  const candidateSymbols = [...new Set([...Object.keys(allocation.targets),
    ...(options.scope !== "incubation" ? [...managedSymbols] : []), ...overview.positions.map((item) => item.symbol)])]
    .filter((symbol) => SUPPORTED_SYMBOLS.includes(symbol)).sort();
  const assets = candidateSymbols.length ? await getAssets(env, candidateSymbols) : {};
  const activation = brokerActivation(env, options);
  const marketHealth = appState.marketData?.live;
  const dataBlocked = marketHealth && (marketHealth.status !== "healthy" || Number(marketHealth.coverage) < policy.minimum_data_coverage);
  const blockIncrease = Boolean(options.blockNewRisk || controls.entries_paused || controls.execution_paused
    || !sessionRisk.allow_increase || dailyRisk.halted || dataBlocked);
  const cancelPlans = forceFlatten ? overview.open_orders.filter((order) => String(order.client_order_id).startsWith("axiom-")) : [];
  const cancelIds = new Set(cancelPlans.map((item) => item.id));
  const openSymbols = new Set(overview.open_orders.filter((order) => !cancelIds.has(order.id)).map((order) => order.symbol));
  const proposed = []; const intents = [];

  for (const symbol of candidateSymbols) {
    if (openSymbols.has(symbol)) {
      safety_reasons.push({ symbol, reason: "open_order_pending" });
      continue;
    }
    const requestedTarget = forceFlatten ? 0 : Number(allocation.targets[symbol] ?? 0);
    const position = positionBySymbol[symbol];
    const current = signedPositionValue(position);
    if (position && !managedSymbols.has(symbol)) {
      safety_reasons.push({ symbol, reason: "unmanaged_existing_position" });
      continue;
    }
    const target = riskReducingTarget(current, requestedTarget, blockIncrease);
    const difference = target - current;
    const minimumOrder = Math.max(1, Number(env.ALPACA_MIN_ORDER_NOTIONAL ?? 1));
    if (Math.abs(difference) < minimumOrder) continue;
    const asset = assets[symbol];
    const maxNotional = equity * policy.maximum_order_pct;
    const increasesExposure = current === 0 ? target !== 0
      : Math.sign(target) === Math.sign(current) && Math.abs(target) > Math.abs(current);
    if (increasesExposure && Math.abs(difference) > maxNotional + .01) {
      safety_reasons.push({ symbol, reason: "order_notional_sanity_limit", severity: "critical" }); continue;
    }
    let allocations = allocation.contributions.filter((item) => item.symbol === symbol)
      .map((item) => ({ strategy_id: item.strategy_id, signed_notional: item.notional }));
    if (!allocations.length && attribution[symbol]?.by_strategy) {
      const price = Math.abs(Number(position?.current_price)) || 1;
      allocations = Object.entries(attribution[symbol].by_strategy).map(([strategy_id, quantity]) => ({
        strategy_id, signed_notional: Number(quantity) * price,
      })).filter((item) => item.signed_notional !== 0);
    }
    const intentId = `intent-${hashCanonical({ scheduledBucket, symbol, target, current, allocations }).slice(0, 40)}`;
    intents.push({ broker_intent_id: intentId, symbol, target_signed_notional: target,
      current_signed_notional: current, allocations, intent_kind: forceFlatten ? "flatten" : blockIncrease ? "reduce_only" : "rebalance" });
    const baseOrder = {
      symbol, type: "market", time_in_force: "day", extended_hours: false,
      _broker_intent_id: intentId, _allocations: allocations,
    };

    // Crossing zero is deliberately two-phase.  This avoids accidentally
    // submitting an oversized order that both closes and opens a short/long.
    if (current > 0 && target < 0) {
      const quantity = Math.abs(cleanNumber(position?.qty));
      if (quantity > 0) proposed.push({ ...baseOrder, qty: String(quantity), side: "sell",
        _risk_reducing: true, client_order_id: orderId(intentId, symbol, "flatten-long") });
      continue;
    }
    if (current < 0 && target > 0) {
      const quantity = Math.abs(cleanNumber(position?.qty));
      if (quantity > 0) proposed.push({ ...baseOrder, qty: String(quantity), side: "buy",
        _risk_reducing: true, client_order_id: orderId(intentId, symbol, "cover-short") });
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
        _risk_reducing: !increasingShort,
        client_order_id: orderId(intentId, symbol, increasingShort ? "short-increase" : "cover") });
    } else if (difference > 0) {
      if (!asset?.tradable || !asset?.fractionable) {
        safety_reasons.push({ symbol, reason: "asset_not_fractionable_for_long" });
        continue;
      }
      proposed.push({
        ...baseOrder,
        notional: String(Math.floor(difference * 100) / 100),
        side: "buy",
        _risk_reducing: false,
        client_order_id: orderId(intentId, symbol, "buy"),
      });
    } else if (current > 0) {
      const fraction = Math.min(Math.abs(difference) / Math.abs(current), 1);
      const quantity = Math.floor(Math.abs(position.qty) * fraction * 1e6) / 1e6;
      if (quantity > 0) proposed.push({
        ...baseOrder,
        qty: String(quantity),
        side: "sell",
        _risk_reducing: true,
        client_order_id: orderId(intentId, symbol, "sell"),
      });
    } else {
      if (!shortBorrowable(asset)) {
        safety_reasons.push({ symbol, reason: "short_borrow_unavailable" });
        continue;
      }
      const quantity = wholeSharesForNotional(difference, { current_price: evaluationsBySymbol[symbol]?.latest_price });
      if (quantity > policy.maximum_order_shares) {
        safety_reasons.push({ symbol, reason: "order_share_sanity_limit", severity: "critical" }); continue;
      }
      if (quantity > 0) proposed.push({ ...baseOrder, qty: String(quantity), side: "sell",
        _opens_short: true, _risk_reducing: false,
        client_order_id: orderId(intentId, symbol, "short") });
    }
  }
  const knownOrders = appState.alpaca?.known_orders ?? {};
  const fills = observedFills.map((fill) => ({ ...fill, client_order_id: knownOrders[fill.broker_order_id]?.client_order_id ?? null,
    allocations: knownOrders[fill.broker_order_id]?.allocations ?? [] }));
  const plan = {
    ...overview,
    feed: env.ALPACA_DATA_FEED || "iex",
    activation,
    trading_enabled: false,
    force_flatten: forceFlatten,
    kill_switch: Boolean(controls.kill_switch),
    short_trading_enabled: activation.short_enabled,
    can_trade_now: false,
    evaluations,
    allocation,
    risk_policy: policy,
    session_risk: sessionRisk,
    daily_risk: dailyRisk,
    block_new_risk: blockIncrease,
    broker_intents: intents,
    order_plans: proposed,
    cancel_plans: cancelPlans,
    proposed_orders: proposed.map(publicOrder),
    submitted_orders: [],
    cancelled_orders: [],
    order_errors: [],
    safety_reasons,
    fills,
    managed_symbols: [...managedSymbols],
    canary: options.canary ?? null,
    scheduled_bucket: scheduledBucket,
  };
  return options.submitOrders === false || options.tradingEnabled === false ? plan : executePaperPlan(env, plan);
}

export { SUPPORTED_SYMBOLS };
