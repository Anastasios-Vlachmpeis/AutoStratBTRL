import {
  RESEARCH_LIMITS,
  deterministicTrialId,
  emptyResearchState,
  ensureResearchState,
  normalizeResearchConfig,
} from "./research-contract.js";

// The registry is deliberately side-effect free.  The Durable Object owns persistence,
// while this module makes all quota and retry decisions from the persisted state.
const DETAIL_RETENTION = 256;
const SUMMARY_RETENTION = 2_048;
const ARCHIVE_RETENTION = 4_096;
const COHORT_RETENTION = 365;

const now = () => new Date().toISOString();
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const dateOf = (value) => {
  const valueString = String(value ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(valueString)) throw new Error("Research session_date must use YYYY-MM-DD");
  return valueString;
};
const statusOf = (telemetry) => ["healthy", "constrained", "paused", "stale", "unavailable"].includes(String(telemetry?.status))
  ? String(telemetry.status) : "healthy";

function researchOf(state) {
  if (!state || typeof state !== "object") throw new Error("Research registry requires a mutable state object");
  const research = ensureResearchState(state);
  research.attempt_summaries ??= [];
  research.trimmed_attempts ??= 0;
  research.budget.sampled ??= 0;
  research.budget.challengers ??= 0;
  research.budget.finalists ??= 0;
  research.budget.validation_slots ??= 0;
  research.budget.runtime_ms ??= 0;
  return research;
}

function resetDailyBudget(research, sessionDate, telemetry = {}) {
  if (research.budget.session_date === sessionDate) return false;
  research.budget = {
    session_date: sessionDate,
    trials: 0,
    sampled: 0,
    challengers: 0,
    finalists: 0,
    validation_slots: 0,
    expensive_dispatches: 0,
    runtime_ms: 0,
    estimated_cost_usd: 0,
    telemetry_status: statusOf(telemetry),
    telemetry_at: telemetry?.at ?? null,
  };
  return true;
}

function cohortById(research, cohortId) {
  return research.cohorts.find((cohort) => cohort.cohort_id === cohortId) ?? null;
}

function configOf(cohort) {
  return normalizeResearchConfig(cohort.contract?.config ?? cohort.config ?? {});
}

function capFor(kind, config) {
  if (kind === "sampled") return config.sampled_genomes;
  if (kind === "challenger") return config.challengers;
  if (kind === "finalist") return config.finalists;
  if (kind === "validation") return config.validation_slots;
  throw new Error(`Unknown research budget kind: ${kind}`);
}

function telemetryBlocked(research) {
  const status = research.budget.telemetry_status;
  return ["paused", "stale", "unavailable"].includes(status);
}

function appendAttempt(research, trial) {
  research.attempt_summaries.push({
    trial_id: trial.trial_id, cohort_id: trial.cohort_id, ordinal: trial.ordinal, kind: trial.kind,
    dna_hash: trial.dna_hash ?? null, behavior_hash: trial.behavior_hash ?? null,
    valid: trial.valid, duplicate: trial.duplicate, rejection_reason: trial.rejection_reason ?? null,
    status: trial.status, created_at: trial.created_at,
  });
  if (research.attempt_summaries.length > SUMMARY_RETENTION) {
    const excess = research.attempt_summaries.length - SUMMARY_RETENTION;
    research.attempt_summaries.splice(0, excess);
    research.trimmed_attempts += excess;
  }
}

function trimDetails(research) {
  const entries = Object.values(research.trials).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  while (entries.length > DETAIL_RETENTION) {
    const removed = entries.shift();
    // The immutable summary remains in attempt_summaries (or its explicit trimmed count).
    delete research.trials[removed.trial_id];
  }
}

function archive(research, values) {
  for (const [key, value] of [["dna_hashes", values.dna_hash], ["behavior_hashes", values.behavior_hash]]) {
    if (!value || research.novelty_archive[key].includes(value)) continue;
    research.novelty_archive[key].push(value);
    if (research.novelty_archive[key].length > ARCHIVE_RETENTION) research.novelty_archive[key].splice(0, research.novelty_archive[key].length - ARCHIVE_RETENTION);
  }
}

function duplicateOf(research, cohort, dnaHash, behaviorHash) {
  const seen = (field, value) => Boolean(value) && (
    research.novelty_archive[field].includes(value)
    || Object.values(research.trials).some((trial) => trial.cohort_id === cohort.cohort_id && trial[field === "dna_hashes" ? "dna_hash" : "behavior_hash"] === value)
    || research.attempt_summaries.some((trial) => trial.cohort_id === cohort.cohort_id && trial[field === "dna_hashes" ? "dna_hash" : "behavior_hash"] === value)
  );
  return seen("dna_hashes", dnaHash) || seen("behavior_hashes", behaviorHash);
}

