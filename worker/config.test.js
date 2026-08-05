import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const configurations = ["wrangler.jsonc", "wrangler.target.example.jsonc",
  "wrangler.staging.example.jsonc", "wrangler.production-paper.example.jsonc"];

for (const file of configurations) {
  test(`${file} keeps frozen paper exposure defaults`, async () => {
    const config = JSON.parse(await readFile(new URL(`../${file}`, import.meta.url), "utf8"));
    assert.equal(config.vars.ALPACA_MAX_STRATEGY_PCT, "0.005");
    assert.equal(config.vars.ALPACA_MAX_PORTFOLIO_PCT, "0.10");
    assert.equal(config.vars.ALPACA_MAX_SYMBOL_PCT, "0.02");
    assert.equal(config.vars.ALPACA_MAX_CLUSTER_PCT, "0.04");
    assert.equal(config.vars.ALPACA_DAILY_LOSS_HALT_PCT, "0.005");
    assert.equal(config.vars.ALPACA_BROKER_MODE, "shadow");
    assert.equal(config.vars.ALPACA_TRADING_ENABLED, "false");
    assert.equal(config.vars.ALPACA_LONG_TRADING_ENABLED, "false");
    assert.equal(config.vars.ALPACA_SHORT_TRADING_ENABLED, "false");
    assert.equal(config.vars.ORCHESTRATION_MODE, "observe");
  });
}

test("staging and production-paper use isolated Cloudflare resources", async () => {
  const staging = JSON.parse(await readFile(new URL("../wrangler.staging.example.jsonc", import.meta.url), "utf8"));
  const production = JSON.parse(await readFile(new URL("../wrangler.production-paper.example.jsonc", import.meta.url), "utf8"));
  assert.equal(staging.vars.ENVIRONMENT, "staging");
  assert.equal(production.vars.ENVIRONMENT, "production-paper");
  assert.equal(staging.vars.STAGING_SYMBOL_LIMIT, "5");
  assert.equal(production.vars.STAGING_SYMBOL_LIMIT, undefined);
  assert.notEqual(staging.name, production.name);
  assert.notEqual(staging.d1_databases[0].database_name, production.d1_databases[0].database_name);
  assert.notEqual(staging.r2_buckets[0].bucket_name, production.r2_buckets[0].bucket_name);
  assert.notEqual(staging.queues.producers[0].queue, production.queues.producers[0].queue);
  assert.equal(staging.workflows, undefined);
  assert.equal(production.workflows, undefined);
});

test("remote examples require cost controls and immutable Backtrader provenance", async () => {
  for (const file of ["wrangler.staging.example.jsonc", "wrangler.production-paper.example.jsonc"]) {
    const config = JSON.parse(await readFile(new URL(`../${file}`, import.meta.url), "utf8"));
    assert.equal(config.vars.COST_CONTROL_ENABLED, "true");
    assert.equal(config.vars.MONTHLY_BUDGET_LIMIT_USD, "50");
    assert.equal(config.vars.BACKTEST_REQUIRE_IMAGE_DIGEST, "true");
    assert.equal(config.vars.BACKTEST_ENGINE, "shadow");
  }
});

test("Cloud Run deployment stays bounded, scale-to-zero, immutable, and rotation-aware", async () => {
  const script = await readFile(new URL("../backtester_service/deploy-cloud-run.ps1", import.meta.url), "utf8");
  for (const value of ["--cpu\", \"1", "--memory\", \"512Mi", "--concurrency\", \"1",
    "--min-instances\", \"0", "--max-instances\", \"3", "--timeout\", \"300"]) assert.ok(script.includes(value));
  for (const value of ["AXIOM_BACKTEST_KEY_ID", "AXIOM_BACKTEST_PREVIOUS_SECRET",
    "AXIOM_BACKTEST_PREVIOUS_KEY_ID", "@$Digest", "docker.pkg.dev", "gcloud artifacts docker images describe"]) assert.ok(script.includes(value));
  assert.equal(script.includes("gcr.io/$ProjectId"), false);
});
