import { COMPILER_MANIFEST, hashCanonical } from "./dsl.js";
import { INITIAL_UNIVERSE_ID, INITIAL_UNIVERSE_SHA256 } from "./universe.js";

export const RESEARCH_SCHEMA_VERSION = 2;
export const RESEARCH_ENGINE_VERSION = "1.0.0";
export const RESEARCH_LIMITS = Object.freeze({
  sampled_genomes: 128,
  challengers: 32,
  finalists: 12,
  validation_slots: 3,
  concurrent_tasks: 3,
  behavior_clusters: 4,
  max_runtime_ms: 25_000,
});

const integer = (value, fallback, low, high) => Math.max(low, Math.min(high,
  Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : fallback));
const decimal = (value, fallback, low, high) => Math.max(low, Math.min(high,
  Number.isFinite(Number(value)) ? Number(value) : fallback));

export function normalizeResearchConfig(value = {}) {
  const sampled = integer(value.sampled_genomes, RESEARCH_LIMITS.sampled_genomes, 1, RESEARCH_LIMITS.sampled_genomes);
  const challengers = integer(value.challengers, RESEARCH_LIMITS.challengers, 0, RESEARCH_LIMITS.challengers);
  return Object.freeze({
    sampled_genomes: sampled,
    challengers,
    total_trials: sampled + challengers,
    finalists: integer(value.finalists, RESEARCH_LIMITS.finalists, 1, RESEARCH_LIMITS.finalists),
    validation_slots: integer(value.validation_slots, RESEARCH_LIMITS.validation_slots, 1, RESEARCH_LIMITS.validation_slots),
    behavior_clusters: integer(value.behavior_clusters, RESEARCH_LIMITS.behavior_clusters, 1, RESEARCH_LIMITS.behavior_clusters),
    max_runtime_ms: integer(value.max_runtime_ms, RESEARCH_LIMITS.max_runtime_ms, 100, RESEARCH_LIMITS.max_runtime_ms),
    minimum_symbols: integer(value.minimum_symbols, 5, 5, 40),
    maximum_symbol_concentration: decimal(value.maximum_symbol_concentration, .35, .05, .35),
    near_duplicate_correlation: decimal(value.near_duplicate_correlation, .995, .90, .9999),
  });
}

export function researchContract({ seed, session_date, dataset_id, dataset_hash, config = {} }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(session_date))) throw new Error("Research session_date must use YYYY-MM-DD");
  if (!/^[a-f0-9]{64}$/.test(String(dataset_hash))) throw new Error("Research dataset_hash must be SHA-256");
  const normalized = normalizeResearchConfig(config);
  const canonical = {
    schema_version: RESEARCH_SCHEMA_VERSION,
    engine_version: RESEARCH_ENGINE_VERSION,
    seed: Number(seed) >>> 0,
    session_date: String(session_date),
    dataset_id: String(dataset_id),
    dataset_hash: String(dataset_hash),
    universe_id: INITIAL_UNIVERSE_ID,
    universe_hash: INITIAL_UNIVERSE_SHA256,
    compiler: { ...COMPILER_MANIFEST },
    config: normalized,
  };
  const hash = hashCanonical(canonical);
  return Object.freeze({ ...canonical, cohort_id: `COH-${session_date}-${hash.slice(0, 24)}`, contract_hash: hash });
}

export function deterministicTrialId(cohortId, ordinal) {
  if (!/^COH-\d{4}-\d{2}-\d{2}-[a-f0-9]{24}$/.test(String(cohortId))) throw new Error("Invalid cohort ID");
  const value = integer(ordinal, -1, 0, 9999);
  if (value !== Number(ordinal)) throw new Error("Trial ordinal must be an integer from 0 to 9999");
  return `TR-${cohortId.slice(-16)}-${String(value + 1).padStart(4, "0")}`;
}

export function emptyResearchState() {
  return {
    schema_version: RESEARCH_SCHEMA_VERSION,
    engine_version: RESEARCH_ENGINE_VERSION,
    paused: false,
    pause_reason: null,
    last_completed_session: null,
    last_cohort_id: null,
    total_trials: 0,
    total_expensive_dispatches: 0,
    cohorts: [],
    trials: {},
    population: [],
    novelty_archive: { dna_hashes: [], behavior_hashes: [] },
    // Private, append-only provenance for the one permitted final-holdout
    // opening of a lineage.  It deliberately contains no bars or metrics.
    holdout_burn_ledger: { by_lineage: {}, authorization_index: {}, total_burns: 0 },
    budget: { session_date: null, trials: 0, expensive_dispatches: 0, runtime_ms: 0, estimated_cost_usd: 0, telemetry_status: "healthy" },
  };
}

