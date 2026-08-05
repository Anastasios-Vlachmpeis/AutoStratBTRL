import { explainStrategyDNA } from "./dsl.js";
import { registerResearchFinalists } from "./engine.js";
import { proposePopulation } from "./evolution.js";
import { researchContract } from "./research-contract.js";
import { screenResearchTrials } from "./research-fitness.js";
import {
  beginCohort,
  compactCohortTrials,
  completeCohort,
  markFinalists,
  recordTrialScreen,
  registerTrial,
} from "./research-registry.js";

const sortedBars = (bars) => [...(bars ?? [])].filter((bar) => bar && Number.isFinite(Number(bar.c)) && Number(bar.c) > 0)
  .sort((left, right) => String(left.t).localeCompare(String(right.t)));

/** Physically remove the final quarter before generation or vector screening. */
export function developmentOnlyDataset(barsBySymbol, fraction = .75) {
  const output = {};
  for (const symbol of Object.keys(barsBySymbol ?? {}).sort()) {
    const bars = sortedBars(barsBySymbol[symbol]);
    const end = Math.floor(bars.length * fraction);
    if (end > 0) output[symbol] = bars.slice(0, end);
  }
  return output;
}

function proposalForRegistry(proposal) {
  const structurallyValid = proposal.structural_status !== "invalid";
  return {
    cohort_id: proposal.cohort_id,
    trial_id: proposal.trial_id,
    ordinal: proposal.ordinal,
    kind: proposal.proposal_kind === "challenger" ? "challenger" : "sampled",
    lineage_id: proposal.dna?.lineage?.parent_strategy_id ?? null,
    parent_ids: proposal.parent_hashes ?? [],
    operator: proposal.operator,
    seed: proposal.seed,
    dna: proposal.dna,
    dna_hash: proposal.dna_hash,
    structural_validation: {
      valid: structurallyValid,
      rejection_reason: proposal.rejection_reason,
    },
  };
}

function researchParents(state) {
  const permittedStates = new Set(["generated", "validation", "released", "healthy", "watch", "adjusted"]);
  return (state.strategies ?? []).filter((strategy) => strategy.strategy_format === "dsl-v1"
    && strategy.strategy_dna && strategy.fitness
    && (permittedStates.has(strategy.state)
      || (strategy.state === "rework" && !["validation", "holdout"].includes(strategy.rework?.source_stage))))
    .sort((left, right) => left.dna_hash.localeCompare(right.dna_hash))
    .map((strategy) => strategy.strategy_dna);
}

function archivedBehaviors(research) {
  return (research.population ?? []).filter((item) => item.behavior_hash && Array.isArray(item.behavior_series))
    .map((item) => ({ dna_hash: item.dna_hash, behavior_fingerprint: item.behavior_hash,
      behavior_series: item.behavior_series }));
}

/**
 * Deterministically prepare a cohort using development bars only. Persistence
 * is deliberately separate so storage failures can never materialize a strategy.
 */
