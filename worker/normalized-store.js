import { sha256 } from "./backtest.js";

const json = (value) => JSON.stringify(value ?? {});
const rows = (result) => result?.results ?? [];
const iso = (value) => new Date(value).toISOString();
const field = (value, snake, camel = snake) => value?.[snake] ?? value?.[camel];
const optional = (value) => value === undefined ? null : value;

// This allowlist is deliberately static. Reset preparation must never accept a
// browser-provided table name or predicate.
export const NORMALIZED_WORKSPACE_TABLES = Object.freeze([
  ["normalized_read_models", ["read_model_id"]],
  ["workspace_reset_targets", ["reset_manifest_id", "target_id"]],
  ["workspace_reset_manifests", ["reset_manifest_id"]],
  ["workspace_migration_steps", ["migration_manifest_id", "step_id"]],
  ["workspace_migration_manifests", ["migration_manifest_id"]],
  ["audit_events", ["audit_event_id"]],
  ["idempotency_records", ["idempotency_key"]],
  ["outbox", ["outbox_id"]],
  ["attribution", ["attribution_id"]],
  ["positions", ["position_snapshot_id"]],
  ["fills", ["fill_id"]],
  ["orders", ["order_id"]],
  ["broker_intents", ["broker_intent_id"]],
  ["risk_actions", ["risk_action_id"]],
  ["strategy_health", ["strategy_health_id"]],
  ["releases", ["release_id"]],
  ["incubation_trades", ["incubation_trade_id"]],
  ["incubation_days", ["incubation_day_id"]],
  ["incubations", ["incubation_id"]],
  ["data_health", ["data_health_id"]],
  ["bar_events", ["bar_event_id"]],
  ["market_sessions", ["market_session_id"]],
  ["job_leases", ["job_id"]],
  ["job_attempts", ["attempt_id"]],
  ["research_jobs", ["job_id"]],
  ["incidents", ["incident_id"]],
  ["operational_status", ["operational_status_id"]],
  ["lifecycle_transitions", ["transition_id"]],
  ["trials", ["trial_id"]],
  ["holdout_access_ledger", ["access_id"]],
  ["artifact_manifests", ["artifact_id"]],
  ["dataset_slice_partitions", ["dataset_slice_id", "partition_id"]],
  ["dataset_slices", ["dataset_slice_id"]],
  ["dataset_members", ["dataset_id", "partition_id"]],
  ["dataset_partitions", ["partition_id"]],
  ["datasets", ["dataset_id"]],
  ["cohorts", ["cohort_id"]],
  ["lineages", ["lineage_id"]],
  ["strategy_dna", ["dna_id"]],
  ["strategies", ["strategy_id"]],
  ["compiler_versions", ["compiler_version_id"]],
  ["engine_versions", ["engine_version_id"]],
  ["calendar_versions", ["calendar_version_id"]],
  ["universe_versions", ["universe_version_id"]],
  ["supervisor_policy_versions", ["policy_version_id"]],
  ["system_config_versions", ["config_version_id"]],
  ["workspaces", ["workspace_id"]],
]);

function required(value, label) {
  if (value === undefined || value === null || value === "") throw new Error(`${label} is required`);
  return value;
}

function validHash(value) { return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value); }

async function deterministicId(prefix, value) {
  return `${prefix}-${await sha256(value)}`;
}

export class NormalizedStore {
  constructor(db, { clock = () => new Date(), batchSize = 75 } = {}) {
    if (!db) throw new Error("AXIOM_DB is required");
    this.db = db;
    this.clock = clock;
    this.batchSize = Math.max(1, Math.min(100, batchSize));
  }

  now() { return iso(this.clock()); }
  statement(sql, ...values) { return this.db.prepare(sql).bind(...values); }

  async batch(statements) {
    const results = [];
    for (let start = 0; start < statements.length; start += this.batchSize) {
      results.push(...await this.db.batch(statements.slice(start, start + this.batchSize)));
    }
    return results;
  }

