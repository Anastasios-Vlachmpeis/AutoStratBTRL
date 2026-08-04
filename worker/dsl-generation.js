import { buildStrategyDNA, explainStrategyDNA } from "./dsl.js";
import { INITIAL_UNIVERSE_ID, INITIAL_UNIVERSE_SHA256, INITIAL_UNIVERSE_SYMBOLS } from "./universe.js";

export const DSL_FAMILIES = Object.freeze([
  "Dual average trend",
  "Residual reversion",
  "Range expansion",
  "Quiet trend",
]);

const node = (id, op, inputs = [], params = {}) => ({ id, op, inputs, params });

function graphFor(family, params) {
  const close = node("close", "close");
  if (family === "Dual average trend") {
    return {
      features: [close,
        node("fast", "sma", ["close"], { window: params.fast }),
        node("slow", "sma", ["close"], { window: params.slow }),
        node("spread", "price_average_distance", ["fast", "slow"]),
        node("upper", "constant", [], { value: params.threshold }),
        node("lower", "constant", [], { value: -params.threshold }),
        node("long", "greater_than", ["spread", "upper"]),
        node("short", "less_than", ["spread", "lower"]),
      ], entry: { long: "long", short: "short" }, exit: { flat: null }, warmup: params.slow,
    };
  }
  if (family === "Residual reversion") {
    return {
      features: [close,
        node("residual", "zscore", ["close"], { window: params.lookback }),
        node("entry", "constant", [], { value: params.entry_z }),
        node("negative_entry", "constant", [], { value: -params.entry_z }),
        node("exit_level", "constant", [], { value: params.exit_z }),
        node("absolute_residual", "absolute", ["residual"]),
        node("long", "less_than", ["residual", "negative_entry"]),
        node("short", "greater_than", ["residual", "entry"]),
        node("flat", "less_than", ["absolute_residual", "exit_level"]),
      ], entry: { long: "long", short: "short" }, exit: { flat: "flat" }, warmup: params.lookback,
    };
  }
  if (family === "Range expansion") {
    return {
      features: [close,
        node("distance_high", "rolling_high_distance", ["close"], { window: params.lookback }),
        node("distance_low", "rolling_low_distance", ["close"], { window: params.lookback }),
        node("upper", "constant", [], { value: params.buffer }),
        node("lower", "constant", [], { value: -params.buffer }),
        node("long", "greater_than", ["distance_high", "upper"]),
        node("short", "less_than", ["distance_low", "lower"]),
      ], entry: { long: "long", short: "short" }, exit: { flat: null }, warmup: params.lookback + 1,
    };
  }
  return {
    features: [close,
      node("returns", "simple_return", ["close"], { lag: 1 }),
      node("volatility", "realized_volatility", ["returns"], { window: params.lookback, annualization: 19656 }),
      node("trend", "simple_return", ["close"], { lag: params.lookback }),
      node("ceiling", "constant", [], { value: params.vol_ceiling }),
      node("upper", "constant", [], { value: params.threshold }),
      node("lower", "constant", [], { value: -params.threshold }),
      node("quiet", "less_than", ["volatility", "ceiling"]),
      node("up", "greater_than", ["trend", "upper"]),
      node("down", "less_than", ["trend", "lower"]),
      node("long", "and", ["quiet", "up"]),
      node("short", "and", ["quiet", "down"]),
    ], entry: { long: "long", short: "short" }, exit: { flat: null }, warmup: params.lookback + 1,
  };
}

export function buildGeneratedStrategyDNA({ family, params, seed, trialId, generation = 1,
  parentStrategyId = null, symbols = INITIAL_UNIVERSE_SYMBOLS }) {
  if (!DSL_FAMILIES.includes(family)) throw new Error(`Unsupported DSL family: ${family}`);
  const graph = graphFor(family, params);
  const dna = buildStrategyDNA({
    lineage: {
      trial_id: String(trialId), generation, parent_strategy_id: parentStrategyId,
      creation_seed: Number(seed) >>> 0,
    },
    scope: {
      mode: "time_series", universe_id: INITIAL_UNIVERSE_ID, universe_sha256: INITIAL_UNIVERSE_SHA256, symbols: [...symbols],
      minimum_dollar_volume: 5_000_000, allow_long: true, allow_short: true,
    },
    features: graph.features,
    entry: graph.entry,
    exit: graph.exit,
    cooldown: { bars: Number(params.cooldown_bars ?? 0) },
    target: {
      position_size: Number(params.position_size), max_strategy_gross: 0.005,
      per_symbol_cap: 0.001, normalization: "equal_weight", ranking: "none", reverse_on_opposite: true,
    },
    session: {
      timezone: "America/New_York", regular_hours_only: true,
      entry_cutoff: "15:45", flatten_at: "15:55",
    },
    risk: {
      stop_loss_bps: params.stop_loss_bps ?? null, max_turnover_per_day: 0.05,
      max_concurrent_symbols: 5, minimum_data_coverage: 0.9, flatten_on_unhealthy_data: true,
    },
    warmup_bars: graph.warmup,
  });
  return { dna, explanation: explainStrategyDNA(dna) };
}
