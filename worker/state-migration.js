/**
 * Pure state-normalisation and migration contracts.
 *
 * This module deliberately performs no storage I/O.  It turns a legacy
 * Durable Object checkpoint into deterministic records which a D1/R2 writer
 * can persist transactionally in a later integration step.
 */
import { canonicalJson, hashCanonical, sha256 } from "./dsl.js";

export const STATE_MIGRATION_SCHEMA_VERSION = 1;
export const NORMALIZED_STATE_SCHEMA_VERSION = 1;
export const MIGRATION_STEPS = Object.freeze([
  "verify_export", "normalize_records", "verify_references",
  "rebuild_read_model", "compare_parity", "ready_for_cutover",
]);

const ZERO_HASH = "0".repeat(64);
const HASH = /^[a-f0-9]{64}$/;
const ACTIVE_STATES = new Set(["released", "healthy", "watch", "adjusted"]);
const RAW_KEYS = new Set(["bars", "raw_bars", "development_bars", "holdout_bars", "validation_bars",
  "bars_by_symbol", "development", "holdout", "sealed_bars", "body", "payload_bytes"]);
const ARTIFACT_BODY_KEYS = new Set(["equity_curve", "exposure_curve", "signed_exposure_curve", "curves",
  "trades", "closed_trades", "orders", "fills", "ledger"]);
const SECRET = /(secret|password|token|api[_-]?key|hmac|credential|private[_-]?key)/i;

const plain = (value) => value && typeof value === "object" && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
const copy = (value) => JSON.parse(JSON.stringify(value));
const sorted = (items, key) => [...items].sort((a, b) => String(a?.[key] ?? "").localeCompare(String(b?.[key] ?? "")));
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const round = (value, digits = 2) => Number(finite(value).toFixed(digits));
const mean = (values) => values.length ? values.reduce((sum, value) => sum + finite(value), 0) / values.length : 0;
const product = (values) => values.reduce((total, value) => total * finite(value, 1), 1);
const clamp = (value, low, high) => Math.min(high, Math.max(low, finite(value)));

function requireId(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  return value;
}

function requireHash(value, name) {
  if (!HASH.test(String(value))) throw new TypeError(`${name} must be a SHA-256 hash`);
  return String(value);
}