  workspaceStatement(workspace, now) {
    const workspaceId = required(field(workspace, "workspace_id", "workspaceId"), "workspace.workspaceId");
    return this.statement(`INSERT INTO workspaces
      (workspace_id,display_name,environment,status,created_at,updated_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(workspace_id) DO UPDATE SET display_name=excluded.display_name,
      environment=excluded.environment,status=excluded.status,updated_at=excluded.updated_at`,
    workspaceId, field(workspace, "display_name", "displayName") ?? workspaceId,
    workspace.environment ?? "development", workspace.status ?? "active",
    field(workspace, "created_at", "createdAt") ?? now, now);
  }

  async persistSnapshotProjection({ workspaceId, stateHash, schemaVersion, strategies = [], readModel,
    comparisonStatus = "pending", environment = "development" }) {
    const now = this.now();
    await this.batch([this.workspaceStatement({ workspaceId, environment, status: "active" }, now)]);
    const statements = strategies.map((item) => this.strategyStatement(workspaceId, {
      strategyId: item.id ?? item.strategy_id, name: item.name ?? item.id, archetype: item.archetype ?? "unknown",
      generation: item.generation ?? 0,
      qualityState: item.lifecycle?.quality?.state ?? item.current_quality_state ?? "proposed",
      operationalState: item.lifecycle?.operational?.state ?? item.current_operational_state ?? "ready",
      createdAt: item.lifecycle?.created_at ?? now,
      retiredAt: ["retired", "dropped"].includes(item.lifecycle?.quality?.state ?? item.state) ? now : null,
    }, now));
    await this.batch(statements);
    const responseHash = await sha256(readModel);
    const readModelId = await deterministicId("read", { workspaceId, stateHash, schemaVersion, responseHash });
    await this.statement(`INSERT INTO normalized_read_models
      (workspace_id,read_model_id,source_checkpoint_hash,schema_version,response_json,response_hash,comparison_status,created_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,source_checkpoint_hash,schema_version) DO UPDATE SET
      response_json=excluded.response_json,response_hash=excluded.response_hash,
      comparison_status=excluded.comparison_status,created_at=excluded.created_at`, workspaceId, readModelId,
    stateHash, Number(schemaVersion), json(readModel), responseHash, comparisonStatus, now).run();
    return { workspaceId, readModelId, responseHash, comparisonStatus };
  }

  async persistExport(exported) {
    const workspace = required(exported?.workspace, "workspace");
    const workspaceId = required(field(workspace, "workspace_id", "workspaceId"), "workspace.workspaceId");
    const now = this.now();
    await this.batch([this.workspaceStatement(workspace, now)]);

    const statements = [];
    for (const item of exported.compilerVersions ?? []) statements.push(this.compilerVersionStatement(workspaceId, item, now));
    for (const item of exported.supervisorPolicyVersions ?? []) statements.push(this.policyVersionStatement(workspaceId, item, now));
    for (const item of exported.universeVersions ?? []) statements.push(this.universeVersionStatement(workspaceId, item, now));
    for (const item of exported.calendarVersions ?? []) statements.push(this.calendarVersionStatement(workspaceId, item, now));
    for (const item of exported.strategies ?? []) statements.push(this.strategyStatement(workspaceId, item, now));
    for (const item of exported.strategyDna ?? exported.strategy_dna ?? []) statements.push(this.dnaStatement(workspaceId, item, now));
    for (const item of exported.lineages ?? []) statements.push(this.lineageStatement(workspaceId, item, now));
    for (const item of exported.cohorts ?? []) statements.push(this.cohortStatement(workspaceId, item, now));
    for (const item of exported.datasets ?? []) statements.push(this.datasetStatement(workspaceId, item, now));
    for (const item of exported.datasetSlices ?? []) statements.push(this.datasetSliceStatement(workspaceId, item, now));
    for (const item of exported.trials ?? []) statements.push(this.trialStatement(workspaceId, item, now));
    for (const item of exported.lifecycleTransitions ?? []) statements.push(await this.lifecycleStatement(workspaceId, item, now));
    for (const item of exported.auditEvents ?? []) statements.push(await this.auditStatement(workspaceId, item, now));
    await this.batch(statements);

    const response = exported.readModel ?? exported.normalizedReadModel ?? exported.snapshot ?? exported;
    const sourceCheckpointHash = validHash(exported.sourceCheckpointHash)
      ? exported.sourceCheckpointHash
      : await sha256(exported.sourceCheckpoint ?? exported.snapshot ?? exported);
    const schemaVersion = Number(exported.schemaVersion ?? 5);
    const responseHash = await sha256(response);
    const readModelId = await deterministicId("read", { workspaceId, sourceCheckpointHash, schemaVersion, responseHash });
    await this.statement(`INSERT INTO normalized_read_models
      (workspace_id,read_model_id,source_checkpoint_hash,schema_version,response_json,response_hash,comparison_status,created_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,source_checkpoint_hash,schema_version) DO UPDATE SET
      response_json=excluded.response_json,response_hash=excluded.response_hash,
      comparison_status=excluded.comparison_status,created_at=excluded.created_at`,
    workspaceId, readModelId, sourceCheckpointHash, schemaVersion, json(response), responseHash,
    exported.comparisonStatus ?? "pending", now).run();
    return { workspaceId, readModelId, sourceCheckpointHash, responseHash, schemaVersion };
  }

