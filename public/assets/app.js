"use strict";

const TOKEN_KEY = "axiom-admin-token";
const COLORS = ["#ef805f", "#ca5c43", "#f0a06f", "#a94735", "#db7555", "#f2b083", "#913e30", "#c98161"];
const PIPELINE = [
  ["generation", "Generated"],
  ["backtesting", "Backtesting"],
  ["validation", "Validation"],
  ["incubation", "Incubation"],
  ["paper_market", "Paper Market"],
];

const state = {
  token: sessionStorage.getItem(TOKEN_KEY) || "",
  dashboard: null,
  strategies: [],
  focusedId: null,
  selectedId: null,
  labelsVisible: false,
  pollTimer: null,
  toastTimer: null,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[char]);
const money = (value) => new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", maximumFractionDigits: 0,
}).format(finite(value));
const percent = (value, digits = 1) => `${finite(value) >= 0 ? "+" : ""}${(finite(value) * 100).toFixed(digits)}%`;
const plainPercent = (value, digits = 1) => `${(finite(value) * 100).toFixed(digits)}%`;
const number = (value, digits = 2) => value == null ? "--" : finite(value).toFixed(digits);
const titleCase = (value) => String(value ?? "").replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());

function toast(message, error = false) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.toggle("error", error);
  node.classList.add("visible");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => node.classList.remove("visible"), 3500);
}

function showSignin(message = "") {
  state.token = "";
  sessionStorage.removeItem(TOKEN_KEY);
  clearInterval(state.pollTimer);
  state.pollTimer = null;
  $("#app").hidden = true;
  $("#signin-screen").hidden = false;
  $("#signin-error").textContent = message;
  $("#signin-token").value = "";
  $("#signin-token").focus();
}

function showApp() {
  $("#signin-screen").hidden = true;
  $("#app").hidden = false;
  if (!state.pollTimer) state.pollTimer = setInterval(refresh, 30_000);
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("authorization", `Bearer ${state.token}`);
  if (options.body) headers.set("content-type", "application/json");
  const response = await fetch(path, { ...options, headers });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) {
    showSignin("That token is invalid. Try again.");
    throw new Error("Authentication required");
  }
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

async function adminCommand(kind) {
  return api("/api/v1/admin/commands", {
    method: "POST",
    headers: { "idempotency-key": `terminal:${kind}:${crypto.randomUUID()}` },
    body: JSON.stringify({ kind }),
  });
}

function seriesValues(series, normalize) {
  const raw = (series.values ?? series.curve ?? []).map((point) => finite(typeof point === "object" ? point.value ?? point.y : point, NaN)).filter(Number.isFinite);
  if (!normalize || raw.length < 2) return raw;
  const start = raw[0] || 1;
  return raw.map((value) => (value / start - 1) * 100);
}

function renderChart(svg, input, { normalize = false, focus = null, empty = "No data yet", onFocus = null } = {}) {
  const series = input.map((item, index) => ({
    ...item,
    color: item.color || COLORS[index % COLORS.length],
    values: seriesValues(item, normalize),
  })).filter((item) => item.values.length > 1);
  if (!series.length) {
    svg.innerHTML = `<text x="50%" y="50%" text-anchor="middle" class="chart-empty">${escapeHtml(empty)}</text>`;
    return;
  }

  const width = 1200;
  const height = 360;
  const pad = { left: 58, right: 24, top: 22, bottom: 34 };
  const all = series.flatMap((item) => item.values);
  let low = Math.min(...all);
  let high = Math.max(...all);
  if (low === high) { low -= 1; high += 1; }
  const margin = Math.max((high - low) * 0.08, 0.01);
  low -= margin;
  high += margin;
  const x = (index, length) => pad.left + index / Math.max(1, length - 1) * (width - pad.left - pad.right);
  const y = (value) => pad.top + (high - value) / (high - low) * (height - pad.top - pad.bottom);
  const grid = Array.from({ length: 5 }, (_, index) => {
    const value = high - (high - low) * index / 4;
    const py = y(value);
    const label = normalize ? `${value.toFixed(1)}%` : Math.abs(value) >= 1000 ? money(value) : value.toFixed(1);
    return `<line x1="${pad.left}" y1="${py}" x2="${width - pad.right}" y2="${py}" class="chart-grid"/><text x="${pad.left - 9}" y="${py + 3}" text-anchor="end" class="chart-axis">${escapeHtml(label)}</text>`;
  }).join("");
  const paths = series.map((item) => {
    const points = item.values.map((value, index) => `${x(index, item.values.length).toFixed(1)},${y(value).toFixed(1)}`).join(" ");
    const muted = focus && focus !== item.id ? " muted" : "";
    const selected = focus === item.id ? " selected" : "";
    return `<polyline data-series-id="${escapeHtml(item.id || "")}" class="chart-line${muted}${selected}" stroke="${item.color}" points="${points}"/>`;
  }).join("");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.innerHTML = grid + paths;
  if (onFocus) $$('[data-series-id]', svg).forEach((line) => line.addEventListener("click", () => onFocus(line.dataset.seriesId)));
}