export function initializeResearch(state, { session_date, telemetry = {} } = {}) {
  const research = researchOf(state);
  if (session_date) resetDailyBudget(research, dateOf(session_date), telemetry);
  else if (telemetry.status) {
    research.budget.telemetry_status = statusOf(telemetry);
    research.budget.telemetry_at = telemetry.at ?? now();
  }
  return research;
}

export function canStartResearch(state, { session_date, kind = "sampled", telemetry } = {}) {
  const research = researchOf(state);
  if (session_date) resetDailyBudget(research, dateOf(session_date), telemetry ?? {});
  if (telemetry) {
    research.budget.telemetry_status = statusOf(telemetry);
    research.budget.telemetry_at = telemetry.at ?? now();
  }
  if (research.paused) return { ok: false, reason: research.pause_reason ?? "operator_paused" };
  if (kind !== "validation" && telemetryBlocked(research)) return { ok: false,
    reason: research.budget.telemetry_status === "paused" ? "optional_research_paused_for_budget" : "budget_telemetry_unavailable" };
  const latest = research.cohorts.at(-1);
  const config = latest ? configOf(latest) : normalizeResearchConfig({});
  if (research.budget.runtime_ms >= config.max_runtime_ms) return { ok: false, reason: "runtime_ceiling" };
  const counter = kind === "sampled" ? "sampled" : kind === "challenger" ? "challengers" : kind === "finalist" ? "finalists" : "validation_slots";
  if (research.budget[counter] >= capFor(kind, config)) return { ok: false, reason: `${kind}_ceiling` };
  return { ok: true, reason: null };
}

export function pauseResearch(state, reason = "operator_paused") {
  const research = researchOf(state);
  research.paused = true;
  research.pause_reason = String(reason || "operator_paused");
  research.paused_at = now();
  return research;
}

export function resumeResearch(state) {
  const research = researchOf(state);
  research.paused = false;
  research.pause_reason = null;
  research.resumed_at = now();
  return research;
}

export function beginCohort(state, contract, { telemetry = {} } = {}) {
  if (!contract?.cohort_id || !contract?.contract_hash || !contract?.session_date) throw new Error("A frozen research contract is required");
  const research = initializeResearch(state, { session_date: contract.session_date, telemetry });
  const existing = cohortById(research, contract.cohort_id);
  if (existing) {
    if (existing.contract_hash !== contract.contract_hash) throw new Error("Cohort ID was reused with a different contract");
    // Storage and service failures are retryable operational failures, not a
    // completed research decision. Reopen the same deterministic cohort so
    // its trial IDs can be replayed without spending the daily quota twice.
    if (existing.status === "infrastructure_error") {
      existing.status = "running";
      existing.completed_at = null;
    }
    return existing;
  }
  const allowed = canStartResearch(state, { kind: "sampled" });
  if (!allowed.ok) throw new Error(`Research cannot start: ${allowed.reason}`);
  const cohort = {
    cohort_id: contract.cohort_id, contract_hash: contract.contract_hash, session_date: contract.session_date,
    contract, status: "running", started_at: now(), completed_at: null,
    attempted: 0, valid: 0, duplicates: 0, invalid: 0, sampled: 0, challengers: 0,
    finalists: [], expensive_dispatches: [], validation_dispatches: [], infrastructure_errors: [],
  };
  research.cohorts.push(cohort);
  if (research.cohorts.length > COHORT_RETENTION) {
    const removable = research.cohorts.findIndex((item) => !["running", "screened_pending_artifacts"].includes(item.status));
    if (removable >= 0) {
      research.cohorts.splice(removable, 1);
      research.trimmed_cohorts = Number(research.trimmed_cohorts ?? 0) + 1;
    }
  }
  research.last_cohort_id = cohort.cohort_id;
  return cohort;
}

