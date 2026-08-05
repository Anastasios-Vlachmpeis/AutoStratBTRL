import { COMPILER_MANIFEST, hashCanonical } from "./dsl.js";
import { INITIAL_UNIVERSE_ID, INITIAL_UNIVERSE_SHA256 } from "./universe.js";

export const RESEARCH_SCHEMA_VERSION = 1;
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
  return state.research;
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
