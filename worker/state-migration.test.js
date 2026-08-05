import test from "node:test";
import assert from "node:assert/strict";
import { hashCanonical } from "./dsl.js";
import {
  MIGRATION_STEPS, advanceMigrationRecord, compareMigrationParity, createMigrationPlan,
  evidenceLabel, exportLegacyState, initialMigrationRecord, normalizeLegacyExport,
  rebuildNormalizedReadModel, validateNormalizedState, verifyLegacyExport,
} from "./state-migration.js";

const H = (text) => hashCanonical({ text });

function fixture({ timeframe = "5Min", artifactTimeframe = "5Min" } = {}) {
  const dnaBody = { dsl_version: "1.0.0", compiler: { semantic_version: "1.0.0" },
    lineage: { generation: 1, parent_strategy_id: null }, scope: { symbols: ["SPY"] },
    features: [], entry: {}, exit: {}, target: { position_size: .02 } };
  const dnaHash = hashCanonical(dnaBody);
  const dna = { ...dnaBody, strategy_id: `DSL1-${dnaHash.slice(0, 24)}`, dna_hash: dnaHash };
  const datasetHash = H("dataset");
  const configHash = H("config");
  const policyHash = H("policy");
  return {
    schemaVersion: 5, seed: 7, cycle: 3, marketClock: 21, nextId: 2,
    lastScheduledBucket: "2026-08-04T14:35:00.000Z",
    strategies: [{
      id: "AX-01", name: "Migrated", state: "validation", asset: "SPY", generation: 1,
      lineage_id: "LIN-01", strategy_format: "dsl-v1", strategy_dna: dna, dna_hash: dnaHash,
      dataset_id: "DS-01", metrics: { score: 72, sharpe: 1.1, pnl: 1200 },
      validation: { status: "pending" }, monitor: { returns: [.01, -.005] },
      backtest_runs: { development: { artifact_id: "ART-DEV", dataset_id: "DS-01", timeframe } },
      lifecycle: { schema_version: 1, strategy_id: "AX-01", quality: { state: "sealed_validation", version: 4 },
        operational: { state: "ready", version: 2 },
        provenance: { dna_hash: dnaHash, dataset_hash: datasetHash, configuration_hash: configHash, policy_hash: policyHash },
        history: [{ transition_id: "TRN-1", strategy_id: "AX-01", artifact_id: "ART-DEV", target: "sealed_validation" }],
        results: {}, created_at: "2026-08-01T00:00:00.000Z" },
    }],
    events: [{ id: "EV-1", type: "REVIEW", title: "Approved" }],
    alpaca: { connected: false, api_key: "must-not-export", managed_symbols: [] },
    marketData: { schema_version: 2, mode: "shadow", bars: [{ t: "secret", c: 1 }], universe: { id: "U-1" } },
    datasets: { "DS-01": { id: "DS-01", timeframe, sha256: datasetHash, bar_count: 100,
      development: [{ t: "2026-08-01", o: 1, h: 2, l: 1, c: 2 }], holdout: [{ t: "sealed", c: 3 }] } },
    backtestArtifacts: { "ART-DEV": { id: "ART-DEV", dataset_id: "DS-01", timeframe: artifactTimeframe,
      result_hash: H("result"), sha256: H("artifact"), object_key: "artifacts/hash/result.json", equity_curve: [100000, 101000] } },
    research: { schema_version: 2, engine_version: "1.0.0", total_trials: 1,
      cohorts: [{ cohort_id: "COH-1", session_date: "2026-08-01", status: "complete", finalists: ["TR-1"] }],
      trials: { "TR-1": { trial_id: "TR-1", cohort_id: "COH-1", dna_hash: dnaHash } },
      population: [], novelty_archive: { dna_hashes: [], behavior_hashes: [] },
      holdout_burn_ledger: { by_lineage: {}, total_burns: 0 }, budget: {} },
    orchestration: { schema_version: 1, mode: "observe" },
  };
}

test("legacy export is deterministic, hashed, sorted, and contains no bars or secrets", () => {
  const options = { workspace_id: "ws-1", exported_at: "2026-08-05T00:00:00.000Z",
    bt_objects: [{ key: "bt:z", artifact_id: "ART-Z", sha256: H("z"), body: "raw" },
      { key: "bt:a", artifact_id: "ART-A", sha256: H("a"), api_token: "secret" }] };
  const first = exportLegacyState(fixture(), options);
  const second = exportLegacyState(fixture(), options);
  assert.deepEqual(first, second);
  assert.equal(verifyLegacyExport(first), true);
  assert.deepEqual(first.bt_objects.map((item) => item.key), ["bt:a", "bt:z"]);
  const wire = JSON.stringify(first);
  assert.equal(wire.includes("must-not-export"), false);
  assert.equal(wire.includes("\"bars\""), false);
  assert.equal(wire.includes("\"holdout\""), false);
  assert.equal(wire.includes("\"development\":["), false);
  assert.equal(wire.includes("equity_curve"), false);
  const tampered = structuredClone(first);
  tampered.source.cycle += 1;
  assert.throws(() => verifyLegacyExport(tampered), /hash mismatch/);
});

