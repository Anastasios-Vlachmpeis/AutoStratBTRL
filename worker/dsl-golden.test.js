import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  SCHEMA_SHA256,
  SEMANTIC_SHA256,
  SUPPORTED_OPERATIONS,
  buildStrategyDNA,
  evaluateFeatures,
  evaluateStrategyTargets,
  evaluateVectorTargets,
  hashCanonical,
} from "./dsl.js";

const fixture = JSON.parse(fs.readFileSync(new URL("../strategy_dsl/fixtures/golden-v1.json", import.meta.url), "utf8"));
const operationsFixture = JSON.parse(fs.readFileSync(new URL("../strategy_dsl/fixtures/operations-v1.json", import.meta.url), "utf8"));
const schema = JSON.parse(fs.readFileSync(new URL("../strategy_dsl/schema/strategy-dsl-v1.schema.json", import.meta.url), "utf8"));
const manifest = JSON.parse(fs.readFileSync(new URL("../strategy_dsl/compiler-manifest.json", import.meta.url), "utf8"));

test("checked-in golden DNA reproduces its cross-runtime identity and targets", () => {
  const dna = buildStrategyDNA(fixture.document);
  assert.equal(dna.dna_hash, fixture.expected_dna_hash);
  assert.deepEqual(evaluateStrategyTargets(dna, fixture.bars).targets, fixture.expected_targets);
  assert.deepEqual(evaluateVectorTargets(dna, fixture.bars).targets, fixture.expected_targets);
});

test("checked-in schema, compiler contract, and operation set cannot drift", () => {
  assert.equal(hashCanonical(schema), SCHEMA_SHA256);
  assert.equal(manifest.schema_sha256, SCHEMA_SHA256);
  assert.equal(hashCanonical(manifest.semantic_contract), SEMANTIC_SHA256);
  assert.equal(manifest.semantic_sha256, SEMANTIC_SHA256);
  const schemaOperations = schema.$defs.node.properties.op.enum;
  assert.deepEqual([...schemaOperations].sort(), [...SUPPORTED_OPERATIONS].sort());
});

test("every DSL operation reproduces the checked-in feature fixture", () => {
  const dna = buildStrategyDNA(operationsFixture.document);
  assert.equal(dna.dna_hash, operationsFixture.expected_dna_hash);
  const evaluated = evaluateFeatures(dna, operationsFixture.bars);
  const last = Object.fromEntries(Object.entries(evaluated).map(([key, values]) => [key, values.at(-1)]));
  assert.deepEqual(last, operationsFixture.expected_last_features);
});