export function ensureResearchState(state) {
  state.research ??= emptyResearchState();
  state.research.schema_version = RESEARCH_SCHEMA_VERSION;
  state.research.engine_version = RESEARCH_ENGINE_VERSION;
  state.research.cohorts ??= [];
  state.research.trials ??= {};
  state.research.population ??= [];
  state.research.novelty_archive ??= { dna_hashes: [], behavior_hashes: [] };
  state.research.novelty_archive.dna_hashes ??= [];
  state.research.novelty_archive.behavior_hashes ??= [];
  state.research.budget ??= emptyResearchState().budget;
  state.research.holdout_burn_ledger ??= emptyResearchState().holdout_burn_ledger;
  state.research.holdout_burn_ledger.by_lineage ??= {};
  // Canonical records live only under by_lineage.  The secondary map is an
  // ID→lineage index, so JSON persistence cannot produce divergent copies.
  state.research.holdout_burn_ledger.authorization_index ??= {};
  for (const [lineage, record] of Object.entries(state.research.holdout_burn_ledger.by_lineage)) {
    if (record?.authorization_id) state.research.holdout_burn_ledger.authorization_index[record.authorization_id] = lineage;
  }
  delete state.research.holdout_burn_ledger.authorizations;
  state.research.holdout_burn_ledger.total_burns ??= 0;
  return state.research;
}

/** A root lineage survives ordinary reproduction and development-only rework. */
export function lineageIdentity(strategy) {
  const explicit = strategy?.lineage_id ?? strategy?.root_lineage_id;
  if (explicit) return String(explicit);
  const dna = strategy?.strategy_dna;
  return String(dna?.lineage?.root_strategy_id ?? dna?.lineage?.parent_strategy_id ?? dna?.strategy_id ?? strategy?.id ?? "");
}

export function holdoutAuthorizationJob({ lineage_id, dataset_id, dataset_hash, dna_hash, configuration_hash = null }) {
  if (!lineage_id || !dataset_id || !dna_hash) throw new Error("Sealed holdout authorization requires lineage, dataset, and DNA identity");
  return `HOJ-${hashCanonical({ phase: "holdout", lineage_id: String(lineage_id), dataset_id: String(dataset_id),
    dataset_hash: String(dataset_hash ?? ""), dna_hash: String(dna_hash), configuration_hash: configuration_hash ?? null }).slice(0, 32)}`;
}

/**
 * Burn the final holdout before remote dispatch. A duplicate retry must carry
 * exactly the same frozen job identity; any other opening is rejected.
 */
export function authorizeSealedHoldout(state, request = {}) {
  const research = ensureResearchState(state);
  const lineage_id = String(request.lineage_id ?? "");
  const job_id = String(request.job_id ?? holdoutAuthorizationJob(request));
  const dataset_id = String(request.dataset_id ?? "");
  const dna_hash = String(request.dna_hash ?? "");
  if (!lineage_id || !dataset_id || !dna_hash || !job_id) throw new Error("Invalid sealed holdout authorization request");
  const ledger = research.holdout_burn_ledger;
  const current = ledger.by_lineage[lineage_id];
  if (current) {
    if (current.outcome) throw new Error("Final holdout already has a terminal outcome for this lineage");
    if (current.job_id !== job_id || current.dataset_id !== dataset_id || current.dna_hash !== dna_hash) {
      throw new Error("Final holdout is already burned for this lineage");
    }
    return { authorization: current, created: false, retry: true };
  }
  const authorization_id = `HOLD-${hashCanonical({ lineage_id, job_id, dataset_id, dna_hash,
    dataset_hash: request.dataset_hash ?? null, configuration_hash: request.configuration_hash ?? null }).slice(0, 32)}`;
  const authorization = {
    authorization_id, lineage_id, job_id, dataset_id, dataset_hash: request.dataset_hash ?? null,
    dna_hash, configuration_hash: request.configuration_hash ?? null,
    authorized_at: new Date().toISOString(), service_status: "authorized", outcome: null,
    completed_at: null, result_hash: null, artifact_id: null,
  };
  ledger.by_lineage[lineage_id] = authorization;
  ledger.authorization_index[authorization_id] = lineage_id;
  ledger.total_burns += 1;
  return { authorization, created: true, retry: false };
}

