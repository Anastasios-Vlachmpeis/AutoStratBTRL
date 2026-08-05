import { hashCanonical } from "./dsl.js";

export const ORCHESTRATION_SCHEMA_VERSION = 1;
export const ORCHESTRATION_MODES = Object.freeze(["observe", "autonomous"]);

export const ROUTINE_COMMANDS = Object.freeze([
  "session_watchdog", "compute_incubation_targets", "compute_released_targets", "record_monitoring_observations",
  "stop_entries", "cancel_unsafe_orders", "flatten_positions", "verify_flat", "reconcile_session",
  "close_valid_day_ledger", "generate_daily_report", "schedule_bounded_research", "run_daily_cohort",
  "weekly_operational_diversity_review", "pipeline_review", "pipeline_validate", "pipeline_incubation",
  "pipeline_release", "pipeline_monitor",
]);

export const OPERATOR_COMMANDS = Object.freeze([
  "global_pause", "global_resume", "kill_switch", "clear_kill_switch", "flatten_all",
  "pause_research", "resume_research", "pause_ingestion", "resume_ingestion", "pause_release", "resume_release",
  "pause_execution", "resume_execution", "retry_operational", "quarantine_strategy", "retire_strategy",
  "pause_strategy", "resume_strategy",
  "reset_nonproduction_workspace",
  "prepare_workspace_reset", "execute_workspace_reset",
  "approve_configuration", "approve_universe", "approve_policy",
]);

const COMMANDS = new Set([...ROUTINE_COMMANDS, ...OPERATOR_COMMANDS]);
const clone = (value) => structuredClone(value);
const trimResults = (value, limit = 512) => Object.fromEntries(Object.entries(value).slice(-limit));

export function orchestrationMode(env = {}) {
  const requested = String(env.ORCHESTRATION_MODE ?? "observe").toLowerCase();
  return ORCHESTRATION_MODES.includes(requested) ? requested : "observe";
}

export function emptyOrchestrationState(mode = "observe") {
  return {
    schema_version: ORCHESTRATION_SCHEMA_VERSION,
    mode: ORCHESTRATION_MODES.includes(mode) ? mode : "observe",
    version: 0,
    controls: {
      global_paused: false, kill_switch: false, flatten_requested: false, entries_paused: false,
      research_paused: false, ingestion_paused: false, release_paused: false, execution_paused: false,
    },
    completed_intent_ids: [], command_results: {}, latest_command_id: null, latest_watchdog_at: null,
    active_session_date: null,
    valid_day_ledgers: {}, approvals: {}, incidents: [],
  };
}

export function ensureOrchestrationState(state, mode = "observe") {
  state.orchestration ??= emptyOrchestrationState(mode);
  const current = state.orchestration;
  current.schema_version = ORCHESTRATION_SCHEMA_VERSION;
  current.mode = ORCHESTRATION_MODES.includes(mode) ? mode
    : (ORCHESTRATION_MODES.includes(current.mode) ? current.mode : "observe");
  current.version ??= 0; current.controls = { ...emptyOrchestrationState().controls, ...(current.controls ?? {}) };
  current.completed_intent_ids ??= []; current.command_results ??= {}; current.valid_day_ledgers ??= {};
  current.active_session_date ??= null;
  current.approvals ??= {}; current.incidents ??= [];
  return current;
}

export function orchestrationCommandId(command) {
  return `ORC-${hashCanonical({ schema_version: ORCHESTRATION_SCHEMA_VERSION, kind: command.kind,
    intent_id: command.intent_id ?? null, strategy_id: command.strategy_id ?? null, actor: command.actor,
    correlation_id: command.correlation_id, payload: command.payload ?? {} }).slice(0, 32)}`;
}

export function createOrchestrationCommand({ kind, intent_id = null, strategy_id = null, actor = "system",
  timestamp = new Date().toISOString(), correlation_id, payload = {} } = {}) {
  const command = { schema_version: ORCHESTRATION_SCHEMA_VERSION, kind, intent_id, strategy_id, actor, timestamp,
    correlation_id: correlation_id ?? intent_id ?? `${kind}:${strategy_id ?? "workspace"}`, payload: clone(payload) };
  command.command_id = orchestrationCommandId(command);
  return validateOrchestrationCommand(command);
}

