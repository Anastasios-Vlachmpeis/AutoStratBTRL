import { sha256 } from "./backtest.js";

export const INITIAL_UNIVERSE_ID = "us-iex-liquid-40-v1";
export const INITIAL_UNIVERSE_EFFECTIVE_FROM = "2026-08-03";
export const INITIAL_UNIVERSE_SHA256 = "6702cf7b153c4cbbc37cd79b4a8c544456841b981fa27cdd40975fbc41d56e43";

export const INITIAL_UNIVERSE_SYMBOLS = Object.freeze([
  "SPY", "QQQ", "IWM", "DIA", "TLT", "GLD", "SLV", "XLF", "XLK", "XLE", "XLV", "XLI",
  "AAPL", "MSFT", "NVDA", "AMZN", "META", "GOOGL", "TSLA", "AVGO", "AMD", "NFLX",
  "JPM", "BAC", "GS", "XOM", "CVX", "UNH", "LLY", "JNJ", "WMT", "COST", "HD", "CAT",
  "BA", "DIS", "KO", "PFE", "INTC", "CSCO",
]);

export const INITIAL_UNIVERSE_GROUPS = Object.freeze({
  broad_equity_etfs: ["SPY", "QQQ", "IWM", "DIA"],
  macro_and_sector_etfs: ["TLT", "GLD", "SLV", "XLF", "XLK", "XLE", "XLV", "XLI"],
  technology_and_communications: ["AAPL", "MSFT", "NVDA", "AMZN", "META", "GOOGL", "TSLA", "AVGO", "AMD", "NFLX", "INTC", "CSCO"],
  financials: ["JPM", "BAC", "GS"],
  energy: ["XOM", "CVX"],
  healthcare: ["UNH", "LLY", "JNJ", "PFE"],
  consumer_and_industrial: ["WMT", "COST", "HD", "CAT", "BA", "DIS", "KO"],
});

function canonicalUniverse() {
  return {
    id: INITIAL_UNIVERSE_ID,
    schema_version: 1,
    effective_from: INITIAL_UNIVERSE_EFFECTIVE_FROM,
    feed: "iex",
    asset_class: "us_equity",
    session: "regular",
    symbols: [...INITIAL_UNIVERSE_SYMBOLS],
    groups: Object.fromEntries(Object.entries(INITIAL_UNIVERSE_GROUPS).map(([name, symbols]) => [name, [...symbols]])),
    selection_policy: "fixed diversified liquid US stocks and ETFs; quarterly review for future cohorts only",
    point_in_time_membership: false,
    survivorship_bias_notice: "Current fixed membership is not a historical point-in-time index universe.",
  };
}

export async function initialUniverseManifest() {
  const manifest = canonicalUniverse();
  return { ...manifest, sha256: await sha256(manifest) };
}

export async function runtimeUniverseManifest(env = {}) {
  const environment = String(env.ENVIRONMENT ?? "local").trim().toLowerCase();
  if (environment !== "staging") return initialUniverseManifest();

  const requested = Number.parseInt(String(env.STAGING_SYMBOL_LIMIT ?? "5"), 10);
  const limit = Number.isFinite(requested)
    ? Math.max(1, Math.min(INITIAL_UNIVERSE_SYMBOLS.length, requested))
    : 5;
  if (limit === INITIAL_UNIVERSE_SYMBOLS.length) return initialUniverseManifest();

  const selected = INITIAL_UNIVERSE_SYMBOLS.slice(0, limit);
  const selectedSet = new Set(selected);
  const manifest = {
    ...canonicalUniverse(),
    id: `${INITIAL_UNIVERSE_ID}-staging-${limit}`,
    symbols: selected,
    groups: Object.fromEntries(Object.entries(INITIAL_UNIVERSE_GROUPS)
      .map(([name, symbols]) => [name, symbols.filter((symbol) => selectedSet.has(symbol))])
      .filter(([, symbols]) => symbols.length > 0)),
    selection_policy: `staging-only deterministic prefix of ${limit} symbols from ${INITIAL_UNIVERSE_ID}`,
    parent_universe_id: INITIAL_UNIVERSE_ID,
    staging_only: true,
  };
  return { ...manifest, sha256: await sha256(manifest) };
}

export function isInitialUniverseSymbol(symbol) {
  return INITIAL_UNIVERSE_SYMBOLS.includes(String(symbol ?? "").toUpperCase());
}

export function assertInitialUniverse() {
  if (INITIAL_UNIVERSE_SYMBOLS.length !== 40) throw new Error("Initial market universe must contain exactly 40 symbols");
  const unique = new Set(INITIAL_UNIVERSE_SYMBOLS);
  if (unique.size !== INITIAL_UNIVERSE_SYMBOLS.length) throw new Error("Initial market universe contains duplicate symbols");
  for (const symbol of INITIAL_UNIVERSE_SYMBOLS) {
    if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) throw new Error(`Invalid initial universe symbol: ${symbol}`);
  }
  const grouped = new Set(Object.values(INITIAL_UNIVERSE_GROUPS).flat());
  if (grouped.size !== unique.size || [...unique].some((symbol) => !grouped.has(symbol))) {
    throw new Error("Initial universe groups must cover every symbol exactly once");
  }
  return true;
}

assertInitialUniverse();
