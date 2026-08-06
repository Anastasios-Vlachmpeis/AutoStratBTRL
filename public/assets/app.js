"use strict";

const TOKEN_KEY = "axiom-admin-token";
const COLORS = ["#79d9cc", "#d8f66a", "#af98ee", "#e4bd5c", "#ef8f74", "#75a8e8", "#e58bc3", "#9ad17b", "#c9a8ff", "#65c4a6", "#efcf72", "#8eb8f6"];
const FILTERS = [
  ["active", "Active"], ["testing", "Testing"], ["validation", "Validation"],
  ["incubation", "Incubation"], ["paper_market", "Paper Market"], ["watch", "Watch"], ["retired", "Retired"],
];
const PIPELINE = [["generation", "Generation"], ["backtesting", "Backtesting"], ["validation", "Validation"], ["incubation", "Incubation"], ["paper_market", "Paper Market"]];
const state = { token: sessionStorage.getItem(TOKEN_KEY) || "", dashboard: null, operations: null,
  route: "overview", filter: "active", strategies: [], strategyCursor: null, selectedId: null,
  detail: null, overviewFocus: null, strategyFocus: null, toastTimer: null, pollTimer: null,
  surface: { azimuth: -.72, elevation: .56, dragging: false, x: 0, y: 0 } };

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const clamp = (value, low, high) => Math.min(high, Math.max(low, Number(value) || 0));
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const titleCase = (value) => String(value ?? "").replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
const money = (value, compact = false) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD",
  notation: compact ? "compact" : "standard", maximumFractionDigits: compact ? 1 : 0 }).format(finite(value));
const percent = (value, digits = 1) => `${finite(value) >= 0 ? "+" : ""}${(finite(value) * 100).toFixed(digits)}%`;
const plainPercent = (value, digits = 1) => `${(finite(value) * 100).toFixed(digits)}%`;
const metric = (value, digits = 2) => value == null ? "—" : finite(value).toFixed(digits);
const timeAgo = (value) => {
  const delta = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(delta)) return "—";
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

function toast(message, error = false) {
  const node = $("#toast");
  node.textContent = message; node.classList.toggle("error", error); node.classList.add("visible");
  clearTimeout(state.toastTimer); state.toastTimer = setTimeout(() => node.classList.remove("visible"), 4200);
}

function showSignin(message = "") {
  state.token = ""; sessionStorage.removeItem(TOKEN_KEY); clearInterval(state.pollTimer);
  $("#app-shell").hidden = true; $("#signin-screen").hidden = false;
  $("#signin-error").textContent = message; $("#signin-token").value = ""; $("#signin-token").focus();
}

