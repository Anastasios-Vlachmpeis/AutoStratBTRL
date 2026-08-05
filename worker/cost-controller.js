export const COST_SCHEMA_VERSION = 1;
export const DEFAULT_MONTHLY_LIMIT_USD = 50;
export const COST_USAGE_KEYS = Object.freeze([
  "alpaca_requests", "worker_requests", "worker_cpu_ms", "durable_object_requests", "durable_object_storage_gb_days",
  "d1_rows_read", "d1_rows_written", "d1_storage_gb_days", "r2_class_a_operations", "r2_class_b_operations",
  "r2_storage_gb_days", "r2_egress_gb", "queue_operations", "cloud_run_vcpu_seconds", "cloud_run_gib_seconds",
  "cloud_run_invocations", "cloud_run_job_tasks", "cloud_logging_gib", "artifact_transfer_gib",
  "research_trials", "research_finalists", "manual_cost_usd",
]);

// Conservative marginal rates. Provider free allowances are deliberately not
// subtracted; fixed subscriptions can be supplied separately through env.
export const DEFAULT_COST_RATES_USD = Object.freeze({
  alpaca_requests: 0,
  worker_requests: .30 / 1_000_000,
  worker_cpu_ms: .02 / 1_000_000,
  durable_object_requests: .15 / 1_000_000,
  durable_object_storage_gb_days: .20 / 30,
  d1_rows_read: .001 / 1_000_000,
  d1_rows_written: 1 / 1_000_000,
  d1_storage_gb_days: .75 / 30,
  r2_class_a_operations: 4.50 / 1_000_000,
  r2_class_b_operations: .36 / 1_000_000,
  r2_storage_gb_days: .015 / 30,
  r2_egress_gb: 0,
  queue_operations: .40 / 1_000_000,
  cloud_run_vcpu_seconds: .000024,
  cloud_run_gib_seconds: .0000025,
  cloud_run_invocations: .40 / 1_000_000,
  cloud_run_job_tasks: 0,
  cloud_logging_gib: .50,
  artifact_transfer_gib: 0,
  research_trials: 0,
  research_finalists: 0,
  manual_cost_usd: 1,
});

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const enabled = (value) => String(value ?? "false").toLowerCase() === "true";
const iso = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("Cost telemetry timestamp is invalid");
  return date.toISOString();
};
const emptyUsage = () => Object.fromEntries(COST_USAGE_KEYS.map((key) => [key, 0]));

export function ensureCostState(state) {
  state.cost_control ??= { schema_version: COST_SCHEMA_VERSION, daily: {}, last_sample_at: null,
    current_policy: null, policy_history: [] };
  state.cost_control.schema_version = COST_SCHEMA_VERSION;
  state.cost_control.daily ??= {};
  state.cost_control.policy_history ??= [];
  return state.cost_control;
}

export function recordCostUsage(state, increments = {}, at = new Date()) {
  const timestamp = iso(at), date = timestamp.slice(0, 10), cost = ensureCostState(state);
  const day = cost.daily[date] ?? { date, usage: emptyUsage(), samples: 0, first_sample_at: timestamp, last_sample_at: timestamp };
  for (const [key, raw] of Object.entries(increments)) {
    if (!COST_USAGE_KEYS.includes(key)) throw new TypeError(`Unsupported cost usage key: ${key}`);
    const value = finite(raw, NaN);
    if (!Number.isFinite(value) || value < 0) throw new TypeError(`Cost usage ${key} must be a non-negative finite number`);
    day.usage[key] = finite(day.usage[key]) + value;
  }
  day.samples += 1; day.last_sample_at = timestamp;
  cost.daily[date] = day; cost.last_sample_at = timestamp;
  const retained = Object.keys(cost.daily).sort().slice(-45);
  cost.daily = Object.fromEntries(retained.map((key) => [key, cost.daily[key]]));
  return day;
}

function monthDays(timestamp) {
  const date = new Date(timestamp);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
}