export function validateOrchestrationCommand(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema_version !== ORCHESTRATION_SCHEMA_VERSION) throw new TypeError("Unsupported orchestration command schema");
  if (!COMMANDS.has(value.kind)) throw new TypeError(`Unsupported orchestration command: ${value.kind}`);
  if (value.actor !== "system" && !/^operator:[A-Za-z0-9._:@-]+$/.test(String(value.actor))) throw new TypeError("Orchestration actor must be system or an authenticated operator");
  if (!value.timestamp || Number.isNaN(new Date(value.timestamp).getTime()) || !value.correlation_id) throw new TypeError("Orchestration timestamp and correlation ID are required");
  if (value.command_id !== orchestrationCommandId(value)) throw new TypeError("Orchestration command ID is not deterministic");
  if (OPERATOR_COMMANDS.includes(value.kind) && value.actor === "system") throw new TypeError("Operator command requires an authenticated operator actor");
  return Object.freeze(clone(value));
}

function result(command, status, actions = [], reason = null) {
  return { schema_version: ORCHESTRATION_SCHEMA_VERSION, command_id: command.command_id, intent_id: command.intent_id,
    status, actions, reason, completed_at: command.timestamp };
}

function routineActions(current, command) {
  const controls = current.controls; const payload = command.payload ?? {};
  if (controls.global_paused && command.kind !== "session_watchdog") return result(command, "blocked", [], "global_paused");
  switch (command.kind) {
    case "session_watchdog":
      if (payload.session_date && current.active_session_date !== payload.session_date) {
        current.active_session_date = payload.session_date;
        if (!controls.kill_switch && !controls.execution_paused) controls.entries_paused = false;
      }
      current.latest_watchdog_at = command.timestamp;
      return result(command, "applied", [{ kind: "watchdog.repair", payload }]);
    case "stop_entries": controls.entries_paused = true; return result(command, "applied", [{ kind: "broker.stop_entries", payload }]);
    case "cancel_unsafe_orders": return result(command, "applied", [{ kind: "broker.cancel_unsafe_orders", payload }]);
    case "flatten_positions": controls.flatten_requested = true; return result(command, "applied", [{ kind: "broker.flatten_all", payload }]);
    case "verify_flat": return result(command, "applied", [{ kind: "broker.verify_flat", payload }]);
    case "reconcile_session": return result(command, "applied", [{ kind: "market.reconcile_session", payload }]);
    case "close_valid_day_ledger": current.valid_day_ledgers[payload.session_date ?? command.timestamp.slice(0, 10)] = { status: "closed", command_id: command.command_id, closed_at: command.timestamp }; return result(command, "applied");
    case "generate_daily_report": return result(command, "applied", [{ kind: "report.generate_daily", payload }]);
    case "schedule_bounded_research":
      return controls.research_paused ? result(command, "blocked", [], "research_paused") : result(command, "applied", [{ kind: "research.schedule", payload }]);
    case "run_daily_cohort":
      return controls.research_paused ? result(command, "blocked", [], "research_paused") : result(command, "applied", [{ kind: "research.run_cohort", payload }]);
    case "weekly_operational_diversity_review": return result(command, "applied", [{ kind: "review.weekly", payload }]);
    case "compute_incubation_targets": case "compute_released_targets":
      return controls.kill_switch || controls.execution_paused || controls.entries_paused
        ? result(command, "blocked", [], controls.kill_switch ? "kill_switch" : "execution_paused")
        : result(command, "applied", [{ kind: "pipeline.compute_targets", scope: command.kind === "compute_incubation_targets" ? "incubation" : "released", payload }]);
    case "record_monitoring_observations": return result(command, "applied", [{ kind: "pipeline.monitor", payload }]);
    case "pipeline_review": return result(command, "applied", [{ kind: "pipeline.review", payload }]);
    case "pipeline_validate": return result(command, "applied", [{ kind: "pipeline.validate", payload }]);
    case "pipeline_incubation": return result(command, "applied", [{ kind: "pipeline.incubation", payload }]);
    case "pipeline_release": return controls.release_paused ? result(command, "blocked", [], "release_paused") : result(command, "applied", [{ kind: "pipeline.release", payload }]);
    case "pipeline_monitor": return result(command, "applied", [{ kind: "pipeline.monitor", payload }]);
    default: throw new TypeError(`Unhandled routine command: ${command.kind}`);
  }
}

