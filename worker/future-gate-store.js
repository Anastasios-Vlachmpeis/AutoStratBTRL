import { hashCanonical } from "./dsl.js";

const HASH = /^[a-f0-9]{64}$/;
const id = (prefix, value) => `${prefix}-${hashCanonical(value).slice(0, 48)}`;

/**
 * Stores only immutable identities, decisions, and optional artifact links.
 * Detailed review evidence belongs in the private artifact repository; no
 * credentials, raw bars, or live account identifiers are accepted here.
 */
export class FutureGateStore {
  constructor(db, { clock = () => new Date() } = {}) {
    if (!db) throw new Error("AXIOM_DB is required for future-gate persistence");
    this.db = db; this.clock = clock;
  }

  now() { return this.clock().toISOString(); }
  statement(sql, ...values) { return this.db.prepare(sql).bind(...values); }
  async batch(statements) { return statements.length ? this.db.batch(statements) : []; }

  workspace(workspaceId, at) {
    if (!workspaceId) throw new TypeError("workspaceId is required");
    return this.statement(`INSERT INTO workspaces
      (workspace_id,display_name,environment,status,created_at,updated_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(workspace_id) DO UPDATE SET updated_at=excluded.updated_at`,
    workspaceId, workspaceId, "development", "active", at, at);
  }

  async persistFeedVersion({ workspaceId, feedVersion }) {
    if (!feedVersion || !HASH.test(String(feedVersion.manifest_hash ?? ""))) throw new TypeError("Verified feed version is required");
    const at = this.now();
    await this.batch([this.workspace(workspaceId, at), this.statement(`INSERT INTO feed_versions
      (workspace_id,feed_version_id,provider,feed,revision,dataset_hash,universe_hash,calendar_hash,
       manifest_hash,timeframe,adjustment,session,range_start,range_end,symbol_count,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,feed_version_id) DO NOTHING`,
    workspaceId, feedVersion.feed_version_id, feedVersion.provider, feedVersion.feed, feedVersion.revision,
    feedVersion.dataset_hash, feedVersion.universe_hash, feedVersion.calendar_hash, feedVersion.manifest_hash,
    feedVersion.timeframe, feedVersion.adjustment, feedVersion.session, feedVersion.range_start,
    feedVersion.range_end, feedVersion.symbol_count, feedVersion.created_at)]);
    return { feed_version_id: feedVersion.feed_version_id, manifest_hash: feedVersion.manifest_hash };
  }

  async persistSipAssessment({ workspaceId, assessment, evidenceArtifactId = null }) {
    if (!assessment || !HASH.test(String(assessment.assessment_hash ?? ""))
        || assessment.activates_feed !== false) throw new TypeError("Non-activating SIP assessment is required");
    const assessmentId = id("sip-assessment", { workspaceId, hash: assessment.assessment_hash });
    await this.statement(`INSERT INTO sip_migration_assessments
      (workspace_id,assessment_id,source_feed_version_id,target_feed_version_id,assessment_hash,
       decision,passed,activates_feed,evidence_artifact_id,assessed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,assessment_id) DO NOTHING`,
    workspaceId, assessmentId, assessment.source_feed_version_id, assessment.target_feed_version_id,
    assessment.assessment_hash, assessment.decision, assessment.passed ? 1 : 0, 0,
    evidenceArtifactId, assessment.assessed_at).run();
    return { assessment_id: assessmentId, decision: assessment.decision, activates_feed: false };
  }

  async persistRealMoneyAssessment({ workspaceId, assessment, evidenceArtifactId = null }) {
    if (!assessment || !HASH.test(String(assessment.assessment_hash ?? ""))
        || assessment.authorizes_orders !== false || assessment.live_execution_implemented !== false
        || assessment.requires_separate_deployment !== true) {
      throw new TypeError("Evidence-only real-money assessment is required");
    }
    const assessmentId = id("capital-assessment", { workspaceId, hash: assessment.assessment_hash });
    await this.statement(`INSERT INTO real_money_readiness_assessments
      (workspace_id,assessment_id,assessment_hash,decision,passed,live_execution_implemented,
       authorizes_orders,requires_separate_deployment,evidence_artifact_id,assessed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,assessment_id) DO NOTHING`,
    workspaceId, assessmentId, assessment.assessment_hash, assessment.decision, assessment.passed ? 1 : 0,
    0, 0, 1, evidenceArtifactId, assessment.assessed_at).run();
    return { assessment_id: assessmentId, decision: assessment.decision,
      authorizes_orders: false, requires_separate_deployment: true };
  }
}