export function monthlyCostEstimate(state, env = {}, at = new Date(), rates = DEFAULT_COST_RATES_USD) {
  const timestamp = iso(at), month = timestamp.slice(0, 7), cost = ensureCostState(state);
  const days = Object.values(cost.daily).filter((item) => item.date.startsWith(month)).sort((a, b) => a.date.localeCompare(b.date));
  const usage = emptyUsage();
  for (const day of days) for (const key of COST_USAGE_KEYS) usage[key] += finite(day.usage?.[key]);
  const variable = COST_USAGE_KEYS.reduce((sum, key) => sum + usage[key] * finite(rates[key]), 0);
  const fixed = Math.max(0, finite(env.MONTHLY_FIXED_COST_USD));
  const monthToDate = variable + fixed;
  const elapsedDays = Math.max(1, Number(timestamp.slice(8, 10)));
  const observedDays = new Set(days.map((item) => item.date)).size;
  const projectionFactor = monthDays(timestamp) / elapsedDays;
  const projected = fixed + variable * projectionFactor;
  return { month, currency: "USD", usage, observed_days: observedDays, elapsed_calendar_days: elapsedDays,
    month_days: monthDays(timestamp), variable_cost_usd: variable, fixed_cost_usd: fixed,
    month_to_date_usd: monthToDate, projected_monthly_usd: projected,
    monthly_limit_usd: Math.max(1, finite(env.MONTHLY_BUDGET_LIMIT_USD, DEFAULT_MONTHLY_LIMIT_USD)) };
}

function telemetryStatus(cost, env, timestamp) {
  if (!enabled(env.COST_CONTROL_ENABLED)) return "disabled";
  if (!cost.last_sample_at) return "unavailable";
  const age = new Date(timestamp).getTime() - new Date(cost.last_sample_at).getTime();
  const maximum = Math.max(60_000, finite(env.COST_TELEMETRY_MAX_AGE_MS, 6 * 60 * 60 * 1000));
  return age < 0 || age > maximum ? "stale" : "healthy";
}

export function evaluateCostPolicy(state, env = {}, at = new Date(), rates = DEFAULT_COST_RATES_USD) {
  const timestamp = iso(at), cost = ensureCostState(state), estimate = monthlyCostEstimate(state, env, timestamp, rates);
  const telemetry = telemetryStatus(cost, env, timestamp);
  const ratio = estimate.monthly_limit_usd > 0 ? estimate.projected_monthly_usd / estimate.monthly_limit_usd : 1;
  let level = "normal", quotaMultiplier = 1, optionalResearch = true, optionalBackfills = true, deepStress = true;
  if (telemetry === "unavailable" || telemetry === "stale") {
    level = "telemetry_unavailable"; quotaMultiplier = 0; optionalResearch = false; optionalBackfills = false; deepStress = false;
  } else if (ratio >= 1) {
    level = "hard_stop"; quotaMultiplier = 0; optionalResearch = false; optionalBackfills = false; deepStress = false;
  } else if (ratio >= .9) {
    level = "optional_paused"; quotaMultiplier = 0; optionalResearch = false; optionalBackfills = false; deepStress = false;
  } else if (ratio >= .75) {
    level = "constrained"; quotaMultiplier = .5; optionalBackfills = false; deepStress = false;
  } else if (ratio >= .5) level = "informational";
  if (telemetry === "disabled") level = "disabled";
  const policy = { schema_version: COST_SCHEMA_VERSION, evaluated_at: timestamp, level, telemetry_status: telemetry,
    projected_ratio: ratio, estimate, optional_research_allowed: optionalResearch,
    optional_backfills_allowed: optionalBackfills, finish_active_sealed_validation: true,
    live_data_allowed: true, risk_supervision_allowed: true, quota_multiplier: quotaMultiplier,
    deep_stress_allowed: deepStress,
    reason: level === "telemetry_unavailable" ? `cost_telemetry_${telemetry}` : `projected_budget_${level}` };
  if (cost.current_policy?.level !== policy.level || cost.current_policy?.estimate?.month !== estimate.month) {
    cost.policy_history.push({ evaluated_at: timestamp, from: cost.current_policy?.level ?? null, to: policy.level,
      projected_ratio: ratio, telemetry_status: telemetry });
    cost.policy_history = cost.policy_history.slice(-120);
  }
  cost.current_policy = policy;
  return policy;
}

export function costPublicSummary(state, env = {}, at = new Date()) {
  const policy = evaluateCostPolicy(state, env, at);
  return { schema_version: policy.schema_version, evaluated_at: policy.evaluated_at, level: policy.level,
    telemetry_status: policy.telemetry_status, projected_ratio: policy.projected_ratio,
    month_to_date_usd: policy.estimate.month_to_date_usd,
    projected_monthly_usd: policy.estimate.projected_monthly_usd,
    monthly_limit_usd: policy.estimate.monthly_limit_usd,
    observed_days: policy.estimate.observed_days,
    optional_research_allowed: policy.optional_research_allowed,
    optional_backfills_allowed: policy.optional_backfills_allowed,
    finish_active_sealed_validation: true, live_data_allowed: true, risk_supervision_allowed: true,
    quota_multiplier: policy.quota_multiplier, reason: policy.reason };
}