/** Remove raw market data, object bodies, and secrets at every depth. */
export function metadataOnly(value, path = "$") {
  if (value === null || ["string", "boolean", "number"].includes(typeof value)) {
    if (typeof value === "number" && !Number.isFinite(value)) throw new TypeError(`Non-finite metadata at ${path}`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => metadataOnly(item, `${path}[${index}]`));
  if (!plain(value)) throw new TypeError(`Migration metadata must be plain JSON at ${path}`);
  const output = {};
  for (const key of Object.keys(value).sort()) {
    const lower = key.toLowerCase();
    // `development` and `holdout` are also legitimate phase names in run
    // metadata. Only array-valued occurrences are raw dataset slices.
    const raw = (RAW_KEYS.has(lower) && (!new Set(["development", "holdout"]).has(lower) || Array.isArray(value[key])))
      || (ARTIFACT_BODY_KEYS.has(lower) && Array.isArray(value[key]));
    if (raw || SECRET.test(key)) continue;
    output[key] = metadataOnly(value[key], `${path}.${key}`);
  }
  return output;
}

function datasetMetadata(id, value = {}) {
  const dataset = metadataOnly(value);
  return {
    ...dataset,
    dataset_id: String(dataset.dataset_id ?? dataset.id ?? id),
    timeframe_label: evidenceLabel(dataset.timeframe ?? dataset.interval ?? dataset.interval_minutes),
  };
}

function objectDescriptor(value) {
  if (!plain(value)) throw new TypeError("bt object descriptors must be plain data");
  const key = requireId(String(value.key ?? ""), "bt object key");
  if (!key.startsWith("bt:")) throw new TypeError("Only bt:* objects belong in the legacy export");
  const descriptor = metadataOnly(value);
  delete descriptor.key;
  return { key, ...descriptor };
}

/**
 * Export a stable, hashed checkpoint.  `exported_at` is input rather than a
 * clock read, so retries over the same checkpoint are byte-for-byte equal.
 */
export function exportLegacyState(state, { workspace_id = "default", exported_at = "1970-01-01T00:00:00.000Z", bt_objects = [] } = {}) {
  if (!plain(state)) throw new TypeError("Legacy Durable Object state must be plain data");
  requireId(String(workspace_id), "workspace_id");
  const source = metadataOnly({
    schemaVersion: finite(state.schemaVersion, 5), seed: state.seed ?? null, cycle: state.cycle ?? 0,
    marketClock: state.marketClock ?? 0, nextId: state.nextId ?? null,
    lastScheduledBucket: state.lastScheduledBucket ?? null,
    strategies: state.strategies ?? [], events: state.events ?? [], alpaca: state.alpaca ?? { connected: false },
    marketData: state.marketData ?? {}, research: state.research ?? {}, orchestration: state.orchestration ?? {},
    datasets: state.datasets ?? {}, backtestArtifacts: state.backtestArtifacts ?? {},
  });
  const unsigned = {
    schema_version: STATE_MIGRATION_SCHEMA_VERSION,
    kind: "axiom.legacy-state-export",
    workspace_id: String(workspace_id),
    source_schema_version: finite(state.schemaVersion, 5),
    exported_at: String(exported_at),
    source,
    bt_objects: sorted(bt_objects.map(objectDescriptor), "key"),
  };
  const export_hash = hashCanonical(unsigned);
  return Object.freeze({ ...unsigned, export_id: `EXP-${export_hash.slice(0, 32)}`, export_hash });
}

export function verifyLegacyExport(bundle) {
  if (!plain(bundle) || bundle.schema_version !== STATE_MIGRATION_SCHEMA_VERSION
    || bundle.kind !== "axiom.legacy-state-export") throw new TypeError("Unsupported legacy export");
  requireHash(bundle.export_hash, "export_hash");
  const { export_id, export_hash, ...unsigned } = bundle;
  const calculated = hashCanonical(unsigned);
  if (calculated !== export_hash || export_id !== `EXP-${calculated.slice(0, 32)}`) throw new Error("Legacy export hash mismatch");
  // This assertion protects future edits to metadataOnly from accidentally
  // admitting raw bars into a previously accepted wire shape.
  const encoded = canonicalJson(bundle);
  for (const key of [...RAW_KEYS].filter((item) => !["development", "holdout"].includes(item))) {
    if (encoded.includes(`\"${key}\":`)) throw new Error(`Legacy export contains forbidden raw field ${key}`);
  }
  return true;
}

export function evidenceLabel(value) {
  const text = String(value ?? "unknown").trim().toLowerCase().replace(/[_\s-]/g, "");
  if (["5m", "5min", "5minute", "5minutes", "5", "300000"].includes(text)) return "5m";
  if (["1h", "1hour", "60m", "60min", "60minute", "60"].includes(text)) return "legacy_hourly";
  if (["1d", "1day", "day", "daily", "1440", "1440m", "1440min"].includes(text)) return "legacy_daily";
  return "unknown";
}

function artifactRecords(source, btObjects) {
  const records = [];
  for (const [id, value] of Object.entries(source.backtestArtifacts ?? {})) {
    const item = metadataOnly(value);
    records.push({ artifact_id: String(item.artifact_id ?? item.id ?? id), source: "durable_object",
      object_key: item.object_key ?? item.r2_key ?? null,
      content_hash: item.content_hash ?? item.sha256 ?? null,
      expected_hash: item.expected_hash ?? item.content_hash ?? item.sha256 ?? null,
      dataset_id: item.dataset_id ?? null,
      timeframe_label: evidenceLabel(item.timeframe ?? item.interval ?? item.interval_minutes), metadata: item });
  }
  for (const object of btObjects) {
    const id = String(object.artifact_id ?? object.id ?? object.key);
    records.push({ artifact_id: id, source: "bt_object", object_key: object.object_key ?? object.r2_key ?? null,
      legacy_object_key: object.key,
      content_hash: object.content_hash ?? object.sha256 ?? object.etag ?? null,
      expected_hash: object.expected_hash ?? object.sha256 ?? object.content_hash ?? null,
      dataset_id: object.dataset_id ?? null,
      timeframe_label: evidenceLabel(object.timeframe ?? object.interval ?? object.interval_minutes), metadata: object });
  }
  const unique = new Map();
  for (const item of sorted(records, "artifact_id")) {
    const prior = unique.get(item.artifact_id);
    if (!prior) { unique.set(item.artifact_id, item); continue; }
    const incompatible = ["object_key", "content_hash", "expected_hash", "dataset_id"].some((key) => prior[key] && item[key] && prior[key] !== item[key]);
    if (incompatible) throw new Error(`Conflicting artifact identity ${item.artifact_id}`);
    const timeframe_label = prior.timeframe_label === "unknown" ? item.timeframe_label
      : item.timeframe_label === "unknown" || item.timeframe_label === prior.timeframe_label ? prior.timeframe_label : "mixed";
    unique.set(item.artifact_id, { ...prior, ...Object.fromEntries(Object.entries(item).filter(([, value]) => value !== null)),
      source: "durable_object+bt_object", timeframe_label, metadata: { ...prior.metadata, ...item.metadata } });
  }
  return [...unique.values()];
}

function normalizeRuns(strategy) {
  return Object.fromEntries(Object.entries(strategy.backtest_runs ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([phase, run]) => {
    const value = metadataOnly(run ?? {});
    return [phase, { ...value, phase, artifact_id: value.artifact_id ?? value.id ?? null,
      dataset_id: value.dataset_id ?? strategy.dataset_id ?? null,
      timeframe_label: evidenceLabel(value.timeframe ?? value.interval ?? value.interval_minutes) }];
  }));
}

function normalizeLifecycle(strategy) {
  const lifecycle = metadataOnly(strategy.lifecycle ?? {});
  const fallback = ({ generated: "screened", rework: "development", validation: "sealed_validation",
    capacity_wait: "capacity_wait", incubation: "incubation", released: "released_paper", healthy: "released_paper",
    adjusted: "released_paper", watch: "watch", development_reject: "development_reject",
    holdout_reject: "holdout_reject", inconclusive: "inconclusive", superseded: "superseded", dropped: "retired" })[strategy.state] ?? "proposed";
  return {
    schema_version: finite(lifecycle.schema_version, 1), strategy_id: String(strategy.id),
    quality: lifecycle.quality ?? { state: fallback, version: 0 },
    operational: lifecycle.operational ?? { state: "ready", version: 0 },
    provenance: lifecycle.provenance ?? {
      dna_hash: HASH.test(String(strategy.dna_hash)) ? strategy.dna_hash : ZERO_HASH,
      dataset_hash: ZERO_HASH, configuration_hash: ZERO_HASH, policy_hash: ZERO_HASH,
    },
    history: lifecycle.history ?? [], results: lifecycle.results ?? {}, created_at: lifecycle.created_at ?? null,
  };
}

/** Convert one verified export to table-shaped, deterministic records. */
export function normalizeLegacyExport(bundle) {
  verifyLegacyExport(bundle);
  const source = bundle.source;
  const datasets = sorted(Object.entries(source.datasets ?? {}).map(([id, value]) => datasetMetadata(id, value)), "dataset_id");
  const artifacts = artifactRecords(source, bundle.bt_objects);
  const strategies = [], strategyDna = [], lineages = [], transitions = [], operational = [];
  for (const raw of sorted(source.strategies ?? [], "id")) {
    const strategy = metadataOnly(raw);
    const strategy_id = requireId(String(strategy.id ?? ""), "strategy.id");
    const runs = normalizeRuns(strategy);
    const lifecycle = normalizeLifecycle(strategy);
    strategies.push({ strategy_id, state: strategy.state ?? "generated", lineage_id: String(strategy.lineage_id
      ?? strategy.strategy_dna?.lineage?.root_strategy_id ?? strategy.strategy_dna?.lineage?.parent_strategy_id ?? strategy_id),
    dna_hash: strategy.dna_hash ?? strategy.strategy_dna?.dna_hash ?? null, dataset_id: strategy.dataset_id ?? null,
    metrics: strategy.metrics ?? null, validation: strategy.validation ?? null,
    backtest_runs: runs, snapshot: { ...strategy, backtest_runs: runs, lifecycle } });
    if (strategy.strategy_dna) strategyDna.push({ strategy_id, dna_hash: strategy.strategy_dna.dna_hash ?? strategy.dna_hash,
      document: strategy.strategy_dna });
    lineages.push({ lineage_id: strategies.at(-1).lineage_id, strategy_id,
      parent_strategy_id: strategy.parent ?? strategy.strategy_dna?.lineage?.parent_strategy_id ?? null,
      generation: finite(strategy.generation ?? strategy.strategy_dna?.lineage?.generation, 1) });
    for (const transition of lifecycle.history ?? []) transitions.push({ ...transition, strategy_id });
    operational.push({ strategy_id, ...lifecycle.operational });
  }
  const cohorts = sorted((source.research?.cohorts ?? []).map((item) => metadataOnly(item)), "cohort_id");
  const trials = sorted(Object.entries(source.research?.trials ?? {}).map(([id, value]) => ({
    ...metadataOnly(value ?? {}), trial_id: String(value?.trial_id ?? id),
  })), "trial_id");
  const normalized = {
    schema_version: NORMALIZED_STATE_SCHEMA_VERSION, kind: "axiom.normalized-state",
    workspace: { workspace_id: bundle.workspace_id, source_schema_version: bundle.source_schema_version,
      source_export_id: bundle.export_id, source_export_hash: bundle.export_hash,
      seed: source.seed, cycle: source.cycle, market_clock: source.marketClock,
      last_scheduled_bucket: source.lastScheduledBucket ?? null, alpaca: source.alpaca ?? { connected: false },
      market_data: source.marketData ?? {}, research: source.research ?? {}, orchestration: source.orchestration ?? {} },
    strategies, strategy_dna: sorted(strategyDna, "strategy_id"), lineages: sorted(lineages, "strategy_id"),
    cohorts, trials, lifecycle_transitions: sorted(transitions, "transition_id"), operational_status: sorted(operational, "strategy_id"),
    events: metadataOnly(source.events ?? []), datasets, artifact_manifests: sorted(artifacts, "artifact_id"),
  };
  const normalized_hash = hashCanonical(normalized);
  return Object.freeze({ ...normalized, normalized_id: `NRM-${normalized_hash.slice(0, 32)}`, normalized_hash });
}

function runEvidence(strategy, datasets, artifacts) {
  const labels = new Set();
  const datasetIndex = new Map(datasets.map((item) => [item.dataset_id, item]));
  const artifactIndex = new Map(artifacts.map((item) => [item.artifact_id, item]));
  const addDataset = (id) => { const item = datasetIndex.get(id); if (item) labels.add(item.timeframe_label); };
  addDataset(strategy.dataset_id);
  for (const run of Object.values(strategy.backtest_runs ?? {})) {
    addDataset(run.dataset_id);
    const artifact = artifactIndex.get(run.artifact_id);
    if (artifact) labels.add(artifact.timeframe_label);
    if (run.timeframe_label !== "unknown") labels.add(run.timeframe_label);
  }
  labels.delete("unknown");
  return [...labels].sort();
}

/** Validate all references and return cutover-blocking findings. */
export function validateNormalizedState(value) {
  const issues = [];
  const add = (code, entity_type, entity_id, message, severity = "critical") => issues.push({ code, entity_type, entity_id, message, severity });
  if (!plain(value) || value.schema_version !== NORMALIZED_STATE_SCHEMA_VERSION) throw new TypeError("Unsupported normalized state");
  if (value.normalized_hash) {
    const { normalized_id, normalized_hash, ...unsigned } = value;
    const calculated = hashCanonical(unsigned);
    if (normalized_hash !== calculated || normalized_id !== `NRM-${calculated.slice(0, 32)}`) add("normalized_hash_mismatch", "normalized_state",
      String(normalized_id ?? "missing"), "Normalized state changed after its content hash was created");
  }
  const ids = (items, key, type) => {
    const set = new Set();
    for (const item of items ?? []) {
      if (!item?.[key] || set.has(item[key])) add("duplicate_identity", type, String(item?.[key] ?? "missing"), `Duplicate or missing ${key}`);
      set.add(item?.[key]);
    }
    return set;
  };
  const strategyIds = ids(value.strategies, "strategy_id", "strategy");
  const dnaIds = ids(value.strategy_dna, "strategy_id", "strategy_dna");
  const datasetIds = ids(value.datasets, "dataset_id", "dataset");
  const artifactIds = ids(value.artifact_manifests, "artifact_id", "artifact");
  const cohortIds = ids(value.cohorts, "cohort_id", "cohort");
  for (const strategy of value.strategies ?? []) {
    if (strategy.dna_hash && !dnaIds.has(strategy.strategy_id)) add("orphan_dna_reference", "strategy", strategy.strategy_id, "Strategy DNA record is missing");
    if (strategy.dataset_id && !datasetIds.has(strategy.dataset_id)) add("orphan_dataset_reference", "strategy", strategy.strategy_id, `Missing dataset ${strategy.dataset_id}`);
    if (strategy.snapshot?.cohort_id && !cohortIds.has(strategy.snapshot.cohort_id)) add("orphan_cohort_reference", "strategy", strategy.strategy_id, `Missing cohort ${strategy.snapshot.cohort_id}`);
    if (strategy.snapshot?.trial_id && !(value.trials ?? []).some((item) => item.trial_id === strategy.snapshot.trial_id)) add("orphan_trial_reference", "strategy", strategy.strategy_id, `Missing trial ${strategy.snapshot.trial_id}`);
    const provenance = strategy.snapshot?.lifecycle?.provenance ?? {};
    if (strategy.dna_hash && HASH.test(String(provenance.dna_hash)) && provenance.dna_hash !== strategy.dna_hash) add("provenance_dna_mismatch", "strategy", strategy.strategy_id, "Lifecycle provenance does not match strategy DNA");
    const boundDataset = (value.datasets ?? []).find((item) => item.dataset_id === strategy.dataset_id);
    const boundDatasetHash = boundDataset?.sha256 ?? boundDataset?.dataset_hash ?? null;
    if (boundDatasetHash && HASH.test(String(provenance.dataset_hash)) && provenance.dataset_hash !== ZERO_HASH
      && provenance.dataset_hash !== boundDatasetHash) add("provenance_dataset_mismatch", "strategy", strategy.strategy_id, "Lifecycle provenance does not match the referenced dataset");
    const parent = value.lineages.find((item) => item.strategy_id === strategy.strategy_id)?.parent_strategy_id;
    if (parent && !strategyIds.has(parent)) add("orphan_parent_reference", "strategy", strategy.strategy_id, `Missing parent strategy ${parent}`);
    for (const run of Object.values(strategy.backtest_runs ?? {})) {
      if (run.dataset_id && !datasetIds.has(run.dataset_id)) add("orphan_dataset_reference", "backtest_run", `${strategy.strategy_id}:${run.phase}`, `Missing dataset ${run.dataset_id}`);
      if (run.artifact_id && !artifactIds.has(run.artifact_id)) add("orphan_artifact_reference", "backtest_run", `${strategy.strategy_id}:${run.phase}`, `Missing artifact ${run.artifact_id}`);
      const runDataset = (value.datasets ?? []).find((item) => item.dataset_id === run.dataset_id);
      const runArtifact = (value.artifact_manifests ?? []).find((item) => item.artifact_id === run.artifact_id);
      if (runDataset?.timeframe_label === "unknown" || runArtifact?.timeframe_label === "unknown") add("unlabeled_evidence_timeframe", "backtest_run",
        `${strategy.strategy_id}:${run.phase}`, "Decision evidence must be explicitly labeled as five-minute or legacy");
    }
    const labels = runEvidence(strategy, value.datasets ?? [], value.artifact_manifests ?? []);
    if (labels.includes("5m") && labels.some((item) => item.startsWith("legacy_"))) add("mixed_evidence_timeframes", "strategy", strategy.strategy_id,
      "Legacy daily/hourly evidence cannot be combined with five-minute decision evidence");
  }
  for (const dna of value.strategy_dna ?? []) {
    if (!strategyIds.has(dna.strategy_id)) add("orphan_strategy_reference", "strategy_dna", dna.strategy_id, "DNA points to a missing strategy");
    if (dna.dna_hash && HASH.test(String(dna.dna_hash))) {
      const { strategy_id, dna_hash, ...body } = dna.document ?? {};
      if (sha256(body) !== dna.dna_hash) add("corrupt_dna_hash", "strategy_dna", dna.strategy_id, "DNA hash does not match its canonical document");
    }
  }
  for (const trial of value.trials ?? []) if (trial.cohort_id && !cohortIds.has(trial.cohort_id)) add("orphan_cohort_reference", "trial", trial.trial_id, `Missing cohort ${trial.cohort_id}`);
  for (const artifact of value.artifact_manifests ?? []) {
    if (artifact.dataset_id && !datasetIds.has(artifact.dataset_id)) add("orphan_dataset_reference", "artifact", artifact.artifact_id, `Missing dataset ${artifact.dataset_id}`);
    if (artifact.expected_hash && artifact.content_hash && artifact.expected_hash !== artifact.content_hash) add("corrupt_artifact_hash", "artifact", artifact.artifact_id, "Artifact content hash does not match its manifest");
    if (artifact.timeframe_label === "mixed") add("conflicting_artifact_timeframe", "artifact", artifact.artifact_id, "Artifact descriptors disagree about their timeframe");
  }
  for (const transition of value.lifecycle_transitions ?? []) {
    if (!strategyIds.has(transition.strategy_id)) add("orphan_strategy_reference", "lifecycle_transition", transition.transition_id, "Transition points to a missing strategy");
    if (transition.artifact_id && !transition.artifact_id.startsWith("dna:") && !transition.artifact_id.startsWith("migration:")
      && !artifactIds.has(transition.artifact_id)) add("orphan_artifact_reference", "lifecycle_transition", transition.transition_id, `Missing artifact ${transition.artifact_id}`);
  }
  return Object.freeze({ valid: !issues.some((item) => item.severity === "critical"), cutover_blocked: issues.some((item) => item.severity === "critical"), issues });
}

function publicResearch(research = {}) {
  const latest = research.cohorts?.at(-1) ?? null;
  const burns = Object.values(research.holdout_burn_ledger?.by_lineage ?? {});
  return { schema_version: research.schema_version ?? 2, engine_version: research.engine_version ?? "1.0.0",
    paused: Boolean(research.paused), pause_reason: research.pause_reason ?? null,
    last_completed_session: research.last_completed_session ?? null, total_trials: finite(research.total_trials),
    total_expensive_dispatches: finite(research.total_expensive_dispatches), population_size: research.population?.length ?? 0,
    novelty_archive_size: research.novelty_archive?.dna_hashes?.length ?? 0,
    holdout: { total_burns: finite(research.holdout_burn_ledger?.total_burns), completed: burns.filter((item) => item.outcome).length,
      pending: burns.filter((item) => !item.outcome).length }, budget: { ...(research.budget ?? {}) },
    latest_cohort: latest ? { cohort_id: latest.cohort_id, session_date: latest.session_date, status: latest.status,
      attempted: latest.attempted, valid: latest.valid, duplicates: latest.duplicates,
      finalists: latest.finalists?.length ?? 0, completed_at: latest.completed_at ?? null } : null };
}

/** Recreate the frontend contract using normalized records only. */
export function rebuildNormalizedReadModel(value) {
  const strategies = value.strategies.map((item) => copy(item.snapshot));
  const released = strategies.filter((item) => ACTIVE_STATES.has(item.state));
  const scored = strategies.filter((item) => item.metrics);
  const simulated = released.length ? 100000 * product(released.map((item) => 1 + clamp(mean(item.monitor?.returns ?? []), -.02, .02))) : 100000;
  const alpaca = copy(value.workspace.alpaca ?? { connected: false });
  const capital = alpaca.connected ? finite(alpaca.account?.equity, simulated) : simulated;
  return {
    meta: { cycle: finite(value.workspace.cycle), clock: finite(value.workspace.market_clock),
      environment: alpaca.connected ? "ALPACA PAPER" : "PAPER SIM", schema_version: value.workspace.source_schema_version,
      seed: value.workspace.seed, last_scheduled_bucket: value.workspace.last_scheduled_bucket },
    summary: { generated: strategies.filter((item) => item.state === "generated").length,
      testing: strategies.filter((item) => item.state === "rework").length,
      validation: strategies.filter((item) => ["validation", "capacity_wait"].includes(item.state)).length,
      released: released.length,
      dropped: strategies.filter((item) => ["development_reject", "holdout_reject", "inconclusive", "dropped"].includes(item.state)).length,
      average_score: round(mean(scored.map((item) => item.metrics.score)), 1), capital: round(capital, 2) },
    strategies, events: copy(value.events), alpaca,
    market_data: { schema_version: value.workspace.market_data?.schema_version ?? 1,
      mode: value.workspace.market_data?.mode ?? "off", universe: value.workspace.market_data?.universe ?? null,
      calendar: value.workspace.market_data?.calendar ?? null, backfill: value.workspace.market_data?.backfill ?? null,
      live: value.workspace.market_data?.live ?? null },
    research: publicResearch(value.workspace.research), orchestration: copy(value.workspace.orchestration ?? {}),
    policy: { release_score: 61, min_sharpe: .55, max_drawdown: .20,
      validation_min_sharpe: .30, validation_max_drawdown: .20, monitor_window: 21 },
  };
}

/** Counts and hashes prevent a superficially-equal migration from cutting over. */
export function compareMigrationParity(bundle, normalized, readModel = rebuildNormalizedReadModel(normalized)) {
  verifyLegacyExport(bundle);
  const mismatches = [];
  const compare = (field, source, target) => { if (source !== target) mismatches.push({ field, source, target }); };
  compare("strategy_count", bundle.source.strategies?.length ?? 0, normalized.strategies.length);
  compare("read_model_strategy_count", bundle.source.strategies?.length ?? 0, readModel.strategies.length);
  compare("event_count", bundle.source.events?.length ?? 0, normalized.events.length);
  compare("cohort_count", bundle.source.research?.cohorts?.length ?? 0, normalized.cohorts.length);
  compare("trial_count", Object.keys(bundle.source.research?.trials ?? {}).length, normalized.trials.length);
  for (const source of bundle.source.strategies ?? []) {
    const target = normalized.strategies.find((item) => item.strategy_id === source.id);
    if (!target) continue;
    compare(`state:${source.id}`, source.state ?? "generated", target.state);
    compare(`metrics:${source.id}`, hashCanonical(source.metrics ?? null), hashCanonical(target.metrics ?? null));
    compare(`lifecycle:${source.id}`, hashCanonical(normalizeLifecycle(source).quality), hashCanonical(target.snapshot.lifecycle.quality));
    compare(`provenance:${source.id}`, hashCanonical(normalizeLifecycle(source).provenance), hashCanonical(target.snapshot.lifecycle.provenance));
  }
  const integrity = validateNormalizedState(normalized);
  return Object.freeze({ passed: mismatches.length === 0 && integrity.valid, cutover_ready: mismatches.length === 0 && !integrity.cutover_blocked,
    mismatches, integrity, parity_hash: hashCanonical({ export_hash: bundle.export_hash, normalized_hash: normalized.normalized_hash, mismatches, issues: integrity.issues }) });
}

export function createMigrationPlan(bundle) {
  verifyLegacyExport(bundle);
  const planHash = hashCanonical({ schema_version: STATE_MIGRATION_SCHEMA_VERSION, export_hash: bundle.export_hash,
    target_schema_version: NORMALIZED_STATE_SCHEMA_VERSION, steps: MIGRATION_STEPS });
  return Object.freeze({ schema_version: STATE_MIGRATION_SCHEMA_VERSION, migration_id: `MIG-${planHash.slice(0, 32)}`,
    workspace_id: bundle.workspace_id, export_id: bundle.export_id, export_hash: bundle.export_hash,
    target_schema_version: NORMALIZED_STATE_SCHEMA_VERSION, steps: MIGRATION_STEPS.map((step, ordinal) => ({ step, ordinal, status: "pending" })), plan_hash: planHash });
}

export function initialMigrationRecord(plan) {
  return Object.freeze({ schema_version: STATE_MIGRATION_SCHEMA_VERSION, migration_id: plan.migration_id,
    plan_hash: plan.plan_hash, status: "pending", next_step: MIGRATION_STEPS[0], completed: {}, failures: {}, version: 0 });
}

/** Advance exactly one step. Replaying the same outcome returns the same record. */
export function advanceMigrationRecord(plan, current, { step, status = "complete", result_hash, detail = null } = {}) {
  if (plan.plan_hash !== current.plan_hash || plan.migration_id !== current.migration_id) throw new Error("Migration plan/record mismatch");
  if (!MIGRATION_STEPS.includes(step) || !["complete", "failed"].includes(status)) throw new TypeError("Invalid migration step result");
  requireHash(result_hash, "result_hash");
  const outcome = { status, result_hash, detail: metadataOnly(detail) };
  const completed = current.completed?.[step];
  if (completed) {
    if (hashCanonical(completed) !== hashCanonical(outcome)) throw new Error(`Migration step ${step} was already recorded with a different result`);
    return current;
  }
  if (current.next_step !== step) throw new Error(`Expected migration step ${current.next_step}`);
  const next = copy(current);
  const failures = Array.isArray(next.failures[step]) ? next.failures[step] : next.failures[step] ? [next.failures[step]] : [];
  if (status === "failed" && failures.some((item) => hashCanonical(item) === hashCanonical(outcome))) return current;
  if (status === "complete") next.completed[step] = outcome;
  else next.failures[step] = [...failures, outcome];
  next.version += 1;
  if (status === "failed") { next.status = "blocked"; next.next_step = step; }
  else {
    const index = MIGRATION_STEPS.indexOf(step);
    next.next_step = MIGRATION_STEPS[index + 1] ?? null;
    next.status = next.next_step ? "running" : "complete";
  }
  return Object.freeze(next);
}