export function prepareEvolutionaryResearch(state, input) {
  if (input?.holdout_bars || input?.validation_bars) throw new Error("Holdout data is forbidden in evolutionary research");
  if (input?.dataset_scope !== "development_only") throw new Error("Evolution requires a physically development-only dataset");
  const contract = researchContract(input);
  const existing = state.research?.cohorts?.find((item) => item.cohort_id === contract.cohort_id);
  if (existing?.status === "complete") return { duplicate: true, contract, cohort: existing, proposals: [], screen: null, trial_artifacts: [] };
  const cohort = beginCohort(state, contract, { telemetry: input.telemetry ?? { status: "healthy" } });
  const proposals = proposePopulation(contract, {
    parents: input.parents ?? researchParents(state),
    archiveDnaHashes: state.research.novelty_archive.dna_hashes,
  });
  for (const proposal of proposals) registerTrial(state, proposalForRegistry(proposal));
  const screen = screenResearchTrials(proposals, input.bars_by_symbol, {
    finalists: contract.config.finalists,
    minimum_symbols: contract.config.minimum_symbols,
    maximum_symbol_concentration: contract.config.maximum_symbol_concentration,
    near_duplicate_correlation: contract.config.near_duplicate_correlation,
    cluster_cap: Math.max(1, Math.ceil(contract.config.finalists / contract.config.behavior_clusters)),
    minimum_fold_bars: input.minimum_fold_bars ?? 40,
    minimum_trades: input.minimum_trades ?? 8,
    maximum_turnover: input.maximum_turnover ?? 20,
    novelty_archive: archivedBehaviors(state.research),
  });
  const records = new Map(screen.records.map((record) => [record.trial_id, record]));
  for (const proposal of proposals) {
    const record = records.get(proposal.trial_id);
    if (record) recordTrialScreen(state, { cohort_id: cohort.cohort_id, trial_id: proposal.trial_id, result: record });
  }
  cohort.status = "screened_pending_artifacts";
  cohort.screen_hash = screen.summary.contract_hash;
  const trialArtifacts = proposals.map((proposal) => ({
    schema_version: 1,
    cohort_id: cohort.cohort_id,
    trial_id: proposal.trial_id,
    contract_hash: contract.contract_hash,
    dataset_id: contract.dataset_id,
    dataset_hash: contract.dataset_hash,
    compiler: contract.compiler,
    proposal,
    screen: records.get(proposal.trial_id) ?? null,
  }));
  return { duplicate: false, contract, cohort, proposals, screen, trial_artifacts: trialArtifacts };
}

export function commitEvolutionaryResearch(state, prepared, { artifact_ids = {} } = {}) {
  if (prepared.duplicate) return { duplicate: true, cohort: prepared.cohort, created: [] };
  const finalistIds = prepared.screen.finalists.map((item) => item.trial_id);
  markFinalists(state, { cohort_id: prepared.cohort.cohort_id, trial_ids: finalistIds });
  const finalists = prepared.screen.finalists.map((item) => ({
    ...item,
    behavior_hash: item.behavior_fingerprint,
    behavior_cluster: item.cluster_id,
    explanation: explainStrategyDNA(item.dna),
  }));
  const created = registerResearchFinalists(state, finalists, {
    ...prepared.cohort,
    attempted: prepared.screen.summary.attempted,
  });
  const research = state.research;
  research.population = [...finalists.map((item) => ({
    trial_id: item.trial_id,
    cohort_id: prepared.cohort.cohort_id,
    dna_hash: item.dna_hash,
    behavior_hash: item.behavior_hash,
    behavior_series: item.behavior_series,
    pareto_rank: item.pareto_rank,
    fitness: item.fitness,
    artifact_id: artifact_ids[item.trial_id] ?? null,
  })), ...(research.population ?? []).filter((item) => !finalists.some((finalist) => finalist.dna_hash === item.dna_hash))].slice(0, 128);
  prepared.cohort.artifact_count = Object.keys(artifact_ids).length;
  prepared.cohort.valid = prepared.screen.records.filter((item) => item.status !== "invalid").length;
  prepared.cohort.invalid = prepared.screen.records.filter((item) => item.status === "invalid").length;
  prepared.cohort.duplicates = prepared.screen.summary.duplicates;
  completeCohort(state, { cohort_id: prepared.cohort.cohort_id, status: "complete",
    archive_trial_ids: finalistIds });
  compactCohortTrials(state, { cohort_id: prepared.cohort.cohort_id });
  return { duplicate: false, cohort: prepared.cohort, created, finalists };
}

export function failEvolutionaryResearch(state, prepared, error) {
  if (!prepared?.cohort) return null;
  const cohort = completeCohort(state, { cohort_id: prepared.cohort.cohort_id,
    infrastructure_error: error instanceof Error ? error.message : String(error) });
  compactCohortTrials(state, { cohort_id: cohort.cohort_id });
  return cohort;
}
