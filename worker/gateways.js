import {
  buildPaperCycle,
  getAccountOverview,
  getAssets,
  getFiveMinuteBars,
  getFiveMinuteHistory,
  getMarketCalendar,
  getRecentMinuteBars,
  getResearchBars,
} from "./alpaca.js";
import { signedBacktest } from "./backtest.js";

export class AlpacaMarketDataGateway {
  constructor(env) {
    this.env = env;
  }

  async researchBars(symbols) {
    return getResearchBars(this.env, symbols);
  }

  async calendar(start, end) {
    return getMarketCalendar(this.env, start, end);
  }

  async fiveMinuteHistory(symbol, bounds) {
    return getFiveMinuteHistory(this.env, symbol, bounds);
  }

  async fiveMinuteBars(symbols, bounds) {
    return getFiveMinuteBars(this.env, symbols, bounds);
  }

  async recentMinuteBars(symbols, bounds) {
    return getRecentMinuteBars(this.env, symbols, bounds);
  }

  async assets(symbols) {
    return getAssets(this.env, symbols);
  }
}

export class AlpacaPaperBrokerGateway {
  constructor(env) {
    this.env = env;
  }

  async accountOverview() {
    return getAccountOverview(this.env);
  }

  async buildCycle(appState, scheduledBucket, orderBucket = scheduledBucket) {
    return buildPaperCycle(this.env, appState, scheduledBucket, orderBucket);
  }
}

export class BacktestResearchGateway {
  constructor(env) {
    this.env = env;
  }

  async run(payload) {
    return signedBacktest(this.env, payload);
  }
}

export function createRuntimeGateways(env) {
  return {
    marketData: new AlpacaMarketDataGateway(env),
    broker: new AlpacaPaperBrokerGateway(env),
    research: new BacktestResearchGateway(env),
  };
}
