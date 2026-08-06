import { hashCanonical } from "./dsl.js";

export const IMMEDIATE_FEED = "iex";
export const IMMEDIATE_FEED_VERSION = "alpaca-iex-5min-adjusted-v1";
export const IMMEDIATE_ACCOUNT_CLASS = "paper";
export const PAPER_BROKER_ACCOUNT_ID = "alpaca-paper-primary";
export const LIVE_EXECUTION_IMPLEMENTED = false;

const HASH = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const IMMEDIATE_ENVIRONMENTS = new Set(["local", "development", "staging", "production-paper"]);
const FEEDS = new Set(["iex", "sip"]);
const SECRET_KEY = /(secret|password|authorization|token|api[_-]?key|credential|private[_-]?key)/i;
const LIVE_CONFIGURATION_KEYS = Object.freeze([
  "ALPACA_LIVE_API_KEY", "ALPACA_LIVE_API_SECRET", "ALPACA_LIVE_BASE_URL",
  "ALPACA_TRADING_BASE_URL", "LIVE_TRADING_ENABLED", "REAL_MONEY_TRADING_ENABLED",
]);

export const REAL_MONEY_REVIEW_DOMAINS = Object.freeze([
  "security", "execution", "risk", "accounting", "legal_tax", "broker", "disaster_recovery",
]);

const lower = (value, fallback = "") => String(value ?? fallback).trim().toLowerCase();
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const truth = (value) => value === true;
const isHash = (value) => HASH.test(String(value ?? ""));
const iso = (value) => {
  const result = new Date(value);
  if (Number.isNaN(result.getTime())) throw new TypeError("Timestamp is invalid");
  return result.toISOString();
};
const atOrBefore = (left, right) => {
  try { return iso(left) <= iso(right); } catch { return false; }
};

function safePlainEvidence(value, label = "evidence") {
  const visit = (item, depth = 0) => {
    if (depth > 8) throw new TypeError(`${label} is too deeply nested`);
    if (item == null || ["string", "boolean"].includes(typeof item)) return;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new TypeError(`${label} contains a non-finite number`);
      return;
    }
    if (Array.isArray(item)) {
      if (item.length > 200) throw new TypeError(`${label} contains an oversized array`);
      item.forEach((entry) => visit(entry, depth + 1));
      return;
    }
    if (typeof item !== "object" || Object.getPrototypeOf(item) !== Object.prototype) {
      throw new TypeError(`${label} must contain plain data only`);
    }
    for (const [key, entry] of Object.entries(item)) {
      if (SECRET_KEY.test(key) && typeof entry !== "boolean") throw new TypeError(`${label} cannot contain credentials`);
      visit(entry, depth + 1);
    }
  };
  visit(value);
  if (JSON.stringify(value).length > 32_768) throw new TypeError(`${label} exceeds 32 KiB`);
  return structuredClone(value);
}

/**
 * The currently deployable application is deliberately unable to select SIP
 * or a live brokerage endpoint. A future migration receives a separate
 * deployment contract rather than weakening this one.
 */
export function assertImmediateDeploymentBoundary(env = {}) {
  const environment = lower(env.ENVIRONMENT, "development");
  const tradingEnvironment = lower(env.TRADING_ENVIRONMENT, IMMEDIATE_ACCOUNT_CLASS);
  const accountClass = lower(env.BROKER_ACCOUNT_CLASS, IMMEDIATE_ACCOUNT_CLASS);
  const feed = lower(env.ALPACA_DATA_FEED, IMMEDIATE_FEED);
  const feedVersion = String(env.DATA_FEED_VERSION ?? IMMEDIATE_FEED_VERSION);
  if (!IMMEDIATE_ENVIRONMENTS.has(environment)) throw new Error(`Unsupported immediate environment: ${environment}`);
  if (tradingEnvironment !== IMMEDIATE_ACCOUNT_CLASS || accountClass !== IMMEDIATE_ACCOUNT_CLASS) {
    throw new Error("This build is paper-only; real-money trading requires a separate reviewed deployment");
  }
  if (feed !== IMMEDIATE_FEED || feedVersion !== IMMEDIATE_FEED_VERSION) {
    throw new Error("This build is pinned to versioned Alpaca IEX data; SIP requires a separate migration");
  }
  for (const key of LIVE_CONFIGURATION_KEYS) {
    if (env[key] != null && String(env[key]).trim() !== "" && lower(env[key]) !== "false") {
      throw new Error(`Live configuration is forbidden in this deployment: ${key}`);
    }
  }
  return Object.freeze({ environment, trading_environment: IMMEDIATE_ACCOUNT_CLASS,
    broker_account_class: IMMEDIATE_ACCOUNT_CLASS, feed: IMMEDIATE_FEED,
    feed_version: IMMEDIATE_FEED_VERSION, live_execution_implemented: LIVE_EXECUTION_IMPLEMENTED });
}

