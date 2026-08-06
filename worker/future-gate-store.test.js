import assert from "node:assert/strict";
import test from "node:test";

import { FutureGateStore } from "./future-gate-store.js";

class MemoryD1 {
  constructor() { this.calls = []; }
  prepare(sql) { const db = this; let args = []; return {
    bind(...values) { args = values; return this; },
    async run() { db.calls.push({ sql, args }); return { meta: { changes: 1 } }; },
    async _run() { return this.run(); },
  }; }
  async batch(statements) { return Promise.all(statements.map((statement) => statement._run())); }
}

const clock = () => new Date("2026-08-06T12:00:00Z");
const feedVersion = { feed_version_id: "feed-iex-identity", provider: "alpaca", feed: "iex", revision: "iex-v1",
  dataset_hash: "a".repeat(64), universe_hash: "b".repeat(64), calendar_hash: "c".repeat(64),
  manifest_hash: "d".repeat(64), timeframe: "5Min", adjustment: "all", session: "regular",
  range_start: "2023-08-01T00:00:00.000Z", range_end: "2026-08-01T00:00:00.000Z",
  symbol_count: 40, created_at: "2026-08-06T00:00:00.000Z" };

test("feed versions persist immutable identities without raw bars", async () => {
  const db = new MemoryD1(), store = new FutureGateStore(db, { clock });
  const result = await store.persistFeedVersion({ workspaceId: "axiom", feedVersion });
  assert.equal(result.manifest_hash, feedVersion.manifest_hash);
  const call = db.calls.find((item) => item.sql.includes("INSERT INTO feed_versions"));
  assert.ok(call); assert.equal(call.args.includes(feedVersion.dataset_hash), true);
  assert.equal(JSON.stringify(db.calls).includes("raw_bars"), false);
});

test("SIP assessments persist decisions but can never activate a feed", async () => {
  const db = new MemoryD1(), store = new FutureGateStore(db, { clock });
  const assessment = { assessment_hash: "e".repeat(64), source_feed_version_id: "feed-iex-identity",
    target_feed_version_id: "feed-sip-identity", decision: "ready_for_separate_sip_rollout",
    passed: true, activates_feed: false, assessed_at: "2026-08-06T12:00:00.000Z" };
  const one = await store.persistSipAssessment({ workspaceId: "axiom", assessment });
  const two = await store.persistSipAssessment({ workspaceId: "axiom", assessment });
  assert.equal(one.assessment_id, two.assessment_id); assert.equal(one.activates_feed, false);
  assert.equal(db.calls.at(-1).args[7], 0);
  await assert.rejects(store.persistSipAssessment({ workspaceId: "axiom",
    assessment: { ...assessment, activates_feed: true } }), /Non-activating/);
});

test("real-money assessments are audit facts, never order authorization", async () => {
  const db = new MemoryD1(), store = new FutureGateStore(db, { clock });
  const assessment = { assessment_hash: "f".repeat(64), decision: "ready_for_separate_live_design_review",
    passed: true, live_execution_implemented: false, authorizes_orders: false,
    requires_separate_deployment: true, assessed_at: "2027-08-06T12:00:00.000Z" };
  const result = await store.persistRealMoneyAssessment({ workspaceId: "axiom", assessment });
  assert.equal(result.authorizes_orders, false); assert.equal(result.requires_separate_deployment, true);
  const call = db.calls.at(-1); assert.deepEqual(call.args.slice(5, 8), [0, 0, 1]);
  await assert.rejects(store.persistRealMoneyAssessment({ workspaceId: "axiom",
    assessment: { ...assessment, authorizes_orders: true } }), /Evidence-only/);
});
