import assert from "node:assert/strict";
import test from "node:test";

import {
  VALID_DAY_MINIMUM_COVERAGE,
  applyLiveMinutePoll,
  auditFiveMinuteBars,
  backfillDateBounds,
  buildBackfillJobs,
  buildCalendarManifest,
  buildDatasetManifest,
  buildHistoricalPartitions,
  buildMonthlyRanges,
  buildSessionReconciliation,
  ensureMarketDataState,
  exchangeParts,
  livePollBounds,
  marketDataMode,
  marketScheduleAction,
  normalizeCalendarSessions,
  publicMarketDataState,
  recordMarketDataUsage,
} from "./market-data.js";
import { initialUniverseManifest } from "./universe.js";

const sessions = normalizeCalendarSessions([
  { date: "2026-03-06", open: "09:30", close: "16:00" },
  { date: "2026-03-09", open: "09:30", close: "16:00" },
  { date: "2026-11-27", open: "09:30", close: "13:00" },
]);

function bar(t, close, volume = 100) {
  return { t, o: close - 0.2, h: close + 0.4, l: close - 0.5, c: close, v: volume };
}

function minuteSet(start = "2026-03-09T13:30:00Z", count = 5) {
  const base = new Date(start).getTime();
  return Array.from({ length: count }, (_, index) => bar(new Date(base + index * 60000).toISOString(), 100 + index, 100 + index));
}

test("exchange timestamps respect New York DST and early-close calendars", () => {
  assert.deepEqual(exchangeParts("2026-03-06T14:30:00Z"), {
    date: "2026-03-06", year: 2026, month: 3, day: 6, weekday: "Fri",
    hour: 9, minute: 30, second: 0, minute_of_day: 570,
  });
  assert.equal(exchangeParts("2026-03-09T13:30:00Z").minute_of_day, 570);
  assert.equal(sessions[2].expected_five_minute_bars, 42);
  assert.equal(marketScheduleAction("2026-11-27T18:10:00Z", sessions), "reconcile");
  assert.equal(marketScheduleAction("2026-11-27T18:30:00Z", sessions), "reconcile");
  assert.equal(marketScheduleAction("2026-11-27T18:31:00Z", sessions), "idle");
});

test("calendar manifests are deterministic and retain exact early closes", async () => {
  const first = await buildCalendarManifest(sessions, "2026-03-06", "2026-11-27");
  const second = await buildCalendarManifest(sessions, "2026-03-06", "2026-11-27");
  assert.deepEqual(first, second);
  assert.equal(first.session_count, 3);
  assert.match(first.sha256, /^[a-f0-9]{64}$/);
  assert.equal(first.sessions.at(-1).close, "13:00");
});

test("historical audit filters extended hours and records missing regular bars", () => {
  const regular = [
    bar("2026-03-09T13:30:00Z", 100),
    bar("2026-03-09T13:35:00Z", 101),
  ];
  const result = auditFiveMinuteBars("SPY", [bar("2026-03-09T12:00:00Z", 99), ...regular],
    [sessions[1]], { start: "2026-03-09", end: "2026-03-09" });
  assert.deepEqual(result.bars.map((item) => item.c), regular.map((item) => item.c));
  assert.ok(result.bars.every((item) => item.t.endsWith(".000Z")));
  assert.equal(result.expected_bars, 78);
  assert.equal(result.observed_bars, 2);
  assert.equal(result.missing_bars, 76);
  assert.equal(result.coverage, 2 / 78);
});

test("historical audit rejects malformed OHLC and duplicate timestamps", () => {
  const valid = bar("2026-03-09T13:30:00Z", 100);
  assert.throws(() => auditFiveMinuteBars("SPY", [valid, valid], [sessions[1]]), /duplicate timestamp/);
  assert.throws(() => auditFiveMinuteBars("SPY", [{ ...valid, h: 90 }], [sessions[1]]), /invalid OHLCV/);
});

test("historical audit flags unexplained overnight adjustment discontinuities", () => {
  const result = auditFiveMinuteBars("SPY", [
    bar("2026-03-06T20:55:00Z", 100),
    { ...bar("2026-03-09T13:30:00Z", 250), o: 250 },
  ], sessions.slice(0, 2));
  assert.equal(result.adjustment_discontinuities.length, 1);
  assert.equal(result.adjustment_discontinuities[0].ratio, 2.5);
});