  compilerVersionStatement(workspaceId, item, now) {
    return this.statement(`INSERT INTO compiler_versions
      (workspace_id,compiler_version_id,language_version,compiler_version,implementation_hash,created_at)
      VALUES (?,?,?,?,?,?) ON CONFLICT(workspace_id,compiler_version_id) DO NOTHING`, workspaceId,
    required(field(item, "compiler_version_id", "compilerVersionId"), "compilerVersionId"),
    field(item, "language_version", "languageVersion") ?? "legacy",
    field(item, "compiler_version", "compilerVersion") ?? "legacy-import",
    required(field(item, "implementation_hash", "implementationHash"), "compiler implementationHash"),
    field(item, "created_at", "createdAt") ?? now);
  }

  policyVersionStatement(workspaceId, item, now) {
    const policy = item.policy ?? item.policy_json ?? {};
    return this.statement(`INSERT INTO supervisor_policy_versions
      (workspace_id,policy_version_id,schema_version,policy_json,policy_hash,effective_from,created_at,approved_by)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,policy_version_id) DO NOTHING`, workspaceId,
    required(field(item, "policy_version_id", "policyVersionId"), "policyVersionId"), Number(item.schemaVersion ?? 1),
    typeof policy === "string" ? policy : json(policy), required(field(item, "policy_hash", "policyHash"), "policyHash"),
    field(item, "effective_from", "effectiveFrom") ?? now, field(item, "created_at", "createdAt") ?? now,
    field(item, "approved_by", "approvedBy") ?? "migration");
  }

  universeVersionStatement(workspaceId, item, now) {
    return this.statement(`INSERT INTO universe_versions
      (workspace_id,universe_version_id,feed,symbols_object_key,symbols_hash,symbol_count,effective_from,created_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,universe_version_id) DO NOTHING`, workspaceId,
    required(field(item, "universe_version_id", "universeVersionId"), "universeVersionId"), item.feed ?? "iex",
    required(field(item, "symbols_object_key", "symbolsObjectKey"), "symbolsObjectKey"),
    required(field(item, "symbols_hash", "symbolsHash"), "symbolsHash"), Number(item.symbolCount ?? item.symbol_count ?? 0),
    field(item, "effective_from", "effectiveFrom") ?? now, field(item, "created_at", "createdAt") ?? now);
  }