function setMetric(selector, value, tone = null) {
  const node = $(selector);
  node.textContent = value;
  node.classList.toggle("positive", tone === "positive");
  node.classList.toggle("negative", tone === "negative");
}

function renderDashboard(data) {
  state.dashboard = data;
  const system = data.system || {};
  const work = data.current_work || {};
  $("#system-label").textContent = system.label || "UNKNOWN";
  $("#system-pill").dataset.state = system.code || "unknown";
  $("#status-panel").dataset.state = system.code || "unknown";
  $("#work-title").textContent = work.title || system.label || "Waiting";
  $("#system-detail").textContent = [system.detail, work.detail].filter(Boolean).join(" ");
  $("#next-action").textContent = system.next_action?.label || "Wait for scheduler";

  const autonomy = $("#autonomy-button");
  const canResume = Boolean(system.can_resume);
  autonomy.textContent = canResume ? "Resume automation" : "Pause automation";
  autonomy.dataset.desired = canResume ? "running" : "paused";
  autonomy.disabled = !(system.can_pause || system.can_resume);

  const account = data.account || {};
  $("#account-connection").textContent = account.connected ? "CONNECTED" : "NOT CONNECTED";
  const pnlTone = finite(account.pnl) >= 0 ? "positive" : "negative";
  setMetric("#metric-pnl", money(account.pnl), pnlTone);
  setMetric("#metric-pnl-pct", percent(account.pnl_fraction), pnlTone);
  setMetric("#metric-equity", money(account.equity));
  setMetric("#metric-sharpe", number(account.rolling_sharpe));
  setMetric("#metric-drawdown", plainPercent(account.max_drawdown));
  setMetric("#metric-cash", money(account.cash));
  setMetric("#metric-exposure", money(account.gross_exposure_usd));
  setMetric("#metric-net-exposure", `${money(account.net_exposure_usd)} net`);
  setMetric("#account-delta", money(account.pnl), pnlTone);
  setMetric("#sharpe-now", number(account.rolling_sharpe));
  renderChart($("#account-pnl-chart"), [{ id: "pnl", values: (account.history || []).map((point) => point.pnl), color: COLORS[0] }], { empty: "Account history will appear after Alpaca connects" });
  renderChart($("#account-sharpe-chart"), [{ id: "sharpe", values: (account.sharpe_history || []).map((point) => point.value), color: COLORS[2] }], { empty: "Sharpe needs more observations" });

  $("#pipeline-strip").innerHTML = PIPELINE.map(([key, label]) => `<article><strong>${finite(data.pipeline?.[key])}</strong><span>${escapeHtml(label)}</span></article>`).join("");
  $("#alert-stack").innerHTML = (data.alerts || []).slice(0, 3).map((alert) => `<article class="alert ${escapeHtml(alert.severity)}"><strong>${escapeHtml(alert.summary)}</strong><span>${escapeHtml(titleCase(alert.severity))}</span></article>`).join("");
  $("#decision-list").innerHTML = (data.recent_activity || []).length
    ? data.recent_activity.map((item) => `<article><time>${escapeHtml(item.at ? new Date(item.at).toLocaleString() : "")}</time><div><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.detail)}</p></div></article>`).join("")
    : '<p class="empty-copy">No automatic decisions recorded yet.</p>';
}