export function assertPaperBrokerAccountId(accountId) {
  const value = String(accountId ?? "");
  if (!SAFE_ID.test(value) || !value.startsWith("alpaca-paper-") || value.includes("live")) {
    throw new Error("Broker records in this deployment require an Alpaca paper account identity");
  }
  return value;
}

export function paperBrokerProvenance(env = {}, accountId = PAPER_BROKER_ACCOUNT_ID) {
  const boundary = assertImmediateDeploymentBoundary(env);
  return Object.freeze({ provider: "alpaca", broker_account_id: assertPaperBrokerAccountId(accountId),
    account_class: boundary.broker_account_class, trading_environment: boundary.trading_environment,
    data_feed: boundary.feed, data_feed_version: boundary.feed_version,
    endpoint_class: "alpaca_paper_api", record_schema: "axiom.paper-broker.v1" });
}

export function assertPaperOrderRequest(request = {}) {
  const requested = lower(request.account_class ?? request.trading_environment, IMMEDIATE_ACCOUNT_CLASS);
  if (requested !== IMMEDIATE_ACCOUNT_CLASS || request.live === true || request.real_money === true) {
    throw new Error("No live-order adapter exists in this build");
  }
  assertPaperBrokerAccountId(request.broker_account_id ?? PAPER_BROKER_ACCOUNT_ID);
  return true;
}

export function createFeedVersion(input = {}) {
  const feed = lower(input.feed);
  if (!FEEDS.has(feed) || lower(input.provider, "alpaca") !== "alpaca") throw new TypeError("Feed identity is invalid");
  for (const [label, value] of [["dataset_hash", input.dataset_hash], ["universe_hash", input.universe_hash],
    ["calendar_hash", input.calendar_hash]]) if (!isHash(value)) throw new TypeError(`${label} must be SHA-256`);
  const manifest = { schema_version: 1, provider: "alpaca", feed, revision: String(input.revision ?? ""),
    dataset_hash: input.dataset_hash, universe_hash: input.universe_hash, calendar_hash: input.calendar_hash,
    timeframe: String(input.timeframe ?? "5Min"), adjustment: String(input.adjustment ?? "all"),
    session: String(input.session ?? "regular"), range_start: iso(input.range_start), range_end: iso(input.range_end),
    symbol_count: Math.trunc(finite(input.symbol_count)), created_at: iso(input.created_at) };
  if (!manifest.revision || manifest.range_start >= manifest.range_end || manifest.symbol_count < 1) {
    throw new TypeError("Feed version range, revision, or symbol count is invalid");
  }
  manifest.manifest_hash = hashCanonical(manifest);
  manifest.feed_version_id = `feed-${feed}-${manifest.manifest_hash.slice(0, 40)}`;
  return Object.freeze(manifest);
}

export function createFeedBridgePolicy(input = {}) {
  if (!SAFE_ID.test(String(input.source_feed_version_id ?? "")) || !SAFE_ID.test(String(input.target_feed_version_id ?? ""))
      || input.source_feed_version_id === input.target_feed_version_id) throw new TypeError("Bridge feed versions are invalid");
  const policy = { schema_version: 1, source_feed_version_id: input.source_feed_version_id,
    target_feed_version_id: input.target_feed_version_id, committed_at: iso(input.committed_at),
    approved_by: String(input.approved_by ?? ""), max_bridge_sessions: Math.trunc(finite(input.max_bridge_sessions)),
    required_checks: [...new Set((input.required_checks ?? []).map(String))].sort() };
  if (!/^operator:[A-Za-z0-9._:@-]+$/.test(policy.approved_by) || policy.max_bridge_sessions < 1
      || !policy.required_checks.length) throw new TypeError("Bridge policy requires an operator, duration, and checks");
  policy.policy_hash = hashCanonical(policy);
  policy.bridge_policy_id = `bridge-${policy.policy_hash.slice(0, 40)}`;
  return Object.freeze(policy);
}