function operatorActions(current, command) {
  const controls = current.controls; const payload = command.payload ?? {};
  switch (command.kind) {
    case "global_pause": controls.global_paused = true; return result(command, "applied");
    case "global_resume": controls.global_paused = false; return result(command, "applied");
    case "kill_switch": controls.kill_switch = true; controls.execution_paused = true; controls.entries_paused = true; return result(command, "applied", [{ kind: "broker.cancel_unsafe_orders", payload }]);
    case "clear_kill_switch": controls.kill_switch = false; return result(command, "applied");
    case "flatten_all": controls.flatten_requested = true; return result(command, "applied", [{ kind: "broker.flatten_all", payload }]);
    case "pause_research": controls.research_paused = true; return result(command, "applied");
    case "resume_research": controls.research_paused = false; return result(command, "applied");
    case "pause_ingestion": controls.ingestion_paused = true; return result(command, "applied");
    case "resume_ingestion": controls.ingestion_paused = false; return result(command, "applied");
    case "pause_release": controls.release_paused = true; return result(command, "applied");
    case "resume_release": controls.release_paused = false; return result(command, "applied");
    case "pause_execution": controls.execution_paused = true; return result(command, "applied");
    case "resume_execution": if (controls.kill_switch) return result(command, "blocked", [], "kill_switch"); controls.execution_paused = false; controls.entries_paused = false; return result(command, "applied");
    case "retry_operational": return result(command, "applied", [{ kind: "operational.retry", strategy_id: command.strategy_id, payload }]);
    case "pause_strategy": return result(command, "applied", [{ kind: "strategy.pause", strategy_id: command.strategy_id, payload }]);
    case "resume_strategy": return result(command, "applied", [{ kind: "strategy.resume", strategy_id: command.strategy_id, payload }]);
    case "quarantine_strategy": return result(command, "applied", [{ kind: "strategy.quarantine", strategy_id: command.strategy_id, payload }]);
    case "retire_strategy": return result(command, "applied", [{ kind: "strategy.retire", strategy_id: command.strategy_id, payload }]);
    case "approve_configuration": case "approve_universe": case "approve_policy": {
      const subject = String(payload.subject_hash ?? "");
      if (!/^[a-f0-9]{64}$/.test(subject)) throw new TypeError("Approval requires a SHA-256 subject hash");
      current.approvals[`${command.kind}:${subject}`] = { kind: command.kind, subject_hash: subject, actor: command.actor, at: command.timestamp };
      return result(command, "applied", [{ kind: "approval.persist", approval: current.approvals[`${command.kind}:${subject}`] }]);
    }
    case "reset_nonproduction_workspace":
      throw new TypeError("Direct workspace reset is disabled; prepare and execute the exact reset manifest");
    case "prepare_workspace_reset":
      return result(command, "applied", [{ kind: "workspace.prepare_reset", payload }]);
    case "execute_workspace_reset":
      if (payload.confirmation !== "RESET NONPRODUCTION WORKSPACE" || !payload.manifest_hash) {
        throw new TypeError("Workspace reset execution requires its manifest hash and exact confirmation phrase");
      }
      return result(command, "applied", [{ kind: "workspace.execute_reset", payload }]);
    default: throw new TypeError(`Unhandled operator command: ${command.kind}`);
  }
}

/** Pure command application. It never rewrites strategy evidence or gate results. */
export function applyOrchestrationCommand(rawState, rawCommand) {
  const command = validateOrchestrationCommand(rawCommand);
  const next = clone(rawState ?? emptyOrchestrationState());
  ensureOrchestrationState({ orchestration: next }, next.mode);
  const prior = next.command_results[command.command_id];
  if (prior) return { state: next, result: prior, idempotent: true };
  const output = ROUTINE_COMMANDS.includes(command.kind) ? routineActions(next, command) : operatorActions(next, command);
  // A pause or kill switch is transient operational state. Do not consume the
  // stable intent ID: the exact command may be retried after the control is
  // lifted without inventing a second market/schedule event.
  if (output.status === "blocked") return { state: next, result: output, idempotent: false, blocked: true };
  next.version += 1; next.latest_command_id = command.command_id;
  if (command.intent_id && !next.completed_intent_ids.includes(command.intent_id)) next.completed_intent_ids.push(command.intent_id);
  next.completed_intent_ids = next.completed_intent_ids.slice(-2048);
  next.command_results[command.command_id] = output; next.command_results = trimResults(next.command_results);
  return { state: next, result: output, idempotent: false };
}

export function executionAllowed(state) {
  const controls = state?.orchestration?.controls ?? state?.controls ?? {};
  return !controls.global_paused && !controls.kill_switch && !controls.execution_paused;
}

export function publicOrchestrationState(value) {
  const state = value ?? emptyOrchestrationState();
  return { schema_version: state.schema_version, mode: state.mode, version: state.version, controls: clone(state.controls),
    latest_command_id: state.latest_command_id, latest_watchdog_at: state.latest_watchdog_at,
    completed_intents: state.completed_intent_ids?.length ?? 0, open_incidents: (state.incidents ?? []).filter((item) => !item.resolved_at).length,
    valid_day_ledgers: Object.values(state.valid_day_ledgers ?? {}).filter((item) => item.status === "closed").length,
    pending_reset: state.pending_reset ? { manifest_hash: state.pending_reset.manifest_hash,
      prepared_at: state.pending_reset.prepared_at, requested_by: state.pending_reset.requested_by } : null };
}