function renderStrategies() {
  const rows = state.strategies;
  $("#strategy-total").textContent = String(rows.length);
  $("#strategy-empty").hidden = rows.length > 0;
  $("#strategy-table").innerHTML = rows.map((strategy) => {
    const focused = state.focusedId === strategy.id ? " focused" : "";
    return `<tr class="${focused}" data-strategy-id="${escapeHtml(strategy.id)}"><td><strong>${escapeHtml(strategy.name)}</strong><small>${escapeHtml(strategy.asset || strategy.id)}</small></td><td><span class="stage ${strategy.needs_attention ? "attention" : ""}">${escapeHtml(strategy.status)}</span></td><td>${strategy.metrics?.return == null ? "--" : percent(strategy.metrics.return)}</td><td>${number(strategy.metrics?.sharpe)}</td><td>${strategy.metrics?.drawdown == null ? "--" : plainPercent(strategy.metrics.drawdown)}</td></tr>`;
  }).join("");
  $$('[data-strategy-id]', $("#strategy-table")).forEach((row) => row.addEventListener("click", () => selectStrategy(row.dataset.strategyId)));
  renderStrategyChart();
}

function renderStrategyChart() {
  renderChart($("#strategy-chart"), state.strategies.map((strategy, index) => ({
    id: strategy.id, name: strategy.name, curve: strategy.curve, color: COLORS[index % COLORS.length],
  })), {
    normalize: true,
    focus: state.focusedId,
    empty: "Strategy curves will appear after backtests finish",
    onFocus: (id) => {
      state.focusedId = state.focusedId === id ? null : id;
      renderStrategies();
    },
  });
  $("#strategy-legend").innerHTML = state.strategies.map((strategy, index) => `<button data-legend-id="${escapeHtml(strategy.id)}" class="${state.focusedId === strategy.id ? "focused" : ""}"><i style="background:${COLORS[index % COLORS.length]}"></i>${escapeHtml(strategy.name)}</button>`).join("");
  $$('[data-legend-id]', $("#strategy-legend")).forEach((button) => button.addEventListener("click", () => {
    state.focusedId = state.focusedId === button.dataset.legendId ? null : button.dataset.legendId;
    renderStrategies();
  }));
}

async function loadStrategies() {
  const stage = $("#strategy-filter").value;
  const data = await api(`/api/v1/strategies?stage=${encodeURIComponent(stage)}&limit=100`);
  state.strategies = data.items || [];
  if (!state.strategies.some((item) => item.id === state.focusedId)) state.focusedId = null;
  renderStrategies();
}

