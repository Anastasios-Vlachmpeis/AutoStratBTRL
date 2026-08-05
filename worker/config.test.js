import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

for (const file of ["wrangler.jsonc", "wrangler.target.example.jsonc"]) {
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