test("live one-minute bars finalize once after the watermark", async () => {
  const bars = { SPY: minuteSet() };
  const provisional = await applyLiveMinutePoll(null, bars, [sessions[1]], {
    now: "2026-03-09T13:35:30Z", receivedAt: "2026-03-09T13:35:30Z", expectedSymbols: ["SPY"],
  });
  assert.equal(provisional.events.length, 0);
  const finalized = await applyLiveMinutePoll(provisional.book, bars, [sessions[1]], {
    now: "2026-03-09T13:36:20Z", receivedAt: "2026-03-09T13:36:20Z", expectedSymbols: ["SPY"],
  });
  assert.equal(finalized.source_revisions.length, 0);
  assert.equal(finalized.events.length, 1);
  assert.equal(finalized.events[0].actionable, true);
  assert.equal(finalized.events[0].bar.o, 99.8);
  assert.equal(finalized.events[0].bar.c, 104);
  assert.equal(finalized.events[0].bar.v, 510);
  assert.equal(finalized.health.status, "healthy");
  const duplicate = await applyLiveMinutePoll(finalized.book, bars, [sessions[1]], {
    now: "2026-03-09T13:37:20Z", receivedAt: "2026-03-09T13:37:20Z", expectedSymbols: ["SPY"],
  });
  assert.equal(duplicate.events.length, 0);
});

test("late source corrections create non-actionable five-minute revisions", async () => {
  const first = await applyLiveMinutePoll(null, { SPY: minuteSet() }, [sessions[1]], {
    now: "2026-03-09T13:36:20Z", receivedAt: "2026-03-09T13:36:20Z", expectedSymbols: ["SPY"],
  });
  const correctedBar = { ...minuteSet().at(-1), h: 107, c: 106 };
  const revised = await applyLiveMinutePoll(first.book, { SPY: [correctedBar] }, [sessions[1]], {
    now: "2026-03-09T13:37:20Z", receivedAt: "2026-03-09T13:37:20Z", expectedSymbols: ["SPY"],
  });
  assert.equal(revised.source_revisions.length, 1);
  assert.equal(revised.source_revisions[0].corrected, true);
  assert.match(revised.source_revisions[0].id, /^source-iex-SPY-/);
  assert.equal(revised.source_revisions[0].bar.c, 106);
  assert.equal(revised.events.length, 1);
  assert.equal(revised.events[0].revision, 2);
  assert.equal(revised.events[0].retroactive, true);
  assert.equal(revised.events[0].actionable, false);
  assert.equal(revised.events[0].health, "revising");
});

test("incomplete source buckets are gapped and cannot become actionable", async () => {
  const result = await applyLiveMinutePoll(null, { SPY: minuteSet(undefined, 4) }, [sessions[1]], {
    now: "2026-03-09T13:36:20Z", receivedAt: "2026-03-09T13:36:20Z", expectedSymbols: ["SPY"],
  });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].coverage, 0.8);
  assert.equal(result.events[0].health, "gapped");
  assert.equal(result.events[0].actionable, false);
});

test("monthly backfill jobs are deterministic, resumable, and cover all 40 symbols", async () => {
  const universe = await initialUniverseManifest();
  const calendar = await buildCalendarManifest(sessions, "2023-08-02", "2026-08-02");
  const ranges = buildMonthlyRanges("2023-08-02", "2026-08-02");
  const first = await buildBackfillJobs({ universe, calendar, start: "2023-08-02", end: "2026-08-02" });
  const second = await buildBackfillJobs({ universe, calendar, start: "2023-08-02", end: "2026-08-02" });
  assert.equal(first.length, ranges.length * 40);
  assert.deepEqual(first, second);
  assert.equal(new Set(first.map((job) => job.id)).size, first.length);
});

