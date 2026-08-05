import assert from "node:assert/strict";
import test from "node:test";

import { isAuthorized, isStrictlyAuthorized } from "./auth.js";

test("local mode remains open when no admin token is configured", () => {
  assert.equal(isAuthorized(new Request("https://example.test/api/state"), {}), true);
});

test("read and write API requests require the configured bearer token", () => {
  const env = { ADMIN_TOKEN: "private-dashboard-token" };
  const anonymous = new Request("https://example.test/api/state");
  const wrong = new Request("https://example.test/api/state", { headers: { authorization: "Bearer wrong" } });
  const valid = new Request("https://example.test/api/state", { headers: { authorization: "Bearer private-dashboard-token" } });
  assert.equal(isAuthorized(anonymous, env), false);
  assert.equal(isAuthorized(wrong, env), false);
  assert.equal(isAuthorized(valid, env), true);
});

test("private artifact authorization stays closed when no token is configured", () => {
  const request = new Request("https://example.test/api/backtest-artifacts/a");
  assert.equal(isStrictlyAuthorized(request, {}), false);
  assert.equal(isStrictlyAuthorized(new Request(request.url, { headers: { authorization: "Bearer secret" } }), { ADMIN_TOKEN: "secret" }), true);
});
