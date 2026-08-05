import { INITIAL_UNIVERSE_GROUPS } from "./universe.js";

export const RISK_POLICY_VERSION = 1;
export const DEFAULT_RISK_POLICY = Object.freeze({
  strategy_gross_pct: 0.005,
  portfolio_gross_pct: 0.10,
  symbol_gross_pct: 0.02,
  cluster_gross_pct: 0.04,
  daily_loss_halt_pct: 0.005,
  entry_cutoff_minutes: 30,
  flatten_start_minutes: 10,
  flat_target_minutes: 5,
  minimum_data_coverage: 0.90,
  maximum_order_pct: 0.02,
  maximum_order_shares: 100_000,
});

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const round = (value, digits = 8) => Number(finite(value).toFixed(digits));

function bounded(env, key, fallback, low, high) {
  return clamp(finite(env?.[key], fallback), low, high);
}

export function riskPolicy(env = {}) {
  return Object.freeze({
    ...DEFAULT_RISK_POLICY,
    strategy_gross_pct: bounded(env, "ALPACA_MAX_STRATEGY_PCT", DEFAULT_RISK_POLICY.strategy_gross_pct, 0, .05),
    portfolio_gross_pct: bounded(env, "ALPACA_MAX_PORTFOLIO_PCT", DEFAULT_RISK_POLICY.portfolio_gross_pct, 0, .50),
    symbol_gross_pct: bounded(env, "ALPACA_MAX_SYMBOL_PCT", DEFAULT_RISK_POLICY.symbol_gross_pct, 0, .10),
    cluster_gross_pct: bounded(env, "ALPACA_MAX_CLUSTER_PCT", DEFAULT_RISK_POLICY.cluster_gross_pct, 0, .20),
    daily_loss_halt_pct: bounded(env, "ALPACA_DAILY_LOSS_HALT_PCT", DEFAULT_RISK_POLICY.daily_loss_halt_pct, 0, .05),
    entry_cutoff_minutes: Math.round(bounded(env, "ALPACA_ENTRY_CUTOFF_MINUTES", DEFAULT_RISK_POLICY.entry_cutoff_minutes, 5, 120)),
    flatten_start_minutes: Math.round(bounded(env, "ALPACA_FLATTEN_START_MINUTES", DEFAULT_RISK_POLICY.flatten_start_minutes, 1, 60)),
    flat_target_minutes: Math.round(bounded(env, "ALPACA_FLAT_TARGET_MINUTES", DEFAULT_RISK_POLICY.flat_target_minutes, 1, 30)),
    maximum_order_pct: bounded(env, "ALPACA_MAX_ORDER_PCT", DEFAULT_RISK_POLICY.maximum_order_pct, .0001, .10),
    maximum_order_shares: Math.round(bounded(env, "ALPACA_MAX_ORDER_SHARES", DEFAULT_RISK_POLICY.maximum_order_shares, 1, 1_000_000)),
  });
}

function instant(value) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function sessionRiskPolicy(clock, policy = DEFAULT_RISK_POLICY) {
  const now = instant(clock?.timestamp);
  const close = instant(clock?.next_close);
  if (!now || !close || !clock?.is_open || close <= now) {
    return { status: "uncertain_or_closed", allow_increase: false, force_flatten: false,
      target_flat: false, minutes_to_close: null, critical: Boolean(clock?.is_open) };
  }
  const minutes = (close.getTime() - now.getTime()) / 60_000;
  return {
    status: minutes <= policy.flat_target_minutes ? "flat_deadline"
      : minutes <= policy.flatten_start_minutes ? "flatten"
        : minutes <= policy.entry_cutoff_minutes ? "reduce_only" : "open",
    allow_increase: minutes > policy.entry_cutoff_minutes,
    force_flatten: minutes <= policy.flatten_start_minutes,
    target_flat: minutes <= policy.flat_target_minutes,
    minutes_to_close: round(minutes, 3),
    critical: false,
  };
}