export function registerTrial(state, proposal) {
  const research = researchOf(state);
  const cohort = cohortById(research, proposal?.cohort_id);
  if (!cohort) throw new Error("Unknown research cohort");
  const trialId = proposal.trial_id ?? deterministicTrialId(cohort.cohort_id, proposal.ordinal);
  const existing = research.trials[trialId];
  if (existing) {
    if (existing.dna_hash !== (proposal.dna_hash ?? null) || existing.behavior_hash !== (proposal.behavior_hash ?? null)) throw new Error("Trial ID was reused with different proposal data");
    return { trial: existing, created: false, duplicate_retry: true };
  }
  // The cohort is persisted before its deterministic Queue jobs are sent.
  // Replaying an existing trial must work if that send is retried, while new
  // trial identities remain forbidden once registration has closed.
  if (cohort.status !== "running") throw new Error("Trials can only be registered for a running cohort");
  const kind = proposal.kind ?? "sampled";
  if (!["sampled", "challenger"].includes(kind)) throw new Error("Trial kind must be sampled or challenger");
  const allowed = canStartResearch(state, { kind });
  if (!allowed.ok) throw new Error(`Research trial rejected: ${allowed.reason}`);
  const structural = proposal.structural_validation ?? { valid: proposal.valid !== false, rejection_reason: proposal.rejection_reason ?? null };
  const duplicate = Boolean(structural.valid) && duplicateOf(research, cohort, proposal.dna_hash, proposal.behavior_hash);
  const trial = {
    trial_id: trialId, cohort_id: cohort.cohort_id, ordinal: Number(proposal.ordinal), kind,
    lineage_id: proposal.lineage_id ?? null, parent_ids: [...(proposal.parent_ids ?? [])], operator: proposal.operator ?? "sample",
    seed: Number(proposal.seed ?? cohort.contract.seed) >>> 0, dna: proposal.dna ?? null,
    dna_hash: proposal.dna_hash ?? null, behavior_hash: proposal.behavior_hash ?? null,
    valid: Boolean(structural.valid), duplicate, rejection_reason: structural.valid ? (duplicate ? "duplicate_novelty" : null) : (structural.rejection_reason ?? "structural_validation_failed"),
    status: structural.valid && !duplicate ? "screening" : "rejected", selected: { backtrader: false, validation: false, incubation: false },
    fitness: proposal.fitness ?? null, constraints: [...(proposal.constraints ?? [])], duration_ms: finite(proposal.duration_ms), estimated_cost_usd: finite(proposal.estimated_cost_usd), created_at: now(),
  };
  research.trials[trialId] = trial;
  cohort.attempted += 1;
  cohort[kind === "sampled" ? "sampled" : "challengers"] += 1;
  if (trial.valid) cohort.valid += 1; else cohort.invalid += 1;
  if (duplicate) cohort.duplicates += 1;
  research.total_trials += 1;
  research.budget.trials += 1;
  research.budget[kind === "sampled" ? "sampled" : "challengers"] += 1;
  research.budget.runtime_ms += trial.duration_ms;
  research.budget.estimated_cost_usd += trial.estimated_cost_usd;
  appendAttempt(research, trial);
  trimDetails(research);
  return { trial, created: true, duplicate_retry: false };
}

export function recordTrialScreen(state, { cohort_id, trial_id, result } = {}) {
  const research = researchOf(state);
  const cohort = cohortById(research, cohort_id);
  const trial = research.trials[trial_id];
  if (!cohort || !trial || trial.cohort_id !== cohort_id) throw new Error("Unknown research trial");
  if (!result || typeof result !== "object") throw new Error("A screen result is required");
  const newlyDuplicate = !trial.duplicate && result.status === "duplicate";
  trial.behavior_hash = result.behavior_fingerprint ?? result.behavior_hash ?? trial.behavior_hash;
  trial.fitness = result.fitness ?? null;
  trial.constraints = [...(result.constraint_failures ?? [])];
  trial.pareto_rank = result.pareto_rank ?? null;
  trial.behavior_cluster = result.cluster_id ?? null;
  trial.duplicate = trial.duplicate || result.status === "duplicate";
  trial.rejection_reason = trial.duplicate ? (result.duplicate_kind ? `${result.duplicate_kind}_duplicate` : trial.rejection_reason ?? "duplicate_novelty")
    : result.status === "eligible" ? null : trial.constraints[0] ?? result.error ?? trial.rejection_reason;
  trial.status = trial.duplicate ? "rejected" : result.status === "eligible" ? "eligible" : "rejected";
  if (newlyDuplicate) cohort.duplicates += 1;
  const summary = research.attempt_summaries.find((item) => item.trial_id === trial_id);
  if (summary) {
    summary.behavior_hash = trial.behavior_hash;
    summary.duplicate = trial.duplicate;
    summary.rejection_reason = trial.rejection_reason;
    summary.status = trial.status;
  }
  return trial;
}

