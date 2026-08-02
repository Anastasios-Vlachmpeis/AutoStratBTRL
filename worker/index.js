import { DurableObject } from "cloudflare:workers";
import {
  applyAlpacaCycle,
  applyAlpacaOverview,
  advanceMarket,
  createDemoState,
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
import { buildPaperCycle, getAccountOverview, getResearchBars } from "./alpaca.js";
import { isAuthorized } from "./auth.js";
import {
  aggregateMetrics, buildBacktestPayload, comparison, engineMode, frozenDna,
  makeDataset, normalizeMetrics, remoteEnabled, reviewDecision, sha256, signedBacktest, validationDecision,
} from "./backtest.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const SINGLETON_NAME = "axiom-global-supervisor";

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: JSON_HEADERS });
}

function labStub(env) {
  return env.AXIOM_LAB.get(env.AXIOM_LAB.idFromName(SINGLETON_NAME));
}

async function stateFrom(stub) {
  const response = await stub.fetch(new Request("https://axiom.internal/api/state"));
  if (!response.ok) throw new Error("Unable to load supervisor state");
  return response.json();
}

async function synchronizeAlpaca(env, stub, bucket, orderBucket = bucket) {
  const appState = await stateFrom(stub);
  const cycle = await buildPaperCycle(env, appState, bucket, orderBucket);
  return stub.fetch(new Request("https://axiom.internal/internal/alpaca-cycle", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(cycle),
  }));
}

async function refreshAlpacaPortfolio(env, stub) {
  const overview = await getAccountOverview(env);
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
  const bars = await getResearchBars(env, symbols);
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
  const bars = await getResearchBars(env, symbols);
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
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const existing = await ctx.storage.get("state");
      if (!existing) {
        const initial = createDemoState();
        initial.schemaVersion = 5; initial.datasets = {}; initial.backtestArtifacts = {};
        await ctx.storage.put("state", initial);
      }
      else {
        const migrated = (existing.schemaVersion ?? 1) < 5 ? migrateState(existing) : existing;
        if ((migrated.schemaVersion ?? 1) < 5) {
          migrated.schemaVersion = 5;
          migrated.datasets ??= {};
          migrated.backtestArtifacts ??= {};
        }
        await ctx.storage.put("state", migrated);
      }
    });
  }

  async load() {
    await this.ready;
    return this.ctx.storage.get("state");
  }

  async save(state) {
    state.schemaVersion = Math.max(state.schemaVersion ?? 1, 5);
    state.datasets ??= {};
    state.backtestArtifacts ??= {};
    await this.ctx.storage.put("state", state);
    return json(snapshot(state));
  }

  record(state, type, title, detail) {
    const now = new Date();
    state.events.unshift({ id: `BT-${now.getTime()}-${Math.random().toString(36).slice(2, 7)}`,
      kind: type, type, title, detail, time: now.toISOString().slice(11, 16), at: now.toISOString() });
    state.events = state.events.slice(0, 28);
  }

  async clearBacktestStorage() {
    const keys = await this.ctx.storage.list({ prefix: "bt:" });
    if (keys.size) await this.ctx.storage.delete([...keys.keys()]);
  }

  async persistArtifact(state, artifact, result) {
    const artifactId = `artifact-${artifact.job_id}-${artifact.strategy_id}`;
    const redactBars = (value) => {
      if (Array.isArray(value)) return value.map(redactBars);
      if (!value || typeof value !== "object") return value;
      return Object.fromEntries(Object.entries(value)
        .filter(([key]) => !["bars", "raw_bars", "development_bars", "holdout_bars"].includes(key))
        .map(([key, item]) => [key, redactBars(item)]));
    };
    const safe = redactBars({ ...artifact, result });
    await this.ctx.storage.put(`bt:artifact:${artifactId}`, safe);
    state.backtestArtifacts ??= {};
    state.backtestArtifacts[artifactId] = { id: artifactId, phase: artifact.phase, strategy_id: artifact.strategy_id, created_at: artifact.created_at, engine: artifact.engine, dataset: artifact.dataset };
    return artifactId;
  }

  async sealDataset(state, symbol, bars) {
    const dataset = await makeDataset(symbol, bars);
    if (dataset.development.length < 300 || dataset.holdout.length < 100) throw new Error(`${symbol} has insufficient history for sealed backtesting`);
    state.datasets ??= {};
    if (!state.datasets[dataset.id]) {
      await this.ctx.storage.put(`bt:dataset:${dataset.id}:development`, dataset.development);
      await this.ctx.storage.put(`bt:dataset:${dataset.id}:holdout`, dataset.holdout);
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
          this.ctx.storage.get(`bt:dataset:${strategy.dataset_id}:development`),
          this.ctx.storage.get(`bt:dataset:${strategy.dataset_id}:holdout`),
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

  async invokeBacktrader(state, env, phase, strategies, dataset) {
    const bars = await this.ctx.storage.get(`bt:dataset:${dataset.id}:${phase === "holdout" ? "holdout" : "development"}`);
    if (!bars?.length) throw new Error(`Sealed ${phase} dataset is unavailable`);
    const built = await buildBacktestPayload(phase, strategies, dataset, bars);
    const { payload, config_hash, dna, slice_hash: sliceHash } = built;
    const job_id = payload.job_id;
    const response = await signedBacktest(env, payload);
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
        const run = await this.invokeBacktrader(state, env, "development", strategies, dataset);
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
      const run = await this.invokeBacktrader(state, env, "holdout", strategies, dataset);
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
        await this.clearBacktestStorage();
        return this.save(createDemoState());
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
        const artifact = await this.ctx.storage.get(`bt:artifact:${id}`);
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
        await this.ctx.storage.put("state", state);
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
    const bucket = new Date(controller.scheduledTime).toISOString().slice(0, 13);
    if (!env.ALPACA_API_KEY || !env.ALPACA_API_SECRET) {
      console.warn("Alpaca schedule skipped: credentials are not configured");
      return;
    }
    ctx.waitUntil(synchronizeAlpaca(env, labStub(env), bucket));
  },
};
