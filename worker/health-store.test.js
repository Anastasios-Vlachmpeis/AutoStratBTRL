import assert from "node:assert/strict";
import test from "node:test";
import { HealthStore } from "./health-store.js";
import { startReleaseMonitoring } from "./monitoring.js";

class MemoryD1 {
  constructor() { this.batches = []; }
  prepare(sql) { return { bind: (...values) => ({ sql, values }) }; }
  async batch(statements) { this.batches.push(statements); return statements.map(() => ({ success: true })); }
}

function fixture() {
  const strategy = { id: "S-1", state: "healthy", release_id: "R-1", asset: "SPY",
    dna_hash: "d".repeat(64), risk_overlay: { effective_multiplier: .5 } };
  startReleaseMonitoring(strategy, { releaseId: "R-1", startedAt: "2026-08-01T00:00:00Z" });
  return strategy;
}

test("health observations persist an immutable policy and idempotent incremental record", async () => {
  const db = new MemoryD1(), store = new HealthStore(db, { clock: () => new Date("2026-08-04T00:00:00Z") });
  const strategy = fixture(), observation = { event_id: "e1", observed_at: "2026-08-03T14:00:00Z",
    return: .001, hard_findings: [], operational_findings: [] };
  await store.persistObservation({ workspaceId: "axiom", strategy, observation });
  const sql = db.batches.flat().map((item) => item.sql).join("\n");
  assert.match(sql, /supervisor_policy_versions/); assert.match(sql, /strategy_health/);
  assert.match(sql, /ON CONFLICT/);
});

test("health decision persists overlay and operational incident without destructive updates", async () => {
  const db = new MemoryD1(), store = new HealthStore(db, { clock: () => new Date("2026-08-04T00:00:00Z") });
  const strategy = fixture(); strategy.health.operational_findings.push({ code: "feed_timeout", event_id: "e1" });
  const decision = { decision_id: "D-1", quality_outcome: "healthy",
    findings: ["feed_timeout"], summary: {}, operational_outcome: "operational_blocked" };
  await store.persistDecision({ workspaceId: "axiom", strategy, decision, artifactId: "A-1",
    actor: "operator:admin" });
  const sql = db.batches.flat().map((item) => item.sql).join("\n");
  assert.match(sql, /risk_actions/); assert.match(sql, /incidents/); assert.doesNotMatch(sql, /DELETE/);
  const decisionRow = db.batches.flat().find((item) => item.sql.includes("INSERT INTO strategy_health"));
  assert.equal(decisionRow.values.at(-1), "2026-08-04T00:00:00.001Z");
  const riskRow = db.batches.flat().find((item) => item.sql.includes("INSERT INTO risk_actions"));
  assert.equal(riskRow.values[11], "operator:admin");
});

test("retirement closes only the immutable release version and appends its zero-risk action", async () => {
  const db = new MemoryD1(), store = new HealthStore(db, { clock: () => new Date("2026-08-04T00:00:00Z") });
  await store.persistRetirement({ workspaceId: "axiom", strategy: fixture(), reason: "persistent_degradation" });
  const sql = db.batches.flat().map((item) => item.sql).join("\n");
  assert.match(sql, /UPDATE releases SET status='retired'/); assert.match(sql, /risk_actions/);
});

test("portfolio overlays append one deterministic risk action", async () => {
  const db = new MemoryD1(), store = new HealthStore(db, { clock: () => new Date("2026-08-04T00:00:00Z") });
  await store.persistPortfolioOverlay({ workspaceId: "axiom", strategy: fixture(),
    sessionDate: "2026-08-03", overlay: { multiplier: .7, reason_codes: ["portfolio_strategy_concentration"] } });
  const rows = db.batches.flat();
  assert.equal(rows.length, 1); assert.match(rows[0].sql, /INSERT INTO risk_actions/);
  assert.equal(rows[0].values[4], "portfolio_overlay");
});

test("operational recovery resolves incidents without deleting their history", async () => {
  const db = new MemoryD1(), store = new HealthStore(db, { clock: () => new Date("2026-08-04T00:00:00Z") });
  await store.resolveOperationalIncidents({ workspaceId: "axiom", strategy: fixture() });
  const sql = db.batches.flat()[0].sql;
  assert.match(sql, /UPDATE incidents SET status='resolved'/); assert.doesNotMatch(sql, /DELETE/);
});