test("partition and dataset hashes reproduce and change with bar content", async () => {
  const universe = await initialUniverseManifest();
  const calendar = await buildCalendarManifest([sessions[1]], "2026-03-09", "2026-03-09");
  const bars = [bar("2026-03-09T13:30:00Z", 100), bar("2026-03-09T13:35:00Z", 101)];
  const audit = auditFiveMinuteBars("SPY", bars, calendar.sessions, { start: "2026-03-09", end: "2026-03-09" });
  const job = (await buildBackfillJobs({ universe: { ...universe, symbols: ["SPY"] }, calendar,
    start: "2026-03-09", end: "2026-03-09" }))[0];
  const partitions = await buildHistoricalPartitions({ universe, calendar, symbol: "SPY", audit, job });
  const dataset = await buildDatasetManifest({ universe: { ...universe, symbols: ["SPY"] }, calendar,
    start: "2026-03-09", end: "2026-03-09", partitions });
  const replay = await buildDatasetManifest({ universe: { ...universe, symbols: ["SPY"] }, calendar,
    start: "2026-03-09", end: "2026-03-09", partitions });
  assert.deepEqual(dataset, replay);
  const relocated = await buildDatasetManifest({ universe: { ...universe, symbols: ["SPY"] }, calendar,
    start: "2026-03-09", end: "2026-03-09",
    partitions: partitions.map((item) => ({ ...item, object_key: "moved/private/object.gz", byte_length: 999999 })) });
  assert.equal(relocated.sha256, dataset.sha256);
  const changedAudit = auditFiveMinuteBars("SPY", [{ ...bars[0], c: 100.1 }, bars[1]], calendar.sessions,
    { start: "2026-03-09", end: "2026-03-09" });
  const changedPartitions = await buildHistoricalPartitions({ universe, calendar, symbol: "SPY", audit: changedAudit, job });
  assert.notEqual(changedPartitions[0].content_hash, partitions[0].content_hash);
});

test("session reconciliation detects exact matches and unexplained differences", async () => {
  const universe = { ...(await initialUniverseManifest()), symbols: ["SPY"] };
  const calendar = await buildCalendarManifest([sessions[1]], "2026-03-09", "2026-03-09");
  const native = [bar("2026-03-09T13:30:00Z", 100)];
  const audits = { SPY: auditFiveMinuteBars("SPY", native, calendar.sessions,
    { start: "2026-03-09", end: "2026-03-09" }) };
  const healthy = await buildSessionReconciliation({ universe, calendar, sessionDate: "2026-03-09", audits,
    liveEvents: [{ symbol: "SPY", payload_json: JSON.stringify(native[0]) }] });
  assert.equal(healthy.summary.matched, 1);
  // This fixture has intentionally low day coverage, so it is not a valid-day reconciliation.
  assert.equal(healthy.status, "revising");
  assert.equal(VALID_DAY_MINIMUM_COVERAGE, 0.90);
  const mismatch = await buildSessionReconciliation({ universe, calendar, sessionDate: "2026-03-09", audits,
    liveEvents: [{ symbol: "SPY", payload_json: JSON.stringify({ ...native[0], c: 100.2 }) }] });
  assert.equal(mismatch.summary.mismatched, 1);
});

test("public market-data state contains metadata but no raw source bars", async () => {
  const state = {};
  await ensureMarketDataState(state, { MARKET_DATA_MODE: "shadow" });
  state.marketData.private_bars = [{ secret: true }];
  const publicState = publicMarketDataState(state);
  assert.equal(publicState.mode, "shadow");
  assert.equal(publicState.universe.symbol_count, 40);
  assert.equal("private_bars" in publicState, false);
  assert.equal(marketDataMode({ MARKET_DATA_MODE: "invalid" }), "off");
  assert.equal(livePollBounds(new Date("2026-03-09T14:00:00Z")).start, "2026-03-09T13:48:00.000Z");
  assert.deepEqual(backfillDateBounds(new Date("2026-08-03T12:00:00Z")), { start: "2023-08-02", end: "2026-08-02" });
});

test("daily cost telemetry rolls over without exposing private bars", async () => {
  const state = {};
  await ensureMarketDataState(state, { MARKET_DATA_MODE: "shadow" });
  recordMarketDataUsage(state, { alpaca_requests: 3, d1_rows: 12 }, "2026-08-03T14:00:00Z");
  recordMarketDataUsage(state, { alpaca_requests: 2, r2_writes: 1 }, "2026-08-03T15:00:00Z");
  assert.equal(state.marketData.usage.alpaca_requests, 5);
  assert.equal(state.marketData.usage.d1_rows, 12);
  recordMarketDataUsage(state, { alpaca_requests: 1 }, "2026-08-04T14:00:00Z");
  assert.equal(state.marketData.usage.alpaca_requests, 1);
  assert.equal(publicMarketDataState(state).usage.date, "2026-08-04");
});