function renderDetail(detail) {
  $("#strategy-detail").hidden = false;
  $("#detail-id").textContent = `${detail.id} · ${detail.asset || "NO SYMBOL"}`;
  $("#detail-name").textContent = detail.name;
  $("#detail-explanation").textContent = detail.explanation;
  $("#detail-status").textContent = detail.status;
  const values = [
    ["RETURN", detail.metrics?.return == null ? "--" : percent(detail.metrics.return)],
    ["SHARPE", number(detail.metrics?.sharpe)],
    ["DRAWDOWN", detail.metrics?.drawdown == null ? "--" : plainPercent(detail.metrics.drawdown)],
    ["SCORE", number(detail.metrics?.score, 0)],
  ];
  $("#detail-metrics").innerHTML = values.map(([label, value]) => `<article><span>${label}</span><strong>${escapeHtml(value)}</strong></article>`).join("");
  const incubation = detail.incubation;
  $("#incubation-progress").hidden = !incubation;
  if (incubation) {
    const days = Math.min(100, finite(incubation.valid_days) / finite(incubation.required_days, 10) * 100);
    const trades = Math.min(100, finite(incubation.eligible_trades) / finite(incubation.required_trades, 67) * 100);
    $("#incubation-progress").innerHTML = `<div><span>Trading days <strong>${incubation.valid_days}/${incubation.required_days}</strong></span><i><b style="width:${days}%"></b></i></div><div><span>Completed trades <strong>${incubation.eligible_trades}/${incubation.required_trades}</strong></span><i><b style="width:${trades}%"></b></i></div>`;
  }
  const lifecycle = (detail.lifecycle || []).slice(-8);
  $("#lifecycle-timeline").innerHTML = lifecycle.length
    ? lifecycle.map((item) => `<article><span>${escapeHtml(titleCase(item.to))}</span><p>${escapeHtml(item.explanation || item.reason_code || "Stage completed")}</p></article>`).join("")
    : '<p class="empty-copy">No completed lifecycle stages yet.</p>';
  $("#strategy-detail").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function selectStrategy(id) {
  state.selectedId = id;
  state.focusedId = id;
  renderStrategies();
  try { renderDetail(await api(`/api/v1/strategies/${encodeURIComponent(id)}`)); }
  catch (error) { toast(error.message, true); }
}

async function loadDashboard() {
  const data = await api("/api/v1/dashboard");
  renderDashboard(data);
}

async function refresh() {
  try { await Promise.all([loadDashboard(), loadStrategies()]); }
  catch (error) { if (error.message !== "Authentication required") toast(error.message, true); }
}

function bindEvents() {
  $("#signin-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const token = $("#signin-token").value.trim();
    if (!token) return;
    state.token = token;
    try {
      await Promise.all([loadDashboard(), loadStrategies()]);
      sessionStorage.setItem(TOKEN_KEY, token);
      showApp();
    } catch (error) {
      if (error.message !== "Authentication required") showSignin(error.message);
    }
  });
  $("#signout-button").addEventListener("click", () => showSignin("Signed out."));
  $("#strategy-filter").addEventListener("change", () => {
    state.focusedId = null;
    state.selectedId = null;
    $("#strategy-detail").hidden = true;
    loadStrategies().catch((error) => toast(error.message, true));
  });
  $("#legend-button").addEventListener("click", () => {
    state.labelsVisible = !state.labelsVisible;
    $("#strategy-legend").hidden = !state.labelsVisible;
    $("#legend-button").textContent = state.labelsVisible ? "Hide labels" : "Show labels";
    $("#legend-button").setAttribute("aria-expanded", String(state.labelsVisible));
  });
  $("#close-detail").addEventListener("click", () => {
    state.selectedId = null;
    $("#strategy-detail").hidden = true;
  });
  $("#autonomy-button").addEventListener("click", async () => {
    const button = $("#autonomy-button");
    button.disabled = true;
    try {
      await api("/api/v1/admin/autonomy", {
        method: "POST",
        headers: { "idempotency-key": `terminal:autonomy:${button.dataset.desired}:${crypto.randomUUID()}` },
        body: JSON.stringify({ desired_state: button.dataset.desired }),
      });
      toast(button.dataset.desired === "paused" ? "Automation paused" : "Automation resumed");
      await loadDashboard();
    } catch (error) { toast(error.message, true); }
    finally { button.disabled = false; }
  });
  $("#emergency-button").addEventListener("click", () => $("#emergency-dialog").showModal());
  $("#confirm-emergency").addEventListener("click", async () => {
    const button = $("#confirm-emergency");
    button.disabled = true;
    try {
      await adminCommand("kill_switch");
      $("#emergency-dialog").close();
      toast("Emergency stop activated");
      await loadDashboard();
    } catch (error) { toast(error.message, true); }
    finally { button.disabled = false; }
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && state.token) refresh(); });
}

async function boot() {
  bindEvents();
  if (!state.token) return showSignin();
  showApp();
  await refresh();
}

boot().catch((error) => showSignin(error.message));
