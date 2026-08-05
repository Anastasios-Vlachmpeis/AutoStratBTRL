import { hashCanonical } from "./dsl.js";
import { ensureOrchestrationState } from "./orchestration.js";
import { recordOperationalEvent } from "./observability.js";

export const RECOVERY_DRILLS = Object.freeze({
  cloudflare_timeout: { severity: "execution_blocked", scope: "scheduler", actions: ["retry_same_intent", "preserve_checkpoint"] },
  gcp_timeout: { severity: "research_degraded", scope: "backtester", actions: ["retry_same_job_id", "preserve_strategy_stage"] },
  alpaca_timeout: { severity: "execution_blocked", scope: "broker", actions: ["block_new_risk", "reconcile_broker"] },
  d1_quota_exhausted: { severity: "execution_blocked", scope: "storage", actions: ["pause_optional_research", "block_new_risk", "preserve_checkpoint"] },
  r2_quota_exhausted: { severity: "research_degraded", scope: "storage", actions: ["pause_optional_research", "preserve_existing_artifacts"] },
  queue_quota_exhausted: { severity: "research_degraded", scope: "queue", actions: ["pause_optional_research", "retain_outbox"] },
  stale_callback: { severity: "research_degraded", scope: "backtester", actions: ["reject_callback", "preserve_strategy_stage"] },
  corrupt_artifact: { severity: "execution_blocked", scope: "storage", actions: ["reject_artifact", "block_dependent_transition"] },
  market_data_gap: { severity: "execution_blocked", scope: "market_data", actions: ["block_new_risk", "exclude_invalid_session"] },
  broker_divergence: { severity: "critical_risk", scope: "broker", actions: ["cancel_managed_orders", "flatten_managed_positions", "verify_flat"] },
  region_outage: { severity: "execution_blocked", scope: "storage", actions: ["restore_immutable_checkpoint", "replay_idempotent_outbox", "reconcile_broker"] },
});

export function recoveryDrill(state, { kind, correlation_id, at = new Date().toISOString(), details = {} } = {}) {
  const policy = RECOVERY_DRILLS[kind];
  if (!policy || !correlation_id) throw new TypeError("Recovery drill requires a known failure and correlation ID");
  const orchestration = ensureOrchestrationState(state, state.orchestration?.mode);
  orchestration.recovery_drills ??= {};
  const incidentId = `DRILL-${hashCanonical({ kind, correlation_id }).slice(0, 32)}`;
  const prior = orchestration.recovery_drills[incidentId];
  if (prior) return { ...prior, duplicate: true };
  if (policy.actions.includes("pause_optional_research")) orchestration.controls.research_paused = true;
  if (policy.actions.includes("block_new_risk")) orchestration.controls.execution_paused = true;
  if (policy.actions.includes("flatten_managed_positions")) {
    orchestration.controls.entries_paused = true; orchestration.controls.flatten_requested = true;
  }
  const result = { incident_id: incidentId, kind, correlation_id, severity: policy.severity,
    subsystem: policy.scope, actions: [...policy.actions], opened_at: new Date(at).toISOString(),
    quality_state_changed: false, duplicate: false };
  orchestration.recovery_drills[incidentId] = result;
  orchestration.recovery_drills = Object.fromEntries(Object.entries(orchestration.recovery_drills).slice(-256));
  orchestration.incidents.push({ ...result, details }); orchestration.incidents = orchestration.incidents.slice(-512);
  recordOperationalEvent(state, { at, subsystem: policy.scope, severity: policy.severity,
    code: kind, message: `Recovery drill selected: ${policy.actions.join(", ")}`, correlation_id, details });
  return result;
}
