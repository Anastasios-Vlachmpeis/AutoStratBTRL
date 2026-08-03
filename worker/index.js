import { DurableObject } from "cloudflare:workers";
import {
  applyAlpacaCycle,
  applyAlpacaOverview,
  advanceMarket,
  createDemoState,
  CURRENT_SCHEMA_VERSION,
  generateBatch,
  migrateState,
  reproduce,
  reworkCandidates,
  reviewCandidates,
  reviewCandidatesWithBars,
  snapshot,
  validateCandidates,
  validateCandidatesWithBars,
} from "./engine.js";
import { isAuthorized } from "./auth.js";
import {
  aggregateMetrics, buildBacktestPayload, comparison, engineMode, frozenDna,
  makeDataset, normalizeMetrics, remoteEnabled, reviewDecision, sha256, validationDecision,
} from "./backtest.js";
import { CONTROL_PLANE_WORKSPACE, createControlPlaneRuntime } from "./control-plane.js";
import { createRuntimeGateways } from "./gateways.js";
import { consumeArchitectureQueue } from "./jobs.js";
import {
  MarketDataRepository,
  applyLiveMinutePoll,
  auditFiveMinuteBars,
  backfillDateBounds,
  buildBackfillJobs,
  buildCalendarManifest,
  buildDatasetManifest,
  buildHistoricalPartitions,
  buildSessionReconciliation,
  describeMarketDataError,
  ensureMarketDataState,
  livePollBounds,
  marketDataMode,
  marketScheduleAction,
  publicMarketDataState,
  recordMarketDataUsage,
} from "./market-data.js";
import { initialUniverseManifest } from "./universe.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const SINGLETON_NAME = CONTROL_PLANE_WORKSPACE;

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: JSON_HEADERS });
}

function labStub(env) {
  return env.AXIOM_LAB.get(env.AXIOM_LAB.idFromName(SINGLETON_NAME));
}

function nextIsoDate(date) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

async function sendQueueMessages(queue, messages) {
  for (let index = 0; index < messages.length; index += 100) {
    const batch = messages.slice(index, index + 100);
    if (typeof queue.sendBatch === "function") {
      await queue.sendBatch(batch.map((body) => ({ body, contentType: "json" })));
    } else {
      for (const body of batch) await queue.send(body, { contentType: "json" });
    }
  }
}

async function tickMarketData(env, stub, scheduledTime = Date.now()) {
  return stub.fetch(new Request("https://axiom.internal/internal/market-data/tick", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scheduled_at: new Date(scheduledTime).toISOString() }),
  }));
}

async function stateFrom(stub) {
  const response = await stub.fetch(new Request("https://axiom.internal/api/state"));
  if (!response.ok) throw new Error("Unable to load supervisor state");
  return response.json();
}

async function synchronizeAlpaca(env, stub, bucket, orderBucket = bucket) {
  const appState = await stateFrom(stub);
  const cycle = await createRuntimeGateways(env).broker.buildCycle(appState, bucket, orderBucket);
  return stub.fetch(new Request("https://axiom.internal/internal/alpaca-cycle", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(cycle),
  }));
}

async function refreshAlpacaPortfolio(env, stub) {
  const overview = await createRuntimeGateways(env).broker.accountOverview();
  return stub.fetch(new Request("https://axiom.internal/internal/alpaca-overview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(overview),
  }));
}

async function reviewWithAlpaca(env, stub) {
  const appState = await stateFrom(stub);
  const symbols = [...new Set(appState.strategies
    .filter((strategy) => ["generated", "rework"].includes(strategy.state))
    .map((strategy) => strategy.asset))];
  const bars = await createRuntimeGateways(env).marketData.researchBars(symbols);
  return stub.fetch(new Request("https://axiom.internal/internal/review-live", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bars }),
  }));
}

async function validateWithAlpaca(env, stub) {
  // A sealed remote validation must never fetch a new bar set. The DO owns the
  // immutable holdout captured during review.
  const appState = await stateFrom(stub);
  const validation = appState.strategies.filter((strategy) => strategy.state === "validation");
  const needsLegacyBars = engineMode(env) === "legacy"
    || validation.some((strategy) => (strategy.engine_family ?? "legacy") === "legacy" && !strategy.dataset_id);
  if (!needsLegacyBars) {
    return stub.fetch(new Request("https://axiom.internal/internal/validate-live", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
    }));
  }
  const symbols = [...new Set(appState.strategies
    .filter((strategy) => strategy.state === "validation")
    .map((strategy) => strategy.asset))];
  const bars = await createRuntimeGateways(env).marketData.researchBars(symbols);
  return stub.fetch(new Request("https://axiom.internal/internal/validate-live", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bars }),
  }));
}

