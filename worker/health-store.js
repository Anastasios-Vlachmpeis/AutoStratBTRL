import { hashCanonical } from "./dsl.js";

const json = (value) => JSON.stringify(value ?? {});
const id = (prefix, value) => `${prefix}-${hashCanonical(value).slice(0, 48)}`;

/** Idempotent D1 journal for per-event health observations, daily decisions,
 * risk overlays, and operational incidents. */
export class HealthStore {
  constructor(db, { clock = () => new Date() } = {}) {
    if (!db) throw new Error("AXIOM_DB is required for health persistence");
    this.db = db; this.clock = clock;
  }
  now() { return this.clock().toISOString(); }
  statement(sql, ...values) { return this.db.prepare(sql).bind(...values); }
  async batch(statements) { return statements.length ? this.db.batch(statements) : []; }
  policyVersionId(evidence) { return `health-policy-${evidence.policy_hash.slice(0, 40)}`; }

  async persistPolicy({ workspaceId, evidence }) {
    const at = evidence.started_at ?? this.now(), policyVersionId = this.policyVersionId(evidence);
    await this.batch([
      this.statement(`INSERT INTO workspaces
        (workspace_id,display_name,environment,status,created_at,updated_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(workspace_id) DO UPDATE SET updated_at=excluded.updated_at`,
      workspaceId, workspaceId, "development", "active", at, this.now()),
      this.statement(`INSERT INTO supervisor_policy_versions
        (workspace_id,policy_version_id,schema_version,policy_json,policy_hash,effective_from,created_at,approved_by)
        VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,policy_hash) DO NOTHING`,
      workspaceId, policyVersionId, 1, json(evidence.policy), evidence.policy_hash,
      at, at, "system:frozen-release-health"),
    ]);
    return policyVersionId;
  }

  async persistObservation({ workspaceId, strategy, observation }) {
    const evidence = strategy.health, policyVersionId = await this.persistPolicy({ workspaceId, evidence });
    const observedAt = observation.observed_at ?? this.now();
    const identity = { release_id: evidence.release_id, event_id: observation.event_id,
      strategy_id: strategy.id, kind: "bar" };
    await this.batch([this.statement(`INSERT INTO strategy_health
      (workspace_id,strategy_health_id,strategy_id,release_id,bar_event_id,health_state,
       metrics_json,reason_codes_json,policy_version_id,evidence_artifact_id,observed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,strategy_health_id) DO NOTHING`,
    workspaceId, id("health", identity), strategy.id, strategy.release_id ?? null, null,
    evidence.status, json(observation), json([...observation.hard_findings, ...observation.operational_findings]),
    policyVersionId, null, observedAt)]);
    return { policyVersionId, observationId: id("health", identity) };
  }

