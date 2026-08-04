import assert from "node:assert/strict";
import test from "node:test";
import {
  SCHEMA_SHA256, SEMANTIC_SHA256, buildStrategyDNA, canonicalJson, evaluateLatestTarget,
  evaluateStrategyTargets, evaluateVectorTargets, explainStrategyDNA, hashCanonical,
  legacyStrategyToDSL, validateStrategyDNA,
} from "./dsl.js";

function document(overrides = {}) {
  const base = {
    compiler: { semantic_version: "1.0.0", schema_sha256: SCHEMA_SHA256, semantic_sha256: SEMANTIC_SHA256 },
    lineage: { trial_id: "unit", generation: 1, parent_strategy_id: null, creation_seed: 7 },
    scope: { mode: "time_series", universe_id: "unit", universe_sha256: "0".repeat(64), symbols: ["SPY"], minimum_dollar_volume: 0, allow_long: true, allow_short: true },
    features: [
      { id: "close", op: "close", inputs: [], params: {} },
      { id: "zero", op: "constant", inputs: [], params: { value: 0 } },
      { id: "long", op: "greater_than", inputs: ["close", "zero"], params: {} },
      { id: "short", op: "less_than", inputs: ["close", "zero"], params: {} },
    ], entry: { long: "long", short: "short" }, exit: { flat: null }, cooldown: { bars: 1 },
    target: { position_size: .002, max_strategy_gross: .005, per_symbol_cap: .005, normalization: "unit", ranking: "none", reverse_on_opposite: true },
    session: { timezone: "America/New_York", regular_hours_only: true, entry_cutoff: "15:45", flatten_at: "15:55" },
    risk: { stop_loss_bps: null, max_turnover_per_day: 20, max_concurrent_symbols: 40, minimum_data_coverage: .9, flatten_on_unhealthy_data: true }, warmup_bars: 0,
  };
  return { ...base, ...overrides };
}
const bars = [
  { t: "2026-08-03T13:30:00Z", o: 1, h: 1, l: 1, c: 1, v: 10 }, // 09:35 EDT decision
  { t: "2026-08-03T13:35:00Z", o: 1, h: 1, l: -1, c: -1, v: 10 },
  { t: "2026-08-03T13:40:00Z", o: 1, h: 1, l: 1, c: 1, v: 10 },
  { t: "2026-08-03T19:50:00Z", o: 1, h: 1, l: 1, c: 1, v: 10 }, // 15:55 EDT
];

