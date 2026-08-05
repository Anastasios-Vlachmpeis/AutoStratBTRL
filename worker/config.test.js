import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

for (const file of ["wrangler.jsonc", "wrangler.target.example.jsonc"]) {
  test(`${file} keeps frozen paper exposure defaults`, async () => {
    const config = JSON.parse(await readFile(new URL(`../${file}`, import.meta.url), "utf8"));
    assert.equal(config.vars.ALPACA_MAX_STRATEGY_PCT, "0.005");
    assert.equal(config.vars.ALPACA_MAX_PORTFOLIO_PCT, "0.10");
    assert.equal(config.vars.ORCHESTRATION_MODE, "observe");
  });
}