const check = (code, passed, detail) => ({ code, passed: Boolean(passed), detail });

/** Evidence-only assessment. It creates no feed switch and mutates no strategy. */
export function assessSipMigration(input = {}) {
  const source = input.source_feed, target = input.target_feed;
  if (source?.feed !== "iex" || target?.feed !== "sip") throw new TypeError("SIP migration must compare IEX to SIP");
  const evidence = safePlainEvidence(input, "SIP migration evidence");
  const comparison = evidence.comparison ?? {}, reruns = evidence.reruns ?? {}, operations = evidence.operations ?? {};
  const policy = evidence.bridge_policy;
  const dimensions = ["bars", "volume", "signals", "targets", "fill_model", "performance"];
  const checks = [
    check("separate_versioned_dataset", source.dataset_hash !== target.dataset_hash
      && source.universe_hash === target.universe_hash && source.calendar_hash === target.calendar_hash,
    "IEX and SIP must be separate datasets over the same universe and calendar"),
    check("three_year_backfill", finite(evidence.backfill?.years) >= 3 && finite(evidence.backfill?.symbols) >= 40
      && truth(evidence.backfill?.separate_storage), "SIP needs a separate 3-year, 40-symbol backfill"),
    check("all_difference_dimensions_measured", dimensions.every((name) => comparison[name]?.measured === true)
      && finite(comparison.unexplained_critical_differences) === 0, "Bar through performance differences must be measured"),
    check("strategy_evidence_rerun", truth(reruns.development) && truth(reruns.sealed_validation)
      && truth(reruns.incubation) && finite(reruns.new_release_versions) >= 1 && truth(reruns.no_evidence_splice),
    "Development, validation, and incubation must be rerun as new SIP releases"),
    check("bridge_precommitted", policy?.source_feed_version_id === source.feed_version_id
      && policy?.target_feed_version_id === target.feed_version_id
      && isHash(policy?.policy_hash) && atOrBefore(policy?.committed_at, comparison.started_at),
    "Any temporary bridge policy must predate comparison"),
    check("revision_semantics", ["polling", "websocket"].includes(operations.consumer_decision)
      && truth(operations.late_update_semantics_verified) && truth(operations.revision_semantics_verified),
    "Consumer choice must preserve late-update and revision behavior"),
    check("cost_and_labels", finite(operations.projected_monthly_usd, Infinity) < finite(operations.budget_limit_usd, 50)
      && finite(operations.budget_limit_usd, 50) <= 50 && truth(operations.operator_labels_updated),
    "Recalculate cost and visibly label the active feed"),
  ];
  const passed = checks.every((item) => item.passed);
  const core = { schema_version: 1, kind: "sip_migration_assessment", source_feed_version_id: source.feed_version_id,
    target_feed_version_id: target.feed_version_id, assessed_at: iso(evidence.assessed_at), checks, passed,
    decision: passed ? "ready_for_separate_sip_rollout" : "blocked", activates_feed: false };
  return Object.freeze({ ...core, assessment_hash: hashCanonical(core) });
}

export function assertFeedContinuity({ validated_feed_version_id, monitoring_feed_version_id,
  bridge_policy, migration_assessment } = {}) {
  if (validated_feed_version_id === monitoring_feed_version_id && SAFE_ID.test(String(validated_feed_version_id ?? ""))) return true;
  const validBridge = bridge_policy?.source_feed_version_id === validated_feed_version_id
    && bridge_policy?.target_feed_version_id === monitoring_feed_version_id && isHash(bridge_policy?.policy_hash)
    && migration_assessment?.passed === true && migration_assessment?.activates_feed === false
    && migration_assessment?.source_feed_version_id === validated_feed_version_id
    && migration_assessment?.target_feed_version_id === monitoring_feed_version_id;
  if (!validBridge) throw new Error("Feed splice blocked: strategy evidence and monitoring feed do not match");
  return true;
}

