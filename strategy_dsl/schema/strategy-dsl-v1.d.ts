export type DSLVersion = "1.0.0";
export type StrategyFormat = "dsl-v1";
export type FeatureType = "number" | "boolean";
export type FeatureOperation =
  | "open" | "high" | "low" | "close" | "volume" | "vwap_proxy" | "constant"
  | "simple_return" | "log_return" | "gap_return" | "sma" | "ema"
  | "price_average_distance" | "moving_average_difference" | "slope" | "zscore"
  | "bollinger_distance" | "rolling_high_distance" | "rolling_low_distance"
  | "rate_of_change" | "true_range" | "atr" | "realized_volatility"
  | "bar_range_percentile" | "relative_volume" | "minutes_since_open"
  | "minutes_until_close" | "is_finite" | "is_missing" | "add" | "subtract"
  | "multiply" | "safe_divide" | "absolute" | "negate" | "safe_log"
  | "greater_than" | "greater_equal" | "less_than" | "less_equal" | "equal"
  | "and" | "or" | "not";

export interface FeatureNode {
  id: string;
  op: FeatureOperation;
  inputs: string[];
  params: { value?: number; window?: number; lag?: number; annualization?: number; epsilon?: number };
}

export interface StrategyDSLv1 {
  dsl_version: DSLVersion;
  strategy_id: string;
  dna_hash: string;
  compiler: { semantic_version: "1.0.0"; schema_sha256: string; semantic_sha256: string };
  lineage: { trial_id: string; generation: number; parent_strategy_id: string | null; creation_seed: number };
  scope: {
    mode: "time_series"; universe_id: string; universe_sha256: string; symbols: string[];
    minimum_dollar_volume: number; allow_long: boolean; allow_short: boolean;
  };
  features: FeatureNode[];
  entry: { long: string | null; short: string | null };
  exit: { flat: string | null };
  cooldown: { bars: number };
  target: {
    position_size: number; max_strategy_gross: number; per_symbol_cap: number;
    normalization: "equal_weight" | "unit"; ranking: "none"; reverse_on_opposite: boolean;
  };
  session: {
    timezone: "America/New_York"; regular_hours_only: true; entry_cutoff: string; flatten_at: string;
  };
  risk: {
    stop_loss_bps: number | null; max_turnover_per_day: number; max_concurrent_symbols: number;
    minimum_data_coverage: number; flatten_on_unhealthy_data: true;
  };
  warmup_bars: number;
}

export interface DSLStrategyEnvelope {
  strategy_format: StrategyFormat;
  id: string;
  asset: string;
  dna: StrategyDSLv1;
  dna_hash: string;
}
