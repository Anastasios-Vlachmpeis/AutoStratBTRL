import assert from "node:assert/strict";
import test from "node:test";
import { startIncubation } from "./incubation.js";
import { IncubationStore } from "./incubation-store.js";

class MemoryD1 {
  constructor() { this.batches = []; }
  prepare(sql) { return { bind: (...values) => ({ sql, values }) }; }
  async batch(statements) { this.batches.push(statements); return statements.map(() => ({ success: true })); }
}

function fixture() {
  const strategy = { id: "S-1", asset: "SPY", dna_hash: "d".repeat(64),
    strategy_dna: { scope: { symbols: ["SPY"], universe_sha256: "u".repeat(64) } } };
  startIncubation(strategy, { startedAt: "2026-08-01T12:00:00.000Z" });
  strategy.incubation.sessions["2026-08-03"] = { session_date: "2026-08-03", completed: true,
    valid: true, coverage: 1, critical_faults: [], exclusions: [] };
  strategy.incubation.closed_trade_ledger.push({ trade_key: "SPY:a:b", trade_id: "t1", symbol: "SPY",
    direction: "long", signed_units: 1, entry_at: "2026-08-03T14:00:00Z",
    exit_at: "2026-08-03T14:05:00Z", pnl: 1, session_date: "2026-08-03", eligible: true });
  strategy.incubation.critical_faults.push({ code: "feed_gap", event_id: "e1", symbol: "SPY" });
  return strategy;
}

test("D1 journal writes frozen policy, incubation, day, eligible trade and incident idempotently", async () => {
  const db = new MemoryD1(), store = new IncubationStore(db, { clock: () => new Date("2026-08-04T00:00:00Z") });
  const strategy = fixture();
  const first = await store.persistEvidence({ workspaceId: "axiom", strategy });
  await store.persistEvidence({ workspaceId: "axiom", strategy });
  assert.equal(first.status, "incubation_continue"); assert.equal(db.batches.length, 2);
  const sql = db.batches[0].map((item) => item.sql).join("\n");
  for (const table of ["supervisor_policy_versions", "incubations", "incubation_days", "incubation_trades", "incidents"]) {
    assert.match(sql, new RegExp(table));
  }
  assert.match(sql, /ON CONFLICT/); assert.equal(db.batches[0].length, db.batches[1].length);
});

test("release persistence requires a decision artifact and uses deterministic conflict-safe rows", async () => {
  const db = new MemoryD1(), store = new IncubationStore(db, { clock: () => new Date("2026-08-04T00:00:00Z") });
  const strategy = fixture();
  await assert.rejects(store.persistRelease({ workspaceId: "axiom", strategy }), /release evidence/);
  strategy.incubation.decision = { decision_id: "decision-1" };
  const first = await store.persistRelease({ workspaceId: "axiom", strategy,
    decisionArtifactId: "artifact-1" });
  const second = await store.persistRelease({ workspaceId: "axiom", strategy,
    decisionArtifactId: "artifact-1" });
  assert.equal(first.releaseId, second.releaseId);
  assert.match(db.batches[0][1].sql, /INSERT INTO releases/);
  assert.match(db.batches[0][1].sql, /ON CONFLICT/);
});
