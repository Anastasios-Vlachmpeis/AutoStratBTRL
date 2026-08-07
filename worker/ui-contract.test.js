import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const publicRoot = new URL("../public/", import.meta.url);
const [html, script, styles, publicFiles] = await Promise.all([
  readFile(new URL("index.html", publicRoot), "utf8"),
  readFile(new URL("assets/app.js", publicRoot), "utf8"),
  readFile(new URL("assets/styles.css", publicRoot), "utf8"),
  readdir(publicRoot),
]);

test("the browser is one terminal rather than a multi-page operator console", () => {
  assert.match(html, /id="app" hidden/);
  assert.equal(html.includes("data-route="), false);
  assert.equal(html.includes("sidebar"), false);
  assert.equal(html.includes("Advanced"), false);
  assert.equal(html.includes("Research details"), false);
});

test("the terminal keeps only system, account, pipeline, strategies and decisions", () => {
  for (const id of ["system-label", "autonomy-button", "emergency-button", "account-pnl-chart",
    "account-sharpe-chart", "pipeline-strip", "strategy-filter", "strategy-chart",
    "strategy-table", "strategy-detail", "decision-list"]) assert.ok(html.includes(`id="${id}"`), id);
  assert.match(html, /PAPER ONLY/);
  assert.match(html, /PAPER TRADING ONLY/);
});

test("complex manual and infrastructure controls are absent", () => {
  for (const forbidden of ["approval-form", "reset-dialog", "open-reset-button", "advanced-tabs",
    "advanced-orders", "advanced-trades", "advanced-artifacts", "dna-surface",
    "generalization-chart", "pause-strategy-button", "Generate new strats", "Run supervisor",
    "Validate holdout", "Advance simulation", "Sync Alpaca"]) assert.equal(html.includes(forbidden), false, forbidden);
  for (const route of ["/api/v1/operations", "/api/v1/logs", "/api/v1/trials", "/api/v1/orders",
    "/api/v1/trades", "/api/v1/artifacts"]) assert.equal(script.includes(route), false, route);
});

test("authentication stays session-only and handles unauthorized responses", () => {
  assert.match(html, /id="signin-form"/);
  assert.match(script, /sessionStorage\.getItem/);
  assert.match(script, /sessionStorage\.setItem/);
  assert.match(script, /response\.status === 401/);
  assert.equal(script.includes("localStorage"), false);
  assert.equal(script.includes("window.prompt"), false);
});

test("only the small product API and two safety controls are consumed", () => {
  for (const route of ["/api/v1/dashboard", "/api/v1/strategies", "/api/v1/admin/autonomy",
    "/api/v1/admin/commands"]) assert.ok(script.includes(route), route);
  assert.match(script, /adminCommand\("kill_switch"\)/);
});

test("strategy labels are hidden by default and layout remains responsive", () => {
  assert.match(html, /id="strategy-legend" hidden/);
  assert.match(styles, /\.app-header\s*\{[^}]*position:\s*sticky/s);
  assert.match(styles, /@media \(max-width: 900px\)/);
  assert.match(styles, /@media \(max-width: 640px\)/);
});

test("tests are not shipped as public static assets", () => {
  assert.equal(publicFiles.some((name) => name.endsWith(".test.js")), false);
});