export function newYorkSessionDate(timestamp) {
  const date = instant(timestamp);
  if (!date) return null;
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const values = Object.fromEntries(parts.map((item) => [item.type, item.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function dailyRiskState(previous, { equity, timestamp, policy = DEFAULT_RISK_POLICY } = {}) {
  const sessionDate = newYorkSessionDate(timestamp);
  const value = finite(equity, NaN);
  if (!sessionDate || !(value > 0)) return { session_date: sessionDate, baseline_equity: null,
    current_equity: Number.isFinite(value) ? value : null, loss_fraction: null, halted: true,
    reason: "invalid_account_equity", triggered_at: timestamp ?? null };
  const same = previous?.session_date === sessionDate && finite(previous?.baseline_equity) > 0;
  const baseline = same ? Number(previous.baseline_equity) : value;
  const loss = Math.max(0, 1 - value / baseline);
  const halted = Boolean(same && previous?.halted) || loss >= policy.daily_loss_halt_pct;
  return { session_date: sessionDate, baseline_equity: round(baseline, 2), current_equity: round(value, 2),
    loss_fraction: round(loss, 8), halted, reason: halted ? "daily_loss_limit" : null,
    triggered_at: halted ? previous?.triggered_at ?? timestamp : null,
    reset_at: same ? previous?.reset_at ?? null : timestamp, reset_by: same ? previous?.reset_by ?? "new_session" : "new_session" };
}

const clusterBySymbol = Object.freeze(Object.fromEntries(Object.entries(INITIAL_UNIVERSE_GROUPS)
  .flatMap(([cluster, symbols]) => symbols.map((symbol) => [symbol, cluster]))));

function strategyMultiplier(strategy) {
  const state = String(strategy?.state ?? "");
  if (["dropped", "retired", "quarantined", "operator_paused"].includes(state)) return 0;
  if (strategy?.operational_status === "operational_blocked") return 0;
  const health = finite(strategy?.risk_overlay?.health_multiplier, state === "watch" ? .5 : 1);
  const portfolio = finite(strategy?.risk_overlay?.portfolio_multiplier, 1);
  return clamp(finite(strategy?.risk_multiplier, 1), 0, 1) * clamp(health, 0, 1) * clamp(portfolio, 0, 1);
}

function scaleContributions(contributions, selector, limit) {
  const groups = new Map();
  for (const item of contributions) {
    const key = selector(item);
    const list = groups.get(key) ?? []; list.push(item); groups.set(key, list);
  }
  for (const items of groups.values()) {
    const gross = items.reduce((sum, item) => sum + Math.abs(item.notional), 0);
    const scale = gross > limit && gross > 0 ? limit / gross : 1;
    if (scale < 1) for (const item of items) item.notional *= scale;
  }
}

/** Allocate signed multi-symbol targets while charging opposing strategies for
 * gross risk before their notionals are netted at the broker. */
export function allocatePortfolioRisk({ equity, buyingPower, strategies = [], rawTargets = {},
  policy = DEFAULT_RISK_POLICY } = {}) {
  if (!(finite(equity) > 0) || !(finite(buyingPower) >= 0)) throw new Error("Fresh positive equity and buying power are required");
  const contributions = [];
  const strategyLimit = equity * policy.strategy_gross_pct;
  for (const strategy of [...strategies].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    const targets = rawTargets[strategy.id] ?? {};
    const entries = Object.entries(targets).filter(([, value]) => Number.isFinite(Number(value)) && Number(value) !== 0)
      .sort(([a], [b]) => a.localeCompare(b));
    const rawGross = entries.reduce((sum, [, value]) => sum + Math.abs(Number(value)), 0);
    const normalization = rawGross > 1 ? 1 / rawGross : 1;
    const cap = strategyLimit * strategyMultiplier(strategy);
    for (const [symbol, target] of entries) contributions.push({ strategy_id: strategy.id, symbol,
      cluster: clusterBySymbol[symbol] ?? `symbol:${symbol}`, notional: Number(target) * normalization * cap });
  }
  scaleContributions(contributions, (item) => item.symbol, equity * policy.symbol_gross_pct);
  scaleContributions(contributions, (item) => item.cluster, equity * policy.cluster_gross_pct);
  const portfolioCap = Math.min(equity * policy.portfolio_gross_pct, buyingPower * .5);
  const grossBeforePortfolio = contributions.reduce((sum, item) => sum + Math.abs(item.notional), 0);
  const portfolioScale = grossBeforePortfolio > portfolioCap && grossBeforePortfolio > 0 ? portfolioCap / grossBeforePortfolio : 1;
  if (portfolioScale < 1) for (const item of contributions) item.notional *= portfolioScale;
  const targets = {};
  for (const item of contributions) {
    // Truncate toward zero at broker currency precision so rounding can never
    // manufacture a cent above an approved gross limit.
    item.notional = Math.trunc(item.notional * 100) / 100;
    targets[item.symbol] = round((targets[item.symbol] ?? 0) + item.notional, 2);
  }
  const gross = round(contributions.reduce((sum, item) => sum + Math.abs(item.notional), 0), 2);
  return { schema_version: RISK_POLICY_VERSION, targets, contributions,
    gross_before_netting: gross, net_gross: round(Object.values(targets).reduce((sum, value) => sum + Math.abs(value), 0), 2),
    limits: { strategy: round(strategyLimit, 2), portfolio: round(portfolioCap, 2),
      symbol: round(equity * policy.symbol_gross_pct, 2), cluster: round(equity * policy.cluster_gross_pct, 2) },
    portfolio_scale: round(portfolioScale, 8) };
}

export function riskReducingTarget(current, desired, blockIncrease = false) {
  const held = finite(current), target = finite(desired);
  if (!blockIncrease) return target;
  if (!held) return 0;
  if (!target || Math.sign(target) !== Math.sign(held)) return 0;
  return Math.abs(target) < Math.abs(held) ? target : held;
}
