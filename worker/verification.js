import { hashCanonical } from "./dsl.js";

export const VERIFICATION_SCHEMA_VERSION = 1;
export const TEST_LAYERS = Object.freeze(["schema_unit", "property_fuzz", "golden_parity", "statistical_isolation",
  "storage_migration", "broker_mocks", "cloud_integration", "end_to_end", "load_cost", "chaos_recovery"]);

export function createVerificationReport({ layer, status, tests = 0, failures = 0, critical_faults = 0,
  coverage = null, artifact_hash, completed_at = new Date(), details = {} } = {}) {
  if (!TEST_LAYERS.includes(layer) || !["passed", "failed", "deferred"].includes(status)) throw new TypeError("Verification report identity is invalid");
  if (!/^[a-f0-9]{64}$/.test(String(artifact_hash ?? ""))) throw new TypeError("Verification report requires an artifact SHA-256");
  const timestamp = new Date(completed_at);
  if (Number.isNaN(timestamp.getTime())) throw new TypeError("Verification report timestamp is invalid");
  const values = [tests, failures, critical_faults];
  if (values.some((value) => !Number.isInteger(Number(value)) || Number(value) < 0)) throw new TypeError("Verification counters must be non-negative integers");
  if (coverage != null && (!Number.isFinite(Number(coverage)) || Number(coverage) < 0 || Number(coverage) > 1)) throw new TypeError("Verification coverage is invalid");
  const report = { schema_version: VERIFICATION_SCHEMA_VERSION, layer, status, tests: Number(tests),
    failures: Number(failures), critical_faults: Number(critical_faults), coverage: coverage == null ? null : Number(coverage),
    artifact_hash, completed_at: timestamp.toISOString(), details: structuredClone(details) };
  report.report_hash = hashCanonical(report);
  return Object.freeze(report);
}

export function evaluateVerificationReadiness(reports = [], { minimum_coverage = .90 } = {}) {
  const latest = new Map();
  for (const report of reports) {
    const expected = createVerificationReport(report);
    if (expected.report_hash !== report.report_hash) throw new Error("Verification report hash mismatch");
    const prior = latest.get(report.layer);
    if (!prior || report.completed_at > prior.completed_at) latest.set(report.layer, report);
  }
  const layers = TEST_LAYERS.map((layer) => {
    const report = latest.get(layer) ?? null, blockers = [];
    if (!report) blockers.push("missing");
    else {
      if (report.status !== "passed") blockers.push(report.status);
      if (report.failures > 0) blockers.push("test_failures");
      if (report.critical_faults > 0) blockers.push("critical_faults");
      if (layer === "schema_unit" && (report.coverage == null || report.coverage < minimum_coverage)) blockers.push("coverage_below_90_percent");
    }
    return { layer, ready: blockers.length === 0, blockers, report_hash: report?.report_hash ?? null };
  });
  const output = { schema_version: VERIFICATION_SCHEMA_VERSION, minimum_coverage, ready: layers.every((item) => item.ready),
    total_tests: [...latest.values()].reduce((sum, item) => sum + item.tests, 0),
    total_failures: [...latest.values()].reduce((sum, item) => sum + item.failures, 0), layers };
  output.verification_hash = hashCanonical(output);
  return output;
}
