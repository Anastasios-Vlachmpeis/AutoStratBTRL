import { readFile } from "node:fs/promises";
import { evaluateCostPolicy, recordCostUsage } from "../worker/cost-controller.js";

const path = process.argv[2];
if (!path) {
  console.error("Usage: node scripts/estimate-monthly-cost.mjs <usage-samples.json>");
  process.exit(2);
}

const input = JSON.parse(await readFile(path, "utf8"));
if (!Array.isArray(input.samples) || input.samples.length === 0) {
  throw new TypeError("Cost input must contain at least one measured usage sample");
}
const state = {};
for (const sample of input.samples) recordCostUsage(state, sample.usage, sample.at);
const at = input.evaluated_at ?? input.samples.at(-1).at;
const policy = evaluateCostPolicy(state, {
  COST_CONTROL_ENABLED: "true",
  MONTHLY_BUDGET_LIMIT_USD: String(input.monthly_limit_usd ?? 50),
  MONTHLY_FIXED_COST_USD: String(input.monthly_fixed_cost_usd ?? 0),
  COST_TELEMETRY_MAX_AGE_MS: String(input.telemetry_max_age_ms ?? 21600000),
}, at);
console.log(JSON.stringify(policy, null, 2));
if (policy.estimate.projected_monthly_usd >= policy.estimate.monthly_limit_usd) process.exitCode = 1;