/**
 * Evidence-only assessment. Even a passing result is not an order
 * authorization and cannot alter deployment variables or broker routing.
 */
export function assessRealMoneyReadiness(input = {}) {
  const evidence = safePlainEvidence(input, "Real-money readiness evidence");
  const paper = evidence.paper_evidence ?? {}, separation = evidence.resource_separation ?? {};
  const capital = evidence.capital_policy ?? {}, safety = evidence.safety ?? {};
  const reviews = evidence.reviews ?? {};
  const reviewRows = REAL_MONEY_REVIEW_DOMAINS.map((domain) => reviews[domain]);
  const reviewers = reviewRows.map((item) => item?.reviewer).filter(Boolean);
  const checks = [
    check("sustained_paper_evidence", finite(paper.minimum_days) > 0
      && finite(paper.completed_days) >= finite(paper.minimum_days) && finite(paper.market_regimes) >= 3
      && finite(paper.unresolved_critical_incidents) === 0 && truth(paper.account_reconciled),
    "Paper duration is user-approved and spans multiple regimes"),
    check("independent_reviews", reviewRows.every((item) => item?.status === "passed" && isHash(item?.artifact_hash))
      && new Set(reviewers).size === REAL_MONEY_REVIEW_DOMAINS.length,
    "Security, execution, risk, accounting, legal/tax, broker, and recovery reviews must be independent"),
    check("isolated_live_resources", ["credentials", "account", "deployment", "workspace", "database", "artifacts",
      "queue", "access_control", "audit_retention"].every((key) => separation[key] === true),
    "A future live system must use fully separate secrets and resources"),
    check("tighter_capital_limits", finite(capital.initial_capital_usd) > 0
      && finite(capital.initial_capital_usd) <= finite(capital.user_approved_capital_usd)
      && finite(capital.strategy_gross_limit) > 0 && finite(capital.strategy_gross_limit) <= .001
      && finite(capital.portfolio_gross_limit) > 0 && finite(capital.portfolio_gross_limit) <= .02
      && truth(capital.manual_strategy_release), "Initial live capital and risk limits must be materially below paper limits"),
    check("independent_kill_and_incidents", truth(safety.independent_kill_path) && truth(safety.independent_flatten_path)
      && truth(safety.kill_drill_passed) && truth(safety.flatten_drill_passed) && truth(safety.human_incident_runbook),
    "Live kill, flatten, and human incident procedures require independent drills"),
    check("execution_calibration", finite(evidence.execution_calibration?.matched_fills) >= 100
      && truth(evidence.execution_calibration?.slippage_model_recalibrated)
      && finite(evidence.execution_calibration?.unexplained_fill_differences) === 0,
    "Paper and realistic live fill assumptions require calibrated evidence"),
    check("model_change_control", truth(evidence.change_management?.model_risk_policy)
      && truth(evidence.change_management?.versioned_approvals) && truth(evidence.change_management?.rollback_policy)
      && truth(evidence.change_management?.emergency_change_policy), "Formal model-risk and change control is mandatory"),
    check("explicit_user_approval", isHash(evidence.user_approval?.artifact_hash)
      && /^user:[A-Za-z0-9._:@-]+$/.test(String(evidence.user_approval?.actor ?? "")),
    "A separate explicit user approval artifact is required"),
  ];
  const passed = checks.every((item) => item.passed);
  const core = { schema_version: 1, kind: "real_money_readiness_assessment",
    assessed_at: iso(evidence.assessed_at), checks, passed,
    decision: passed ? "ready_for_separate_live_design_review" : "blocked",
    live_execution_implemented: LIVE_EXECUTION_IMPLEMENTED, authorizes_orders: false,
    requires_separate_deployment: true };
  return Object.freeze({ ...core, assessment_hash: hashCanonical(core) });
}

export function publicFutureBoundary(env = {}) {
  const boundary = assertImmediateDeploymentBoundary(env);
  return Object.freeze({ schema_version: 1, current_feed: boundary.feed.toUpperCase(),
    current_feed_version: boundary.feed_version, account_class: boundary.broker_account_class,
    trading_environment: boundary.trading_environment, sip_enabled: false, live_money_supported: false,
    browser_switch_available: false, future_assessments_authorize_changes: false });
}
