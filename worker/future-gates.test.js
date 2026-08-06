import assert from "node:assert/strict";
import test from "node:test";

import {
  IMMEDIATE_FEED_VERSION,
  LIVE_EXECUTION_IMPLEMENTED,
  REAL_MONEY_REVIEW_DOMAINS,
  assessRealMoneyReadiness,
  assessSipMigration,
  assertFeedContinuity,
  assertImmediateDeploymentBoundary,
  assertPaperBrokerAccountId,
  assertPaperOrderRequest,
  createFeedBridgePolicy,
  createFeedVersion,
  paperBrokerProvenance,
  publicFutureBoundary,
} from "./future-gates.js";

const hash = (letter) => letter.repeat(64);
const immediate = { ENVIRONMENT: "production-paper", TRADING_ENVIRONMENT: "paper",
  BROKER_ACCOUNT_CLASS: "paper", ALPACA_DATA_FEED: "iex", DATA_FEED_VERSION: IMMEDIATE_FEED_VERSION };

function feed(feedName, datasetLetter, createdAt = "2026-08-06T00:00:00Z") {
  return createFeedVersion({ provider: "alpaca", feed: feedName, revision: `${feedName}-v1`,
    dataset_hash: hash(datasetLetter), universe_hash: hash("c"), calendar_hash: hash("d"),
    timeframe: "5Min", adjustment: "all", session: "regular",
    range_start: "2023-08-01T00:00:00Z", range_end: "2026-08-01T00:00:00Z",
    symbol_count: 40, created_at: createdAt });
}

function sipEvidence() {
  const source = feed("iex", "a"), target = feed("sip", "b");
  const bridge = createFeedBridgePolicy({ source_feed_version_id: source.feed_version_id,
    target_feed_version_id: target.feed_version_id, committed_at: "2026-08-06T01:00:00Z",
    approved_by: "operator:admin", max_bridge_sessions: 10,
    required_checks: ["signal parity", "fill parity", "revision parity"] });
  return { source_feed: source, target_feed: target,
    backfill: { years: 3, symbols: 40, separate_storage: true },
    comparison: { started_at: "2026-08-06T02:00:00Z", unexplained_critical_differences: 0,
      bars: { measured: true }, volume: { measured: true }, signals: { measured: true },
      targets: { measured: true }, fill_model: { measured: true }, performance: { measured: true } },
    reruns: { development: true, sealed_validation: true, incubation: true,
      new_release_versions: 3, no_evidence_splice: true }, bridge_policy: bridge,
    operations: { consumer_decision: "polling", late_update_semantics_verified: true,
      revision_semantics_verified: true, projected_monthly_usd: 22, budget_limit_usd: 50,
      operator_labels_updated: true }, assessed_at: "2026-08-10T00:00:00Z" };
}

function liveEvidence() {
  const reviews = Object.fromEntries(REAL_MONEY_REVIEW_DOMAINS.map((domain, index) => [domain, {
    status: "passed", reviewer: `reviewer:${domain}:${index}`, artifact_hash: hash(String(index + 1)),
  }]));
  return { assessed_at: "2027-08-06T00:00:00Z",
    paper_evidence: { minimum_days: 180, completed_days: 220, market_regimes: 4,
      unresolved_critical_incidents: 0, account_reconciled: true }, reviews,
    resource_separation: { credentials: true, account: true, deployment: true, workspace: true,
      database: true, artifacts: true, queue: true, access_control: true, audit_retention: true },
    capital_policy: { initial_capital_usd: 500, user_approved_capital_usd: 1000,
      strategy_gross_limit: .001, portfolio_gross_limit: .02, manual_strategy_release: true },
    safety: { independent_kill_path: true, independent_flatten_path: true, kill_drill_passed: true,
      flatten_drill_passed: true, human_incident_runbook: true },
    execution_calibration: { matched_fills: 150, slippage_model_recalibrated: true,
      unexplained_fill_differences: 0 },
    change_management: { model_risk_policy: true, versioned_approvals: true,
      rollback_policy: true, emergency_change_policy: true },
    user_approval: { actor: "user:owner", artifact_hash: hash("e") } };
}

test("immediate deployment contract is IEX and paper only", () => {
  const boundary = assertImmediateDeploymentBoundary(immediate);
  assert.equal(boundary.feed, "iex"); assert.equal(boundary.broker_account_class, "paper");
  assert.equal(boundary.live_execution_implemented, false);
  assert.throws(() => assertImmediateDeploymentBoundary({ ...immediate, ALPACA_DATA_FEED: "sip" }), /pinned/);
  assert.throws(() => assertImmediateDeploymentBoundary({ ...immediate, TRADING_ENVIRONMENT: "live" }), /paper-only/);
  assert.throws(() => assertImmediateDeploymentBoundary({ ...immediate,
    ALPACA_TRADING_BASE_URL: "https://api.alpaca.markets" }), /forbidden/);
  assert.throws(() => assertImmediateDeploymentBoundary({ ...immediate, ENVIRONMENT: "production-live" }), /Unsupported/);
});

