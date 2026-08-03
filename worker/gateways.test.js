import assert from "node:assert/strict";
import test from "node:test";

import {
  AlpacaMarketDataGateway,
  AlpacaPaperBrokerGateway,
  BacktestResearchGateway,
  createRuntimeGateways,
} from "./gateways.js";

test("runtime gateways expose explicit market, broker, and research boundaries", () => {
  const gateways = createRuntimeGateways({});
  assert.ok(gateways.marketData instanceof AlpacaMarketDataGateway);
  assert.ok(gateways.broker instanceof AlpacaPaperBrokerGateway);
  assert.ok(gateways.research instanceof BacktestResearchGateway);
  assert.equal(typeof gateways.marketData.researchBars, "function");
  assert.equal(typeof gateways.broker.accountOverview, "function");
  assert.equal(typeof gateways.broker.buildCycle, "function");
  assert.equal(typeof gateways.research.run, "function");
});

