import assert from "node:assert/strict";
import test from "node:test";

import {
  INITIAL_UNIVERSE_ID,
  INITIAL_UNIVERSE_SHA256,
  INITIAL_UNIVERSE_SYMBOLS,
  assertInitialUniverse,
  initialUniverseManifest,
  isInitialUniverseSymbol,
  runtimeUniverseManifest,
} from "./universe.js";

test("initial IEX universe is a frozen diversified set of exactly 40 symbols", async () => {
  assert.equal(assertInitialUniverse(), true);
  assert.equal(INITIAL_UNIVERSE_SYMBOLS.length, 40);
  assert.equal(new Set(INITIAL_UNIVERSE_SYMBOLS).size, 40);
  const manifest = await initialUniverseManifest();
  assert.equal(manifest.id, INITIAL_UNIVERSE_ID);
  assert.equal(manifest.feed, "iex");
  assert.equal(manifest.symbols.length, 40);
  assert.equal(manifest.point_in_time_membership, false);
  assert.match(manifest.sha256, /^[a-f0-9]{64}$/);
  assert.equal(manifest.sha256, INITIAL_UNIVERSE_SHA256);
});

test("universe manifest and membership are deterministic", async () => {
  assert.deepEqual(await initialUniverseManifest(), await initialUniverseManifest());
  assert.equal(isInitialUniverseSymbol("spy"), true);
  assert.equal(isInitialUniverseSymbol("BTCUSD"), false);
});

test("staging uses an explicitly distinct reduced universe", async () => {
  const full = await initialUniverseManifest();
  const staging = await runtimeUniverseManifest({ ENVIRONMENT: "staging", STAGING_SYMBOL_LIMIT: "5" });
  assert.equal(staging.symbols.length, 5);
  assert.equal(staging.staging_only, true);
  assert.equal(staging.parent_universe_id, full.id);
  assert.notEqual(staging.id, full.id);
  assert.notEqual(staging.sha256, full.sha256);
});

test("production-paper always uses the complete frozen universe", async () => {
  assert.deepEqual(
    await runtimeUniverseManifest({ ENVIRONMENT: "production-paper", STAGING_SYMBOL_LIMIT: "5" }),
    await initialUniverseManifest(),
  );
});