export function recordSealedHoldoutServiceStatus(state, { lineage_id, authorization_id, status, error = null } = {}) {
  const research = ensureResearchState(state);
  const ledger = research.holdout_burn_ledger;
  const authorization = ledger.by_lineage[String(lineage_id ?? "")]
    ?? ledger.by_lineage[ledger.authorization_index[String(authorization_id ?? "")]];
  if (!authorization) throw new Error("Unknown sealed holdout authorization");
  authorization.service_status = String(status ?? "error");
  authorization.last_error = error ? String(error) : null;
  authorization.last_service_at = new Date().toISOString();
  return authorization;
}

/** Bind the burned reservation to the exact wire payload(s) before sending. */
export function bindSealedHoldoutDispatch(state, { lineage_id, authorization_id, jobs = [] } = {}) {
  const authorization = recordSealedHoldoutServiceStatus(state, { lineage_id, authorization_id, status: "bound" });
  const normalized = [...jobs].map((job) => ({ job_id: String(job.job_id), payload_hash: String(job.payload_hash) }))
    .sort((a, b) => a.job_id.localeCompare(b.job_id));
  if (!normalized.length || normalized.some((job) => !job.job_id || !job.payload_hash)) throw new Error("Exact holdout dispatch binding is required");
  const prior = authorization.wire_jobs;
  if (prior && hashCanonical(prior) !== hashCanonical(normalized)) throw new Error("Sealed holdout retry changed its wire payload");
  authorization.wire_jobs ??= normalized;
  authorization.bound_at ??= new Date().toISOString();
  return authorization;
}

export function recordSealedHoldoutOutcome(state, { lineage_id, authorization_id, outcome, result_hash = null, artifact_id = null } = {}) {
  if (!["incubation", "holdout_reject", "inconclusive"].includes(outcome)) throw new Error("Invalid sealed holdout outcome");
  const research = ensureResearchState(state);
  const ledger = research.holdout_burn_ledger;
  const authorization = ledger.by_lineage[String(lineage_id ?? "")]
    ?? ledger.by_lineage[ledger.authorization_index[String(authorization_id ?? "")]];
  if (!authorization) throw new Error("Unknown sealed holdout authorization");
  if (!authorization.wire_jobs?.length) throw new Error("Sealed holdout outcome requires an exact dispatch binding");
  if (authorization.outcome) {
    if (authorization.outcome === outcome && authorization.result_hash === result_hash && authorization.artifact_id === artifact_id) return authorization;
    throw new Error("Final holdout already has a terminal outcome for this lineage");
  }
  recordSealedHoldoutServiceStatus(state, { lineage_id, authorization_id, status: "complete" });
  authorization.outcome = outcome;
  authorization.result_hash = result_hash;
  authorization.artifact_id = artifact_id;
  authorization.completed_at = new Date().toISOString();
  return authorization;
}

export function publicResearchState(research) {
  const value = research ?? emptyResearchState();
  const latest = value.cohorts?.at(-1) ?? null;
  return {
    schema_version: value.schema_version ?? RESEARCH_SCHEMA_VERSION,
    engine_version: value.engine_version ?? RESEARCH_ENGINE_VERSION,
    paused: Boolean(value.paused),
    pause_reason: value.pause_reason ?? null,
    last_completed_session: value.last_completed_session ?? null,
    total_trials: Number(value.total_trials ?? 0),
    total_expensive_dispatches: Number(value.total_expensive_dispatches ?? 0),
    population_size: value.population?.length ?? 0,
    novelty_archive_size: value.novelty_archive?.dna_hashes?.length ?? 0,
    holdout: {
      total_burns: Number(value.holdout_burn_ledger?.total_burns ?? 0),
      completed: Object.values(value.holdout_burn_ledger?.by_lineage ?? {}).filter((item) => item.outcome).length,
      pending: Object.values(value.holdout_burn_ledger?.by_lineage ?? {}).filter((item) => !item.outcome).length,
    },
    budget: { ...(value.budget ?? {}) },
    latest_cohort: latest ? {
      cohort_id: latest.cohort_id,
      session_date: latest.session_date,
      status: latest.status,
      attempted: latest.attempted,
      valid: latest.valid,
      duplicates: latest.duplicates,
      finalists: latest.finalists?.length ?? 0,
      completed_at: latest.completed_at ?? null,
    } : null,
  };
}
