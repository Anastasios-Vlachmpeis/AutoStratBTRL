import { sha256 } from "./backtest.js";
import { CONTROL_PLANE_WORKSPACE } from "./control-plane.js";
import { INITIAL_UNIVERSE_SYMBOLS, initialUniverseManifest } from "./universe.js";

export const MARKET_DATA_SCHEMA_VERSION = 1;
export const FIVE_MINUTE_MS = 5 * 60 * 1000;
export const ONE_MINUTE_MS = 60 * 1000;
export const LIVE_OVERLAP_MINUTES = 12;
export const LIVE_WATERMARK_SECONDS = 75;
export const VALID_DAY_MINIMUM_COVERAGE = 0.90;

const ET_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short", hourCycle: "h23",
});
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error ?? "Unknown market-data error");
}

export function marketDataMode(env = {}) {
  const mode = String(env.MARKET_DATA_MODE ?? "off").trim().toLowerCase();
  return ["off", "shadow"].includes(mode) ? mode : "off";
}

export function recordMarketDataUsage(state, increments = {}, at = new Date()) {
  const clock = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(clock.getTime())) throw new Error("Invalid market-data usage timestamp");
  const date = clock.toISOString().slice(0, 10);
  state.marketData ??= {};
  const current = state.marketData.usage?.date === date ? state.marketData.usage : { date };
  for (const key of ["alpaca_requests", "queue_messages", "d1_rows", "r2_writes", "worker_elapsed_ms"]) {
    current[key] = Number(current[key] ?? 0) + Math.max(0, Number(increments[key] ?? 0));
  }
  current.updated_at = new Date().toISOString();
  state.marketData.usage = current;
  return current;
}

export function exchangeParts(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid market timestamp");
  const entries = Object.fromEntries(ET_FORMATTER.formatToParts(date)
    .filter((item) => item.type !== "literal").map((item) => [item.type, item.value]));
  const hour = Number(entries.hour) % 24;
  const minute = Number(entries.minute);
  return {
    date: `${entries.year}-${entries.month}-${entries.day}`,
    year: Number(entries.year), month: Number(entries.month), day: Number(entries.day),
    weekday: entries.weekday, hour, minute, second: Number(entries.second),
    minute_of_day: hour * 60 + minute,
  };
}

function parseClock(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value ?? ""));
  if (!match) throw new Error(`Invalid exchange clock value: ${value}`);
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  if (minutes < 0 || minutes > 24 * 60) throw new Error(`Invalid exchange clock value: ${value}`);
  return minutes;
}