  calendarVersionStatement(workspaceId, item, now) {
    return this.statement(`INSERT INTO calendar_versions
      (workspace_id,calendar_version_id,market,first_session,last_session,session_count,object_key,content_hash,created_at)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,calendar_version_id) DO NOTHING`, workspaceId,
    required(field(item, "calendar_version_id", "calendarVersionId"), "calendarVersionId"), item.market ?? "XNYS",
    required(field(item, "first_session", "firstSession"), "firstSession"), required(field(item, "last_session", "lastSession"), "lastSession"),
    Number(item.sessionCount ?? item.session_count ?? 0), required(field(item, "object_key", "objectKey"), "calendar objectKey"),
    required(field(item, "content_hash", "contentHash"), "calendar contentHash"), field(item, "created_at", "createdAt") ?? now);
  }

  strategyStatement(workspaceId, item, now) {
    return this.statement(`INSERT INTO strategies
      (workspace_id,strategy_id,strategy_name,archetype,generation,current_quality_state,current_operational_state,created_at,retired_at)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,strategy_id) DO UPDATE SET
      strategy_name=excluded.strategy_name,archetype=excluded.archetype,generation=excluded.generation,
      current_quality_state=excluded.current_quality_state,current_operational_state=excluded.current_operational_state,
      retired_at=excluded.retired_at`, workspaceId, required(field(item, "strategy_id", "strategyId"), "strategyId"),
    field(item, "strategy_name", "name") ?? field(item, "strategy_id", "strategyId"), item.archetype ?? "unknown",
    Number(item.generation ?? 0), field(item, "current_quality_state", "qualityState") ?? "proposed",
    field(item, "current_operational_state", "operationalState") ?? "ready",
    field(item, "created_at", "createdAt") ?? now, optional(field(item, "retired_at", "retiredAt")));
  }

  dnaStatement(workspaceId, item, now) {
    const dna = item.dna ?? item.dna_json ?? {};
    return this.statement(`INSERT INTO strategy_dna
      (workspace_id,dna_id,strategy_id,schema_version,language_version,dna_json,dna_hash,compiler_version_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,dna_id) DO NOTHING`, workspaceId,
    required(field(item, "dna_id", "dnaId"), "dnaId"), required(field(item, "strategy_id", "strategyId"), "dna strategyId"),
    Number(item.schemaVersion ?? item.schema_version ?? 1), field(item, "language_version", "languageVersion") ?? "legacy",
    typeof dna === "string" ? dna : json(dna), required(field(item, "dna_hash", "dnaHash"), "dnaHash"),
    required(field(item, "compiler_version_id", "compilerVersionId"), "dna compilerVersionId"), field(item, "created_at", "createdAt") ?? now);
  }

  lineageStatement(workspaceId, item, now) {
    return this.statement(`INSERT INTO lineages
      (workspace_id,lineage_id,child_strategy_id,parent_strategy_id,operation,mutation_seed,mutation_json,created_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,lineage_id) DO NOTHING`, workspaceId,
    required(field(item, "lineage_id", "lineageId"), "lineageId"), required(field(item, "child_strategy_id", "childStrategyId"), "childStrategyId"),
    optional(field(item, "parent_strategy_id", "parentStrategyId")), item.operation ?? "origin", optional(item.mutationSeed ?? item.mutation_seed),
    json(item.mutation ?? item.mutation_json ?? {}), field(item, "created_at", "createdAt") ?? now);
  }

  cohortStatement(workspaceId, item, now) {
    return this.statement(`INSERT INTO cohorts
      (workspace_id,cohort_id,universe_version_id,policy_version_id,generation_seed,requested_trials,status,created_at,completed_at)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,cohort_id) DO UPDATE SET status=excluded.status,completed_at=excluded.completed_at`, workspaceId,
    required(field(item, "cohort_id", "cohortId"), "cohortId"), required(field(item, "universe_version_id", "universeVersionId"), "cohort universeVersionId"),
    required(field(item, "policy_version_id", "policyVersionId"), "cohort policyVersionId"), required(field(item, "generation_seed", "generationSeed"), "generationSeed"),
    Number(item.requestedTrials ?? item.requested_trials ?? 1), item.status ?? "complete", field(item, "created_at", "createdAt") ?? now,
    optional(field(item, "completed_at", "completedAt")));
  }

