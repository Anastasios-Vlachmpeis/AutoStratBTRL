import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const [html, script, styles] = await Promise.all([
  readFile(new URL("index.html", import.meta.url), "utf8"),
  readFile(new URL("assets/app.js", import.meta.url), "utf8"),
  readFile(new URL("assets/styles.css", import.meta.url), "utf8"),
]);

test("normal navigation is only Overview and Strategies with a gear-only Advanced route", () => {
  assert.match(html, /data-route="overview"[^>]*>[\s\S]*?Overview<\/span>/);
  assert.match(html, /data-route="strategies"[^>]*>[\s\S]*?Strategies<\/span>/);
  assert.match(html, /class="nav-link gear-link"[^>]+data-route="advanced"/);
  assert.equal((html.match(/data-route=/g) || []).length, 3);
  assert.match(html, /id="overview-page"[^>]*data-page="overview"(?![^>]*hidden)/);
});

test("normal product has no old manual pipeline or persistent safety interface", () => {
  for (const forbidden of ["generate-button", "review-button", "validate-button", "advance-button",
    "sync-button", "portfolio-refresh-button", "safety-dock", "operation-overlay", "blocking operation modal"]) {
    assert.equal(html.includes(forbidden), false, forbidden);
  }
  for (const label of ["Generate new strats", "Run supervisor", "Validate holdout", "Advance simulation", "Sync Alpaca"]) {
    assert.equal(html.includes(label), false, label);
  }
});

test("overview exposes the account, active curves, pipeline, passive work and recent decisions immediately", () => {
  for (const id of ["account-pnl-chart", "account-sharpe-chart", "overview-strategy-chart", "pipeline-strip",
    "work-visual", "decision-list", "autonomy-button", "emergency-button"]) assert.ok(html.includes(`id="${id}"`), id);
  assert.match(html, /PAPER MARKET/); assert.match(html, /Incubation \+ Paper Market/);
  assert.match(html, /id="overview-legend" hidden/);
});

test("strategy product contains stage filters, focusable combined curves and one normal pause action", () => {
  for (const stage of ["Active", "Testing", "Validation", "Incubation", "Paper Market", "Watch", "Retired"]) assert.ok(script.includes(`"${stage}"`), stage);
  assert.match(html, /id="strategy-chart"/); assert.match(html, /id="pause-strategy-button"[^>]*>Pause strategy/);
  assert.match(html, /<details class="panel research-details">/); assert.match(html, /id="dna-surface"/);
  assert.equal(html.includes("Resume strategy</button>"), false);
});

test("authentication is branded, session-only and returns to sign-in on unauthorized responses", () => {
  assert.match(html, /id="signin-screen"/); assert.match(html, /id="signin-form"/);
  assert.match(script, /sessionStorage\.getItem/); assert.match(script, /sessionStorage\.setItem/); assert.match(script, /response\.status === 401/);
  assert.equal(script.includes("localStorage"), false); assert.equal(script.includes("window.prompt"), false);
});

test("frontend consumes product APIs and keeps advanced operator APIs separate", () => {
  for (const route of ["/api/v1/dashboard", "/api/v1/strategies", "/api/v1/admin/autonomy", "/api/v1/operations"]) assert.ok(script.includes(route), route);
  assert.match(html, /data-page="advanced" hidden/); assert.match(html, /Orders &amp; trades/); assert.match(html, /Trials &amp; artifacts/);
});

test("navigation is sticky and layouts include tablet and narrow-mobile adaptations", () => {
  assert.match(styles, /\.sidebar\s*\{[^}]*position:\s*sticky/s); assert.match(styles, /\.topbar\s*\{[^}]*position:\s*sticky/s);
  assert.match(styles, /@media \(max-width: 900px\)/); assert.match(styles, /@media \(max-width: 680px\)/);
  assert.match(styles, /\.sidebar\s*\{[^}]*position:\s*fixed/s);
});
