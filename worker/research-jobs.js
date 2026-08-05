import { hashCanonical } from "./dsl.js";

export const RESEARCH_SCREEN_JOB_KIND = "research.screen-trial.v1";
export const RESEARCH_FINALIZE_JOB_KIND = "research.finalize-cohort.v1";

function base(generated, workspaceId, actor) {
  return {
    workspace_id: String(workspaceId), cohort_id: generated.cohort.cohort_id,
    contract_hash: generated.contract.contract_hash, dataset_id: generated.contract.dataset_id,
    dataset_hash: generated.contract.dataset_hash, actor: String(actor ?? "system"),
  };
}

/** One trial per job bounds a turn to five immutable symbol partitions. */
export function planResearchJobs(generated, { workspace_id, actor = "system" } = {}) {
  if (!generated?.contract || !generated?.cohort || !Array.isArray(generated.proposals)) {
    throw new TypeError("Generated research cohort is required");
  }
  const common = base(generated, workspace_id, actor);
  const screens = [...generated.proposals].sort((a, b) => a.ordinal - b.ordinal).map((proposal) => {
    const symbols = [...new Set(proposal.dna?.scope?.symbols ?? [])].sort();
    if (symbols.length < generated.contract.config.minimum_symbols || symbols.length > generated.contract.config.maximum_symbols) {
      throw new Error(`Trial ${proposal.trial_id} has an unbounded symbol scope`);
    }
    const identity = { ...common, trial_id: proposal.trial_id, ordinal: proposal.ordinal, symbols };
    return { kind: RESEARCH_SCREEN_JOB_KIND, ...identity,
      job_id: `RSJ-${hashCanonical({ kind: RESEARCH_SCREEN_JOB_KIND, ...identity }).slice(0, 32)}` };
  });
  const finalIdentity = { ...common, trial_ids: screens.map((item) => item.trial_id) };
  const finalize = { kind: RESEARCH_FINALIZE_JOB_KIND, ...finalIdentity,
    job_id: `RFJ-${hashCanonical({ kind: RESEARCH_FINALIZE_JOB_KIND, ...finalIdentity }).slice(0, 32)}` };
  // The finalizer is emitted only after the last persisted screen receipt.
  // Enqueuing it here could consume all Queue retries while earlier screens
  // are still serialized through the singleton Durable Object.
  return { screens, finalize, all: screens };
}

export function verifyResearchJob(body, cohort) {
  if (!cohort || body?.cohort_id !== cohort.cohort_id || body.contract_hash !== cohort.contract_hash
      || body.dataset_id !== cohort.contract?.dataset_id || body.dataset_hash !== cohort.contract?.dataset_hash) {
    throw new Error("Research job does not match its frozen cohort contract");
  }
  const kind = body.kind;
  const identity = kind === RESEARCH_SCREEN_JOB_KIND
    ? { workspace_id: body.workspace_id, cohort_id: body.cohort_id, contract_hash: body.contract_hash,
      dataset_id: body.dataset_id, dataset_hash: body.dataset_hash, actor: body.actor,
      trial_id: body.trial_id, ordinal: body.ordinal, symbols: body.symbols }
    : { workspace_id: body.workspace_id, cohort_id: body.cohort_id, contract_hash: body.contract_hash,
      dataset_id: body.dataset_id, dataset_hash: body.dataset_hash, actor: body.actor, trial_ids: body.trial_ids };
  const prefix = kind === RESEARCH_SCREEN_JOB_KIND ? "RSJ" : kind === RESEARCH_FINALIZE_JOB_KIND ? "RFJ" : null;
  if (!prefix || body.job_id !== `${prefix}-${hashCanonical({ kind, ...identity }).slice(0, 32)}`) {
    throw new Error("Research job identity verification failed");
  }
  return true;
}