test("broker provenance and order requests cannot be relabeled live", () => {
  const provenance = paperBrokerProvenance(immediate);
  assert.equal(provenance.record_schema, "axiom.paper-broker.v1");
  assert.equal(assertPaperBrokerAccountId("alpaca-paper-secondary"), "alpaca-paper-secondary");
  assert.equal(assertPaperOrderRequest({ account_class: "paper", broker_account_id: "alpaca-paper-primary" }), true);
  assert.throws(() => assertPaperBrokerAccountId("alpaca-live-primary"), /paper account/);
  assert.throws(() => assertPaperOrderRequest({ account_class: "live", broker_account_id: "alpaca-paper-primary" }), /No live-order/);
});

test("feed versions and bridge policies are deterministic and immutable", () => {
  const one = feed("iex", "a"), two = feed("iex", "a");
  assert.deepEqual(one, two); assert.match(one.manifest_hash, /^[a-f0-9]{64}$/);
  assert.notEqual(feed("sip", "b").feed_version_id, one.feed_version_id);
  assert.throws(() => createFeedVersion({ feed: "sip", dataset_hash: "bad" }), /SHA-256/);
  assert.throws(() => createFeedBridgePolicy({ source_feed_version_id: one.feed_version_id,
    target_feed_version_id: one.feed_version_id }), /invalid/);
});

test("passing SIP evidence is non-activating and feed splices remain guarded", () => {
  const evidence = sipEvidence(), assessment = assessSipMigration(evidence);
  assert.equal(assessment.passed, true); assert.equal(assessment.activates_feed, false);
  assert.equal(assessment.decision, "ready_for_separate_sip_rollout");
  assert.equal(assertFeedContinuity({ validated_feed_version_id: evidence.source_feed.feed_version_id,
    monitoring_feed_version_id: evidence.source_feed.feed_version_id }), true);
  assert.throws(() => assertFeedContinuity({ validated_feed_version_id: evidence.source_feed.feed_version_id,
    monitoring_feed_version_id: evidence.target_feed.feed_version_id }), /splice blocked/);
  assert.equal(assertFeedContinuity({ validated_feed_version_id: evidence.source_feed.feed_version_id,
    monitoring_feed_version_id: evidence.target_feed.feed_version_id,
    bridge_policy: evidence.bridge_policy, migration_assessment: assessment }), true);
});

test("incomplete or retroactively committed SIP evidence stays blocked", () => {
  const evidence = sipEvidence(); evidence.bridge_policy = { ...evidence.bridge_policy,
    committed_at: "2026-08-07T00:00:00.000Z" };
  const assessment = assessSipMigration(evidence);
  assert.equal(assessment.passed, false);
  assert.equal(assessment.checks.find((item) => item.code === "bridge_precommitted").passed, false);
});

test("real-money prerequisites can be assessed but can never authorize orders", () => {
  const assessment = assessRealMoneyReadiness(liveEvidence());
  assert.equal(assessment.passed, true);
  assert.equal(assessment.decision, "ready_for_separate_live_design_review");
  assert.equal(assessment.authorizes_orders, false);
  assert.equal(assessment.live_execution_implemented, false);
  assert.equal(assessment.requires_separate_deployment, true);
  assert.equal(LIVE_EXECUTION_IMPLEMENTED, false);
});

test("missing reviews, loose limits, secrets, and incomplete evidence block safely", () => {
  const evidence = liveEvidence(); evidence.reviews.security.status = "pending";
  evidence.capital_policy.strategy_gross_limit = .005;
  const assessment = assessRealMoneyReadiness(evidence);
  assert.equal(assessment.passed, false);
  assert.equal(assessment.checks.find((item) => item.code === "independent_reviews").passed, false);
  assert.equal(assessment.checks.find((item) => item.code === "tighter_capital_limits").passed, false);
  assert.throws(() => assessRealMoneyReadiness({ ...liveEvidence(), api_secret: "do-not-store" }), /credentials/);
});

test("operator boundary summary exposes policy, never a browser switch", () => {
  const summary = publicFutureBoundary(immediate);
  assert.deepEqual(summary, { schema_version: 1, current_feed: "IEX",
    current_feed_version: IMMEDIATE_FEED_VERSION, account_class: "paper", trading_environment: "paper",
    sip_enabled: false, live_money_supported: false, browser_switch_available: false,
    future_assessments_authorize_changes: false });
});