test("canonical JSON and SHA-256 are deterministic and known-compatible", async () => {
  assert.equal(canonicalJson({ z: [2, { b: 1, a: true }], a: 0 }), '{"a":0,"z":[2,{"a":true,"b":1}]}');
  assert.equal(hashCanonical("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  const web = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson({ b: 2, a: 1 })));
  const webHex = [...new Uint8Array(web)].map((value) => value.toString(16).padStart(2, "0")).join("");
  assert.equal(hashCanonical({ a: 1, b: 2 }), webHex);
  const numericBoundary = { tiny: 1e-7, micro: 1e-6, large: 1e20, huge: 1e21 };
  assert.equal(canonicalJson(numericBoundary), '{"huge":1e+21,"large":100000000000000000000,"micro":0.000001,"tiny":1e-7}');
  assert.equal(hashCanonical(numericBoundary), "1d8e1d426a4b7de0a1b6e93916a94391dcdbf142bd68d993ceaddbe54d2d887e");
  assert.throws(() => canonicalJson({ bad: NaN }));
});

test("complete DNA has derived identity, validates, explains, and mutates its hash", () => {
  const dna = buildStrategyDNA(document());
  assert.match(dna.strategy_id, /^DSL1-[a-f0-9]{24}$/);
  assert.equal(dna.strategy_id.slice(5), dna.dna_hash.slice(0, 24));
  assert.equal(validateStrategyDNA(dna).max_depth, 2);
  assert.equal(explainStrategyDNA(dna).graph.nodes.length, 4);
  const changed = buildStrategyDNA(document({ cooldown: { bars: 2 } }));
  assert.notEqual(changed.dna_hash, dna.dna_hash);
});

test("strict validation rejects lookahead, type mismatches, cycles, and excess complexity", () => {
  const forward = buildStrategyDNA(document({ features: [{ id: "x", op: "close", inputs: [], params: {} }, { id: "zero", op: "constant", inputs: [], params: { value: 0 } }, { id: "long", op: "greater_than", inputs: ["x", "zero"], params: {} }, { id: "short", op: "less_than", inputs: ["x", "zero"], params: {} }] }));
  forward.features[0].params.lag = -1;
  assert.throws(() => validateStrategyDNA(forward), /invalid lag/);
  const malformed = buildStrategyDNA(document()); malformed.features[2].inputs = ["long", "zero"];
  assert.throws(() => validateStrategyDNA(malformed), /topologically ordered/);
  const typed = buildStrategyDNA(document()); typed.features[3].op = "and";
  assert.throws(() => validateStrategyDNA(typed), /boolean inputs/);
  const deepFeatures = [{ id: "x", op: "constant", inputs: [], params: { value: 1 } }];
  for (let i = 0; i < 13; i += 1) deepFeatures.push({ id: `x${i}`, op: "absolute", inputs: [i ? `x${i - 1}` : "x"], params: {} });
  deepFeatures.push({ id: "zero", op: "constant", inputs: [], params: { value: 0 } }, { id: "long", op: "greater_than", inputs: ["x12", "zero"], params: {} }, { id: "short", op: "less_than", inputs: ["x12", "zero"], params: {} });
  const deep = buildStrategyDNA(document()); deep.features = deepFeatures;
  assert.throws(() => validateStrategyDNA(deep), /depth/);
});

test("sequential targets respect long, short reversal, missing data, session flatten, and vector parity", () => {
  const dna = buildStrategyDNA(document());
  const result = evaluateStrategyTargets(dna, bars);
  assert.deepEqual(result.targets, [.00001, -.00001, .00001, 0]);
  assert.deepEqual(evaluateVectorTargets(dna, bars).targets, result.targets);
  assert.equal(evaluateLatestTarget(dna, bars), 0);
  const unhealthy = evaluateStrategyTargets(dna, [{ ...bars[0], data_coverage: .5 }]);
  assert.deepEqual(unhealthy.targets, [0]);
  const missing = evaluateStrategyTargets(dna, [{ ...bars[0], c: null }]);
  assert.deepEqual(missing.targets, [0]);
});

test("early closes clamp the session and equal-weight sizing is deterministic", () => {
  const unit = buildStrategyDNA(document());
  const equalWeight = buildStrategyDNA(document({
    target: { ...document().target, normalization: "equal_weight" },
    risk: { ...document().risk, max_concurrent_symbols: 4 },
  }));
  const earlyCloseBars = [
    { t: "2026-11-27T14:30:00Z", session_close: "2026-11-27T18:00:00Z", o: 1, h: 1, l: 1, c: 1, v: 10 },
    { t: "2026-11-27T17:55:00Z", session_close: "2026-11-27T18:00:00Z", o: 1, h: 1, l: 1, c: 1, v: 10 },
  ];
  assert.deepEqual(evaluateStrategyTargets(unit, earlyCloseBars).targets, [.00001, 0]);
  assert.equal(evaluateStrategyTargets(equalWeight, [earlyCloseBars[0]]).targets[0], .0000025);
});

test("daily turnover limits retain the prior target instead of creating a hidden fill", () => {
  const dna = buildStrategyDNA(document({ risk: { ...document().risk, max_turnover_per_day: .000015 } }));
  assert.deepEqual(evaluateStrategyTargets(dna, bars.slice(0, 2)).targets, [.00001, .00001]);
});

test("deterministic invalid-document fuzzing rejects every malformed strategy", () => {
  const pristine = buildStrategyDNA(document());
  for (let index = 0; index < 120; index += 1) {
    const malformed = structuredClone(pristine);
    if (index % 4 === 0) malformed.features[index % malformed.features.length].op = `unknown_${index}`;
    else if (index % 4 === 1) malformed.features[2].inputs = ["future_node", "zero"];
    else if (index % 4 === 2) malformed.risk.minimum_data_coverage = .5;
    else malformed.scope.symbols = ["SPY", "SPY"];
    assert.throws(() => validateStrategyDNA(malformed));
  }
});

test("legacy adapter covers every current archetype", () => {
  for (const archetype of ["Momentum", "Mean reversion", "Breakout", "Volatility filter"]) {
    const dna = legacyStrategyToDSL({ id: archetype, asset: "SPY", archetype, params: { position_size: .002 } });
    assert.equal(dna.dsl_version, "1.0.0");
    assert.doesNotThrow(() => validateStrategyDNA(dna));
  }
});