  async persistDecision({ workspaceId, strategy, decision, artifactId = null,
    observedAt = this.now(), actor = "system" }) {
    const evidence = strategy.health, policyVersionId = await this.persistPolicy({ workspaceId, evidence });
    const identity = { release_id: evidence.release_id, decision_id: decision.decision_id, strategy_id: strategy.id };
    // The schema permits one health record per strategy/timestamp. An immediate
    // decision is causally after its observation, so persist it one millisecond later.
    const decisionObservedAt = new Date(new Date(observedAt).getTime() + 1).toISOString();
    const statements = [this.statement(`INSERT INTO strategy_health
      (workspace_id,strategy_health_id,strategy_id,release_id,bar_event_id,health_state,
       metrics_json,reason_codes_json,policy_version_id,evidence_artifact_id,observed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,strategy_health_id) DO NOTHING`,
    workspaceId, id("health-decision", identity), strategy.id, strategy.release_id ?? null, null,
    decision.quality_outcome, json(decision.summary), json(decision.findings), policyVersionId,
    artifactId, decisionObservedAt)];
    const multiplier = Number(strategy.risk_overlay?.effective_multiplier ?? 1);
    const overlayIdentity = { decision_id: decision.decision_id, multiplier };
    statements.push(this.statement(`INSERT INTO risk_actions
      (workspace_id,risk_action_id,strategy_id,release_id,action_kind,scope_kind,scope_id,
       reason_code,target_json,idempotency_key,evidence_artifact_id,actor,decided_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,idempotency_key) DO NOTHING`,
    workspaceId, id("risk-health", overlayIdentity), strategy.id, strategy.release_id ?? null,
    "health_overlay", "strategy", strategy.id, decision.findings[0] ?? decision.quality_outcome,
    json(strategy.risk_overlay), hashCanonical(overlayIdentity), artifactId, actor, decisionObservedAt));
    for (const finding of evidence.operational_findings ?? []) {
      const incidentIdentity = { release_id: evidence.release_id, code: finding.code,
        event_id: finding.event_id, symbol: finding.symbol ?? null };
      statements.push(this.statement(`INSERT INTO incidents
        (workspace_id,incident_id,strategy_id,severity,incident_kind,status,details_json,
         evidence_artifact_id,opened_at,acknowledged_at,resolved_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,incident_id) DO NOTHING`,
      workspaceId, id("incident-health", incidentIdentity), strategy.id, "critical",
      "release_operational_block", "open", json(finding), artifactId, finding.at ?? decisionObservedAt, null, null));
    }
    await this.batch(statements);
    return { policyVersionId, decisionId: id("health-decision", identity) };
  }

  async persistRetirement({ workspaceId, strategy, reason, endedAt = this.now(), actor = "system" }) {
    if (!strategy?.release_id) return { updated: false };
    const identity = { release_id: strategy.release_id, strategy_id: strategy.id, reason };
    await this.batch([
      this.statement(`UPDATE releases SET status='retired',ended_at=COALESCE(ended_at,?)
        WHERE workspace_id=? AND release_id=?`, endedAt, workspaceId, strategy.release_id),
      this.statement(`INSERT INTO risk_actions
        (workspace_id,risk_action_id,strategy_id,release_id,action_kind,scope_kind,scope_id,
         reason_code,target_json,idempotency_key,evidence_artifact_id,actor,decided_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,idempotency_key) DO NOTHING`,
      workspaceId, id("risk-retire", identity), strategy.id, strategy.release_id, "retire",
      "strategy", strategy.id, reason, json({ multiplier: 0 }), hashCanonical(identity),
      null, actor, endedAt),
    ]);
    return { updated: true };
  }

  async resolveOperationalIncidents({ workspaceId, strategy, resolvedAt = this.now() }) {
    await this.batch([this.statement(`UPDATE incidents SET status='resolved',resolved_at=COALESCE(resolved_at,?)
      WHERE workspace_id=? AND strategy_id=? AND incident_kind='release_operational_block'
        AND status!='resolved'`, resolvedAt, workspaceId, strategy.id)]);
    return { resolved: true };
  }

  async persistPortfolioOverlay({ workspaceId, strategy, sessionDate, overlay, decidedAt = this.now() }) {
    const identity = { strategy_id: strategy.id, session_date: sessionDate,
      multiplier: overlay.multiplier, reasons: overlay.reason_codes };
    await this.batch([this.statement(`INSERT INTO risk_actions
      (workspace_id,risk_action_id,strategy_id,release_id,action_kind,scope_kind,scope_id,
       reason_code,target_json,idempotency_key,evidence_artifact_id,actor,decided_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,idempotency_key) DO NOTHING`,
    workspaceId, id("risk-portfolio-health", identity), strategy.id, strategy.release_id ?? null,
    "portfolio_overlay", "strategy", strategy.id, overlay.reason_codes[0] ?? "portfolio_clear",
    json(overlay), hashCanonical(identity), null, "system", decidedAt)]);
    return { riskActionId: id("risk-portfolio-health", identity) };
  }
}