export function markFinalists(state, { cohort_id, trial_ids = [] } = {}) {
  const research = researchOf(state);
  const cohort = cohortById(research, cohort_id);
  if (!cohort) throw new Error("Unknown research cohort");
  const chosen = [];
  for (const trialId of trial_ids) {
    const trial = research.trials[trialId];
    if (!trial || trial.cohort_id !== cohort_id || !trial.valid || trial.duplicate) continue;
    if (trial.selected.backtrader) { chosen.push(trial); continue; }
    const allowed = canStartResearch(state, { kind: "finalist" });
    if (!allowed.ok) break;
    trial.selected.backtrader = true;
    trial.status = "finalist";
    cohort.finalists.push(trial.trial_id);
    research.budget.finalists += 1;
    // A finalist has consumed authoritative attention.  Keep its fingerprints even
    // if its detailed trial record is later compacted out of Durable Object state.
    archive(research, trial);
    chosen.push(trial);
  }
  return chosen;
}

export function dispatchExpensiveFinalists(state, { cohort_id, trial_ids = [], phase = "development", runtime_ms = 0, estimated_cost_usd = 0 } = {}) {
  const research = researchOf(state);
  const cohort = cohortById(research, cohort_id);
  if (!cohort) throw new Error("Unknown research cohort");
  const dispatched = [];
  const validation = phase === "validation";
  for (const trialId of trial_ids) {
    const trial = research.trials[trialId];
    if (!trial || trial.cohort_id !== cohort_id || !trial.valid || trial.duplicate || !trial.selected.backtrader) continue;
    if (trial.selected[validation ? "validation" : "backtrader_dispatched"]) { dispatched.push(trial); continue; }
    const allowed = validation ? canStartResearch(state, { kind: "validation" }) : { ok: true };
    if (!allowed.ok) break;
    if (validation) {
      trial.selected.validation = true;
      cohort.validation_dispatches.push(trialId);
      research.budget.validation_slots += 1;
    } else trial.selected.backtrader_dispatched = true;
    trial.status = validation ? "validating" : "backtrader_development";
    trial.expensive_dispatch ??= [];
    trial.expensive_dispatch.push({ phase, dispatched_at: now(), runtime_ms: finite(runtime_ms), estimated_cost_usd: finite(estimated_cost_usd) });
    cohort.expensive_dispatches.push({ trial_id: trialId, phase });
    research.total_expensive_dispatches += 1;
    research.budget.expensive_dispatches += 1;
    research.budget.runtime_ms += finite(runtime_ms);
    research.budget.estimated_cost_usd += finite(estimated_cost_usd);
    dispatched.push(trial);
  }
  return dispatched;
}

export function compactCohortTrials(state, { cohort_id, retain_trial_ids = [] } = {}) {
  const research = researchOf(state);
  const retain = new Set(retain_trial_ids);
  for (const trial of Object.values(research.trials)) {
    if (trial.cohort_id !== cohort_id || retain.has(trial.trial_id)) continue;
    trial.dna = null;
    trial.fitness = trial.fitness ? {
      net_return: trial.fitness.net_return,
      sharpe_proxy: trial.fitness.sharpe_proxy,
      max_drawdown: trial.fitness.max_drawdown,
      stability: trial.fitness.stability,
      trades: trial.fitness.trades,
      complexity: trial.fitness.complexity,
      novelty: trial.fitness.novelty,
    } : null;
  }
  trimDetails(research);
  return research;
}

export function completeCohort(state, { cohort_id, status = "complete", archive_trial_ids = [], infrastructure_error = null } = {}) {
  const research = researchOf(state);
  const cohort = cohortById(research, cohort_id);
  if (!cohort) throw new Error("Unknown research cohort");
  if (infrastructure_error) {
    // Infrastructure failures are operational evidence only: never turn them into a selection result.
    cohort.infrastructure_errors.push({ at: now(), message: String(infrastructure_error) });
    cohort.status = "infrastructure_error";
    cohort.completed_at = null;
  } else {
    cohort.status = status;
    for (const trialId of archive_trial_ids) {
      const trial = research.trials[trialId];
      if (trial?.cohort_id === cohort_id) archive(research, trial);
    }
    cohort.completed_at ??= now();
    research.last_completed_session = cohort.session_date;
  }
  return cohort;
}

export function researchReset(state) {
  if (!state || typeof state !== "object") throw new Error("Research registry requires a mutable state object");
  state.research = emptyResearchState();
  return state.research;
}