test("normalization produces stable domain records and a parity read model", () => {
  const bundle = exportLegacyState(fixture(), { workspace_id: "ws-1", exported_at: "2026-08-05T00:00:00.000Z",
    bt_objects: [{ key: "bt:ART-DEV", artifact_id: "ART-DEV", sha256: H("artifact"), dataset_id: "DS-01", timeframe: "5Min" }] });
  const first = normalizeLegacyExport(bundle);
  const second = normalizeLegacyExport(bundle);
  assert.deepEqual(first, second);
  assert.equal(first.strategies.length, 1);
  assert.equal(first.strategy_dna.length, 1);
  assert.equal(first.lineages.length, 1);
  assert.equal(first.cohorts.length, 1);
  assert.equal(first.trials.length, 1);
  assert.equal(first.lifecycle_transitions.length, 1);
  assert.equal(first.datasets[0].timeframe_label, "5m");
  assert.equal(first.artifact_manifests[0].source, "durable_object+bt_object");
  const read = rebuildNormalizedReadModel(first);
  assert.equal(read.meta.cycle, 3);
  assert.equal(read.summary.validation, 1);
  assert.equal(read.strategies[0].metrics.sharpe, 1.1);
  assert.equal(read.strategies[0].lifecycle.quality.state, "sealed_validation");
  assert.deepEqual(read.events, fixture().events);
  const parity = compareMigrationParity(bundle, first, read);
  assert.equal(parity.passed, true);
  assert.equal(parity.cutover_ready, true);
  assert.deepEqual(parity.mismatches, []);
});

test("daily and hourly evidence labels remain legacy and cannot mix with five-minute decisions", () => {
  assert.equal(evidenceLabel("1Day"), "legacy_daily");
  assert.equal(evidenceLabel("60Min"), "legacy_hourly");
  assert.equal(evidenceLabel("5-minute"), "5m");
  const bundle = exportLegacyState(fixture({ timeframe: "5Min", artifactTimeframe: "1Day" }));
  const normalized = normalizeLegacyExport(bundle);
  const integrity = validateNormalizedState(normalized);
  assert.equal(integrity.cutover_blocked, true);
  assert.ok(integrity.issues.some((item) => item.code === "mixed_evidence_timeframes"));
  assert.equal(compareMigrationParity(bundle, normalized).cutover_ready, false);
});

test("orphan and corrupt evidence references block cutover", () => {
  const bundle = exportLegacyState(fixture());
  const normalized = structuredClone(normalizeLegacyExport(bundle));
  normalized.strategies[0].backtest_runs.development.artifact_id = "ART-MISSING";
  normalized.artifact_manifests[0].expected_hash = H("different");
  normalized.trials[0].cohort_id = "COH-MISSING";
  const integrity = validateNormalizedState(normalized);
  assert.equal(integrity.valid, false);
  const codes = new Set(integrity.issues.map((item) => item.code));
  for (const code of ["normalized_hash_mismatch", "orphan_artifact_reference", "corrupt_artifact_hash", "orphan_cohort_reference"]) assert.ok(codes.has(code));
});

test("canonical DNA corruption is detected", () => {
  const normalized = structuredClone(normalizeLegacyExport(exportLegacyState(fixture())));
  normalized.strategy_dna[0].document.target.position_size = .9;
  const integrity = validateNormalizedState(normalized);
  assert.ok(integrity.issues.some((item) => item.code === "corrupt_dna_hash"));
  assert.ok(integrity.issues.some((item) => item.code === "normalized_hash_mismatch"));
});

test("migration plans and records are deterministic, resumable, and idempotent", () => {
  const bundle = exportLegacyState(fixture());
  const plan = createMigrationPlan(bundle);
  assert.deepEqual(plan, createMigrationPlan(bundle));
  let record = initialMigrationRecord(plan);
  const firstHash = H("verify");
  const advanced = advanceMigrationRecord(plan, record, { step: MIGRATION_STEPS[0], result_hash: firstHash, detail: { checked: true } });
  assert.equal(advanced.version, 1);
  assert.equal(advanced.next_step, MIGRATION_STEPS[1]);
  assert.strictEqual(advanceMigrationRecord(plan, advanced,
    { step: MIGRATION_STEPS[0], result_hash: firstHash, detail: { checked: true } }), advanced);
  assert.throws(() => advanceMigrationRecord(plan, advanced,
    { step: MIGRATION_STEPS[0], result_hash: H("changed"), detail: { checked: true } }), /different result/);
  record = advanced;
  for (const step of MIGRATION_STEPS.slice(1)) record = advanceMigrationRecord(plan, record, { step, result_hash: H(step) });
  assert.equal(record.status, "complete");
  assert.equal(record.next_step, null);
});

test("failed migration steps stay resumable but cannot be skipped", () => {
  const plan = createMigrationPlan(exportLegacyState(fixture()));
  const initial = initialMigrationRecord(plan);
  const failed = advanceMigrationRecord(plan, initial, { step: MIGRATION_STEPS[0], status: "failed", result_hash: H("bad"), detail: { code: "corrupt" } });
  assert.equal(failed.status, "blocked");
  assert.equal(failed.next_step, MIGRATION_STEPS[0]);
  assert.throws(() => advanceMigrationRecord(plan, failed, { step: MIGRATION_STEPS[1], result_hash: H("skip") }), /Expected migration step/);
  assert.strictEqual(advanceMigrationRecord(plan, failed,
    { step: MIGRATION_STEPS[0], status: "failed", result_hash: H("bad"), detail: { code: "corrupt" } }), failed);
  const recovered = advanceMigrationRecord(plan, failed,
    { step: MIGRATION_STEPS[0], status: "complete", result_hash: H("repaired"), detail: { repaired: true } });
  assert.equal(recovered.status, "running");
  assert.equal(recovered.next_step, MIGRATION_STEPS[1]);
  assert.equal(recovered.failures[MIGRATION_STEPS[0]].length, 1);
});
