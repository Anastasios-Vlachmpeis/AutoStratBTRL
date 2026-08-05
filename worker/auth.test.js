import assert from "node:assert/strict";
import test from "node:test";

import { adminTokenConfiguration, isAuthorized, isStrictlyAuthorized } from "./auth.js";

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

test("staging and production paper fail closed without a strong admin secret", () => {
  const request = new Request("https://example.test/api/state", { headers: { authorization: "Bearer short" } });
  assert.equal(isAuthorized(request, { ENVIRONMENT: "staging" }), false);
  assert.equal(isAuthorized(request, { ENVIRONMENT: "production-paper", ADMIN_TOKEN: "short" }), false);
  assert.equal(adminTokenConfiguration({ ENVIRONMENT: "production-paper", ADMIN_TOKEN: "short" }).valid, false);
});

test("admin token rotation accepts overlapping current and previous secrets", () => {
  const env = { ENVIRONMENT: "staging", ADMIN_TOKEN_KEY_ID: "2026-08", ADMIN_TOKEN: "a".repeat(40),
    ADMIN_TOKEN_PREVIOUS_KEY_ID: "2026-07", ADMIN_TOKEN_PREVIOUS: "b".repeat(40) };
  const previous = new Request("https://example.test/api/state", { headers: { authorization: `Bearer ${"b".repeat(40)}` } });
  const current = new Request("https://example.test/api/state", { headers: { authorization: `Bearer ${"a".repeat(40)}` } });
  assert.equal(isAuthorized(previous, env), true);
  assert.equal(isStrictlyAuthorized(current, env), true);
  assert.deepEqual(adminTokenConfiguration(env).key_ids, ["2026-08", "2026-07"]);
});