function clockText(minutes) {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function normalizeCalendarSessions(rawSessions = []) {
  const sessions = rawSessions.map((item) => {
    const date = String(item.date ?? "");
    const open = String(item.open ?? item.session_open ?? "");
    const close = String(item.close ?? item.session_close ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Invalid market calendar date: ${date}`);
    const openMinute = parseClock(open);
    const closeMinute = parseClock(close);
    if (closeMinute <= openMinute || (closeMinute - openMinute) % 5 !== 0) {
      throw new Error(`Invalid market calendar session: ${date}`);
    }
    return { date, open: clockText(openMinute), close: clockText(closeMinute),
      expected_one_minute_bars: closeMinute - openMinute,
      expected_five_minute_bars: (closeMinute - openMinute) / 5 };
  }).sort((a, b) => a.date.localeCompare(b.date));
  const dates = new Set();
  for (const session of sessions) {
    if (dates.has(session.date)) throw new Error(`Duplicate market calendar session: ${session.date}`);
    dates.add(session.date);
  }
  return sessions;
}

export function calendarIndex(sessions = []) {
  return Object.fromEntries(normalizeCalendarSessions(sessions).map((session) => [session.date, session]));
}

export async function buildCalendarManifest(rawSessions, requestedStart, requestedEnd) {
  const sessions = normalizeCalendarSessions(rawSessions);
  if (!sessions.length) throw new Error("Market calendar snapshot is empty");
  const canonical = {
    schema_version: 1,
    source: "alpaca-calendar",
    timezone: "America/New_York",
    requested_start: requestedStart,
    requested_end: requestedEnd,
    first_session: sessions[0].date,
    last_session: sessions.at(-1).date,
    session_count: sessions.length,
    sessions,
  };
  const hash = await sha256(canonical);
  return { ...canonical, id: `calendar-${canonical.first_session}-${canonical.last_session}-${hash.slice(0, 16)}`, sha256: hash };
}

export function normalizeMarketBar(raw, symbol = raw?.symbol) {
  const timestamp = new Date(raw?.t);
  const normalized = {
    t: Number.isNaN(timestamp.getTime()) ? "" : timestamp.toISOString(),
    o: Number(raw?.o), h: Number(raw?.h), l: Number(raw?.l), c: Number(raw?.c), v: Number(raw?.v ?? 0),
  };
  if (!normalized.t || ![normalized.o, normalized.h, normalized.l, normalized.c, normalized.v].every(Number.isFinite)) {
    throw new Error(`${symbol ?? "unknown"} contains a malformed bar`);
  }
  if (normalized.o <= 0 || normalized.h <= 0 || normalized.l <= 0 || normalized.c <= 0 || normalized.v < 0
      || normalized.h < Math.max(normalized.o, normalized.l, normalized.c)
      || normalized.l > Math.min(normalized.o, normalized.h, normalized.c)) {
    throw new Error(`${symbol ?? "unknown"} contains an invalid OHLCV bar at ${normalized.t}`);
  }
  return normalized;
}

function sessionBounds(session) {
  return { open: parseClock(session.open), close: parseClock(session.close) };
}

function barSession(bar, sessionsByDate, intervalMinutes) {
  const parts = exchangeParts(bar.t);
  const session = sessionsByDate[parts.date];
  if (!session) return null;
  const bounds = sessionBounds(session);
  if (parts.minute_of_day < bounds.open || parts.minute_of_day >= bounds.close) return null;
  if ((parts.minute_of_day - bounds.open) % intervalMinutes !== 0 || parts.second !== 0) return null;
  return { parts, session, bounds };
}

export function auditFiveMinuteBars(symbol, rawBars, rawSessions, range = {}) {
  const sessions = normalizeCalendarSessions(rawSessions);
  const sessionsByDate = Object.fromEntries(sessions.map((session) => [session.date, session]));
  const seen = new Set();
  const accepted = [];
  for (const raw of rawBars ?? []) {
    const bar = normalizeMarketBar(raw, symbol);
    if (seen.has(bar.t)) throw new Error(`${symbol} contains duplicate timestamp ${bar.t}`);
    seen.add(bar.t);
    if (barSession(bar, sessionsByDate, 5)) accepted.push(bar);
  }
  accepted.sort((a, b) => a.t.localeCompare(b.t));
  const start = range.start ?? sessions[0]?.date;
  const end = range.end ?? sessions.at(-1)?.date;
  const expected = new Set();
  for (const session of sessions.filter((item) => (!start || item.date >= start) && (!end || item.date <= end))) {
    const { open, close } = sessionBounds(session);
    for (let minute = open; minute < close; minute += 5) expected.add(`${session.date}T${clockText(minute)}`);
  }
  const observed = new Set(accepted.map((bar) => {
    const parts = exchangeParts(bar.t);
    return `${parts.date}T${clockText(parts.minute_of_day)}`;
  }));
  const missing = [...expected].filter((key) => !observed.has(key));
  const adjustmentDiscontinuities = [];
  for (let index = 1; index < accepted.length; index += 1) {
    const previous = accepted[index - 1];
    const current = accepted[index];
    const previousParts = exchangeParts(previous.t);
    const currentParts = exchangeParts(current.t);
    const ratio = current.o / previous.c;
    if (previousParts.date !== currentParts.date && (ratio < 0.5 || ratio > 2)) {
      adjustmentDiscontinuities.push({ previous: previous.t, current: current.t, ratio });
    }
  }
  return {
    symbol,
    bars: accepted,
    expected_bars: expected.size,
    observed_bars: observed.size,
    missing_bars: missing.length,
    missing_examples: missing.slice(0, 100),
    coverage: expected.size ? observed.size / expected.size : 0,
    adjustment_discontinuities: adjustmentDiscontinuities,
  };
}

export function buildMonthlyRanges(startDate, endDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate) || startDate > endDate) {
    throw new Error("Invalid monthly backfill bounds");
  }
  const ranges = [];
  let cursor = new Date(`${startDate}T00:00:00Z`);
  const final = new Date(`${endDate}T00:00:00Z`);
  while (cursor <= final) {
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth();
    const monthStart = `${year}-${String(month + 1).padStart(2, "0")}-01`;
    const nextMonth = new Date(Date.UTC(year, month + 1, 1));
    const monthEnd = new Date(nextMonth.getTime() - 86400000).toISOString().slice(0, 10);
    ranges.push({ start: startDate > monthStart ? startDate : monthStart, end: endDate < monthEnd ? endDate : monthEnd,
      year, month: month + 1, key: `${year}-${String(month + 1).padStart(2, "0")}` });
    cursor = nextMonth;
  }
  return ranges;
}

export async function buildBackfillJobs({ universe, calendar, start, end }) {
  const ranges = buildMonthlyRanges(start, end);
  const jobs = [];
  for (const symbol of universe.symbols) for (const range of ranges) {
    const canonical = { schema_version: 1, universe_id: universe.id, universe_hash: universe.sha256,
      calendar_id: calendar.id, feed: universe.feed, symbol, timeframe: "5Min", adjustment: "all",
      start: range.start, end: range.end, partition: range.key };
    const hash = await sha256(canonical);
    jobs.push({ ...canonical, id: `market-backfill-${hash.slice(0, 32)}`, sha256: hash });
  }
  return jobs;
}

export async function buildHistoricalPartitions({ universe, calendar, symbol, audit, job }) {
  const byMonth = new Map();
  for (const bar of audit.bars) {
    const parts = exchangeParts(bar.t);
    const key = `${parts.year}-${String(parts.month).padStart(2, "0")}`;
    const entries = byMonth.get(key) ?? [];
    entries.push(bar); byMonth.set(key, entries);
  }
  const partitions = [];
  for (const [month, bars] of [...byMonth].sort(([a], [b]) => a.localeCompare(b))) {
    const contentHash = await sha256(bars);
    const canonical = { schema_version: 1, feed: universe.feed, adjustment: "all", timeframe: "5Min",
      universe_id: universe.id, universe_hash: universe.sha256, calendar_id: calendar.id,
      symbol, month, start: bars[0].t, end: bars.at(-1).t, row_count: bars.length,
      content_hash: contentHash, source_job_id: job.id,
      expected_bars: audit.expected_bars,
      missing_bars: audit.missing_bars,
      coverage: audit.coverage,
      adjustment_discontinuities: audit.adjustment_discontinuities.length };
    const manifestHash = await sha256(canonical);
    partitions.push({ ...canonical, id: `partition-${manifestHash.slice(0, 32)}`, sha256: manifestHash, bars });
  }
  return partitions;
}

export async function buildDatasetManifest({ universe, calendar, start, end, partitions }) {
  // The dataset identity is independent of storage location and compression
  // byte size.  Only immutable data/provenance and quality fields enter the
  // root hash, so moving an object cannot create a different dataset.
  const summaries = partitions.map((item) => ({
    id: item.id,
    schema_version: item.schema_version ?? MARKET_DATA_SCHEMA_VERSION,
    feed: item.feed,
    adjustment: item.adjustment,
    timeframe: item.timeframe,
    universe_id: item.universe_id,
    universe_hash: item.universe_hash ?? universe.sha256,
    calendar_id: item.calendar_id,
    symbol: item.symbol,
    month: item.month,
    start: item.start,
    end: item.end,
    row_count: Number(item.row_count),
    expected_bars: Number(item.expected_bars ?? item.row_count),
    missing_bars: Number(item.missing_bars ?? 0),
    coverage: Number(item.coverage ?? 1),
    adjustment_discontinuities: Number(item.adjustment_discontinuities ?? 0),
    content_hash: item.content_hash,
    sha256: item.sha256,
  }))
    .sort((a, b) => `${a.symbol}:${a.month}`.localeCompare(`${b.symbol}:${b.month}`));
  const canonical = {
    schema_version: 1, feed: universe.feed, adjustment: "all", timeframe: "5Min", session: "regular",
    universe_id: universe.id, universe_hash: universe.sha256, calendar_id: calendar.id,
    calendar_hash: calendar.sha256, start, end, symbol_count: universe.symbols.length,
    row_count: summaries.reduce((sum, item) => sum + item.row_count, 0),
    missing_bars: summaries.reduce((sum, item) => sum + Number(item.missing_bars ?? 0), 0),
    adjustment_discontinuities: summaries.reduce((sum, item) => sum + Number(item.adjustment_discontinuities ?? 0), 0),
    partitions: summaries,
  };
  const rootHash = await sha256(canonical);
  return { ...canonical, id: `dataset-${rootHash.slice(0, 32)}`, sha256: rootHash };
}

function emptyLiveBook(feed = "iex") {
  return { schema_version: 1, feed, minutes: {}, finalized: {}, latest_by_symbol: {}, last_poll_at: null };
}

function fiveMinuteBucket(bar, sessionsByDate) {
  const match = barSession(bar, sessionsByDate, 1);
  if (!match) return null;
  const offset = match.parts.minute_of_day - match.bounds.open;
  const within = offset % 5;
  const startMs = new Date(bar.t).getTime() - within * ONE_MINUTE_MS;
  const closeMs = startMs + FIVE_MINUTE_MS;
  return { start: new Date(startMs).toISOString(), close: new Date(closeMs).toISOString(), startMs, closeMs };
}

function aggregateMinuteRecords(records, bucket) {
  const ordered = records.sort((a, b) => a.bar.t.localeCompare(b.bar.t));
  if (!ordered.length) return null;
  return {
    t: bucket.start,
    close_t: bucket.close,
    o: ordered[0].bar.o,
    h: Math.max(...ordered.map((item) => item.bar.h)),
    l: Math.min(...ordered.map((item) => item.bar.l)),
    c: ordered.at(-1).bar.c,
    v: ordered.reduce((sum, item) => sum + item.bar.v, 0),
    source_count: ordered.length,
    constituent_hashes: ordered.map((item) => item.hash),
  };
}

export async function applyLiveMinutePoll(existingBook, rawBarsBySymbol, rawSessions, options = {}) {
  const feed = options.feed ?? existingBook?.feed ?? "iex";
  const receivedAt = new Date(options.receivedAt ?? new Date()).toISOString();
  const now = new Date(options.now ?? receivedAt);
  if (Number.isNaN(now.getTime())) throw new Error("Invalid live poll clock");
  const watermarkSeconds = Number(options.watermarkSeconds ?? LIVE_WATERMARK_SECONDS);
  const sessionsByDate = calendarIndex(rawSessions);
  const book = structuredClone(existingBook ?? emptyLiveBook(feed));
  book.feed = feed; book.minutes ??= {}; book.finalized ??= {}; book.latest_by_symbol ??= {};
  const revisions = [];
  const affected = new Map();

  for (const [symbol, rawBars] of Object.entries(rawBarsBySymbol ?? {})) {
    if (!INITIAL_UNIVERSE_SYMBOLS.includes(symbol)) continue;
    book.minutes[symbol] ??= {};
    for (const raw of rawBars ?? []) {
      const bar = normalizeMarketBar(raw, symbol);
      const bucket = fiveMinuteBucket(bar, sessionsByDate);
      if (!bucket) continue;
      const hash = await sha256({ feed, symbol, ...bar });
      const prior = book.minutes[symbol][bar.t];
      if (prior?.hash === hash) continue;
      const revision = Number(prior?.revision ?? 0) + 1;
      book.minutes[symbol][bar.t] = { bar, hash, revision, received_at: receivedAt };
      revisions.push({ id: `source-${feed}-${symbol}-${bar.t}-${revision}`, feed, symbol, timestamp: bar.t,
        source_hash: hash, revision, received_at: receivedAt, corrected: Boolean(prior), bar });
      affected.set(`${symbol}:${bucket.start}`, { symbol, bucket });
    }
  }

  // A bucket usually becomes eligible after a later poll. Revisit every
  // buffered bucket so finalization does not depend on receiving a correction
  // after the watermark has elapsed.
  for (const [symbol, entries] of Object.entries(book.minutes)) {
    for (const item of Object.values(entries)) {
      const bucket = fiveMinuteBucket(item.bar, sessionsByDate);
      if (bucket) affected.set(`${symbol}:${bucket.start}`, { symbol, bucket });
    }
  }

  const events = [];
  for (const { symbol, bucket } of affected.values()) {
    if (now.getTime() < bucket.closeMs + watermarkSeconds * 1000) continue;
    const records = Object.values(book.minutes[symbol] ?? {}).filter((item) => {
      const timestamp = new Date(item.bar.t).getTime();
      return timestamp >= bucket.startMs && timestamp < bucket.closeMs;
    });
    const aggregated = aggregateMinuteRecords(records, bucket);
    if (!aggregated) continue;
    const contentHash = await sha256({ feed, symbol, ...aggregated });
    const finalKey = `${symbol}:${bucket.close}`;
    const prior = book.finalized[finalKey];
    if (prior?.content_hash === contentHash) continue;
    const revision = Number(prior?.revision ?? 0) + 1;
    const coverage = aggregated.source_count / 5;
    const retroactive = Boolean(prior);
    const health = coverage === 1 ? (retroactive ? "revising" : "healthy") : "gapped";
    const eventCanonical = { feed, symbol, bucket_close: bucket.close, revision, content_hash: contentHash };
    const eventHash = await sha256(eventCanonical);
    const event = {
      id: `five-minute-${eventHash.slice(0, 32)}`,
      ...eventCanonical,
      bar: aggregated,
      coverage,
      health,
      retroactive,
      actionable: !retroactive && coverage === 1,
      finalized_at: receivedAt,
      watermark_seconds: watermarkSeconds,
    };
    book.finalized[finalKey] = { content_hash: contentHash, revision, event_id: event.id,
      bucket_close: bucket.close, health, coverage, bar: aggregated };
    book.latest_by_symbol[symbol] = { event_id: event.id, bucket_close: bucket.close, health, coverage, revision };
    events.push(event);
  }

  const minuteCutoff = now.getTime() - 30 * ONE_MINUTE_MS;
  for (const [symbol, entries] of Object.entries(book.minutes)) {
    for (const timestamp of Object.keys(entries)) if (new Date(timestamp).getTime() < minuteCutoff) delete entries[timestamp];
    if (!Object.keys(entries).length) delete book.minutes[symbol];
  }
  const finalizedCutoff = now.getTime() - 24 * 60 * ONE_MINUTE_MS;
  for (const [key, item] of Object.entries(book.finalized)) {
    if (new Date(item.bucket_close).getTime() < finalizedCutoff) delete book.finalized[key];
  }
  book.last_poll_at = receivedAt;
  const health = summarizeLiveHealth(book, now, options.expectedSymbols ?? INITIAL_UNIVERSE_SYMBOLS);
  return { book, source_revisions: revisions, events, health };
}

export function summarizeLiveHealth(book, now = new Date(), expectedSymbols = INITIAL_UNIVERSE_SYMBOLS) {
  const current = now instanceof Date ? now : new Date(now);
  const symbols = {};
  for (const symbol of expectedSymbols) {
    const latest = book?.latest_by_symbol?.[symbol];
    let status = latest?.health ?? "unknown";
    if (latest && current.getTime() - new Date(latest.bucket_close).getTime() > 10 * ONE_MINUTE_MS) status = "delayed";
    symbols[symbol] = { status, bucket_close: latest?.bucket_close ?? null, coverage: latest?.coverage ?? 0,
      revision: latest?.revision ?? 0 };
  }
  const statuses = Object.values(symbols).map((item) => item.status);
  const precedence = ["unknown", "delayed", "gapped", "revising", "healthy"];
  const overall = precedence.find((status) => statuses.includes(status)) ?? "unknown";
  const healthy = statuses.filter((status) => status === "healthy").length;
  return { status: overall, healthy_symbols: healthy, symbol_count: expectedSymbols.length,
    coverage: expectedSymbols.length ? healthy / expectedSymbols.length : 0, symbols, checked_at: current.toISOString() };
}

export function marketScheduleAction(value, rawSessions = []) {
  const parts = exchangeParts(value);
  const sessions = calendarIndex(rawSessions);
  const session = sessions[parts.date];
  if (!session) return "idle";
  const { open, close } = sessionBounds(session);
  if (parts.minute_of_day >= open - 5 && parts.minute_of_day <= close + 5) return "poll";
  if (parts.minute_of_day >= close + 10 && parts.minute_of_day <= close + 30) return "reconcile";
  return "idle";
}

function barsEquivalent(left, right) {
  if (!left || !right) return false;
  return ["o", "h", "l", "c", "v"].every((key) => Math.abs(Number(left[key]) - Number(right[key])) <= 1e-8);
}

export async function buildSessionReconciliation({ universe, calendar, sessionDate, audits, liveEvents }) {
  const liveByKey = new Map((liveEvents ?? []).map((event) => {
    const payload = typeof event.payload_json === "string" ? JSON.parse(event.payload_json) : event.bar ?? event.payload_json;
    const bar = normalizeMarketBar(payload, event.symbol);
    return [`${event.symbol}:${bar.t}`, bar];
  }));
  const symbolResults = {};
  const nativePayload = {};
  for (const symbol of universe.symbols) {
    const bars = audits[symbol]?.bars ?? [];
    nativePayload[symbol] = bars;
    let matched = 0;
    let mismatched = 0;
    for (const bar of bars) {
      const live = liveByKey.get(`${symbol}:${bar.t}`);
      if (barsEquivalent(bar, live)) matched += 1;
      else mismatched += 1;
    }
    const liveCount = [...liveByKey.keys()].filter((key) => key.startsWith(`${symbol}:`)).length;
    symbolResults[symbol] = {
      native_bars: bars.length,
      live_bars: liveCount,
      matched,
      mismatched,
      missing_live: Math.max(0, bars.length - liveCount),
      extra_live: Math.max(0, liveCount - bars.length),
      coverage: audits[symbol]?.coverage ?? 0,
    };
  }
  const summary = Object.values(symbolResults).reduce((total, item) => ({
    native_bars: total.native_bars + item.native_bars,
    live_bars: total.live_bars + item.live_bars,
    matched: total.matched + item.matched,
    mismatched: total.mismatched + item.mismatched,
    missing_live: total.missing_live + item.missing_live,
    extra_live: total.extra_live + item.extra_live,
  }), { native_bars: 0, live_bars: 0, matched: 0, mismatched: 0, missing_live: 0, extra_live: 0 });
  const nativeHash = await sha256(nativePayload);
  const canonical = {
    schema_version: 1, feed: universe.feed, timeframe: "5Min", adjustment: "all",
    universe_id: universe.id, universe_hash: universe.sha256, calendar_id: calendar.id,
    session_date: sessionDate, summary, symbols: symbolResults, native_hash: nativeHash,
  };
  const hash = await sha256(canonical);
  const healthy = summary.mismatched === 0 && summary.missing_live === 0 && summary.extra_live === 0
    && Object.values(symbolResults).every((item) => item.coverage >= VALID_DAY_MINIMUM_COVERAGE);
  return { ...canonical, id: `reconciliation-${sessionDate}-${hash.slice(0, 24)}`, sha256: hash,
    status: healthy ? "healthy" : "revising", native_bars: nativePayload };
}

async function gzipText(text) {
  if (typeof CompressionStream === "undefined") return { bytes: encoder.encode(text), encoding: "identity" };
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return { bytes: new Uint8Array(await new Response(stream).arrayBuffer()), encoding: "gzip" };
}

async function decodeObject(object) {
  if (!object) return null;
  let bytes = new Uint8Array(await object.arrayBuffer());
  const encoding = object.customMetadata?.encoding ?? "identity";
  if (encoding === "gzip") {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return JSON.parse(decoder.decode(bytes));
}

function safeKey(value) {
  return encodeURIComponent(String(value)).replaceAll("%", "_");
}

async function runStatements(database, statements, chunkSize = 80) {
  if (!database || !statements.length) return;
  for (let index = 0; index < statements.length; index += chunkSize) {
    const chunk = statements.slice(index, index + chunkSize);
    if (typeof database.batch === "function") await database.batch(chunk);
    else for (const statement of chunk) await statement.run();
  }
}

export class MarketDataRepository {
  constructor(storage, env = {}, workspace = CONTROL_PLANE_WORKSPACE) {
    this.storage = storage;
    this.env = env;
    this.workspace = workspace;
  }

  persistentReady() {
    return Boolean(this.env.AXIOM_DB && this.env.AXIOM_ARTIFACTS && this.env.AXIOM_JOBS);
  }

  assertPersistentReady() {
    if (!this.persistentReady()) throw new Error("Market-data backfill requires AXIOM_DB, AXIOM_ARTIFACTS, and AXIOM_JOBS bindings");
  }

  async putCompressedJson(key, value, metadata = {}) {
    if (!this.env.AXIOM_ARTIFACTS) throw new Error("AXIOM_ARTIFACTS binding is required");
    const text = JSON.stringify(value);
    const { bytes, encoding } = await gzipText(text);
    const httpMetadata = { contentType: "application/json" };
    if (encoding === "gzip") httpMetadata.contentEncoding = "gzip";
    await this.env.AXIOM_ARTIFACTS.put(key, bytes, {
      httpMetadata,
      customMetadata: Object.fromEntries(Object.entries({ encoding, ...metadata }).map(([name, item]) => [name, String(item)])),
    });
    return { byte_length: bytes.byteLength, encoding };
  }

  async saveUniverse(manifest) {
    const previous = await this.storage.get(`md:universe:${manifest.id}`);
    if (previous?.sha256 === manifest.sha256 && (!this.env.AXIOM_DB || !this.env.AXIOM_ARTIFACTS)) return;
    if (previous?.sha256 === manifest.sha256 && this.env.AXIOM_DB && this.env.AXIOM_ARTIFACTS) {
      const mirrored = await this.env.AXIOM_DB.prepare("SELECT sha256 FROM market_universe_versions WHERE universe_id = ?")
        .bind(manifest.id).first();
      if (mirrored?.sha256 === manifest.sha256) return;
    }
    await this.storage.put(`md:universe:${manifest.id}`, manifest);
    if (!this.env.AXIOM_DB || !this.env.AXIOM_ARTIFACTS) return;
    const key = `market/universes/${safeKey(manifest.id)}/${manifest.sha256}.json.gz`;
    await this.putCompressedJson(key, manifest, { kind: "universe", sha256: manifest.sha256 });
    await this.env.AXIOM_DB.prepare(`
      INSERT INTO market_universe_versions
        (universe_id, sha256, effective_from, symbol_count, feed, object_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(universe_id) DO NOTHING
    `).bind(manifest.id, manifest.sha256, manifest.effective_from, manifest.symbols.length,
      manifest.feed, key, new Date().toISOString()).run();
  }

  async saveCalendar(manifest) {
    const previous = await this.storage.get(`md:calendar:${manifest.id}`);
    if (previous?.sha256 === manifest.sha256 && (!this.env.AXIOM_DB || !this.env.AXIOM_ARTIFACTS)) return;
    if (previous?.sha256 === manifest.sha256 && this.env.AXIOM_DB && this.env.AXIOM_ARTIFACTS) {
      const mirrored = await this.env.AXIOM_DB.prepare("SELECT sha256 FROM market_calendar_manifests WHERE calendar_id = ?")
        .bind(manifest.id).first();
      if (mirrored?.sha256 === manifest.sha256) return;
    }
    await this.storage.put(`md:calendar:${manifest.id}`, manifest);
    if (!this.env.AXIOM_DB || !this.env.AXIOM_ARTIFACTS) return;
    const key = `market/calendars/${safeKey(manifest.id)}/${manifest.sha256}.json.gz`;
    await this.putCompressedJson(key, manifest, { kind: "calendar", sha256: manifest.sha256 });
    await this.env.AXIOM_DB.prepare(`
      INSERT INTO market_calendar_manifests
        (calendar_id, sha256, first_session, last_session, session_count, object_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(calendar_id) DO NOTHING
    `).bind(manifest.id, manifest.sha256, manifest.first_session, manifest.last_session,
      manifest.session_count, key, new Date().toISOString()).run();
  }

  async loadCalendar(id) {
    const local = await this.storage.get(`md:calendar:${id}`);
    if (local) return local;
    if (!this.env.AXIOM_DB || !this.env.AXIOM_ARTIFACTS) return null;
    const row = await this.env.AXIOM_DB.prepare("SELECT object_key FROM market_calendar_manifests WHERE calendar_id = ?")
      .bind(id).first();
    if (!row) return null;
    const manifest = await decodeObject(await this.env.AXIOM_ARTIFACTS.get(row.object_key));
    if (manifest) await this.storage.put(`md:calendar:${id}`, manifest);
    return manifest;
  }

  async createBackfillJobs(backfillId, jobs) {
    this.assertPersistentReady();
    const statements = jobs.map((job) => this.env.AXIOM_DB.prepare(`
      INSERT INTO market_backfill_jobs
        (job_id, backfill_id, universe_id, calendar_id, symbol, range_start, range_end, partition_month, status, attempts, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?)
      ON CONFLICT(job_id) DO NOTHING
    `).bind(job.id, backfillId, job.universe_id, job.calendar_id, job.symbol, job.start, job.end,
      job.partition, new Date().toISOString()));
    await runStatements(this.env.AXIOM_DB, statements);
  }

  async backfillJobStatus(jobId) {
    if (!this.env.AXIOM_DB) return null;
    return this.env.AXIOM_DB.prepare("SELECT status, partition_id FROM market_backfill_jobs WHERE job_id = ?")
      .bind(jobId).first();
  }

  async markBackfillJob(jobId, status, fields = {}) {
    if (!this.env.AXIOM_DB) return;
    await this.env.AXIOM_DB.prepare(`
      UPDATE market_backfill_jobs SET status = ?,
        attempts = attempts + CASE WHEN ? = 'running' THEN 1 ELSE 0 END,
        partition_id = COALESCE(?, partition_id), error = ?, updated_at = ?
      WHERE job_id = ?
    `).bind(status, status, fields.partition_id ?? null, fields.error ?? null, new Date().toISOString(), jobId).run();
  }

  async backfillProgress(backfillId) {
    if (!this.env.AXIOM_DB) return { total: 0, complete: 0, failed: 0, running: 0, queued: 0 };
    const row = await this.env.AXIOM_DB.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END) AS complete,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
        SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued
      FROM market_backfill_jobs WHERE backfill_id = ?
    `).bind(backfillId).first();
    return Object.fromEntries(["total", "complete", "failed", "running", "queued"]
      .map((key) => [key, Number(row?.[key] ?? 0)]));
  }

  async savePartition(partition, audit) {
    this.assertPersistentReady();
    const [year, month] = partition.month.split("-");
    const key = `market/${partition.feed}/${safeKey(partition.universe_id)}/5Min/${partition.symbol}/${year}/${month}/${partition.content_hash}.json.gz`;
    const storage = await this.putCompressedJson(key, partition.bars, {
      kind: "five-minute-bars", sha256: partition.content_hash, symbol: partition.symbol,
      universe_id: partition.universe_id, calendar_id: partition.calendar_id,
    });
    await this.env.AXIOM_DB.prepare(`
      INSERT INTO market_partitions
        (partition_id, universe_id, calendar_id, feed, timeframe, adjustment, symbol, partition_month,
         range_start, range_end, row_count, expected_bars, missing_bars, coverage, adjustment_discontinuities, content_hash,
         manifest_hash, object_key, byte_length, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(partition_id) DO NOTHING
    `).bind(partition.id, partition.universe_id, partition.calendar_id, partition.feed, partition.timeframe,
      partition.adjustment, partition.symbol, partition.month, partition.start, partition.end,
      partition.row_count, audit.expected_bars, audit.missing_bars, audit.coverage,
      audit.adjustment_discontinuities.length, partition.content_hash, partition.sha256, key,
      storage.byte_length, new Date().toISOString()).run();
    return { ...partition, bars: undefined, object_key: key, byte_length: storage.byte_length,
      expected_bars: audit.expected_bars, missing_bars: audit.missing_bars, coverage: audit.coverage };
  }

  async listPartitions(backfillId) {
    if (!this.env.AXIOM_DB) return [];
    const result = await this.env.AXIOM_DB.prepare(`
      SELECT p.* FROM market_partitions p
      JOIN market_backfill_jobs j ON j.partition_id = p.partition_id
      WHERE j.backfill_id = ? AND j.status = 'complete'
      ORDER BY p.symbol, p.partition_month
    `).bind(backfillId).all();
    return result.results ?? [];
  }

  async saveDatasetManifest(manifest) {
    this.assertPersistentReady();
    const key = `market/datasets/${manifest.id}/${manifest.sha256}.json.gz`;
    await this.putCompressedJson(key, manifest, { kind: "dataset-manifest", sha256: manifest.sha256 });
    await this.env.AXIOM_DB.prepare(`
      INSERT INTO market_dataset_manifests
        (dataset_id, sha256, universe_id, calendar_id, feed, timeframe, range_start, range_end,
         symbol_count, row_count, missing_bars, object_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(dataset_id) DO NOTHING
    `).bind(manifest.id, manifest.sha256, manifest.universe_id, manifest.calendar_id, manifest.feed,
      manifest.timeframe, manifest.start, manifest.end, manifest.symbol_count, manifest.row_count,
      manifest.missing_bars, key, new Date().toISOString()).run();
    return key;
  }

  async loadDatasetManifest(datasetId) {
    if (!this.env.AXIOM_DB || !this.env.AXIOM_ARTIFACTS) return null;
    const row = await this.env.AXIOM_DB.prepare(`SELECT dataset_id,sha256,object_key
      FROM market_dataset_manifests WHERE dataset_id=?`).bind(datasetId).first();
    if (!row) return null;
    const manifest = await decodeObject(await this.env.AXIOM_ARTIFACTS.get(row.object_key));
    if (!manifest || manifest.id !== row.dataset_id || manifest.sha256 !== row.sha256) {
      throw new Error(`Dataset manifest ${datasetId} failed identity verification`);
    }
    const canonical = { ...manifest }; delete canonical.id; delete canonical.sha256;
    if (await sha256(canonical) !== manifest.sha256) throw new Error(`Dataset manifest ${datasetId} failed hash verification`);
    return manifest;
  }

  /**
   * Load only immutable partitions named by the verified dataset manifest.
   * `development_only` physically removes the final quarter before returning;
   * no holdout bar is included in the returned object or its hash.
   */
  async loadSealedDataset(datasetId, { scope = "development_only", symbols = null, access = null } = {}) {
    if (!["development_only", "holdout_only", "full_private"].includes(scope)) throw new Error("Unsupported sealed dataset scope");
    const manifest = await this.loadDatasetManifest(datasetId);
    if (!manifest) throw new Error(`Sealed dataset ${datasetId} is unavailable`);
    const requested = symbols ? new Set(symbols.map(String)) : null;
    const expected = manifest.partitions.filter((item) => !requested || requested.has(item.symbol));
    if (!expected.length) throw new Error("Sealed dataset selection contains no partitions");
    const rows = await this.env.AXIOM_DB.prepare(`SELECT * FROM market_partitions
      WHERE universe_id=? AND calendar_id=? AND range_start>=? AND range_end<=?
      ORDER BY symbol,partition_month`).bind(manifest.universe_id, manifest.calendar_id, manifest.start, manifest.end).all();
    const byId = new Map((rows.results ?? []).map((row) => [row.partition_id, row]));
    const barsBySymbol = {};
    for (const part of expected) {
      const row = byId.get(part.id);
      if (!row || row.content_hash !== part.content_hash || row.manifest_hash !== part.sha256) {
        throw new Error(`Dataset partition ${part.id} is missing or has mismatched provenance`);
      }
      const bars = await decodeObject(await this.env.AXIOM_ARTIFACTS.get(row.object_key));
      if (!Array.isArray(bars) || bars.length !== Number(part.row_count)
          || await sha256(bars) !== part.content_hash) {
        throw new Error(`Dataset partition ${part.id} failed content verification`);
      }
      (barsBySymbol[part.symbol] ??= []).push(...bars);
    }
    for (const values of Object.values(barsBySymbol)) values.sort((left, right) => String(left.t).localeCompare(String(right.t)));
    const output = scope === "full_private" ? barsBySymbol : Object.fromEntries(Object.entries(barsBySymbol).map(([symbol, values]) => {
      const split = Math.floor(values.length * .75);
      return [symbol, scope === "development_only" ? values.slice(0, split) : values.slice(split)];
    }));
    const datasetHash = await sha256(output);
    const datasetSliceId = await this.mirrorNormalizedDataset(manifest, expected, byId, scope, datasetHash, output);
    if (scope === "holdout_only" && this.env.AXIOM_DB
        && String(this.env.NORMALIZED_STORAGE_ENABLED ?? "false").toLowerCase() === "true") {
      const actor = access?.actor ?? "system", purpose = access?.purpose ?? "sealed_validation";
      const requestHash = await sha256({ workspace_id: this.workspace, dataset_slice_id: datasetSliceId,
        actor, purpose, decision_id: access?.decisionId ?? null });
      await this.env.AXIOM_DB.prepare(`INSERT INTO holdout_access_ledger
        (workspace_id,access_id,dataset_slice_id,artifact_id,strategy_id,purpose,actor,request_hash,decision_id,accessed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,request_hash,actor,purpose) DO NOTHING`).bind(
        this.workspace, `holdout-access-${requestHash.slice(0, 32)}`, datasetSliceId, null,
        access?.strategyId ?? null, purpose, actor, requestHash, access?.decisionId ?? null, new Date().toISOString()).run();
    }
    return { schema_version: 1, dataset_id: manifest.id, dataset_root_hash: manifest.sha256,
      dataset_hash: datasetHash, dataset_scope: scope, dataset_slice_id: datasetSliceId,
      bars_by_symbol: output, partition_ids: expected.map((item) => item.id), manifest };
  }

  async mirrorNormalizedDataset(manifest, expected, byId, scope, sliceHash, barsBySymbol) {
    if (!this.env.AXIOM_DB || String(this.env.NORMALIZED_STORAGE_ENABLED ?? "false").toLowerCase() !== "true") {
      return `slice-${scope}-${sliceHash.slice(0, 32)}`;
    }
    const now = new Date().toISOString();
    const [universe, calendar, datasetRow] = await Promise.all([
      this.env.AXIOM_DB.prepare("SELECT object_key FROM market_universe_versions WHERE universe_id=?").bind(manifest.universe_id).first(),
      this.env.AXIOM_DB.prepare("SELECT object_key FROM market_calendar_manifests WHERE calendar_id=?").bind(manifest.calendar_id).first(),
      this.env.AXIOM_DB.prepare("SELECT object_key FROM market_dataset_manifests WHERE dataset_id=?").bind(manifest.id).first(),
    ]);
    if (!universe?.object_key || !calendar?.object_key || !datasetRow?.object_key) throw new Error("Normalized dataset provenance dependencies are missing");
    const statements = [
      this.env.AXIOM_DB.prepare(`INSERT INTO workspaces (workspace_id,display_name,environment,status,created_at,updated_at)
        VALUES (?,?,'development','active',?,?) ON CONFLICT(workspace_id) DO UPDATE SET updated_at=excluded.updated_at`).bind(this.workspace, this.workspace, now, now),
      this.env.AXIOM_DB.prepare(`INSERT INTO universe_versions
        (workspace_id,universe_version_id,feed,symbols_object_key,symbols_hash,symbol_count,effective_from,created_at)
        VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,universe_version_id) DO NOTHING`).bind(this.workspace,
        manifest.universe_id, manifest.feed, universe.object_key, manifest.universe_hash, manifest.symbol_count, manifest.start, now),
      this.env.AXIOM_DB.prepare(`INSERT INTO calendar_versions
        (workspace_id,calendar_version_id,market,first_session,last_session,session_count,object_key,content_hash,created_at)
        VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,calendar_version_id) DO NOTHING`).bind(this.workspace,
        manifest.calendar_id, "XNYS", manifest.start, manifest.end, 0, calendar.object_key, manifest.calendar_hash, now),
      this.env.AXIOM_DB.prepare(`INSERT INTO datasets
        (workspace_id,dataset_id,dataset_root_hash,universe_version_id,calendar_version_id,feed,timeframe,adjustment,range_start,range_end,manifest_object_key,manifest_hash,row_count,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,dataset_id) DO NOTHING`).bind(this.workspace,
        manifest.id, manifest.sha256, manifest.universe_id, manifest.calendar_id, manifest.feed, manifest.timeframe,
        manifest.adjustment, manifest.start, manifest.end, datasetRow.object_key, manifest.sha256, manifest.row_count, now),
    ];
    expected.forEach((part, ordinal) => {
      const row = byId.get(part.id);
      statements.push(this.env.AXIOM_DB.prepare(`INSERT INTO dataset_partitions
        (workspace_id,partition_id,feed,timeframe,symbol,range_start,range_end,revision,object_key,content_hash,row_count,byte_length,coverage,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,partition_id) DO NOTHING`).bind(this.workspace,
        part.id, part.feed, part.timeframe, part.symbol, part.start, part.end, 0, row.object_key,
        part.content_hash, part.row_count, Number(row.byte_length ?? 0), part.coverage, now));
      statements.push(this.env.AXIOM_DB.prepare(`INSERT INTO dataset_members
        (workspace_id,dataset_id,partition_id,ordinal) VALUES (?,?,?,?)
        ON CONFLICT(workspace_id,dataset_id,partition_id) DO NOTHING`).bind(this.workspace, manifest.id, part.id, ordinal));
    });
    await runStatements(this.env.AXIOM_DB, statements);
    const values = Object.values(barsBySymbol).flat();
    const sliceKind = scope === "holdout_only" ? "holdout" : scope === "development_only" ? "development" : "screen";
    const sliceId = `slice-${scope}-${sliceHash.slice(0, 32)}`;
    await this.env.AXIOM_DB.prepare(`INSERT INTO dataset_slices
      (workspace_id,dataset_slice_id,dataset_id,slice_kind,ordinal,range_start,range_end,sealed,slice_hash,manifest_object_key,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,dataset_slice_id) DO NOTHING`).bind(this.workspace,
      sliceId, manifest.id, sliceKind, 0, values.map((item) => item.t).sort().at(0) ?? manifest.start,
      values.map((item) => item.t).sort().at(-1) ?? manifest.end, scope === "holdout_only" ? 1 : 0,
      sliceHash, datasetRow.object_key, now).run();
    return sliceId;
  }

  async loadLiveBook() {
    return (await this.storage.get("md:live-book")) ?? emptyLiveBook("iex");
  }

  async saveLiveResult(result) {
    await this.storage.put("md:live-book", result.book);
    if (!this.env.AXIOM_DB) return;
    const statements = [];
    for (const revision of result.source_revisions) statements.push(this.env.AXIOM_DB.prepare(`
      INSERT INTO market_live_bar_revisions
        (revision_id, feed, symbol, bar_timestamp, source_hash, revision, received_at, corrected, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(revision_id) DO NOTHING
    `).bind(revision.id, revision.feed, revision.symbol, revision.timestamp, revision.source_hash,
      revision.revision, revision.received_at, revision.corrected ? 1 : 0, JSON.stringify(revision.bar)));
    for (const event of result.events) statements.push(this.env.AXIOM_DB.prepare(`
      INSERT INTO market_five_minute_events
        (event_id, feed, symbol, session_date, bucket_start, bucket_close, revision, content_hash, coverage,
         health, retroactive, actionable, finalized_at, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_id) DO NOTHING
    `).bind(event.id, event.feed, event.symbol, exchangeParts(event.bar.t).date, event.bar.t, event.bucket_close, event.revision,
      event.content_hash, event.coverage, event.health, event.retroactive ? 1 : 0,
      event.actionable ? 1 : 0, event.finalized_at, JSON.stringify(event.bar)));
    statements.push(this.env.AXIOM_DB.prepare(`
      INSERT INTO market_data_health
        (health_id, status, healthy_symbols, symbol_count, coverage, checked_at, details_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(health_id) DO NOTHING
    `).bind(`health:${result.health.checked_at}`, result.health.status, result.health.healthy_symbols,
      result.health.symbol_count, result.health.coverage, result.health.checked_at, JSON.stringify(result.health.symbols)));
    await runStatements(this.env.AXIOM_DB, statements);
  }

  async liveEventsForSession(sessionDate, feed = "iex") {
    if (!this.env.AXIOM_DB) return [];
    const result = await this.env.AXIOM_DB.prepare(`
      SELECT symbol, bucket_start, revision, payload_json
      FROM market_five_minute_events
      WHERE session_date = ? AND feed = ?
      ORDER BY symbol, bucket_start, revision DESC
    `).bind(sessionDate, feed).all();
    const latest = new Map();
    for (const row of result.results ?? []) {
      const key = `${row.symbol}:${row.bucket_start}`;
      if (!latest.has(key)) latest.set(key, row);
    }
    return [...latest.values()];
  }

  async saveSessionReconciliation(reconciliation) {
    if (!this.env.AXIOM_ARTIFACTS || !this.env.AXIOM_DB) throw new Error("Session reconciliation requires D1 and R2 bindings");
    const key = `market/reconciliations/${reconciliation.session_date}/${reconciliation.sha256}.json.gz`;
    await this.putCompressedJson(key, reconciliation, { kind: "session-reconciliation", sha256: reconciliation.sha256 });
    await this.env.AXIOM_DB.prepare(`
      INSERT INTO market_session_reconciliations
        (reconciliation_id, session_date, universe_id, calendar_id, feed, status, native_hash,
         matched_bars, mismatched_bars, missing_live_bars, extra_live_bars, sha256, object_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(reconciliation_id) DO NOTHING
    `).bind(reconciliation.id, reconciliation.session_date, reconciliation.universe_id,
      reconciliation.calendar_id, reconciliation.feed, reconciliation.status, reconciliation.native_hash,
      reconciliation.summary.matched, reconciliation.summary.mismatched,
      reconciliation.summary.missing_live, reconciliation.summary.extra_live,
      reconciliation.sha256, key, new Date().toISOString()).run();
    return key;
  }

  async resetInventory() {
    const objectKeys = [];
    if (this.env.AXIOM_ARTIFACTS) {
      let cursor;
      do {
        const page = await this.env.AXIOM_ARTIFACTS.list({ prefix: "market/", cursor });
        objectKeys.push(...(page.objects ?? []).map((item) => item.key));
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
    }
    const d1Targets = [];
    if (this.env.AXIOM_DB) {
      const tables = [
        ["market_session_reconciliations", "reconciliation_id"], ["market_data_health", "health_id"],
        ["market_five_minute_events", "event_id"], ["market_live_bar_revisions", "revision_id"],
        ["market_dataset_manifests", "dataset_id"], ["market_partitions", "partition_id"],
        ["market_backfill_jobs", "job_id"], ["market_calendar_manifests", "calendar_id"],
        ["market_universe_versions", "universe_id"],
      ];
      for (const [table, key] of tables) {
        const result = await this.env.AXIOM_DB.prepare(`SELECT ${key} FROM ${table} ORDER BY ${key}`).all();
        d1Targets.push(...(result.results ?? []).map((row) => `${table}:${row[key]}`));
      }
    }
    return { object_keys: objectKeys.sort(), d1_targets: d1Targets.sort() };
  }

  async clear() {
    if (this.env.AXIOM_ARTIFACTS) {
      let cursor;
      do {
        const page = await this.env.AXIOM_ARTIFACTS.list({ prefix: "market/", cursor });
        const keys = (page.objects ?? []).map((item) => item.key);
        if (keys.length) await this.env.AXIOM_ARTIFACTS.delete(keys);
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
    }
    if (this.env.AXIOM_DB) {
      for (const table of ["market_session_reconciliations", "market_data_health", "market_five_minute_events", "market_live_bar_revisions",
        "market_dataset_manifests", "market_partitions", "market_backfill_jobs", "market_calendar_manifests", "market_universe_versions"]) {
        await this.env.AXIOM_DB.prepare(`DELETE FROM ${table}`).run();
      }
    }
    const keys = await this.storage.list({ prefix: "md:" });
    if (keys.size) await this.storage.delete([...keys.keys()]);
  }
}

export async function ensureMarketDataState(state, env = {}) {
  const universe = await initialUniverseManifest();
  state.marketData ??= {};
  state.marketData.schema_version = MARKET_DATA_SCHEMA_VERSION;
  state.marketData.mode = marketDataMode(env);
  state.marketData.universe = {
    id: universe.id, sha256: universe.sha256, effective_from: universe.effective_from,
    feed: universe.feed, symbol_count: universe.symbols.length, symbols: universe.symbols,
    survivorship_bias_notice: universe.survivorship_bias_notice,
  };
  state.marketData.backfill ??= { status: "not_started", total_jobs: 0, completed_jobs: 0,
    failed_jobs: 0, dataset_id: null, calendar_id: null, started_at: null, completed_at: null };
  state.marketData.live ??= { status: "off", last_poll_at: null, last_event_at: null,
    healthy_symbols: 0, symbol_count: universe.symbols.length, coverage: 0, revision_events: 0 };
  state.marketData.usage ??= { date: null, alpaca_requests: 0, queue_messages: 0,
    d1_rows: 0, r2_writes: 0, worker_elapsed_ms: 0, updated_at: null };
  return universe;
}

export function publicMarketDataState(state) {
  const market = state.marketData ?? {};
  return {
    schema_version: market.schema_version ?? MARKET_DATA_SCHEMA_VERSION,
    mode: market.mode ?? "off",
    universe: structuredClone(market.universe ?? null),
    calendar: structuredClone(market.calendar ?? null),
    backfill: structuredClone(market.backfill ?? null),
    live: structuredClone(market.live ?? null),
    usage: structuredClone(market.usage ?? null),
  };
}

export function backfillDateBounds(now = new Date()) {
  const end = new Date(now);
  end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end);
  start.setUTCFullYear(start.getUTCFullYear() - 3);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

export function livePollBounds(now = new Date(), overlapMinutes = LIVE_OVERLAP_MINUTES) {
  const end = new Date(now);
  const start = new Date(end.getTime() - overlapMinutes * ONE_MINUTE_MS);
  return { start: start.toISOString(), end: end.toISOString() };
}

export function describeMarketDataError(error) {
  return errorMessage(error);
}