  datasetStatement(workspaceId, item, now) {
    return this.statement(`INSERT INTO datasets
      (workspace_id,dataset_id,dataset_root_hash,universe_version_id,calendar_version_id,feed,timeframe,adjustment,range_start,range_end,manifest_object_key,manifest_hash,row_count,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,dataset_id) DO NOTHING`, workspaceId,
    required(field(item, "dataset_id", "datasetId"), "datasetId"), required(field(item, "dataset_root_hash", "datasetRootHash"), "datasetRootHash"),
    required(field(item, "universe_version_id", "universeVersionId"), "dataset universeVersionId"),
    required(field(item, "calendar_version_id", "calendarVersionId"), "dataset calendarVersionId"), item.feed ?? "iex", item.timeframe ?? "5Min",
    item.adjustment ?? "all", required(field(item, "range_start", "rangeStart"), "dataset rangeStart"),
    required(field(item, "range_end", "rangeEnd"), "dataset rangeEnd"),
    required(field(item, "manifest_object_key", "manifestObjectKey"), "dataset manifestObjectKey"),
    required(field(item, "manifest_hash", "manifestHash"), "dataset manifestHash"), Number(item.rowCount ?? item.row_count ?? 0),
    field(item, "created_at", "createdAt") ?? now);
  }

  datasetSliceStatement(workspaceId, item, now) {
    return this.statement(`INSERT INTO dataset_slices
      (workspace_id,dataset_slice_id,dataset_id,slice_kind,ordinal,range_start,range_end,sealed,slice_hash,manifest_object_key,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,dataset_slice_id) DO NOTHING`, workspaceId,
    required(field(item, "dataset_slice_id", "datasetSliceId"), "datasetSliceId"), required(field(item, "dataset_id", "datasetId"), "slice datasetId"),
    item.sliceKind ?? item.slice_kind ?? "development", Number(item.ordinal ?? 0), required(field(item, "range_start", "rangeStart"), "slice rangeStart"),
    required(field(item, "range_end", "rangeEnd"), "slice rangeEnd"), item.sealed ? 1 : 0,
    required(field(item, "slice_hash", "sliceHash"), "sliceHash"), required(field(item, "manifest_object_key", "manifestObjectKey"), "slice manifestObjectKey"),
    field(item, "created_at", "createdAt") ?? now);
  }

  trialStatement(workspaceId, item, now) {
    return this.statement(`INSERT INTO trials
      (workspace_id,trial_id,cohort_id,strategy_id,dna_id,dataset_slice_id,trial_seed,trial_kind,status,result_artifact_id,metrics_json,created_at,completed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,trial_id) DO UPDATE SET
      status=excluded.status,result_artifact_id=excluded.result_artifact_id,metrics_json=excluded.metrics_json,completed_at=excluded.completed_at`, workspaceId,
    required(field(item, "trial_id", "trialId"), "trialId"), required(field(item, "cohort_id", "cohortId"), "trial cohortId"),
    optional(field(item, "strategy_id", "strategyId")), required(field(item, "dna_id", "dnaId"), "trial dnaId"),
    required(field(item, "dataset_slice_id", "datasetSliceId"), "trial datasetSliceId"), required(field(item, "trial_seed", "trialSeed"), "trialSeed"),
    field(item, "trial_kind", "trialKind") ?? "development", item.status ?? "complete", optional(field(item, "result_artifact_id", "resultArtifactId")),
    item.metrics === undefined && item.metrics_json === undefined ? null : json(item.metrics ?? item.metrics_json),
    field(item, "created_at", "createdAt") ?? now, optional(field(item, "completed_at", "completedAt")));
  }

