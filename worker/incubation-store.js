import { hashCanonical } from "./dsl.js";

const json = (value) => JSON.stringify(value ?? {});
const id = (prefix, value) => `${prefix}-${hashCanonical(value).slice(0, 48)}`;

/** Normalized, idempotent incubation evidence journal. The Durable Object is
 * the coordinator; D1 is the replay/audit ledger. */
export class IncubationStore {
  constructor(db, { clock = () => new Date() } = {}) {
    if (!db) throw new Error("AXIOM_DB is required for incubation persistence");
    this.db = db; this.clock = clock;
  }
  now() { return this.clock().toISOString(); }
  statement(sql, ...values) { return this.db.prepare(sql).bind(...values); }
  async batch(statements) { return statements.length ? this.db.batch(statements) : []; }
  policyVersionId(evidence) { return `incubation-policy-${evidence.policy_hash.slice(0, 40)}`; }

  async persistEvidence({ workspaceId, strategy }) {
    const evidence = strategy?.incubation;
    if (!workspaceId || !strategy?.id || !evidence?.incubation_id) throw new Error("Complete incubation evidence is required");
    const now = this.now(), policyVersionId = this.policyVersionId(evidence);
    const statements = [
      this.statement(`INSERT INTO workspaces
        (workspace_id,display_name,environment,status,created_at,updated_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(workspace_id) DO UPDATE SET updated_at=excluded.updated_at`,
      workspaceId, workspaceId, "development", "active", evidence.started_at, now),
      this.statement(`INSERT INTO supervisor_policy_versions
        (workspace_id,policy_version_id,schema_version,policy_json,policy_hash,effective_from,created_at,approved_by)
        VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,policy_hash) DO NOTHING`,
      workspaceId, policyVersionId, 1, json(evidence.policy), evidence.policy_hash,
      evidence.started_at, evidence.started_at, "system:frozen-incubation"),
      this.statement(`INSERT INTO incubations
        (workspace_id,incubation_id,strategy_id,policy_version_id,started_at,minimum_completed_trades,
         minimum_trading_days,maximum_trading_days,status,completed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,incubation_id) DO UPDATE SET
        status=excluded.status,completed_at=COALESCE(incubations.completed_at,excluded.completed_at)`,
      workspaceId, evidence.incubation_id, strategy.id, policyVersionId, evidence.started_at,
      evidence.policy.progress.minimum_eligible_trades, evidence.policy.progress.minimum_valid_days,
      evidence.policy.progress.maximum_valid_days, evidence.status,
      ["released_paper", "incubation_reject", "incubation_rework"].includes(evidence.status) ? now : null),
    ];
    for (const day of Object.values(evidence.sessions ?? {}).filter((item) => item.completed)) {
      const dayId = id("incubation-day", { evidence: evidence.incubation_id, date: day.session_date });
      statements.push(this.statement(`INSERT INTO incubation_days
        (workspace_id,incubation_day_id,incubation_id,session_date,eligible,coverage,critical_faults,
         metrics_json,evidence_artifact_id,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(workspace_id,incubation_id,session_date) DO UPDATE SET
        eligible=excluded.eligible,coverage=excluded.coverage,critical_faults=excluded.critical_faults,
        metrics_json=excluded.metrics_json,recorded_at=excluded.recorded_at`,
      workspaceId, dayId, evidence.incubation_id, day.session_date, day.valid ? 1 : 0,
      Number(day.coverage), day.critical_faults?.length ?? 0, json(day), null, now));
    }
    const validDays = new Set(Object.values(evidence.sessions ?? {}).filter((item) => item.completed && item.valid)
      .map((item) => item.session_date));
    for (const trade of (evidence.closed_trade_ledger ?? []).filter((item) => item.eligible !== false
      && validDays.has(item.session_date))) {
      const tradeId = id("incubation-trade", { incubation: evidence.incubation_id, trade_key: trade.trade_key });
      statements.push(this.statement(`INSERT INTO incubation_trades
        (workspace_id,incubation_trade_id,incubation_id,trade_key,symbol,side,opened_at,closed_at,
         quantity,realized_pnl,evidence_artifact_id,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(workspace_id,incubation_id,trade_key) DO NOTHING`,
      workspaceId, tradeId, evidence.incubation_id, trade.trade_key, trade.symbol, trade.direction,
      trade.entry_at, trade.exit_at, Math.max(1e-12, Math.abs(Number(trade.signed_units))),
      Number(trade.pnl), null, now));
    }
    for (const finding of evidence.critical_faults ?? []) {
      const incidentId = id("incident-incubation", { incubation: evidence.incubation_id,
        code: finding.code, event_id: finding.event_id, symbol: finding.symbol ?? null });
      statements.push(this.statement(`INSERT INTO incidents
        (workspace_id,incident_id,strategy_id,severity,incident_kind,status,details_json,
         evidence_artifact_id,opened_at,acknowledged_at,resolved_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,incident_id) DO NOTHING`,
      workspaceId, incidentId, strategy.id, "critical", "incubation_fault", "open",
      json(finding), null, finding.at ?? now, null, null));
    }
    await this.batch(statements);
    return { incubationId: evidence.incubation_id, policyVersionId, status: evidence.status };
  }

  async persistRelease({ workspaceId, strategy, decisionArtifactId, releasedAt = this.now() }) {
    const evidence = strategy?.incubation;
    if (!workspaceId || !evidence?.decision?.decision_id || !decisionArtifactId) {
      throw new Error("Verified incubation release evidence is required");
    }
    const releaseId = id("release", { strategy_id: strategy.id,
      decision_id: evidence.decision.decision_id, mode: "paper" });
    const policyVersionId = this.policyVersionId(evidence);
    await this.batch([
      this.statement(`UPDATE incubations SET status='released_paper',completed_at=COALESCE(completed_at,?)
        WHERE workspace_id=? AND incubation_id=?`, releasedAt, workspaceId, evidence.incubation_id),
      this.statement(`INSERT INTO releases
        (workspace_id,release_id,strategy_id,policy_version_id,decision_artifact_id,release_mode,status,released_at,ended_at)
        VALUES (?,?,?,?,?,'paper','active',?,?) ON CONFLICT(workspace_id,release_id) DO NOTHING`,
      workspaceId, releaseId, strategy.id, policyVersionId, decisionArtifactId, releasedAt, null),
    ]);
    return { releaseId, policyVersionId };
  }
}
