import assert from "node:assert/strict";
import test from "node:test";
import { BrokerStore } from "./broker-store.js";

class MemoryD1 {
  constructor() { this.calls = []; this.orders = new Map(); this.allocations = new Map(); }
  prepare(sql) {
    const db = this; let args = [];
    return {
      bind(...values) { args = values; return this; },
      async run() {
        db.calls.push({ sql, args });
        if (sql.includes("INSERT INTO orders")) db.orders.set(args[5], {
          order_id: args[1], broker_intent_id: args[2], client_order_id: args[5],
        });
        if (sql.includes("INSERT INTO broker_intent_allocations")) {
          const values = db.allocations.get(args[1]) ?? [];
          values.push({ strategy_id: args[2], signed_notional: args[3] }); db.allocations.set(args[1], values);
        }
        if (sql.startsWith("UPDATE orders SET broker_order_id")) {
          const known = db.orders.get(args[6]); if (known) db.orders.set(args[0], known);
        }
        return { meta: { changes: 1 } };
      },
      async first() { db.calls.push({ sql, args }); return db.orders.get(args[2]) ?? null; },
      async all() { db.calls.push({ sql, args }); return { results: db.allocations.get(args[1]) ?? [] }; },
      async _run() { return this.run(); },
    };
  }
  async batch(statements) { return Promise.all(statements.map((statement) => statement._run())); }
}

const clock = () => new Date("2026-08-05T15:00:00Z");
const plan = () => ({
  scheduled_bucket: "bar:2026-08-05T14:55:00Z", fetched_at: "2026-08-05T15:00:00Z",
  clock: { timestamp: "2026-08-05T15:00:00Z" }, managed_symbols: [],
  allocation: { contributions: [{ strategy_id: "strategy-1", symbol: "SPY", notional: 500 }] },
  daily_risk: { halted: false }, positions: [],
  broker_intents: [{ broker_intent_id: "intent-1", symbol: "SPY", target_signed_notional: 500,
    intent_kind: "rebalance", allocations: [{ strategy_id: "strategy-1", signed_notional: 500 }] }],
  order_plans: [{ _broker_intent_id: "intent-1", client_order_id: "axiom-client-1", symbol: "SPY",
    side: "buy", type: "market", time_in_force: "day", notional: "500" }],
});

test("broker plan is journaled before submission with deterministic idempotency", async () => {
  const db = new MemoryD1(), store = new BrokerStore(db, { clock });
  await store.persistPlan({ workspaceId: "workspace-1", plan: plan() });
  await store.persistPlan({ workspaceId: "workspace-1", plan: plan() });
  assert.ok(db.calls.some((call) => call.sql.includes("INSERT INTO risk_actions")));
  assert.ok(db.calls.some((call) => call.sql.includes("INSERT INTO broker_intents")));
  assert.ok(db.calls.some((call) => call.sql.includes("INSERT INTO broker_intent_allocations")));
  const registryIndex = db.calls.findIndex((call) => call.sql.includes("INSERT INTO paper_broker_accounts"));
  const intentIndex = db.calls.findIndex((call) => call.sql.includes("INSERT INTO broker_intents"));
  assert.ok(registryIndex >= 0 && registryIndex < intentIndex);
  const orderCalls = db.calls.filter((call) => call.sql.includes("INSERT INTO orders"));
  assert.equal(orderCalls.length, 2);
  assert.equal(orderCalls[0].args[1], orderCalls[1].args[1]);
});

test("broker journal rejects non-paper account namespaces", async () => {
  const db = new MemoryD1(), store = new BrokerStore(db, { clock });
  await assert.rejects(store.persistPlan({ workspaceId: "workspace-1", plan: plan(),
    brokerAccountId: "alpaca-live-primary" }), /paper account/);
  assert.equal(db.calls.length, 0);
});

test("known partial fills are append-only and attributed; manual fills are isolated", async () => {
  const db = new MemoryD1(), store = new BrokerStore(db, { clock });
  await store.persistPlan({ workspaceId: "workspace-1", plan: plan() });
  const result = await store.persistExecution({ workspaceId: "workspace-1", execution: {
    submitted_orders: [{ id: "broker-order-1", client_order_id: "axiom-client-1", status: "partially_filled",
      broker_intent_id: "intent-1", submitted_at: "2026-08-05T15:00:00Z" }],
    cancelled_orders: [],
    fills: [
      { broker_fill_id: "fill-1", broker_order_id: "broker-order-1", symbol: "SPY", side: "buy",
        qty: 1.25, price: 400, transaction_time: "2026-08-05T15:00:01Z",
        allocations: [] },
      { broker_fill_id: "manual-fill", broker_order_id: "manual-order", symbol: "QQQ", side: "buy",
        qty: 1, price: 500, transaction_time: "2026-08-05T15:00:02Z", allocations: [] },
    ],
  } });
  assert.equal(result.persisted_fills, 1);
  assert.equal(result.recovered_allocations["fill-1"][0].strategy_id, "strategy-1");
  assert.deepEqual(result.unattributed, [{ broker_fill_id: "manual-fill", reason: "unknown_or_manual_order" }]);
  assert.ok(db.calls.some((call) => call.sql.includes("INSERT INTO fills")));
  assert.ok(db.calls.some((call) => call.sql.includes("INSERT INTO attribution")));
});

test("daily halt creates a durable portfolio risk action", async () => {
  const db = new MemoryD1(), store = new BrokerStore(db, { clock });
  const halted = plan(); halted.daily_risk = { halted: true, session_date: "2026-08-05", reason: "daily_loss_limit" };
  await store.persistPlan({ workspaceId: "workspace-1", plan: halted });
  const actions = db.calls.filter((call) => call.sql.includes("INSERT INTO risk_actions"));
  assert.equal(actions.length, 2);
  assert.ok(actions.some((call) => call.args.includes("halt")));
});

test("safety cancellations update only known broker orders", async () => {
  const db = new MemoryD1(), store = new BrokerStore(db, { clock });
  await store.persistCancellations({ workspaceId: "workspace-1",
    cancelled: [{ id: "broker-order-1" }] });
  const update = db.calls.find((call) => call.sql.includes("SET status='cancel_requested'"));
  assert.equal(update.args.at(-1), "broker-order-1");
});