  async lifecycleStatement(workspaceId, item, now) {
    const transitionId = field(item, "transition_id", "transitionId") ?? await deterministicId("transition", { workspaceId, item });
    const inputHash = field(item, "input_hash", "inputHash") ?? await sha256(item.input ?? {});
    const resultHash = field(item, "result_hash", "resultHash") ?? await sha256(item.result ?? item);
    const idempotencyKey = field(item, "idempotency_key", "idempotencyKey") ?? transitionId;
    return this.statement(`INSERT INTO lifecycle_transitions
      (workspace_id,transition_id,strategy_id,sequence,from_state,to_state,trigger_kind,actor,command_id,idempotency_key,policy_version_id,evidence_artifact_id,input_hash,result_hash,supersedes_transition_id,occurred_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,idempotency_key) DO NOTHING`, workspaceId, transitionId,
    required(field(item, "strategy_id", "strategyId"), "transition strategyId"), Number(item.sequence), optional(field(item, "from_state", "fromState")),
    required(field(item, "to_state", "toState"), "transition toState"), field(item, "trigger_kind", "triggerKind") ?? "migration",
    item.actor ?? "system", field(item, "command_id", "commandId") ?? transitionId, idempotencyKey,
    optional(field(item, "policy_version_id", "policyVersionId")), optional(field(item, "evidence_artifact_id", "evidenceArtifactId")), inputHash, resultHash,
    optional(field(item, "supersedes_transition_id", "supersedesTransitionId")), field(item, "occurred_at", "occurredAt") ?? now);
  }

  async auditStatement(workspaceId, item, now) {
    const details = item.details ?? item.details_json ?? {};
    const eventHash = field(item, "event_hash", "eventHash") ?? await sha256({ workspaceId, ...item, details });
    const auditEventId = field(item, "audit_event_id", "auditEventId") ?? `audit-${eventHash}`;
    return this.statement(`INSERT INTO audit_events
      (workspace_id,audit_event_id,actor,action,subject_kind,subject_id,request_id,source_ip_hash,details_json,previous_event_hash,event_hash,occurred_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,event_hash) DO NOTHING`, workspaceId, auditEventId, item.actor ?? "system",
    required(item.action, "audit action"), field(item, "subject_kind", "subjectKind") ?? "workspace",
    field(item, "subject_id", "subjectId") ?? workspaceId, optional(field(item, "request_id", "requestId")),
    optional(field(item, "source_ip_hash", "sourceIpHash")), typeof details === "string" ? details : json(details),
    optional(field(item, "previous_event_hash", "previousEventHash")), eventHash, field(item, "occurred_at", "occurredAt") ?? now);
  }

  async loadLatestReadModel(workspaceId) {
    const record = await this.statement(`SELECT read_model_id,source_checkpoint_hash,schema_version,response_json,response_hash,
      comparison_status,comparison_artifact_id,created_at FROM normalized_read_models
      WHERE workspace_id=? ORDER BY created_at DESC,read_model_id DESC LIMIT 1`, workspaceId).first();
    if (!record) return null;
    const response = JSON.parse(record.response_json);
    if (await sha256(response) !== record.response_hash) throw new Error("normalized read model hash mismatch");
    return { ...record, schema_version: Number(record.schema_version), response };
  }

