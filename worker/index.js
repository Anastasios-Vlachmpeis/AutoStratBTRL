import { DurableObject } from "cloudflare:workers";
import {
  applyAlpacaCycle,
  applyAlpacaOverview,
  advanceMarket,
  createDemoState,
  generateBatch,
  migrateState,
  reproduce,
  reviewCandidates,
  reviewCandidatesWithBars,
  snapshot,
  validateCandidates,
  validateCandidatesWithBars,
} from "./engine.js";
import { buildPaperCycle, getAccountOverview, getResearchBars } from "./alpaca.js";
import { isAuthorized } from "./auth.js";

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
  const appState = await stateFrom(stub);
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
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const existing = await ctx.storage.get("state");
      if (!existing) await ctx.storage.put("state", createDemoState());
      else if ((existing.schemaVersion ?? 1) < 4) await ctx.storage.put("state", migrateState(existing));
    });
  }

  async load() {
    await this.ready;
    return this.ctx.storage.get("state");
  }

  async save(state) {
    await this.ctx.storage.put("state", state);
    return json(snapshot(state));
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
        return this.save(createDemoState());
      }
      if (request.method === "POST" && url.pathname === "/internal/review-live") {
        const body = await request.json();
        reviewCandidatesWithBars(state, body.bars ?? {});
        return this.save(state);
      }
      if (request.method === "POST" && url.pathname === "/internal/validate-live") {
        const body = await request.json();
        validateCandidatesWithBars(state, body.bars ?? {});
        return this.save(state);
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
