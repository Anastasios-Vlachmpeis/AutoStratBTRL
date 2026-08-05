import { hashCanonical } from "./dsl.js";

const BROKER_ACCOUNT_ID = "alpaca-paper-primary";
const json = (value) => JSON.stringify(value ?? {});
const signedQty = (position) => (position.side === "short" || Number(position.qty) < 0)
  ? -Math.abs(Number(position.qty)) : Math.abs(Number(position.qty));

function id(prefix, value) { return `${prefix}-${hashCanonical(value).slice(0, 48)}`; }

/** Durable broker journal. A plan is inserted before any network submission;
 * execution evidence is then attached idempotently by broker/client IDs. */
export class BrokerStore {
  constructor(db, { clock = () => new Date() } = {}) {
    if (!db) throw new Error("AXIOM_DB is required for broker persistence");
    this.db = db; this.clock = clock;
  }

  now() { return this.clock().toISOString(); }
  statement(sql, ...values) { return this.db.prepare(sql).bind(...values); }
  async batch(statements) { return statements.length ? this.db.batch(statements) : []; }

  async persistPlan({ workspaceId, plan, brokerAccountId = BROKER_ACCOUNT_ID }) {
    if (!workspaceId || !plan?.scheduled_bucket) throw new Error("Workspace and scheduled broker bucket are required");
    const observedAt = plan.fetched_at ?? plan.clock?.timestamp ?? this.now();
    const statements = [this.statement(`INSERT INTO workspaces
      (workspace_id,display_name,environment,status,created_at,updated_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(workspace_id) DO UPDATE SET updated_at=excluded.updated_at`,
    workspaceId, workspaceId, "development", "active", observedAt, observedAt)];

    for (const contribution of plan.allocation?.contributions ?? []) {
      const identity = { bucket: plan.scheduled_bucket, strategy_id: contribution.strategy_id,
        symbol: contribution.symbol, notional: contribution.notional };
      const key = hashCanonical(identity);
      statements.push(this.statement(`INSERT INTO risk_actions
        (workspace_id,risk_action_id,strategy_id,release_id,action_kind,scope_kind,scope_id,reason_code,
         target_json,idempotency_key,evidence_artifact_id,actor,decided_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,idempotency_key) DO NOTHING`,
      workspaceId, id("risk", identity), contribution.strategy_id, null, "allocate", "symbol",
      contribution.symbol, "portfolio_risk_policy", json(contribution), key, null, "system", observedAt));
    }
    if (plan.daily_risk?.halted) {
      const identity = { bucket: plan.scheduled_bucket, session: plan.daily_risk.session_date,
        reason: plan.daily_risk.reason };
      statements.push(this.statement(`INSERT INTO risk_actions
        (workspace_id,risk_action_id,strategy_id,release_id,action_kind,scope_kind,scope_id,reason_code,
         target_json,idempotency_key,evidence_artifact_id,actor,decided_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,idempotency_key) DO NOTHING`,
      workspaceId, id("risk", identity), null, null, "halt", "portfolio", brokerAccountId,
      plan.daily_risk.reason ?? "daily_loss_limit", json(plan.daily_risk), hashCanonical(identity),
      null, "system", observedAt));
    }
    for (const intent of plan.broker_intents ?? []) {
      const requestHash = hashCanonical(intent);
      statements.push(this.statement(`INSERT INTO broker_intents
        (workspace_id,broker_intent_id,broker_account_id,strategy_id,bar_event_id,symbol,
         target_signed_notional,target_signed_quantity,intent_kind,status,idempotency_key,request_hash,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,broker_intent_id) DO UPDATE SET
        status=CASE WHEN broker_intents.request_hash=excluded.request_hash THEN broker_intents.status ELSE 'hash_conflict' END`,
      workspaceId, intent.broker_intent_id, brokerAccountId,
      intent.allocations?.length === 1 ? intent.allocations[0].strategy_id : null, null, intent.symbol,
      Number(intent.target_signed_notional), null, intent.intent_kind, "planned",
      hashCanonical({ bucket: plan.scheduled_bucket, symbol: intent.symbol }), requestHash, observedAt));
      for (const allocation of intent.allocations ?? []) {
        const allocationHash = hashCanonical({ broker_intent_id: intent.broker_intent_id,
          strategy_id: allocation.strategy_id, signed_notional: Number(allocation.signed_notional) });
        statements.push(this.statement(`INSERT INTO broker_intent_allocations
          (workspace_id,broker_intent_id,strategy_id,signed_notional,allocation_hash,created_at)
          VALUES (?,?,?,?,?,?) ON CONFLICT(workspace_id,broker_intent_id,strategy_id) DO NOTHING`,
        workspaceId, intent.broker_intent_id, allocation.strategy_id,
        Number(allocation.signed_notional), allocationHash, observedAt));
      }
    }
    for (const order of plan.order_plans ?? []) {
      const orderId = id("order", { brokerAccountId, client_order_id: order.client_order_id });
      statements.push(this.statement(`INSERT INTO orders
        (workspace_id,order_id,broker_intent_id,broker_account_id,broker_order_id,client_order_id,
         symbol,side,order_type,time_in_force,requested_quantity,requested_notional,status,submitted_at,terminal_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,broker_account_id,client_order_id)
        DO UPDATE SET status=CASE WHEN orders.status='planned' THEN excluded.status ELSE orders.status END`,
      workspaceId, orderId, order._broker_intent_id, brokerAccountId, null, order.client_order_id,
      order.symbol, order.side, order.type, order.time_in_force,
      order.qty == null ? null : Number(order.qty), order.notional == null ? null : Number(order.notional),
      "planned", null, null));
    }
    const managed = new Set(plan.managed_symbols ?? []);
    for (const position of plan.positions ?? []) {
      const source = { brokerAccountId, symbol: position.symbol, qty: position.qty,
        market_value: position.market_value, observed_at: observedAt };
      statements.push(this.statement(`INSERT INTO positions
        (workspace_id,position_snapshot_id,broker_account_id,symbol,signed_quantity,market_value,
         average_entry_price,managed,source_hash,observed_at) VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(workspace_id,broker_account_id,symbol,observed_at) DO NOTHING`,
      workspaceId, id("position", source), brokerAccountId, position.symbol, signedQty(position),
      Number(position.market_value), Number(position.avg_entry_price) || null,
      managed.has(position.symbol) ? 1 : 0, hashCanonical(source), observedAt));
    }
    await this.batch(statements);
    return { planned: plan.order_plans?.length ?? 0, intents: plan.broker_intents?.length ?? 0 };
  }