  async checkCutoverHealth(workspaceId, { sourceCheckpointHash, minimumStrategies = 0, requireMigrationComplete = true } = {}) {
    const [readModel, strategy, critical, artifacts, migration] = await Promise.all([
      this.loadLatestReadModel(workspaceId),
      this.statement("SELECT COUNT(*) AS count FROM strategies WHERE workspace_id=?", workspaceId).first(),
      this.statement("SELECT COUNT(*) AS count FROM incidents WHERE workspace_id=? AND status!='resolved' AND severity='critical'", workspaceId).first(),
      this.statement("SELECT COUNT(*) AS count FROM artifact_manifests WHERE workspace_id=? AND verified_at IS NULL", workspaceId).first(),
      this.statement("SELECT status FROM workspace_migration_manifests WHERE workspace_id=? ORDER BY prepared_at DESC LIMIT 1", workspaceId).first(),
    ]);
    const reasons = [];
    if (!readModel) reasons.push("read_model_missing");
    else {
      if (readModel.comparison_status !== "matched") reasons.push("read_model_not_matched");
      if (sourceCheckpointHash && readModel.source_checkpoint_hash !== sourceCheckpointHash) reasons.push("checkpoint_mismatch");
    }
    if (Number(strategy?.count ?? 0) < minimumStrategies) reasons.push("strategy_count_below_minimum");
    if (Number(critical?.count ?? 0) > 0) reasons.push("critical_incidents_open");
    if (Number(artifacts?.count ?? 0) > 0) reasons.push("artifacts_unverified");
    if (requireMigrationComplete && migration?.status !== "complete") reasons.push("migration_incomplete");
    return { ready: reasons.length === 0, reasons, readModel, counts: {
      strategies: Number(strategy?.count ?? 0), criticalIncidents: Number(critical?.count ?? 0), unverifiedArtifacts: Number(artifacts?.count ?? 0),
    }, migrationStatus: migration?.status ?? null };
  }

  async recordMigrationManifest(input) {
    const now = this.now(), workspaceId = required(input.workspaceId, "workspaceId");
    const manifestHash = input.manifestHash ?? await sha256(input.manifest ?? input);
    const migrationManifestId = input.migrationManifestId ?? await deterministicId("migration", {
      workspaceId, sourceExportHash: input.sourceExportHash, targetSchemaVersion: input.targetSchemaVersion,
    });
    await this.statement(`INSERT INTO workspace_migration_manifests
      (workspace_id,migration_manifest_id,source_schema_version,target_schema_version,source_export_object_key,source_export_hash,
       manifest_object_key,manifest_hash,status,counts_json,prepared_at,completed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,migration_manifest_id) DO UPDATE SET
      status=excluded.status,counts_json=excluded.counts_json,completed_at=excluded.completed_at`, workspaceId, migrationManifestId,
    Number(input.sourceSchemaVersion), Number(input.targetSchemaVersion), required(input.sourceExportObjectKey, "sourceExportObjectKey"),
    required(input.sourceExportHash, "sourceExportHash"), required(input.manifestObjectKey, "manifestObjectKey"), manifestHash,
    input.status ?? "prepared", json(input.counts), input.preparedAt ?? now, optional(input.completedAt)).run();
    return { migrationManifestId, manifestHash };
  }

  async recordMigrationStep(input) {
    const now = this.now(), workspaceId = required(input.workspaceId, "workspaceId");
    const inputHash = input.inputHash ?? await sha256(input.input ?? {});
    const idempotencyKey = input.idempotencyKey ?? `${input.migrationManifestId}:${input.stepKind}:${inputHash}`;
    const stepId = input.stepId ?? await deterministicId("migration-step", { workspaceId, idempotencyKey });
    await this.statement(`INSERT INTO workspace_migration_steps
      (workspace_id,migration_manifest_id,step_id,step_kind,idempotency_key,status,input_hash,result_hash,details_json,started_at,completed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,idempotency_key) DO UPDATE SET
      status=excluded.status,result_hash=excluded.result_hash,details_json=excluded.details_json,
      started_at=excluded.started_at,completed_at=excluded.completed_at`, workspaceId, input.migrationManifestId, stepId,
    input.stepKind, idempotencyKey, input.status ?? "pending", inputHash, optional(input.resultHash), json(input.details),
    optional(input.startedAt ?? (input.status === "running" ? now : null)), optional(input.completedAt ?? (input.status === "complete" ? now : null))).run();
    return { stepId, idempotencyKey, inputHash };
  }