function showApp() {
  $("#signin-screen").hidden = true; $("#app-shell").hidden = false;
  if (!state.pollTimer) state.pollTimer = setInterval(refreshVisible, 30_000);
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (state.token) headers.set("authorization", `Bearer ${state.token}`);
  if (options.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(path, { ...options, headers });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) { showSignin("That token is invalid or expired. Sign in again."); throw new Error("Authentication required"); }
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

async function adminCommand(kind, { strategyId = null, payload = {} } = {}) {
  const idempotency = `ui:${kind}:${crypto.randomUUID()}`;
  const result = await api("/api/v1/admin/commands", { method: "POST", headers: { "idempotency-key": idempotency },
    body: JSON.stringify({ kind, strategy_id: strategyId, payload, correlation_id: idempotency }) });
  if (result.status === "blocked") throw new Error(result.outcome?.reason || "The command is blocked by a safety control");
  toast(`${titleCase(kind)} accepted`); return result;
}

function chartValues(values, normalize) {
  const clean = (values || []).map((point) => finite(typeof point === "object" ? point.value ?? point.y ?? point.equity : point, NaN)).filter(Number.isFinite);
  if (!normalize || !clean.length || Math.abs(clean[0]) < 1e-12) return clean;
  return clean.map((value) => value / clean[0] - 1);
}

function renderLineChart(svg, input, { normalize = false, focus = null, onFocus = null, animated = false,
  empty = "No curve evidence yet", formatter = null } = {}) {
  if (!svg) return;
  const width = 1200, height = 390, pad = { left: 55, right: 24, top: 24, bottom: 33 };
  const series = (input || []).map((item, index) => ({ ...item, color: item.color || COLORS[index % COLORS.length],
    values: chartValues(item.values || item.curve, normalize) })).filter((item) => item.values.length > 1);
  if (!series.length) { svg.innerHTML = `<text class="chart-empty" x="50%" y="50%" text-anchor="middle">${escapeHtml(empty)}</text>`; return; }
  const all = series.flatMap((item) => item.values), maximumLength = Math.max(...series.map((item) => item.values.length));
  let low = Math.min(...all), high = Math.max(...all); if (high - low < 1e-9) { low -= 1; high += 1; }
  const margin = (high - low) * .11; low -= margin; high += margin;
  const x = (index, count) => pad.left + index / Math.max(1, count - 1) * (width - pad.left - pad.right);
  const y = (value) => pad.top + (high - value) / (high - low) * (height - pad.top - pad.bottom);
  const fmt = formatter || (normalize ? (value) => `${(value * 100).toFixed(1)}%` : (value) => Number(value).toLocaleString(undefined, { maximumFractionDigits: 1 }));
  const grid = Array.from({ length: 5 }, (_, index) => {
    const value = high - index / 4 * (high - low), py = y(value);
    return `<line class="chart-grid-line" x1="${pad.left}" x2="${width - pad.right}" y1="${py}" y2="${py}"/><text class="chart-axis" x="${pad.left - 9}" y="${py + 3}" text-anchor="end">${escapeHtml(fmt(value))}</text>`;
  }).join("");
  const zero = low < 0 && high > 0 ? `<line class="chart-zero" x1="${pad.left}" x2="${width - pad.right}" y1="${y(0)}" y2="${y(0)}"/>` : "";
  const paths = series.map((item, index) => {
    const d = item.values.map((value, pointIndex) => `${pointIndex ? "L" : "M"}${x(pointIndex, item.values.length).toFixed(1)},${y(value).toFixed(1)}`).join(" ");
    const opacity = focus && focus !== item.id ? .12 : .9;
    const lastX = x(item.values.length - 1, item.values.length), lastY = y(item.values.at(-1));
    return `<path class="chart-line${focus === item.id ? " focused" : ""}${animated ? " work-curve" : ""}" data-series="${escapeHtml(item.id)}" d="${d}" stroke="${item.color}" style="opacity:${opacity};${animated ? `animation-delay:${index * 110}ms` : ""}"/><circle class="chart-dot" cx="${lastX}" cy="${lastY}" r="3.6" fill="${item.color}" style="opacity:${opacity}"/>`;
  }).join("");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.innerHTML = `${grid}${zero}${paths}<text class="chart-axis" x="${pad.left}" y="${height - 8}">START</text><text class="chart-axis" x="${width - pad.right}" y="${height - 8}" text-anchor="end">LATEST</text>`;
  if (onFocus) $$("[data-series]", svg).forEach((path) => path.addEventListener("click", () => onFocus(path.dataset.series)));
}

function renderLegend(node, series, focused, onFocus) {
  node.innerHTML = (series || []).map((item, index) => `<button type="button" data-legend-id="${escapeHtml(item.strategy_id || item.id)}" style="opacity:${focused && focused !== (item.strategy_id || item.id) ? .4 : 1}"><i style="background:${COLORS[index % COLORS.length]}"></i>${escapeHtml(item.name || item.strategy_id || item.id)}</button>`).join("");
  $$('[data-legend-id]', node).forEach((button) => button.addEventListener("click", () => onFocus(button.dataset.legendId)));
}

function toggleLegend(button, legend) {
  const opening = legend.hidden; legend.hidden = !opening; button.textContent = opening ? "Hide legend" : "Show legend"; button.setAttribute("aria-expanded", String(opening));
}

function renderDashboard(data) {
  state.dashboard = data;
  const system = data.system || {}, account = data.account || {};
  $("#system-banner").dataset.state = system.code || "degraded"; $("#system-label").textContent = system.label || "DEGRADED";
  $("#system-detail").textContent = system.detail || "The system state is unavailable.";
  $("#next-action").textContent = system.next_action?.label || "Waiting for scheduler";
  const autonomy = $("#autonomy-button"); autonomy.disabled = !(system.can_pause || system.can_resume);
  autonomy.dataset.desired = system.can_pause ? "paused" : "running";
  autonomy.textContent = system.can_pause ? "Pause automation" : system.can_resume ? "Resume automation" : "Automation unavailable";
  $("#alert-stack").innerHTML = (data.alerts || []).map((item) => `<article class="alert-item ${escapeHtml(item.severity)}"><span>${escapeHtml(item.summary)}</span><small>${escapeHtml(titleCase(item.severity))}</small></article>`).join("");
  $("#account-connection").textContent = account.connected ? "CONNECTED" : "NOT CONNECTED";
  $("#metric-pnl").textContent = money(account.pnl); $("#metric-pnl").className = account.pnl >= 0 ? "positive" : "negative";
  $("#metric-pnl-pct").textContent = percent(account.pnl_fraction); $("#metric-sharpe").textContent = metric(account.rolling_sharpe);
  $("#metric-equity").textContent = money(account.equity); $("#metric-drawdown").textContent = plainPercent(account.max_drawdown);
  $("#metric-cash").textContent = money(account.cash); $("#metric-exposure").textContent = money(account.gross_exposure_usd, true);
  $("#metric-net-exposure").textContent = `${money(account.net_exposure_usd, true)} net`;
  $("#sharpe-now").textContent = metric(account.rolling_sharpe); $("#account-delta").textContent = percent(account.pnl_fraction);
  const history = account.history || [], pnl = history.map((point) => point.pnl);
  renderLineChart($("#account-pnl-chart"), [{ id: "pnl", values: pnl, color: COLORS[1] }], { formatter: (value) => money(value, true), empty: "Connect Alpaca to show account history" });
  renderLineChart($("#account-sharpe-chart"), [{ id: "sharpe", values: (account.sharpe_history || []).map((point) => point.value), color: COLORS[2] }], { empty: "Sharpe needs more account observations" });
  renderOverviewCurves(); renderPipeline(data.pipeline || {}); renderCurrentWork(data.current_work || {}); renderDecisions(data.recent_activity || []);
}

function renderOverviewCurves() {
  const curves = state.dashboard?.strategy_book?.curves || [];
  const series = curves.map((item) => ({ id: item.strategy_id, name: item.name, curve: item.curve }));
  renderLineChart($("#overview-strategy-chart"), series, { normalize: true, focus: state.overviewFocus,
    empty: "No strategies are incubating or trading in the Paper Market yet",
    onFocus: (id) => { state.overviewFocus = state.overviewFocus === id ? null : id; renderOverviewCurves(); } });
  renderLegend($("#overview-legend"), curves, state.overviewFocus, (id) => { state.overviewFocus = state.overviewFocus === id ? null : id; renderOverviewCurves(); });
}

function renderPipeline(counts) {
  $("#pipeline-strip").innerHTML = PIPELINE.map(([key, label], index) => `<article class="pipeline-step"><span>0${index + 1} · ${escapeHtml(label.toUpperCase())}</span><strong>${finite(counts[key])}</strong><small>${finite(counts[key]) ? "ACTIVE" : "CLEAR"}</small></article>`).join("");
}

function renderCurrentWork(work) {
  $("#work-title").textContent = work.title || "Waiting for the next scheduled event"; $("#work-detail").textContent = work.detail || "No work is currently running."; $("#work-kind").textContent = String(work.kind || "idle").toUpperCase();
  const host = $("#work-visual"), curves = work.curves || [];
  if (curves.length) {
    host.innerHTML = '<svg id="work-chart" viewBox="0 0 1200 390" aria-label="Current autonomous work"></svg>';
    renderLineChart($("#work-chart"), curves.map((item) => ({ id: item.strategy_id, name: item.name, curve: item.curve })), { normalize: true, animated: true });
    return;
  }
  if (work.kind === "generation") {
    const nodes = Array.from({ length: 22 }, (_, index) => ({ x: 9 + (index * 37 % 83), y: 12 + (index * 53 % 76), delay: index * 95 }));
    const links = nodes.slice(1).map((node, index) => { const prior = nodes[index], dx = node.x - prior.x, dy = node.y - prior.y;
      return `<i class="dna-link" style="left:${prior.x}%;top:${prior.y}%;width:${Math.hypot(dx, dy)}%;transform:rotate(${Math.atan2(dy, dx)}rad);animation-delay:${node.delay}ms"></i>`; }).join("");
    host.innerHTML = `<div class="dna-field">${links}${nodes.map((node) => `<i class="dna-node" style="left:${node.x}%;top:${node.y}%;animation-delay:${node.delay}ms"></i>`).join("")}</div>`;
    return;
  }
  host.innerHTML = '<svg id="work-chart" viewBox="0 0 1200 390"><text class="chart-empty" x="50%" y="50%" text-anchor="middle">Automation is waiting for its next scheduled event</text></svg>';
}

function renderDecisions(items) {
  $("#decision-list").innerHTML = items.length ? items.slice(0, 5).map((item) => `<article class="decision-row"><time>${escapeHtml(timeAgo(item.at))}</time><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.detail || "Decision recorded")}</p></article>`).join("") : '<div class="empty-state">No lifecycle decisions have been recorded yet.</div>';
}

async function loadDashboard() {
  const data = await api("/api/v1/dashboard"); renderDashboard(data); return data;
}

function renderFilters() {
  $("#strategy-filters").innerHTML = FILTERS.map(([key, label]) => `<button type="button" data-filter="${key}" class="${state.filter === key ? "active" : ""}">${escapeHtml(label)}</button>`).join("");
  $$('[data-filter]', $("#strategy-filters")).forEach((button) => button.addEventListener("click", () => {
    if (state.filter === button.dataset.filter) return; state.filter = button.dataset.filter; state.strategyFocus = null;
    state.selectedId = null; state.detail = null; $("#strategy-detail").hidden = true; loadStrategies().catch((error) => toast(error.message, true));
  }));
}

async function loadStrategies(append = false) {
  const cursor = append && state.strategyCursor ? `&cursor=${encodeURIComponent(state.strategyCursor)}` : "";
  const data = await api(`/api/v1/strategies?stage=${encodeURIComponent(state.filter)}&limit=50${cursor}`);
  state.strategies = append ? [...state.strategies, ...data.items] : data.items; state.strategyCursor = data.next_cursor;
  renderStrategyBrowser(data.total); return data;
}

function renderStrategyBrowser(total) {
  renderFilters(); $("#strategy-total").textContent = `${finite(total, state.strategies.length)} STRATEGIES`;
  $("#strategy-empty").hidden = state.strategies.length > 0; $("#strategy-load-more").hidden = !state.strategyCursor;
  const series = state.strategies.map((item) => ({ id: item.id, name: item.name, curve: item.curve }));
  renderLineChart($("#strategy-chart"), series, { normalize: true, focus: state.strategyFocus,
    empty: "No curves are available for this stage", onFocus: (id) => focusStrategy(id, true) });
  renderLegend($("#strategy-legend"), state.strategies.map((item) => ({ ...item, strategy_id: item.id })), state.strategyFocus, (id) => focusStrategy(id, true));
  $("#strategy-show-all").hidden = !state.strategyFocus; $("#strategy-chart-label").textContent = state.strategyFocus ? `${state.strategies.find((item) => item.id === state.strategyFocus)?.name || state.strategyFocus} · FOCUSED` : `${state.filter.replaceAll("_", " ").toUpperCase()} CURVES`;
  $("#strategy-table").innerHTML = state.strategies.map((item) => `<tr data-strategy-id="${escapeHtml(item.id)}" class="${state.selectedId === item.id ? "selected" : ""}"><td><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.asset || "MULTI")} · ${escapeHtml(item.archetype || "typed DSL")}</small></td><td><span class="stage-pill">${escapeHtml(item.status)}</span></td><td>${item.metrics.return == null ? "—" : percent(item.metrics.return)}</td><td>${metric(item.metrics.sharpe)}</td><td>${item.metrics.drawdown == null ? "—" : plainPercent(item.metrics.drawdown)}</td><td>${metric(item.metrics.score, 1)}</td><td>${escapeHtml(item.last_decision || "Evidence accumulating")}</td></tr>`).join("");
  $$('[data-strategy-id]', $("#strategy-table")).forEach((row) => row.addEventListener("click", () => selectStrategy(row.dataset.strategyId)));
}

function focusStrategy(id, openDetail = false) {
  state.strategyFocus = state.strategyFocus === id ? null : id; renderStrategyBrowser(state.strategies.length);
  if (openDetail && state.strategyFocus) selectStrategy(state.strategyFocus);
}

async function selectStrategy(id) {
  state.selectedId = id; state.strategyFocus = id; renderStrategyBrowser(state.strategies.length);
  const detail = await api(`/api/v1/strategies/${encodeURIComponent(id)}`); state.detail = detail; renderStrategyDetail(detail);
  $("#strategy-detail").hidden = false; $("#strategy-detail").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderStrategyDetail(detail) {
  $("#detail-id").textContent = `${detail.id} · ${detail.asset || "MULTI"}`; $("#detail-name").textContent = detail.name;
  $("#detail-explanation").textContent = detail.explanation; $("#detail-status").textContent = detail.status;
  const pause = $("#pause-strategy-button"); pause.disabled = Boolean(detail.paused); pause.textContent = detail.paused ? "Paused" : "Pause strategy";
  const metrics = [["RETURN", detail.metrics.return == null ? "—" : percent(detail.metrics.return)], ["SHARPE", metric(detail.metrics.sharpe)],
    ["MAX DRAWDOWN", detail.metrics.drawdown == null ? "—" : plainPercent(detail.metrics.drawdown)], ["SUPERVISOR SCORE", metric(detail.metrics.score, 1)]];
  $("#detail-metrics").innerHTML = metrics.map(([label, value]) => `<article><span>${label}</span><strong>${value}</strong></article>`).join("");
  renderIncubation(detail.incubation); renderTimeline(detail.lifecycle || []); renderResearch(detail);
}

function renderIncubation(incubation) {
  const host = $("#incubation-progress"); host.hidden = !incubation; if (!incubation) return;
  const blocks = [["Forward trading days", incubation.valid_days, incubation.required_days], ["Completed trades", incubation.eligible_trades, incubation.required_trades]];
  host.innerHTML = blocks.map(([label, value, required]) => `<div class="progress-block"><span><b>${escapeHtml(label)}</b><em>${finite(value)} / ${finite(required)}</em></span><div class="progress-track"><i style="width:${clamp(value / required * 100, 0, 100)}%"></i></div></div>`).join("");
}

function renderTimeline(events) {
  $("#lifecycle-timeline").innerHTML = events.length ? events.map((event) => `<article class="timeline-event"><time>${escapeHtml(timeAgo(event.at))}</time><strong>${escapeHtml(titleCase(event.to))}</strong><p>${escapeHtml(event.explanation || event.reason_code || "Lifecycle transition")}</p></article>`).join("") : '<div class="empty-state">Lifecycle history begins after the first completed review.</div>';
}

function deepNumbers(value, prefix = "", output = []) {
  if (typeof value === "number" && Number.isFinite(value)) output.push([prefix || "parameter", value]);
  else if (value && typeof value === "object") Object.entries(value).forEach(([key, nested]) => deepNumbers(nested, prefix ? `${prefix}.${key}` : key, output));
  return output;
}

function renderResearch(detail) {
  const numbers = deepNumbers(detail.research?.params || {}).concat(deepNumbers(detail.research?.dna?.risk || {}));
  const sizeCandidates = deepNumbers(detail.research?.dna?.target || {}).concat(numbers).filter(([name]) => /size|position|exposure|weight/i.test(name));
  const size = Math.abs(finite(sizeCandidates[0]?.[1], .02)); $("#position-size-label").textContent = plainPercent(size, 2);
  requestAnimationFrame(() => { $("#position-size-bar").style.width = `${clamp(size / .02 * 100, 2, 100)}%`; });
  renderSurface(detail, numbers); renderGeneralization(detail.research?.regime_scores || {});
  const evidence = detail.evidence?.provenance || {};
  const rows = [["DNA hash", detail.research?.dna_hash || "Not assigned"], ["Engine", evidence.engine_family || "Pending"],
    ["Development result", evidence.development?.result_hash || "Pending"], ["Validation", evidence.validation?.access_status || "Not consumed"],
    ["Execution", evidence.development?.execution || "Next bar open"]];
  $("#provenance-content").innerHTML = rows.map(([label, value]) => `<div class="provenance-row"><span>${escapeHtml(label)}</span><code title="${escapeHtml(value)}">${escapeHtml(value)}</code></div>`).join("");
}

function surfaceValue(x, y, seed) { return .44 + .21 * Math.sin((x + seed) * 2.8) + .16 * Math.cos((y - seed) * 3.5) + .11 * Math.sin((x + y) * 5); }
function renderSurface(detail, rawNumbers = null) {
  const svg = $("#dna-surface"); if (!svg) return;
  const numbers = (rawNumbers || deepNumbers(detail.research?.params || {})).slice(0, 3);
  while (numbers.length < 3) numbers.push([["lookback", "threshold", "risk"][numbers.length], [.35, .62, .48][numbers.length]]);
  const seed = ([...detail.id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 41) / 41;
  const az = state.surface.azimuth, el = state.surface.elevation, center = { x: 310, y: 207 }, scale = 122;
  const project = ({ x, y, z }) => { const rx = x * Math.cos(az) - y * Math.sin(az), ry = x * Math.sin(az) + y * Math.cos(az);
    return { x: center.x + rx * scale, y: center.y + (ry * Math.sin(el) - z * Math.cos(el) * 1.55) * scale }; };
  const cells = [], nx = 12, ny = 10;
  for (let yi = 0; yi < ny; yi += 1) for (let xi = 0; xi < nx; xi += 1) {
    const x0 = -1 + xi * 2 / nx, x1 = -1 + (xi + 1) * 2 / nx, y0 = -1 + yi * 2 / ny, y1 = -1 + (yi + 1) * 2 / ny;
    const world = [[x0,y0], [x1,y0], [x1,y1], [x0,y1]].map(([x, y]) => ({ x, y, z: surfaceValue(x, y, seed) }));
    const level = world.reduce((sum, point) => sum + point.z, 0) / 4; cells.push({ world, depth: (x0 + x1) * Math.sin(az) + (y0 + y1) * Math.cos(az), level });
  }
  const polygons = cells.sort((a, b) => a.depth - b.depth).map((cell) => `<polygon class="surface-cell" fill="hsl(${55 + clamp(cell.level, 0, 1) * 60} 78% ${28 + clamp(cell.level, 0, 1) * 30}%)" points="${cell.world.map((point) => { const p = project(point); return `${p.x.toFixed(1)},${p.y.toFixed(1)}`; }).join(" ")}"/>`).join("");
  const origin = project({ x: -1, y: -1, z: 0 }), xEnd = project({ x: 1.15, y: -1, z: 0 }), yEnd = project({ x: -1, y: 1.15, z: 0 }), zEnd = project({ x: -1, y: -1, z: 1.15 });
  const px = clamp((Math.tanh(finite(numbers[0][1])) + 1) / 2, 0, 1) * 2 - 1, py = clamp((Math.tanh(finite(numbers[1][1])) + 1) / 2, 0, 1) * 2 - 1;
  const point = project({ x: px, y: py, z: surfaceValue(px, py, seed) + .035 });
  svg.innerHTML = `${polygons}<g><line class="surface-axis" x1="${origin.x}" y1="${origin.y}" x2="${xEnd.x}" y2="${xEnd.y}"/><line class="surface-axis" x1="${origin.x}" y1="${origin.y}" x2="${yEnd.x}" y2="${yEnd.y}"/><line class="surface-axis" x1="${origin.x}" y1="${origin.y}" x2="${zEnd.x}" y2="${zEnd.y}"/><text class="surface-label" x="${xEnd.x}" y="${xEnd.y + 14}">${escapeHtml(numbers[0][0].split(".").at(-1))}</text><text class="surface-label" x="${yEnd.x}" y="${yEnd.y + 14}">${escapeHtml(numbers[1][0].split(".").at(-1))}</text><text class="surface-label" x="${zEnd.x + 7}" y="${zEnd.y}">fitness</text></g><circle class="surface-point" cx="${point.x}" cy="${point.y}" r="6"><title>This strategy</title></circle>`;
}

function renderGeneralization(scores) {
  const entries = Object.entries(scores).filter(([, value]) => Number.isFinite(Number(value))).slice(0, 8);
  const values = entries.length >= 3 ? entries : [["trend", .72], ["chop", .48], ["high vol", .61], ["low vol", .68]];
  const svg = $("#generalization-chart"), cx = 240, cy = 196, radius = 128, count = values.length;
  const point = (index, level) => { const angle = -Math.PI / 2 + index * Math.PI * 2 / count; return [cx + Math.cos(angle) * radius * level, cy + Math.sin(angle) * radius * level]; };
  const rings = [.25, .5, .75, 1].map((level) => `<polygon class="radar-ring" points="${values.map((_, index) => point(index, level).join(",")).join(" ")}"/>`).join("");
  const axes = values.map((_, index) => { const [x, y] = point(index, 1); return `<line class="radar-axis" x1="${cx}" y1="${cy}" x2="${x}" y2="${y}"/>`; }).join("");
  const shapePoints = values.map(([, value], index) => point(index, clamp(Math.abs(finite(value)), 0, 1)));
  const labels = values.map(([label], index) => { const [x, y] = point(index, 1.18); return `<text class="radar-label" x="${x}" y="${y}" text-anchor="middle">${escapeHtml(titleCase(label))}</text>`; }).join("");
  svg.innerHTML = `${rings}${axes}<polygon class="radar-shape" points="${shapePoints.map((pointValue) => pointValue.join(",")).join(" ")}"/>${shapePoints.map(([x,y]) => `<circle class="radar-dot" cx="${x}" cy="${y}" r="4"/>`).join("")}${labels}`;
}

async function loadAdvanced() {
  const [operations, logs, orders, trades, trials, artifacts] = await Promise.all([
    api("/api/v1/operations"), api("/api/v1/logs?limit=50"), api("/api/v1/orders?limit=50"),
    api("/api/v1/trades?limit=50"), api("/api/v1/trials?limit=50"), api("/api/v1/artifacts?limit=50"),
  ]);
  state.operations = operations; renderAdvancedHealth(operations); renderAdvancedList($("#advanced-logs"), logs.items, "No operator logs yet");
  renderAdvancedList($("#advanced-orders"), orders.items, "No paper orders"); renderAdvancedList($("#advanced-trades"), trades.items, "No paper trades");
  renderAdvancedList($("#advanced-trials"), trials.items, "No trials recorded"); renderAdvancedList($("#advanced-artifacts"), artifacts.items, "No artifacts stored");
  updateControlButtons();
}

function renderAdvancedHealth(operations) {
  const cards = [
    ["MODE", operations.mode?.label, (operations.mode?.blocked_reasons || []).join(", ") || "No active risk block"],
    ["MARKET DATA", `${titleCase(operations.data?.status)} · ${Math.round(finite(operations.data?.coverage) * 100)}%`, `${finite(operations.data?.healthy_symbols)} of ${finite(operations.data?.expected_symbols)} symbols healthy`],
    ["BACKTESTER", titleCase(operations.services?.backtester?.mode), `${finite(operations.services?.backtester?.active_runs)} active runs`],
    ["BROKER", titleCase(operations.services?.broker?.mode), operations.services?.broker?.connected ? "Alpaca paper connected" : "Not connected"],
    ["QUEUE", titleCase(operations.services?.queue?.status), `${finite(operations.services?.queue?.research_pending)} research jobs pending`],
    ["STORAGE", titleCase(operations.services?.storage?.mode), operations.services?.storage?.ready ? "Storage bindings healthy" : "Storage unavailable"],
    ["MONTHLY COST", money(operations.budget?.estimated_monthly_usd), `${money(operations.budget?.month_to_date_usd)} month to date`],
    ["ROLLOUT", `PHASE ${operations.rollout?.phase || "—"}`, operations.rollout?.legacy_authoritative ? "Legacy authority retained" : "Normalized authority active"],
  ];
  $("#advanced-health").innerHTML = cards.map(([label, value, detail]) => `<article class="advanced-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value || "—")}</strong><p>${escapeHtml(detail)}</p></article>`).join("");
}

function renderAdvancedList(host, items, empty) {
  if (!items?.length) { host.innerHTML = `<div class="empty-state">${escapeHtml(empty)}</div>`; return; }
  host.innerHTML = items.map((item) => { const at = item.at || item.timestamp || item.created_at || item.submitted_at || item.opened_at;
    const title = item.title || item.name || item.symbol || item.id; const detail = item.detail || item.summary || item.reason || item.status || item.phase || "Recorded";
    return `<article class="list-row"><time>${escapeHtml(timeAgo(at))}</time><strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span><code>${escapeHtml(item.strategy_id || item.category || item.phase || "")}</code></article>`; }).join("");
}

function updateControlButtons() {
  const controls = state.operations?.controls || {};
  $$('[data-control]').forEach((button) => { const key = button.dataset.control, paused = Boolean(controls[`${key}_paused`]);
    button.dataset.command = `${paused ? "resume" : "pause"}_${key}`; button.textContent = `${paused ? "Resume" : "Pause"} ${key}`; });
}

async function setRoute() {
  const route = location.hash.replace(/^#\//, "") || "overview"; state.route = ["overview", "strategies", "advanced"].includes(route) ? route : "overview";
  if (route !== state.route) history.replaceState(null, "", `#/${state.route}`);
  $$('[data-page]').forEach((page) => { page.hidden = page.dataset.page !== state.route; });
  $$('[data-route]').forEach((link) => link.classList.toggle("active", link.dataset.route === state.route));
  $("#page-title").textContent = titleCase(state.route); window.scrollTo({ top: 0, behavior: "instant" });
  try {
    if (state.route === "overview") await loadDashboard();
    else if (state.route === "strategies") await loadStrategies();
    else await loadAdvanced();
  } catch (error) { if (state.token) toast(error.message, true); }
}

async function refreshVisible() {
  if (!state.token || document.hidden) return;
  try { await loadDashboard(); if (state.route === "strategies") await loadStrategies(); if (state.route === "advanced") await loadAdvanced(); }
  catch (error) { if (state.token) toast(error.message, true); }
}

function bindEvents() {
  $("#signin-form").addEventListener("submit", async (event) => {
    event.preventDefault(); const button = event.submitter, token = $("#signin-token").value;
    button.disabled = true; $("#signin-error").textContent = ""; state.token = token; sessionStorage.setItem(TOKEN_KEY, token);
    try { await loadDashboard(); showApp(); if (!location.hash) location.hash = "#/overview"; await setRoute(); }
    catch (error) { if (state.token) showSignin(error.message); } finally { button.disabled = false; }
  });
  $("#signout-button").addEventListener("click", () => showSignin("Signed out. Your session token was discarded."));
  window.addEventListener("hashchange", setRoute); document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshVisible(); });
  $("#overview-legend-button").addEventListener("click", () => toggleLegend($("#overview-legend-button"), $("#overview-legend")));
  $("#strategy-legend-button").addEventListener("click", () => toggleLegend($("#strategy-legend-button"), $("#strategy-legend")));
  $("#strategy-show-all").addEventListener("click", () => { state.strategyFocus = null; renderStrategyBrowser(state.strategies.length); });
  $("#strategy-load-more").addEventListener("click", () => loadStrategies(true).catch((error) => toast(error.message, true)));
  $("#autonomy-button").addEventListener("click", async () => { const button = $("#autonomy-button"), desired = button.dataset.desired;
    button.disabled = true; try { await api("/api/v1/admin/autonomy", { method: "POST", headers: { "idempotency-key": `ui:autonomy:${desired}:${crypto.randomUUID()}` }, body: JSON.stringify({ desired_state: desired }) }); toast(`Automation ${desired === "paused" ? "paused" : "resumed"}`); await loadDashboard(); }
    catch (error) { toast(error.message, true); } finally { button.disabled = false; } });
  $("#pause-strategy-button").addEventListener("click", async () => { if (!state.detail || state.detail.paused) return;
    try { await adminCommand("pause_strategy", { strategyId: state.detail.id }); await selectStrategy(state.detail.id); }
    catch (error) { toast(error.message, true); } });
  $("#emergency-button").addEventListener("click", () => $("#emergency-dialog").showModal());
  $$('[data-emergency]').forEach((button) => button.addEventListener("click", async () => { const kind = button.dataset.emergency;
    const message = kind === "kill_switch" ? "Activate the kill switch and flatten every Axiom-managed paper position?" : `${button.querySelector("strong").textContent}?`;
    if (!window.confirm(message)) return; button.disabled = true;
    try { await adminCommand(kind); $("#emergency-dialog").close(); await loadDashboard(); } catch (error) { toast(error.message, true); } finally { button.disabled = false; } }));
  $$('[data-advanced]').forEach((button) => button.addEventListener("click", () => { $$('[data-advanced]').forEach((item) => item.classList.toggle("active", item === button)); $$('[data-advanced-section]').forEach((section) => { section.hidden = section.dataset.advancedSection !== button.dataset.advanced; }); }));
  $$('[data-control]').forEach((button) => button.addEventListener("click", async () => { button.disabled = true;
    try { await adminCommand(button.dataset.command); await loadAdvanced(); } catch (error) { toast(error.message, true); } finally { button.disabled = false; } }));
  $("#approval-form").addEventListener("submit", async (event) => { event.preventDefault(); const kind = $("#approval-kind").value, hash = $("#approval-hash").value.trim().toLowerCase();
    try { await adminCommand(`approve_${kind}`, { payload: { subject_hash: hash } }); event.target.reset(); } catch (error) { toast(error.message, true); } });
  $$('[data-strategy-action]').forEach((button) => button.addEventListener("click", async () => { const id = $("#advanced-strategy-id").value.trim(); if (!id) return toast("Enter a strategy ID first", true);
    if (["retire_strategy", "quarantine_strategy"].includes(button.dataset.strategyAction) && !window.confirm(`${titleCase(button.dataset.strategyAction)} ${id}?`)) return;
    try { await adminCommand(button.dataset.strategyAction, { strategyId: id }); } catch (error) { toast(error.message, true); } }));
  $("#open-reset-button").addEventListener("click", () => { $("#reset-manifest").textContent = "Prepare a deletion manifest first."; $("#execute-reset-button").disabled = true; $("#reset-confirmation").value = ""; $("#reset-dialog").showModal(); });
  $("#prepare-reset-button").addEventListener("click", async () => { try { const result = await adminCommand("prepare_workspace_reset"); const manifest = result.reset_manifest; if (!manifest) throw new Error("The server did not return a reset manifest");
    $("#reset-manifest").dataset.hash = manifest.manifest_hash; $("#reset-manifest").textContent = `Manifest ${manifest.manifest_hash.slice(0, 16)}… · ${JSON.stringify(manifest.counts || {})}`; $("#execute-reset-button").disabled = false; } catch (error) { toast(error.message, true); } });
  $("#execute-reset-button").addEventListener("click", async () => { const confirmation = $("#reset-confirmation").value, manifestHash = $("#reset-manifest").dataset.hash;
    if (confirmation !== "RESET NONPRODUCTION WORKSPACE") return toast("Type the exact reset phrase", true);
    if (!window.confirm("Permanently delete the nonproduction Axiom workspace described by this manifest?")) return;
    try { await adminCommand("execute_workspace_reset", { payload: { confirmation, manifest_hash: manifestHash } }); $("#reset-dialog").close(); await refreshVisible(); } catch (error) { toast(error.message, true); } });
  const surface = $("#dna-surface");
  surface.addEventListener("pointerdown", (event) => { state.surface.dragging = true; state.surface.x = event.clientX; state.surface.y = event.clientY; surface.setPointerCapture(event.pointerId); });
  surface.addEventListener("pointermove", (event) => { if (!state.surface.dragging || !state.detail) return; state.surface.azimuth += (event.clientX - state.surface.x) * .008; state.surface.elevation = clamp(state.surface.elevation + (event.clientY - state.surface.y) * .005, .15, 1.1); state.surface.x = event.clientX; state.surface.y = event.clientY; renderSurface(state.detail); });
  surface.addEventListener("pointerup", () => { state.surface.dragging = false; }); surface.addEventListener("pointercancel", () => { state.surface.dragging = false; });
}

async function boot() {
  bindEvents(); renderFilters();
  if (!state.token) { showSignin(); return; }
  try { await loadDashboard(); showApp(); if (!location.hash) history.replaceState(null, "", "#/overview"); await setRoute(); }
  catch (error) { if (state.token) showSignin(error.message); }
}

boot();