  async orderForFill(workspaceId, brokerAccountId, fill) {
    if (!fill.broker_order_id) return null;
    return this.statement(`SELECT order_id,client_order_id,broker_intent_id FROM orders
      WHERE workspace_id=? AND broker_account_id=? AND broker_order_id=?`,
    workspaceId, brokerAccountId, fill.broker_order_id).first();
  }

  async allocationsForIntent(workspaceId, brokerIntentId) {
    const result = await this.statement(`SELECT strategy_id,signed_notional FROM broker_intent_allocations
      WHERE workspace_id=? AND broker_intent_id=? ORDER BY strategy_id`, workspaceId, brokerIntentId).all();
    return result?.results ?? [];
  }

  async persistExecution({ workspaceId, execution, brokerAccountId = BROKER_ACCOUNT_ID }) {
    const receivedAt = this.now(); const statements = [];
    for (const order of execution.submitted_orders ?? []) {
      const terminal = ["filled", "canceled", "expired", "rejected"].includes(order.status)
        ? order.filled_at ?? order.canceled_at ?? order.updated_at ?? receivedAt : null;
      statements.push(this.statement(`UPDATE orders SET broker_order_id=?,status=?,submitted_at=COALESCE(submitted_at,?),
        terminal_at=COALESCE(terminal_at,?) WHERE workspace_id=? AND broker_account_id=? AND client_order_id=?`,
      order.id, order.status, order.submitted_at ?? receivedAt, terminal,
      workspaceId, brokerAccountId, order.client_order_id));
      statements.push(this.statement(`UPDATE broker_intents SET status=? WHERE workspace_id=? AND broker_intent_id=?`,
        order.status === "rejected" ? "rejected" : "submitted", workspaceId, order.broker_intent_id));
    }
    for (const order of execution.cancelled_orders ?? []) {
      statements.push(this.statement(`UPDATE orders SET status='cancel_requested',terminal_at=COALESCE(terminal_at,?)
        WHERE workspace_id=? AND broker_account_id=? AND broker_order_id=?`,
      order.canceled_at ?? receivedAt, workspaceId, brokerAccountId, order.id));
    }
    await this.batch(statements);

    let persistedFills = 0; const unattributed = []; const recoveredAllocations = {};
    for (const fill of execution.fills ?? []) {
      const order = await this.orderForFill(workspaceId, brokerAccountId, fill);
      if (!order) { unattributed.push({ broker_fill_id: fill.broker_fill_id, reason: "unknown_or_manual_order" }); continue; }
      const fillId = id("fill", { brokerAccountId, broker_fill_id: fill.broker_fill_id });
      await this.statement(`INSERT INTO fills
        (workspace_id,fill_id,order_id,broker_account_id,broker_fill_id,symbol,side,quantity,price,fee,
         filled_at,received_at,raw_artifact_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(workspace_id,broker_account_id,broker_fill_id) DO NOTHING`,
      workspaceId, fillId, order.order_id, brokerAccountId, fill.broker_fill_id, fill.symbol,
      fill.side, Math.abs(Number(fill.qty)), Number(fill.price), 0, fill.transaction_time,
      receivedAt, null).run();
      persistedFills += 1;
      let allocations = fill.allocations ?? [];
      if (!allocations.length) {
        allocations = await this.allocationsForIntent(workspaceId, order.broker_intent_id);
        if (allocations.length) recoveredAllocations[fill.broker_fill_id] = allocations;
      }
      const gross = allocations.reduce((sum, item) => sum + Math.abs(Number(item.signed_notional)), 0);
      if (!gross) { unattributed.push({ broker_fill_id: fill.broker_fill_id, reason: "missing_strategy_allocation" }); continue; }
      const fillSign = fill.side === "sell" ? -1 : 1;
      const allocationStatements = allocations.map((allocation) => {
        const weight = Math.abs(Number(allocation.signed_notional)) / gross;
        const signedQuantity = fillSign * Math.abs(Number(fill.qty)) * weight;
        const allocatedNotional = signedQuantity * Number(fill.price);
        const identity = { fillId, strategy_id: allocation.strategy_id, signedQuantity, allocatedNotional };
        const allocationHash = hashCanonical(identity);
        return this.statement(`INSERT INTO attribution
          (workspace_id,attribution_id,fill_id,strategy_id,release_id,symbol,signed_quantity,
           allocated_notional,realized_pnl,allocation_hash,attributed_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,allocation_hash) DO NOTHING`,
        workspaceId, id("attribution", identity), fillId, allocation.strategy_id, null, fill.symbol,
        signedQuantity, allocatedNotional, null, allocationHash, fill.transaction_time);
      });
      await this.batch(allocationStatements);
    }
    return { submitted: execution.submitted_orders?.length ?? 0, persisted_fills: persistedFills,
      unattributed, recovered_allocations: recoveredAllocations };
  }

  async persistCancellations({ workspaceId, cancelled = [], brokerAccountId = BROKER_ACCOUNT_ID }) {
    const at = this.now();
    await this.batch(cancelled.map((order) => this.statement(`UPDATE orders
      SET status='cancel_requested',terminal_at=COALESCE(terminal_at,?)
      WHERE workspace_id=? AND broker_account_id=? AND broker_order_id=?`,
    at, workspaceId, brokerAccountId, order.id)));
    return { cancelled: cancelled.length };
  }
}

export { BROKER_ACCOUNT_ID };