  async recordQuotaPressure(input) {
    const now = this.now(), workspaceId = required(input.workspaceId, "workspaceId");
    const details = { usedBytes: input.usedBytes ?? null, quotaBytes: input.quotaBytes ?? null, utilization: input.utilization ?? null, ...input.details };
    const incidentId = input.incidentId ?? await deterministicId("incident-quota", { workspaceId, scope: input.scope ?? "d1", bucket: now.slice(0, 10) });
    await this.statement(`INSERT INTO incidents
      (workspace_id,incident_id,severity,incident_kind,status,details_json,opened_at)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(workspace_id,incident_id) DO UPDATE SET
      severity=excluded.severity,status='open',details_json=excluded.details_json`, workspaceId, incidentId,
    input.severity ?? "warning", "storage_quota_pressure", "open", json(details), now).run();
    return { incidentId, researchPaused: true };
  }

  async recordAuditEvent({ workspaceId, actor, action, subjectKind, subjectId, requestId = null, details = {} }) {
    const statement = await this.auditStatement(workspaceId, { actor, action,
      subjectKind, subjectId, requestId, details, occurredAt: this.now() }, this.now());
    await statement.run();
  }

  async enumerateWorkspaceResetTargets(workspaceId) {
    const targets = [];
    for (const [table, keys] of NORMALIZED_WORKSPACE_TABLES) {
      if (["workspace_reset_targets", "workspace_reset_manifests", "workspaces"].includes(table)) continue;
      const selected = await this.statement(`SELECT ${keys.join(",")} FROM ${table} WHERE workspace_id=?`, workspaceId).all();
      for (const record of rows(selected)) {
        const key = Object.fromEntries(keys.map((name) => [name, record[name]]));
        const targetId = await deterministicId("reset-target", { workspaceId, table, key });
        targets.push({ targetId, storageKind: "d1", targetKind: table, targetLocator: json({ table, key }), key });
      }
    }
    return targets.sort((left, right) => left.targetLocator.localeCompare(right.targetLocator));
  }

  async prepareWorkspaceReset({ workspaceId, requestedBy, environment = "development", manifestObjectKey,
    manifestHash: suppliedManifestHash = null, recoverableUntil = null }) {
    const now = this.now(), targets = await this.enumerateWorkspaceResetTargets(workspaceId);
    const manifestHash = suppliedManifestHash ?? await sha256({ workspaceId, targets });
    const resetManifestId = await deterministicId("reset", { workspaceId, manifestHash });
    await this.statement(`INSERT INTO workspace_reset_manifests
      (workspace_id,reset_manifest_id,environment,requested_by,manifest_object_key,manifest_hash,status,recoverable_until,prepared_at)
      VALUES (?,?,?,?,?,?,'prepared',?,?) ON CONFLICT(workspace_id,reset_manifest_id) DO NOTHING`, workspaceId, resetManifestId,
    environment, required(requestedBy, "requestedBy"), required(manifestObjectKey, "manifestObjectKey"), manifestHash, recoverableUntil, now).run();
    const targetStatements = targets.map((target, index) => this.statement(`INSERT INTO workspace_reset_targets
      (workspace_id,reset_manifest_id,target_id,storage_kind,target_kind,target_locator,deletion_order)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(workspace_id,reset_manifest_id,target_id) DO NOTHING`, workspaceId, resetManifestId,
    target.targetId, target.storageKind, target.targetKind, target.targetLocator, index));
    await this.batch(targetStatements);
    return { resetManifestId, manifestHash, targets };
  }

  async clearWorkspaceData(workspaceId) {
    const preserved = new Set(["workspace_reset_targets", "workspace_reset_manifests", "artifact_manifests", "workspaces"]);
    for (const [table] of NORMALIZED_WORKSPACE_TABLES) {
      if (!preserved.has(table)) await this.statement(`DELETE FROM ${table} WHERE workspace_id=?`, workspaceId).run();
    }
    await this.statement("UPDATE workspaces SET status='reset',updated_at=? WHERE workspace_id=?", this.now(), workspaceId).run();
  }
}