export class AxiomLab extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.controlPlane = createControlPlaneRuntime(ctx.storage, env, SINGLETON_NAME);
    this.gateways = createRuntimeGateways(env);
    this.marketDataRepository = new MarketDataRepository(ctx.storage, env, SINGLETON_NAME);
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const existing = await this.controlPlane.loadState();
      if (!existing) {
        const initial = createDemoState();
        initial.schemaVersion = CURRENT_SCHEMA_VERSION; initial.datasets = {}; initial.backtestArtifacts = {};
        const universe = await ensureMarketDataState(initial, env);
        await this.marketDataRepository.saveUniverse(universe);
        await this.controlPlane.saveState(initial);
      }
      else {
        const migrated = (existing.schemaVersion ?? 1) < CURRENT_SCHEMA_VERSION ? migrateState(existing) : existing;
        if ((migrated.schemaVersion ?? 1) < CURRENT_SCHEMA_VERSION) {
          migrated.schemaVersion = CURRENT_SCHEMA_VERSION;
          migrated.datasets ??= {};
          migrated.backtestArtifacts ??= {};
        }
        const universe = await ensureMarketDataState(migrated, env);
        await this.marketDataRepository.saveUniverse(universe);
        await this.controlPlane.saveState(migrated);
      }
    });
  }

  async load() {
    await this.ready;
    return this.controlPlane.loadState();
  }

  async save(state) {
    state.schemaVersion = Math.max(state.schemaVersion ?? 1, CURRENT_SCHEMA_VERSION);
    state.datasets ??= {};
    state.backtestArtifacts ??= {};
    await ensureMarketDataState(state, this.env);
    await this.controlPlane.saveState(state);
    return json(snapshot(state));
  }

  record(state, type, title, detail) {
    const now = new Date();
    state.events.unshift({ id: `BT-${now.getTime()}-${Math.random().toString(36).slice(2, 7)}`,
      kind: type, type, title, detail, time: now.toISOString().slice(11, 16), at: now.toISOString() });
    state.events = state.events.slice(0, 28);
  }

  async clearWorkspaceStorage() {
    await this.marketDataRepository.clear();
    await this.controlPlane.artifacts.clear();
  }

  async ensureMarketCalendar(state, start, end, force = false) {
    const existing = state.marketData?.calendar;
    if (!force && existing?.requested_start <= start && existing?.requested_end >= end) {
      const stored = await this.marketDataRepository.loadCalendar(existing.id);
      if (stored) return stored;
    }
    const rows = await this.gateways.marketData.calendar(start, end);
    const manifest = await buildCalendarManifest(rows, start, end);
    await this.marketDataRepository.saveCalendar(manifest);
    recordMarketDataUsage(state, {
      alpaca_requests: rows.__alpaca_request_count ?? 1, d1_rows: 1, r2_writes: 1,
    });
    state.marketData.calendar = {
      id: manifest.id, sha256: manifest.sha256, source: manifest.source,
      timezone: manifest.timezone, first_session: manifest.first_session,
      last_session: manifest.last_session, session_count: manifest.session_count,
      requested_start: manifest.requested_start, requested_end: manifest.requested_end,
    };
    return manifest;
  }

  async startMarketBackfill(state, body = {}) {
    if (marketDataMode(this.env) !== "shadow") throw new Error("MARKET_DATA_MODE must be shadow to start a backfill");
    this.marketDataRepository.assertPersistentReady();
    const asOf = body.as_of ? new Date(`${body.as_of}T12:00:00Z`) : new Date();
    if (Number.isNaN(asOf.getTime())) throw new Error("Invalid backfill as_of date");
    const defaults = backfillDateBounds(asOf);
    const start = String(body.start ?? defaults.start);
    const end = String(body.end ?? defaults.end);
    const durationDays = (new Date(`${end}T00:00:00Z`) - new Date(`${start}T00:00:00Z`)) / 86400000;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)
        || start > end || durationDays < 1090 || durationDays > 1105) {
      throw new Error("Historical backfill must cover one bounded three-year period");
    }
    const universe = await initialUniverseManifest();
    const assets = await this.gateways.marketData.assets(universe.symbols);
    recordMarketDataUsage(state, { alpaca_requests: assets.__alpaca_request_count ?? universe.symbols.length });
    const unavailable = universe.symbols.filter((symbol) => assets[symbol]?.status !== "active" || !assets[symbol]?.tradable);
    if (unavailable.length) throw new Error(`Initial universe contains unavailable assets: ${unavailable.join(", ")}`);
    await this.marketDataRepository.saveUniverse(universe);
    const calendar = await this.ensureMarketCalendar(state, start, end, true);
    const jobs = await buildBackfillJobs({ universe, calendar, start, end });
    const backfillHash = await sha256({ universe_id: universe.id, universe_hash: universe.sha256,
      calendar_id: calendar.id, start, end, jobs: jobs.map((job) => job.id) });
    const backfillId = `backfill-${backfillHash.slice(0, 32)}`;
    await this.marketDataRepository.createBackfillJobs(backfillId, jobs);
    const progress = await this.marketDataRepository.backfillProgress(backfillId);
    state.marketData.backfill = {
      id: backfillId, status: progress.complete ? "running" : "queued", start, end, total_jobs: progress.total,
      completed_jobs: progress.complete, failed_jobs: progress.failed,
      dataset_id: state.marketData.backfill?.id === backfillId ? state.marketData.backfill.dataset_id : null,
      calendar_id: calendar.id,
      universe_id: universe.id, started_at: new Date().toISOString(), completed_at: null,
    };
    this.record(state, "MARKET_DATA", "Three-year IEX backfill queued",
      `${universe.symbols.length} symbols · ${jobs.length} resumable monthly partitions`);
    // Persist the immutable backfill identity before messages can reach the DO.
    // If queue submission fails, restarting the same command safely re-enqueues
    // every deterministic job and completed partitions are skipped.
    await this.controlPlane.saveState(state);
    await sendQueueMessages(this.env.AXIOM_JOBS, jobs.map((job) => ({
      kind: "market-data.backfill-partition.v1", workspace_id: SINGLETON_NAME, backfill_id: backfillId, job,
    })));
    recordMarketDataUsage(state, { queue_messages: jobs.length, d1_rows: jobs.length });
  }

  async syncBackfillProgress(state, backfillId) {
    const progress = await this.marketDataRepository.backfillProgress(backfillId);
    if (state.marketData?.backfill?.id === backfillId) {
      state.marketData.backfill.total_jobs = progress.total;
      state.marketData.backfill.completed_jobs = progress.complete;
      state.marketData.backfill.failed_jobs = progress.failed;
      state.marketData.backfill.status = progress.complete === progress.total && progress.total > 0
        ? "complete" : progress.failed ? "degraded" : "running";
    }
    return progress;
  }

  async finalizeBackfillDataset(state, backfillId, universe, calendar, start, end) {
    if (state.marketData?.backfill?.dataset_id) return state.marketData.backfill.dataset_id;
    const rows = await this.marketDataRepository.listPartitions(backfillId);
    const partitions = rows.map((row) => ({
      id: row.partition_id, universe_id: row.universe_id, calendar_id: row.calendar_id,
      feed: row.feed, timeframe: row.timeframe, adjustment: row.adjustment, symbol: row.symbol,
      month: row.partition_month, start: row.range_start, end: row.range_end, row_count: row.row_count,
      expected_bars: row.expected_bars, missing_bars: row.missing_bars, coverage: row.coverage,
      adjustment_discontinuities: row.adjustment_discontinuities,
      content_hash: row.content_hash, sha256: row.manifest_hash, object_key: row.object_key,
      byte_length: row.byte_length,
    }));
    const manifest = await buildDatasetManifest({ universe, calendar, start, end, partitions });
    await this.marketDataRepository.saveDatasetManifest(manifest);
    state.marketData.backfill.dataset_id = manifest.id;
    state.marketData.backfill.dataset_hash = manifest.sha256;
    state.marketData.backfill.row_count = manifest.row_count;
    state.marketData.backfill.missing_bars = manifest.missing_bars;
    state.marketData.backfill.completed_at = new Date().toISOString();
    this.record(state, "MARKET_DATA", "Three-year IEX dataset sealed",
      `${manifest.row_count} five-minute bars · root ${manifest.sha256.slice(0, 12)}`);
    return manifest.id;
  }

  async processMarketBackfillPartition(state, body) {
    const startedAt = Date.now();
    const job = body?.job;
    const backfillId = String(body?.backfill_id ?? "");
    if (!job?.id || !backfillId || job.universe_id !== state.marketData?.backfill?.universe_id) {
      throw new Error("Market-data backfill job does not match the active immutable backfill");
    }
    const existing = await this.marketDataRepository.backfillJobStatus(job.id);
    if (existing?.status === "complete") {
      const progress = await this.syncBackfillProgress(state, backfillId);
      if (progress.complete === progress.total && progress.total > 0 && !state.marketData.backfill.dataset_id) {
        const universe = await initialUniverseManifest();
        const calendar = await this.marketDataRepository.loadCalendar(job.calendar_id);
        if (!calendar) throw new Error("Sealed backfill calendar is unavailable for dataset finalization");
        await this.finalizeBackfillDataset(state, backfillId, universe, calendar,
          state.marketData.backfill.start, state.marketData.backfill.end);
      }
      return { duplicate: true, partition_id: existing.partition_id };
    }
    try {
      await this.marketDataRepository.markBackfillJob(job.id, "running");
      const calendar = await this.marketDataRepository.loadCalendar(job.calendar_id);
      if (!calendar || calendar.sha256 !== state.marketData.calendar?.sha256) {
        // The active live calendar may differ; accept the exact sealed backfill
        // calendar by ID and verify its own hash through the stored manifest.
        if (!calendar?.sha256) throw new Error("Sealed backfill calendar is unavailable");
      }
      const universe = await initialUniverseManifest();
      if (job.universe_hash !== universe.sha256) throw new Error("Backfill universe hash mismatch");
      const response = await this.gateways.marketData.fiveMinuteHistory(job.symbol, {
        start: `${job.start}T00:00:00Z`, end: `${nextIsoDate(job.end)}T00:00:00Z`,
      });
      recordMarketDataUsage(state, { alpaca_requests: response.__alpaca_request_count ?? 1 });
      const audit = auditFiveMinuteBars(job.symbol, response[job.symbol] ?? [], calendar.sessions,
        { start: job.start, end: job.end });
      if (!audit.bars.length) throw new Error(`${job.symbol} returned no regular-session bars for ${job.partition}`);
      const partitions = await buildHistoricalPartitions({ universe, calendar, symbol: job.symbol, audit, job });
      if (partitions.length !== 1 || partitions[0].month !== job.partition) {
        throw new Error(`Backfill job ${job.id} did not produce its single expected monthly partition`);
      }
      const saved = await this.marketDataRepository.savePartition(partitions[0], audit);
      await this.marketDataRepository.markBackfillJob(job.id, "complete", { partition_id: saved.id });
      recordMarketDataUsage(state, { d1_rows: 3, r2_writes: 1, worker_elapsed_ms: Date.now() - startedAt });
      const progress = await this.syncBackfillProgress(state, backfillId);
      if (progress.complete === progress.total && progress.total > 0) {
        await this.finalizeBackfillDataset(state, backfillId, universe, calendar,
          state.marketData.backfill.start, state.marketData.backfill.end);
      }
      return { duplicate: false, partition_id: saved.id };
    } catch (error) {
      await this.marketDataRepository.markBackfillJob(job.id, "failed", { error: describeMarketDataError(error) });
      recordMarketDataUsage(state, { d1_rows: 2, worker_elapsed_ms: Date.now() - startedAt });
      await this.syncBackfillProgress(state, backfillId);
      this.record(state, "MARKET_DATA_ERROR", `${job.symbol} backfill deferred`, describeMarketDataError(error));
      await this.controlPlane.saveState(state);
      throw error;
    }
  }

  async ensureLiveCalendar(state, now) {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(now).filter((part) => part.type !== "literal");
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const date = `${values.year}-${values.month}-${values.day}`;
    const startDate = new Date(`${date}T00:00:00Z`); startDate.setUTCDate(startDate.getUTCDate() - 14);
    const endDate = new Date(`${date}T00:00:00Z`); endDate.setUTCDate(endDate.getUTCDate() + 45);
    return this.ensureMarketCalendar(state, startDate.toISOString().slice(0, 10), endDate.toISOString().slice(0, 10));
  }

  async pollLiveMarketData(state, now, calendar) {
    const startedAt = Date.now();
    const bounds = livePollBounds(now);
    const universe = await initialUniverseManifest();
    const bars = await this.gateways.marketData.recentMinuteBars(universe.symbols, bounds);
    const book = await this.marketDataRepository.loadLiveBook();
    const result = await applyLiveMinutePoll(book, bars, calendar.sessions, {
      feed: universe.feed, now, receivedAt: new Date().toISOString(), expectedSymbols: universe.symbols,
    });
    await this.marketDataRepository.saveLiveResult(result);
    recordMarketDataUsage(state, {
      alpaca_requests: bars.__alpaca_request_count ?? 1,
      d1_rows: result.source_revisions.length + result.events.length + 1,
      worker_elapsed_ms: Date.now() - startedAt,
    }, now);
    const previousStatus = state.marketData.live?.status;
    state.marketData.live = {
      ...state.marketData.live,
      status: result.health.status,
      last_poll_at: result.book.last_poll_at,
      last_event_at: result.events.at(-1)?.finalized_at ?? state.marketData.live?.last_event_at ?? null,
      healthy_symbols: result.health.healthy_symbols,
      symbol_count: result.health.symbol_count,
      coverage: result.health.coverage,
      revision_events: Number(state.marketData.live?.revision_events ?? 0)
        + result.events.filter((event) => event.retroactive).length,
      latest_event_count: result.events.length,
    };
    if (previousStatus && previousStatus !== result.health.status) {
      this.record(state, result.health.status === "healthy" ? "MARKET_DATA" : "MARKET_DATA_ERROR",
        `Live IEX data ${result.health.status}`, `${result.health.healthy_symbols}/${result.health.symbol_count} symbols healthy`);
    }
    return result;
  }

  async reconcileLiveSession(state, now, calendar) {
    const startedAt = Date.now();
    const dateParts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(now).filter((part) => part.type !== "literal");
    const values = Object.fromEntries(dateParts.map((part) => [part.type, part.value]));
    const sessionDate = `${values.year}-${values.month}-${values.day}`;
    if (state.marketData.live?.last_reconciliation?.session_date === sessionDate) return { duplicate: true };
    const universe = await initialUniverseManifest();
    const response = await this.gateways.marketData.fiveMinuteBars(universe.symbols, {
      start: `${sessionDate}T00:00:00Z`, end: `${nextIsoDate(sessionDate)}T00:00:00Z`,
    });
    const session = calendar.sessions.filter((item) => item.date === sessionDate);
    const audits = Object.fromEntries(universe.symbols.map((symbol) => [symbol,
      auditFiveMinuteBars(symbol, response[symbol] ?? [], session, { start: sessionDate, end: sessionDate })]));
    const liveEvents = await this.marketDataRepository.liveEventsForSession(sessionDate, universe.feed);
    const reconciliation = await buildSessionReconciliation({ universe, calendar, sessionDate, audits, liveEvents });
    await this.marketDataRepository.saveSessionReconciliation(reconciliation);
    recordMarketDataUsage(state, {
      alpaca_requests: response.__alpaca_request_count ?? 1, d1_rows: 1, r2_writes: 1,
      worker_elapsed_ms: Date.now() - startedAt,
    }, now);
    state.marketData.live.last_reconciliation = {
      id: reconciliation.id, session_date: sessionDate, status: reconciliation.status,
      matched_bars: reconciliation.summary.matched, mismatched_bars: reconciliation.summary.mismatched,
      missing_live_bars: reconciliation.summary.missing_live, sha256: reconciliation.sha256,
    };
    this.record(state, reconciliation.status === "healthy" ? "MARKET_DATA" : "MARKET_DATA_ERROR",
      `IEX session reconciliation ${reconciliation.status}`,
      `${reconciliation.summary.matched} matched · ${reconciliation.summary.mismatched} mismatched · ${reconciliation.summary.missing_live} missing live`);
    return reconciliation;
  }

  async runMarketDataTick(state, scheduledAt) {
    if (marketDataMode(this.env) !== "shadow") return { skipped: true, reason: "market_data_off" };
    const now = new Date(scheduledAt);
    if (Number.isNaN(now.getTime())) throw new Error("Invalid market-data schedule timestamp");
    const bucket = now.toISOString().slice(0, 16);
    if (state.marketData.last_tick_bucket === bucket) return { duplicate: true, changed: false };
    const priorCalendarId = state.marketData.calendar?.id ?? null;
    const calendar = await this.ensureLiveCalendar(state, now);
    const action = marketScheduleAction(now, calendar.sessions);
    let result = { skipped: true, reason: "outside_session" };
    if (action === "poll") result = await this.pollLiveMarketData(state, now, calendar);
    else if (action === "reconcile") result = await this.reconcileLiveSession(state, now, calendar);
    const changed = action !== "idle" || priorCalendarId !== calendar.id;
    if (action !== "idle") state.marketData.last_tick_bucket = bucket;
    return { action, result, changed };
  }

  async persistArtifact(state, artifact, result) {
    const artifactId = `artifact-${artifact.job_id}-${artifact.strategy_id}`;
    await this.controlPlane.artifacts.putArtifact(artifactId, { ...artifact, result }, {
      phase: artifact.phase, strategy_id: artifact.strategy_id, dataset_id: artifact.dataset?.id,
    });
    state.backtestArtifacts ??= {};
    state.backtestArtifacts[artifactId] = { id: artifactId, phase: artifact.phase, strategy_id: artifact.strategy_id, created_at: artifact.created_at, engine: artifact.engine, dataset: artifact.dataset };
    return artifactId;
  }

  async sealDataset(state, symbol, bars) {
    const dataset = await makeDataset(symbol, bars);
    if (dataset.development.length < 300 || dataset.holdout.length < 100) throw new Error(`${symbol} has insufficient history for sealed backtesting`);
    state.datasets ??= {};
    if (!state.datasets[dataset.id]) {
      await this.controlPlane.artifacts.putDatasetSlice(dataset.id, "development", dataset.development, {
        symbol: dataset.symbol, timeframe: dataset.timeframe,
      });
      await this.controlPlane.artifacts.putDatasetSlice(dataset.id, "holdout", dataset.holdout, {
        symbol: dataset.symbol, timeframe: dataset.timeframe,
      });
      state.datasets[dataset.id] = { id: dataset.id, symbol: dataset.symbol, timeframe: dataset.timeframe, bar_count: dataset.bar_count, split_index: dataset.split_index, start: dataset.start, end: dataset.end, sha256: dataset.sha256 };
    }
    return state.datasets[dataset.id];
  }

  async validateLegacyStrategies(state, fallbackBars = {}) {
    const candidates = state.strategies.filter((item) => item.state === "validation"
      && (item.engine_family ?? "legacy") === "legacy");
    for (const strategy of candidates) {
      let bars = fallbackBars[strategy.asset] ?? [];
      if (strategy.dataset_id) {
        const [development, holdout] = await Promise.all([
          this.controlPlane.artifacts.getDatasetSlice(strategy.dataset_id, "development"),
          this.controlPlane.artifacts.getDatasetSlice(strategy.dataset_id, "holdout"),
        ]);
        if (development?.length && holdout?.length) bars = [...development, ...holdout];
        else this.record(state, "BACKTEST_ERROR", `${strategy.name} validation deferred`, "sealed legacy comparison dataset is missing");
      }
      validateCandidatesWithBars(state, { [strategy.asset]: bars }, {
        family: "legacy", strategyIds: [strategy.id], advanceClock: false, silent: true,
      });
    }
    return candidates.length > 0;
  }

  async invokeBacktrader(state, phase, strategies, dataset) {
    const bars = await this.controlPlane.artifacts.getDatasetSlice(dataset.id, phase === "holdout" ? "holdout" : "development");
    if (!bars?.length) throw new Error(`Sealed ${phase} dataset is unavailable`);
    const built = await buildBacktestPayload(phase, strategies, dataset, bars);
    const { payload, config_hash, dna, slice_hash: sliceHash } = built;
    const job_id = payload.job_id;
    const response = await this.gateways.research.run(payload);
    if (response.job_id !== job_id || response.phase !== phase) throw new Error("Backtest service provenance does not match the request");
    if (response.dataset?.sha256 !== sliceHash || response.engine?.name !== "backtrader"
      || response.engine?.config_hash !== config_hash) {
      throw new Error("Backtest service returned an unexpected dataset or execution configuration");
    }
    return { response, job_id, config_hash, dna, dataset };
  }

  async reviewRemote(state, env, barsBySymbol) {
    reworkCandidates(state);
    const candidates = state.strategies.filter((item) => item.state === "generated" || (item.state === "rework" && item.rework?.source_stage === "data"));
    if (!candidates.length) return this.record(state, "REVIEW", "No candidates waiting", "Generate a new cohort or reproduce a released strategy first.");
    const byDataset = new Map();
    for (const strategy of candidates) {
      try {
        const dataset = await this.sealDataset(state, strategy.asset, barsBySymbol[strategy.asset] ?? []);
        strategy.dna_hash ??= await frozenDna(strategy);
        strategy.engine_family ??= "backtrader";
        strategy.dataset_id ??= dataset.id;
        if (strategy.dataset_id !== dataset.id) throw new Error("strategy dataset is immutable");
        const group = byDataset.get(dataset.id) ?? { dataset, strategies: [] };
        group.strategies.push(strategy); byDataset.set(dataset.id, group);
      } catch (error) {
        strategy.rework = { ...(strategy.rework ?? {}), source_stage: "data", diagnosis: error.message, attempt: strategy.rework?.attempt ?? 0, max_attempts: 3, history: strategy.rework?.history ?? [] };
        strategy.state = "rework"; this.record(state, "BACKTEST_ERROR", `${strategy.name} data unavailable`, error.message);
      }
    }
    for (const { dataset, strategies } of byDataset.values()) {
      try {
        const run = await this.invokeBacktrader(state, "development", strategies, dataset);
        for (const strategy of strategies) {
          const strategyResult = run.response.results.find((item) => String(item.strategy_id ?? item.id) === strategy.id);
          if (strategyResult?.dna_hash !== strategy.dna_hash) throw new Error(`service returned mismatched DNA for ${strategy.id}`);
          const results = strategyResult?.windows ?? (strategyResult ? [strategyResult] : []);
          if (!results.length) throw new Error(`service returned no result for ${strategy.id}`);
          const metrics = aggregateMetrics(results);
          const artifactId = await this.persistArtifact(state, { job_id: run.job_id, strategy_id: strategy.id, phase: "development", created_at: new Date().toISOString(), engine: run.response.engine ?? { name: "backtrader" }, dataset, dna_hash: strategy.dna_hash, config_hash: run.config_hash,
            input_hash: run.response.input_hash, service_result_hash: run.response.result_hash,
            warnings: run.response.warnings ?? [] }, { strategy: strategyResult, metrics });
          strategy.backtest_runs ??= {}; strategy.backtest_runs.development = { artifact_id: artifactId, dataset_id: dataset.id, dna_hash: strategy.dna_hash, config_hash: run.config_hash, engine: run.response.engine ?? { name: "backtrader" }, input_hash: run.response.input_hash,
            service_result_hash: run.response.result_hash, result_hash: await sha256({ results, metrics }), completed_at: new Date().toISOString() };
          strategy.metrics = metrics; strategy.backtests = (strategy.backtests ?? 0) + results.length;
          const [next, reason] = reviewDecision(metrics); strategy.state = next;
          if (next === "rework") strategy.rework = { ...(strategy.rework ?? {}), source_stage: "development", diagnosis: reason, attempt: strategy.rework?.attempt ?? 0, max_attempts: 3, history: strategy.rework?.history ?? [] };
          this.record(state, next === "validation" ? "PROMOTE" : next === "dropped" ? "DROP" : "REWORK", `${strategy.name} → ${next}`, reason);
        }
      } catch (error) {
        for (const strategy of strategies) this.record(state, "BACKTEST_ERROR", `${strategy.name} review deferred`, error.message);
      }
    }
    const validation = state.strategies.filter((item) => item.state === "validation"
      || (item.state === "rework" && item.rework?.source_stage === "capacity"))
      .sort((a, b) => (b.metrics?.score ?? 0) - (a.metrics?.score ?? 0));
    validation.slice(0, 3).forEach((strategy) => { strategy.state = "validation"; });
    validation.slice(3).forEach((strategy) => { strategy.state = "rework"; strategy.rework = { ...(strategy.rework ?? {}), source_stage: "capacity", diagnosis: "waiting for validation capacity", attempt: strategy.rework?.attempt ?? 0, max_attempts: 3, history: strategy.rework?.history ?? [] }; });
    state.marketClock += 8;
  }

  async validateRemote(state, env, options = {}) {
    const candidates = state.strategies.filter((item) => item.state === "validation"
      && ((item.engine_family ?? "legacy") === "backtrader"
        || (options.includeShadow && item.backtest_runs?.shadow)));
    if (!candidates.length) {
      if (!options.silent) this.record(state, "VALIDATE", "No strategies awaiting validation", "Supervisor approval is required before holdout testing.");
      return;
    }
    const groups = new Map();
    for (const strategy of candidates) { const dataset = state.datasets?.[strategy.dataset_id]; if (!dataset) { this.record(state, "BACKTEST_ERROR", `${strategy.name} validation deferred`, "sealed dataset missing"); continue; } const group = groups.get(dataset.id) ?? { dataset, strategies: [] }; group.strategies.push(strategy); groups.set(dataset.id, group); }
    for (const { dataset, strategies } of groups.values()) try {
      const run = await this.invokeBacktrader(state, "holdout", strategies, dataset);
      for (const strategy of strategies) {
        const strategyResult = run.response.results.find((item) => String(item.strategy_id ?? item.id) === strategy.id);
        if (strategyResult?.dna_hash !== strategy.dna_hash) throw new Error(`service returned mismatched DNA for ${strategy.id}`);
        const result = strategyResult?.windows?.[0] ?? strategyResult;
        if (!result) throw new Error(`service returned no result for ${strategy.id}`);
        const validation = normalizeMetrics(result);
        const artifactId = await this.persistArtifact(state, { job_id: run.job_id, strategy_id: strategy.id, phase: "holdout", created_at: new Date().toISOString(), engine: run.response.engine ?? { name: "backtrader" }, dataset, dna_hash: strategy.dna_hash, config_hash: run.config_hash,
          input_hash: run.response.input_hash, service_result_hash: run.response.result_hash,
          warnings: run.response.warnings ?? [] }, { strategy: strategyResult, metrics: validation });
        strategy.backtest_runs ??= {}; strategy.backtest_runs.holdout = { artifact_id: artifactId, dataset_id: dataset.id, dna_hash: strategy.dna_hash, config_hash: run.config_hash, engine: run.response.engine ?? { name: "backtrader" }, input_hash: run.response.input_hash,
          service_result_hash: run.response.result_hash, result_hash: await sha256({ result, validation }), completed_at: new Date().toISOString() };
        strategy.validation = validation; strategy.backtests = (strategy.backtests ?? 0) + 1;
        const [next, reason] = validationDecision(strategy.metrics, validation); strategy.state = next;
        if (next === "rework") strategy.rework = { ...(strategy.rework ?? {}), source_stage: "validation", diagnosis: reason, attempt: strategy.rework?.attempt ?? 0, max_attempts: 3, history: strategy.rework?.history ?? [] };
        this.record(state, next === "released" ? "RELEASE" : next === "dropped" ? "DROP" : "REWORK", `${strategy.name} → ${next}`, reason);
      }
    } catch (error) { for (const strategy of strategies) this.record(state, "BACKTEST_ERROR", `${strategy.name} validation deferred`, error.message); }
    if (options.advanceClock !== false) state.marketClock += 5;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const state = await this.load();

    try {
      if (request.method === "GET" && url.pathname === "/api/state") return json(snapshot(state));
      if (request.method === "GET" && url.pathname === "/api/architecture") {
        return json(await this.controlPlane.health(true));
      }
      if (request.method === "GET" && url.pathname === "/api/market-data") {
        return json(publicMarketDataState(state));
      }

      if (request.method === "POST" && url.pathname === "/api/market-data/backfill/start") {
        const body = await request.json().catch(() => ({}));
        await this.startMarketBackfill(state, body);
        return this.save(state);
      }
      if (request.method === "POST" && url.pathname === "/api/market-data/poll") {
        const body = await request.json().catch(() => ({}));
        await this.runMarketDataTick(state, body.scheduled_at ?? new Date().toISOString());
        return this.save(state);
      }

      if (request.method === "POST" && url.pathname === "/api/generate") {
        const body = await request.json();
        generateBatch(state, Math.max(1, Math.min(Number(body.count ?? 6), 12)));
        return this.save(state);
      }
      if (request.method === "POST" && url.pathname === "/api/review") {
        reviewCandidates(state);
        return this.save(state);
      }
      if (request.method === "POST" && url.pathname === "/api/validate") {
        validateCandidates(state);
        return this.save(state);
      }
      if (request.method === "POST" && url.pathname === "/api/advance") {
        const body = await request.json();
        advanceMarket(state, Math.max(1, Math.min(Number(body.periods ?? 1), 4)));
        return this.save(state);
      }
      if (request.method === "POST" && url.pathname === "/api/reproduce") {
        const body = await request.json();
        reproduce(state, String(body.id));
        return this.save(state);
      }
      if (request.method === "POST" && url.pathname === "/api/reset") {
        await this.clearWorkspaceStorage();
        return this.save(createDemoState());
      }
      if (request.method === "POST" && url.pathname === "/internal/market-data/backfill-partition") {
        const body = await request.json();
        const result = await this.processMarketBackfillPartition(state, body);
        await this.controlPlane.saveState(state);
        return json({ ok: true, ...result });
      }
      if (request.method === "POST" && url.pathname === "/internal/market-data/tick") {
        const body = await request.json();
        const result = await this.runMarketDataTick(state, body.scheduled_at);
        if (result.changed) await this.controlPlane.saveState(state);
        return json({ ok: true, ...result });
      }
      if (request.method === "POST" && url.pathname === "/internal/review-live") {
        const body = await request.json();
        if (!remoteEnabled(this.env)) {
          const deferred = state.strategies.filter((item) => ["generated", "rework"].includes(item.state)
            && item.engine_family === "backtrader").map((item) => [item, item.state]);
          deferred.forEach(([item]) => { item.state = "engine-deferred"; });
          state.strategies.filter((item) => ["generated", "rework"].includes(item.state)).forEach((item) => { item.engine_family ??= "legacy"; });
          reviewCandidatesWithBars(state, body.bars ?? {});
          deferred.forEach(([item, priorState]) => {
            item.state = priorState;
            this.record(state, "BACKTEST_ERROR", `${item.name} review deferred`, "Backtrader engine is unavailable; engine family was not changed");
          });
          state.strategies.filter((item) => item.metrics && !item.engine_family).forEach((item) => { item.engine_family = "legacy"; });
        }
        else if (engineMode(this.env) === "backtrader") await this.reviewRemote(state, this.env, body.bars ?? {});
        else {
          // Shadow runs write provenance only; lifecycle decisions remain legacy.
          const shadow = structuredClone(state);
          await this.reviewRemote(shadow, this.env, body.bars ?? {});
          state.datasets = shadow.datasets;
          state.backtestArtifacts = shadow.backtestArtifacts;
          const backtraderDeferred = state.strategies.filter((item) => ["generated", "rework"].includes(item.state)
            && item.engine_family === "backtrader").map((item) => [item, item.state]);
          backtraderDeferred.forEach(([item]) => { item.state = "engine-deferred"; });
          state.strategies.filter((item) => ["generated", "rework"].includes(item.state)).forEach((item) => { item.engine_family ??= "legacy"; });
          reviewCandidatesWithBars(state, body.bars ?? {});
          backtraderDeferred.forEach(([item, priorState]) => { item.state = priorState; });
          for (const remote of shadow.strategies) {
            if (remote.engine_family === "backtrader" && !state.strategies.some((item) => item.id === remote.id)) {
              state.strategies.unshift(remote);
            }
          }
          state.nextId = Math.max(state.nextId, shadow.nextId);
          state.strategies.filter((item) => item.metrics && !item.engine_family).forEach((item) => { item.engine_family = "legacy"; });
          for (const strategy of state.strategies) {
            const remote = shadow.strategies.find((item) => item.id === strategy.id);
            if (strategy.engine_family === "backtrader" && remote) {
              strategy.state = remote.state;
              strategy.rework = remote.rework;
            }
            if (!remote?.backtest_runs?.development) continue;
            strategy.dna_hash ??= remote.dna_hash; strategy.dataset_id ??= remote.dataset_id;
            if (strategy.engine_family === "backtrader") {
              strategy.metrics = remote.metrics;
              strategy.backtests = remote.backtests;
              strategy.backtest_runs = { ...(strategy.backtest_runs ?? {}), development: remote.backtest_runs.development };
              continue;
            }
            strategy.backtest_runs ??= {};
            strategy.backtest_runs.shadow = { ...remote.backtest_runs.development, phase: "development",
              remote_metrics: remote.metrics, comparison: comparison(strategy.metrics, remote.metrics) };
          }
          shadow.events.filter((item) => item.kind === "BACKTEST_ERROR").forEach((item) => {
            if (!state.events.some((event) => event.title === item.title && event.detail === item.detail)) {
              this.record(state, "BACKTEST_ERROR", item.title, item.detail);
            }
          });
        }
        return this.save(state);
      }
      if (request.method === "POST" && url.pathname === "/internal/validate-live") {
        const body = await request.json();
        if (!remoteEnabled(this.env)) {
          const awaiting = state.strategies.filter((item) => item.state === "validation");
          const hasLegacy = await this.validateLegacyStrategies(state, body.bars ?? {});
          awaiting.filter((item) => item.engine_family === "backtrader").forEach((item) => {
            this.record(state, "BACKTEST_ERROR", `${item.name} validation deferred`, "Backtrader engine is unavailable; holdout was not run by another engine");
          });
          if (hasLegacy) state.marketClock += 5;
          if (!awaiting.length) this.record(state, "VALIDATE", "No strategies awaiting validation", "Supervisor approval is required before holdout testing.");
        }
        else if (engineMode(this.env) === "backtrader") {
          const awaiting = state.strategies.filter((item) => item.state === "validation");
          const hasLegacy = awaiting.some((item) => (item.engine_family ?? "legacy") === "legacy");
          const hasRemote = awaiting.some((item) => item.engine_family === "backtrader");
          if (!awaiting.length) this.record(state, "VALIDATE", "No strategies awaiting validation", "Supervisor approval is required before holdout testing.");
          if (hasLegacy) await this.validateLegacyStrategies(state, body.bars ?? {});
          if (hasRemote) await this.validateRemote(state, this.env, { advanceClock: false, silent: true });
          if (hasLegacy || hasRemote) state.marketClock += 5;
        }
        else {
          const shadow = structuredClone(state);
          const awaiting = state.strategies.some((item) => item.state === "validation");
          await this.validateRemote(shadow, this.env, { includeShadow: true, advanceClock: false });
          state.backtestArtifacts = shadow.backtestArtifacts;
          for (const strategy of state.strategies) {
            const remote = shadow.strategies.find((item) => item.id === strategy.id);
            if (!remote?.backtest_runs?.holdout) continue;
            if (strategy.engine_family === "backtrader") {
              strategy.validation = remote.validation;
              strategy.state = remote.state;
              strategy.backtests = remote.backtests;
              strategy.rework = remote.rework;
              strategy.backtest_runs = { ...(strategy.backtest_runs ?? {}), holdout: remote.backtest_runs.holdout };
              continue;
            }
            strategy.backtest_runs ??= {};
            strategy.backtest_runs.shadow_validation = { ...remote.backtest_runs.holdout, phase: "holdout", remote_metrics: remote.validation, comparison: comparison(strategy.validation, remote.validation) };
          }
          await this.validateLegacyStrategies(state, body.bars ?? {});
          if (awaiting) state.marketClock += 5;
          state.strategies.forEach((strategy) => {
            if (strategy.backtest_runs?.shadow_validation) strategy.backtest_runs.shadow_validation.comparison = comparison(strategy.validation, strategy.backtest_runs.shadow_validation.remote_metrics);
          });
          shadow.events.filter((item) => item.kind === "BACKTEST_ERROR").forEach((item) => {
            if (!state.events.some((event) => event.title === item.title && event.detail === item.detail)) {
              this.record(state, "BACKTEST_ERROR", item.title, item.detail);
            }
          });
        }
        return this.save(state);
      }
      if (request.method === "GET" && url.pathname.startsWith("/api/backtest-artifacts/")) {
        const id = decodeURIComponent(url.pathname.slice("/api/backtest-artifacts/".length));
        const artifact = await this.controlPlane.artifacts.getArtifact(id);
        return artifact ? json(artifact) : json({ error: "Artifact not found" }, 404);
      }
      if (request.method === "POST" && url.pathname === "/internal/alpaca-cycle") {
        const cycle = await request.json();
        const changed = applyAlpacaCycle(state, cycle);
        return changed ? this.save(state) : json(snapshot(state));
      }
      if (request.method === "POST" && url.pathname === "/internal/alpaca-overview") {
        const overview = await request.json();
        applyAlpacaOverview(state, overview);
        return this.save(state);
      }
      if (request.method === "POST" && url.pathname === "/internal/scheduled") {
        const scheduledBucket = request.headers.get("x-axiom-scheduled-bucket");
        if (!scheduledBucket) return json({ error: "Missing schedule bucket" }, 400);
        if (state.lastScheduledBucket === scheduledBucket) return json({ ok: true, duplicate: true });
        state.lastScheduledBucket = scheduledBucket;
        advanceMarket(state, 1);
        await this.controlPlane.saveState(state);
        return json({ ok: true, duplicate: false, bucket: scheduledBucket });
      }
      return json({ error: "Unknown endpoint" }, 404);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Invalid request" }, 400);
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      if (!isAuthorized(request, env)) {
        return json({ error: "Admin token required" }, 401);
      }
      const stub = labStub(env);
      try {
        if (request.method === "POST" && url.pathname === "/api/alpaca/sync") {
          const hour = new Date().toISOString().slice(0, 13);
          return await synchronizeAlpaca(env, stub, `manual-${Date.now()}`, hour);
        }
        if (request.method === "POST" && url.pathname === "/api/alpaca/portfolio") {
          return await refreshAlpacaPortfolio(env, stub);
        }
        if (request.method === "POST" && url.pathname === "/api/review") {
          return await reviewWithAlpaca(env, stub);
        }
        if (request.method === "POST" && url.pathname === "/api/validate") {
          return await validateWithAlpaca(env, stub);
        }
        return stub.fetch(request);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "Alpaca request failed" }, 502);
      }
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(controller, env, ctx) {
    if (!env.ALPACA_API_KEY || !env.ALPACA_API_SECRET) {
      console.warn("Alpaca schedule skipped: credentials are not configured");
      return;
    }
    const stub = labStub(env);
    const work = [];
    if (controller.cron === "0 * * * *") {
      const bucket = new Date(controller.scheduledTime).toISOString().slice(0, 13);
      work.push(synchronizeAlpaca(env, stub, bucket));
    }
    if (marketDataMode(env) === "shadow" && controller.cron === "* * * * *") {
      work.push(tickMarketData(env, stub, controller.scheduledTime));
    }
    if (work.length) ctx.waitUntil(Promise.all(work));
  },

  async queue(batch, env) {
    await consumeArchitectureQueue(batch, env);
  },
};
