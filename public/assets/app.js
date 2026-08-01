const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

let state = null;
let selectedId = null;
let activeView = "overview";
let toastTimer = null;
let adminToken = sessionStorage.getItem("axiom-admin-token") || "";

const statusLabels = {
  generated: "Generated", rework: "Rework", released: "Released", healthy: "Healthy",
  watch: "Watch", adjusted: "Adjusted", dropped: "Dropped"
};

const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
}[char]));

const pct = (value, digits = 1) => value == null ? "—" : `${(value * 100).toFixed(digits)}%`;
const signedPct = (value) => value == null ? "—" : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;
const number = (value, digits = 2) => value == null ? "—" : Number(value).toFixed(digits);
const money = (value) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 }).format(value);

function showToast(message, error = false) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.className = `toast visible${error ? " error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.className = "toast", 2800);
}

async function api(path, body = null, allowAuthRetry = true) {
  document.body.classList.add("loading");
  try {
    const headers = body ? { "Content-Type": "application/json" } : {};
    if (body && adminToken) headers.Authorization = `Bearer ${adminToken}`;
    const response = await fetch(path, {
      method: body ? "POST" : "GET",
      headers,
      body: body ? JSON.stringify(body) : null
    });
    const result = await response.json();
    if (response.status === 401 && body && allowAuthRetry) {
      const supplied = window.prompt("Enter the Cloudflare ADMIN_TOKEN for this deployment:");
      if (!supplied) throw new Error("Admin token required");
      adminToken = supplied.trim();
      sessionStorage.setItem("axiom-admin-token", adminToken);
      return api(path, body, false);
    }
    if (!response.ok) throw new Error(result.error || "Request failed");
    state = result;
    render();
    return result;
  } catch (error) {
    showToast(error.message, true);
    throw error;
  } finally {
    document.body.classList.remove("loading");
  }
}

function filteredStrategies() {
  if (!state) return [];
  if (activeView === "testing") return state.strategies.filter((item) => ["generated", "rework"].includes(item.state));
  if (activeView === "released") return state.strategies.filter((item) => ["released", "healthy", "watch", "adjusted"].includes(item.state));
  if (activeView === "lineage") return state.strategies.filter((item) => item.parent || item.generation > 1);
  return state.strategies;
}

function getSelected() {
  return state?.strategies.find((item) => item.id === selectedId) || null;
}

function ensureSelection() {
  const visible = filteredStrategies();
  if (!state.strategies.some((item) => item.id === selectedId)) {
    const best = state.strategies.find((item) => ["healthy", "released", "watch", "adjusted"].includes(item.state));
    selectedId = (best || state.strategies[0])?.id || null;
  }
  if (visible.length && !visible.some((item) => item.id === selectedId)) selectedId = visible[0].id;
}

function renderSummary() {
  $("#cycle-value").textContent = String(state.meta.cycle).padStart(2, "0");
  $("#capital-value").textContent = money(state.summary.capital);
  $("#seed-value").textContent = state.meta.seed;
  $("#count-generated").textContent = String(state.summary.generated).padStart(2, "0");
  $("#count-testing").textContent = String(state.summary.testing).padStart(2, "0");
  $("#count-released").textContent = String(state.summary.released).padStart(2, "0");
  $("#count-dropped").textContent = String(state.summary.dropped).padStart(2, "0");
  $("#average-score").textContent = number(state.summary.average_score, 1);
}

function renderChart(strategy) {
  const svg = $("#equity-chart");
  const values = strategy?.metrics?.curve || [1, 1, 1, 1];
  const width = 900, height = 255, left = 18, right = 64, top = 14, bottom = 30;
  const min = Math.min(...values, 0.96), max = Math.max(...values, 1.04);
  const spread = Math.max(max - min, 0.04);
  const x = (index) => left + index / Math.max(values.length - 1, 1) * (width - left - right);
  const y = (value) => top + (max - value) / spread * (height - top - bottom);
  const path = values.map((value, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(" ");
  const area = `${path} L${x(values.length - 1)},${height - bottom} L${left},${height - bottom} Z`;
  let grid = "";
  for (let index = 0; index < 5; index++) {
    const gridY = top + index * (height - top - bottom) / 4;
    const label = max - spread * index / 4;
    grid += `<line class="grid-line" x1="${left}" y1="${gridY}" x2="${width - right}" y2="${gridY}"/><text class="axis-label" x="${width - right + 9}" y="${gridY + 3}">${label.toFixed(2)}×</text>`;
  }
  const endX = x(values.length - 1), endY = y(values[values.length - 1]);
  svg.innerHTML = `<defs><linearGradient id="area-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#a8f05a" stop-opacity=".18"/><stop offset="1" stop-color="#a8f05a" stop-opacity="0"/></linearGradient></defs>
    ${grid}<line class="benchmark-line" x1="${left}" y1="${y(1)}" x2="${width - right}" y2="${y(1)}"/>
    <path class="equity-area" d="${area}"/><path class="equity-line" d="${path}"/><circle class="end-dot" cx="${endX}" cy="${endY}" r="5"/>
    <text class="axis-label" x="${left}" y="${height - 8}">START</text><text class="axis-label" x="${width - right}" y="${height - 8}" text-anchor="end">LATEST</text>`;
  $("#chart-delta").textContent = strategy?.metrics ? `${signedPct(strategy.metrics.return)} net` : "Awaiting evidence";
}

function metric(label, value, className = "") {
  return `<div class="metric"><span>${label}</span><strong class="${className}">${value}</strong></div>`;
}

function renderSelected() {
  const strategy = getSelected();
  if (!strategy) return;
  const metrics = strategy.metrics;
  $("#selected-name").textContent = strategy.name;
  $("#selected-meta").innerHTML = `<span>${escapeHtml(strategy.archetype)}</span><span>${escapeHtml(strategy.asset)}</span><span>GEN ${strategy.generation}</span>`;
  const status = $("#selected-status");
  status.textContent = statusLabels[strategy.state] || strategy.state;
  status.className = `status-badge ${strategy.state}`;
  $("#selected-id").textContent = strategy.id;
  const allowed = ["released", "healthy", "watch", "adjusted"].includes(strategy.state);
  $("#reproduce-button").disabled = !allowed;
  $("#metric-row").innerHTML = [
    metric("SUPERVISOR SCORE", metrics ? number(metrics.score, 1) : "PENDING", metrics?.score >= 61 ? "positive" : ""),
    metric("ANNUALIZED", metrics ? signedPct(metrics.annualized) : "—", metrics?.annualized >= 0 ? "positive" : "negative"),
    metric("SHARPE", metrics ? number(metrics.sharpe) : "—", metrics?.sharpe >= .55 ? "positive" : ""),
    metric("MAX DRAWDOWN", metrics ? pct(metrics.drawdown) : "—", metrics?.drawdown > .2 ? "negative" : ""),
    metric("ROBUSTNESS", metrics ? number(metrics.robustness) : "—")
  ].join("");
  renderChart(strategy);
  renderDNA(strategy);
  renderRegimes(strategy);
  renderGates(strategy);
}

function labelParam(key) {
  return key.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function renderDNA(strategy) {
  const lineage = strategy.parent
    ? `<span>PARENT</span><strong>${escapeHtml(strategy.parent)}</strong><span class="arrow">→</span><strong>${escapeHtml(strategy.id)}</strong>`
    : `<span>ORIGIN</span><strong>FIRST-PRINCIPLE SEED</strong><span class="arrow">→</span><strong>${escapeHtml(strategy.id)}</strong>`;
  const params = Object.entries(strategy.params).map(([key, value]) => {
    const formatted = key === "position_size" ? pct(value, 0) : value;
    return `<div class="param"><span>${escapeHtml(labelParam(key))}</span><strong>${escapeHtml(formatted)}</strong></div>`;
  }).join("");
  $("#dna-content").innerHTML = `<div class="dna-lineage">${lineage}</div><div class="param-grid">${params}</div>`;
}

function renderRegimes(strategy) {
  const scores = strategy.metrics?.regime_scores;
  if (!scores) {
    $("#regime-content").innerHTML = `<div class="empty-state">Run the supervisor to expose regime fitness.</div>`;
    return;
  }
  $("#regime-content").innerHTML = Object.entries(scores).map(([name, score]) => {
    const distance = Math.min(Math.abs(score) * 48, 48);
    const left = score >= 0 ? 50 : 50 - distance;
    return `<div class="regime-row"><div class="regime-head"><span>${escapeHtml(name)}</span><span>${score >= 0 ? "+" : ""}${number(score, 2)}</span></div><div class="regime-track"><i class="${score < 0 ? "negative" : ""}" style="left:${left}%;width:${distance}%"></i></div></div>`;
  }).join("");
}

function renderGates(strategy) {
  const m = strategy.metrics;
  const gates = [
    ["Supervisor score", state.policy.release_score, m?.score, (v, t) => v >= t, (v) => number(v, 1)],
    ["Sharpe ratio", state.policy.min_sharpe, m?.sharpe, (v, t) => v >= t, (v) => number(v, 2)],
    ["Maximum drawdown", state.policy.max_drawdown, m?.drawdown, (v, t) => v <= t, (v) => pct(v)],
    ["Positive regimes", 3, m?.positive_regimes, (v, t) => v >= t, (v) => `${v} / 4`]
  ];
  $("#gate-content").innerHTML = gates.map(([label, threshold, value, test, format]) => {
    const known = value != null, pass = known && test(value, threshold);
    return `<div class="gate ${known ? pass ? "pass" : "fail" : ""}"><span class="gate-mark">${known ? pass ? "✓" : "×" : "·"}</span><span>${label}</span><strong>${known ? format(value) : "PENDING"}</strong></div>`;
  }).join("");
}

function renderAudit() {
  $("#audit-feed").innerHTML = state.events.map((event) => `<article class="audit-item"><span class="audit-time">${escapeHtml(event.time)}</span><div class="audit-copy"><strong><i class="event-dot ${escapeHtml(event.kind)}"></i>${escapeHtml(event.title)}</strong><p>${escapeHtml(event.detail)}</p></div></article>`).join("");
}

function renderTable() {
  const strategies = filteredStrategies();
  const titles = { overview: "All research units", testing: "Generation & rework queue", released: "Released market book", lineage: "Reproduction lineage" };
  $("#roster-title").textContent = titles[activeView];
  $("#empty-state").hidden = strategies.length > 0;
  $("#strategy-table").innerHTML = strategies.map((strategy) => {
    const m = strategy.metrics;
    return `<tr data-id="${escapeHtml(strategy.id)}" class="${strategy.id === selectedId ? "selected" : ""}">
      <td class="unit-cell"><strong>${escapeHtml(strategy.name)}</strong><span>${escapeHtml(strategy.id)}${strategy.parent ? ` · CHILD OF ${escapeHtml(strategy.parent)}` : ""}</span></td>
      <td class="archetype-cell"><strong>${escapeHtml(strategy.archetype)}</strong><span>${escapeHtml(strategy.asset)}</span></td>
      <td><span class="status-badge ${strategy.state}">${escapeHtml(statusLabels[strategy.state] || strategy.state)}</span></td>
      <td>${strategy.backtests ? `${strategy.backtests} backtests` : "not tested"}</td><td>${m ? number(m.sharpe) : "—"}</td><td>${m ? pct(m.drawdown) : "—"}</td>
      <td class="score-cell">${m ? number(m.score, 1) : "—"}${m ? `<div class="score-bar"><i style="width:${Math.min(m.score, 100)}%"></i></div>` : ""}</td><td class="row-arrow">›</td></tr>`;
  }).join("");
  $$("#strategy-table tr").forEach((row) => row.addEventListener("click", () => {
    selectedId = row.dataset.id;
    renderSelected(); renderTable();
  }));
}

function render() {
  ensureSelection();
  renderSummary();
  renderSelected();
  renderAudit();
  renderTable();
}

async function action(path, payload, successMessage) {
  try {
    await api(path, payload);
    showToast(successMessage);
  } catch (_) { /* api already surfaced the error */ }
}

$("#generate-button").addEventListener("click", () => action("/api/generate", { count: 6 }, "Six new strategy DNAs seeded."));
$("#review-button").addEventListener("click", () => action("/api/review", {}, "Supervisor review cycle complete."));
$("#advance-button").addEventListener("click", () => action("/api/advance", { periods: 1 }, "Paper market advanced by 21 sessions."));
$("#reproduce-button").addEventListener("click", async () => {
  const parent = getSelected();
  if (!parent) return;
  const before = new Set(state.strategies.map((item) => item.id));
  try {
    await api("/api/reproduce", { id: parent.id });
    const child = state.strategies.find((item) => !before.has(item.id));
    if (child) selectedId = child.id;
    activeView = "lineage";
    $$(".rail-button").forEach((button) => button.classList.toggle("active", button.dataset.view === activeView));
    render();
    showToast(`Child DNA created from ${parent.id}.`);
  } catch (_) { /* handled */ }
});
$("#reset-button").addEventListener("click", () => action("/api/reset", {}, "Deterministic demo restored."));

$$(".rail-button").forEach((button) => button.addEventListener("click", () => {
  activeView = button.dataset.view;
  $$(".rail-button").forEach((item) => item.classList.toggle("active", item === button));
  ensureSelection(); renderTable(); renderSelected();
}));

api("/api/state").catch(() => {});
