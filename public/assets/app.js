const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

let state = null;
let selectedId = null;
let activeView = "portfolio";
let deskOverview = true;
let curveLegendVisible = false;
let toastTimer = null;
let adminToken = sessionStorage.getItem("axiom-admin-token") || "";
let operationsState = null;
let operationsError = null;
let operatorLogsState = { items: [], next_cursor: null, total: 0, category: "" };
const evidenceCache = new Map();
const evidencePending = new Set();
let resetManifest = null;

const multiStrategyViews = new Set(["overview", "testing", "released"]);
const activeFilters = { overview: "all", testing: "all", released: "all" };
const filterConfigs = {
  overview: [
    { id: "all", label: "All" },
    { id: "generated", label: "Generated", states: ["generated"] },
    { id: "rework", label: "Rework", states: ["rework"] },
    { id: "validation", label: "Validation", states: ["validation", "capacity_wait"] },
    { id: "market", label: "Market", states: ["incubation", "release_blocked_short", "released", "healthy", "watch", "quarantined"] },
    { id: "retired", label: "Retired", states: ["development_reject", "holdout_reject", "inconclusive", "incubation_reject", "retired", "dropped", "superseded"] },
  ],
  testing: [
    { id: "all", label: "All" },
    { id: "generated", label: "Generated", states: ["generated"] },
    { id: "rework", label: "Rework", states: ["rework"] },
    { id: "validation", label: "Validation", states: ["validation"] },
    { id: "capacity_wait", label: "Capacity wait", states: ["capacity_wait"] },
  ],
  released: [
    { id: "all", label: "All" },
    { id: "incubation", label: "Incubation", states: ["incubation", "release_blocked_short"] },
    { id: "released", label: "New", states: ["released"] },
    { id: "healthy", label: "Healthy", states: ["healthy"] },
    { id: "watch", label: "Watch", states: ["watch"] },
    { id: "quarantined", label: "Quarantined", states: ["quarantined"] },
    { id: "operational", label: "Operational block", operational: "operational_blocked" },
  ],
};

const statusLabels = {
  generated: "Generated", rework: "Rework", validation: "Validation", capacity_wait: "Capacity wait",
  development_reject: "Development reject", incubation: "Incubation", release_blocked_short: "Short release blocked", holdout_reject: "Holdout reject",
  inconclusive: "Inconclusive", incubation_reject: "Incubation reject", released: "Released paper", healthy: "Healthy paper", watch: "Watch paper",
  quarantined: "Quarantined", retired: "Retired", operational_blocked: "Operational block",
  dropped: "Dropped", superseded: "Superseded"
};

const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
}[char]));

const pct = (value, digits = 1) => value == null ? "—" : `${(value * 100).toFixed(digits)}%`;
const signedPct = (value) => value == null ? "—" : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;
const number = (value, digits = 2) => value == null ? "—" : Number(value).toFixed(digits);
const money = (value) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 }).format(value);
const usd = (value) => value == null ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);

function localTime(value) {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

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
    if (adminToken) headers.Authorization = `Bearer ${adminToken}`;
    const response = await fetch(path, {
      method: body ? "POST" : "GET",
      headers,
      body: body ? JSON.stringify(body) : null
    });
    const result = await response.json();
    if (response.status === 401 && allowAuthRetry) {
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

function strategiesForView(view = activeView) {
  if (!state) return [];
  if (view === "testing") return state.strategies.filter((item) => ["generated", "rework", "validation", "capacity_wait"].includes(item.state));
  if (view === "released") return state.strategies.filter((item) => ["incubation", "release_blocked_short", "released", "healthy", "watch", "quarantined"].includes(item.state));
  return state.strategies;
}

function filteredStrategies() {
  const strategies = strategiesForView();
  const config = filterConfigs[activeView];
  if (!config) return strategies;
  const selectedFilter = config.find((filter) => filter.id === activeFilters[activeView]) || config[0];
  if (selectedFilter.operational) return strategies.filter((strategy) => strategy.operational_status === selectedFilter.operational);
  return selectedFilter.states ? strategies.filter((strategy) => selectedFilter.states.includes(strategy.state)) : strategies;
}

function getSelected() {
  return state?.strategies.find((item) => item.id === selectedId) || null;
}

function ensureSelection() {
  const visible = filteredStrategies();
  if (multiStrategyViews.has(activeView) && deskOverview) {
    selectedId = null;
    return;
  }
  if (multiStrategyViews.has(activeView) && !visible.length) {
    selectedId = null;
    return;
  }
  if (!state.strategies.length) {
    selectedId = null;
    return;
  }
  if (!state.strategies.some((item) => item.id === selectedId)) {
    const best = state.strategies.find((item) => ["healthy", "released", "watch", "quarantined", "incubation", "release_blocked_short"].includes(item.state));
    selectedId = (best || state.strategies[0])?.id || null;
  }
  if (visible.length && !visible.some((item) => item.id === selectedId)) selectedId = visible[0].id;
}

function renderSummary() {
  $("#cycle-value").textContent = String(state.meta.cycle).padStart(2, "0");
  $("#capital-value").textContent = money(state.summary.capital);
  $("#environment-value").textContent = state.meta.environment;
  $("#data-source-value").textContent = state.alpaca?.connected ? `${String(state.alpaca.feed).toUpperCase()} · ${state.alpaca.trading_enabled ? "TRADE ON" : "READ ONLY"}` : "SYNTHETIC";
  $("#sync-button").disabled = !("alpaca" in state);
  $("#seed-value").textContent = state.meta.seed;
  $("#count-generated").textContent = String(state.summary.generated).padStart(2, "0");
  $("#count-testing").textContent = String(state.summary.testing).padStart(2, "0");
  $("#count-validation").textContent = String(state.summary.validation || 0).padStart(2, "0");
  $("#count-released").textContent = String(state.summary.released).padStart(2, "0");
  $("#count-dropped").textContent = String(state.summary.dropped).padStart(2, "0");
  const paused = Boolean(state.research?.paused);
  $("#research-toggle-label").textContent = paused ? "Resume research" : "Pause research";
  $("#research-toggle-button").title = paused
    ? `Paused: ${state.research?.pause_reason || "operator_paused"}`
    : "Pause autonomous evolutionary cohorts";
  $("#average-score").textContent = state.strategies.length ? number(state.summary.average_score, 1) : "—";
}

function renderView() {
  const portfolio = activeView === "portfolio";
  const logs = activeView === "logs";
  const strategyWorkspace = !portfolio && !logs;
  $("#foundry-controls").hidden = !strategyWorkspace;
  $("#portfolio-dashboard").hidden = !portfolio;
  $("#logs-dashboard").hidden = !logs;
  $("#release-pipeline").hidden = !strategyWorkspace;
  $("#desk-observer").hidden = !strategyWorkspace;
  $("#strategy-overview").hidden = !strategyWorkspace;
  $("#strategy-roster").hidden = !strategyWorkspace;
  $("#strategy-detail").hidden = !strategyWorkspace;
}

function renderDeskObserver() {
  const target = $("#desk-observer");
  if (!target || ["portfolio", "logs"].includes(activeView)) return;
  const research = state.research ?? {}, cohort = research.latest_cohort ?? {};
  const visible = strategiesForView(), selected = getSelected();
  const card = (label, value, detail) => `<div class="desk-observer-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small title="${escapeHtml(detail)}">${escapeHtml(detail)}</small></div>`;
  if (activeView === "overview") {
    target.innerHTML = [
      card("LATEST COHORT", cohort.status ? String(cohort.status).toUpperCase() : "NONE", cohort.cohort_id || "No cohort completed"),
      card("EVOLUTION TRIALS", String(research.total_trials ?? 0), `${cohort.valid ?? 0} valid · ${cohort.duplicates ?? 0} duplicate in latest cohort`),
      card("EXPENSIVE DISPATCHES", String(research.total_expensive_dispatches ?? 0), `${research.budget?.expensive_dispatches ?? 0} in current session budget`),
      card("DIVERSE POPULATION", String(research.population_size ?? 0), `${research.novelty_archive_size ?? 0} immutable DNA hashes archived`),
      card("FINALISTS", String(cohort.finalists ?? 0), `${cohort.attempted ?? 0} attempted · typed DSL only for new strategies`),
    ].join("");
    return;
  }
  if (activeView === "testing") {
    const validation = visible.filter((item) => item.state === "validation").length;
    const rejected = state.strategies.filter((item) => ["development_reject", "holdout_reject", "inconclusive"].includes(item.state)).length;
    const backtrader = visible.filter((item) => item.engine_family === "backtrader").length;
    const folds = selected?.backtest_runs?.development?.folds?.length ?? (selected?.backtests ? Math.min(selected.backtests, 3) : 0);
    target.innerHTML = [
      card("EVIDENCE TYPE", selected ? "EXACT HISTORICAL" : "DEVELOPMENT QUEUE", "Next-bar-open fills; vector screening is not counted here"),
      card("ROLLING FOLDS", String(folds || "—"), selected ? `${selected.id} development provenance` : "Three rolling development folds per finalist"),
      card("ENGINE ASSIGNMENT", `${backtrader}/${visible.length}`, "Backtrader assignments; one engine family per release decision"),
      card("SEALED VALIDATION", String(validation), `${research.holdout?.pending ?? 0} one-use authorizations pending · no raw bars exposed`),
      card("TERMINAL REJECTIONS", String(rejected), "Quality gates only; infrastructure failures remain retryable"),
    ].join("");
    return;
  }
  const incubating = visible.filter((item) => item.state === "incubation").length;
  const paper = visible.filter((item) => ["released", "healthy", "watch", "quarantined"].includes(item.state)).length;
  const watch = visible.filter((item) => item.state === "watch").length;
  const blocked = visible.filter((item) => item.operational_status === "operational_blocked" || item.state === "release_blocked_short").length;
  target.innerHTML = [
    card("LIVE SHADOW", String(incubating), "Future 5-minute evidence; no candidate orders reach Alpaca"),
    card("RELEASED PAPER", String(paper), "Paper positions only; this does not represent real money"),
    card("WATCH", String(watch), "Reduced risk overlay; frozen DNA is unchanged"),
    card("OPERATIONAL BLOCKS", String(blocked), "Service faults block risk without becoming alpha evidence"),
    card("PORTFOLIO OVERLAY", pct(state.portfolio_health?.gross_before_netting && state.alpaca?.account?.equity ? state.portfolio_health.gross_before_netting / state.alpaca.account.equity : 0, 2), "Gross before netting; 10% portfolio cap"),
  ].join("");
}

function renderOperations() {
  const grid = $("#operations-grid");
  const attention = $("#operations-attention");
  if (!grid || !attention) return;
  if (!operationsState) {
    $("#ops-mode").textContent = "UNAVAILABLE";
    $("#ops-mode").className = "status-badge operational_blocked";
    $("#ops-generated-at").textContent = operationsError || "Operator read model is unavailable";
    grid.innerHTML = '<div class="operations-card"><span>CONTROL PLANE</span><strong class="bad">NO READ MODEL</strong><small>Safety commands remain available. No operational status is inferred.</small></div>';
    attention.innerHTML = '<span class="attention-chip critical">operator view unavailable</span>';
    return;
  }
  const ops = operationsState;
  const blocked = !ops.mode.new_risk_possible;
  $("#ops-mode").textContent = String(ops.mode.code).replaceAll("_", " ").toUpperCase();
  $("#ops-mode").className = `status-badge ${blocked ? "watch" : "healthy"}`;
  $("#ops-generated-at").textContent = `As of ${localTime(ops.generated_at)} · ${ops.timezone}`;
  const dailyUsed = ops.risk.daily_loss_limit > 0 ? ops.risk.daily_loss_fraction / ops.risk.daily_loss_limit : 0;
  const grossUsed = ops.risk.portfolio_gross_limit > 0 ? ops.risk.portfolio_gross_fraction / ops.risk.portfolio_gross_limit : 0;
  const queue = ops.services.queue, backtester = ops.services.backtester, broker = ops.services.broker;
  const cost = ops.budget.estimated_monthly_usd == null ? "NOT ESTIMATED" : usd(ops.budget.estimated_monthly_usd);
  const costTone = ["hard_stop", "optional_paused", "telemetry_unavailable"].includes(ops.budget.level) ? "bad"
    : ["constrained", "informational"].includes(ops.budget.level) ? "warn" : "good";
  grid.innerHTML = [
    ["MARKET / NEXT", ops.market.session_status.toUpperCase(), `${ops.market.next_action.label} · ${ops.market.feed} (not SIP)`, ops.market.session_status === "open" ? "good" : ""],
    ["ALPACA PAPER", ops.account.connected ? usd(ops.account.equity) : "DISCONNECTED", `${usd(ops.account.cash)} cash · ${usd(ops.account.buying_power)} buying power`, ops.account.connected ? "good" : "warn"],
    ["DAILY LOSS", pct(ops.risk.daily_loss_fraction, 2), `${Math.round(dailyUsed * 100)}% of ${pct(ops.risk.daily_loss_limit, 2)} halt`, ops.risk.daily_loss_halted ? "bad" : dailyUsed >= .8 ? "warn" : "good"],
    ["PORTFOLIO GROSS", pct(ops.risk.portfolio_gross_fraction, 2), `${Math.round(grossUsed * 100)}% of ${pct(ops.risk.portfolio_gross_limit, 0)} cap · ${usd(ops.account.net_exposure_usd)} net`, grossUsed >= 1 ? "bad" : grossUsed >= .8 ? "warn" : "good"],
    [`DATA / ${ops.data.expected_symbols} SYMBOLS`, `${ops.data.healthy_symbols}/${ops.data.expected_symbols} ${String(ops.data.status).toUpperCase()}`, `${pct(ops.data.coverage, 0)} coverage · ${ops.data.revision_events} revisions`, ops.data.status === "healthy" && ops.data.coverage >= .9 ? "good" : "warn"],
    ["JOBS / COST", `${queue.research_pending} QUEUED · ${backtester.active_runs} RUNS`, `${queue.status} queue · ${broker.mode} broker · ${cost}/${usd(ops.budget.monthly_limit_usd)} limit · ${String(ops.budget.level).replaceAll("_", " ")}`, cost === "NOT ESTIMATED" ? "warn" : costTone],
  ].map(([label, value, detail, tone]) => `<div class="operations-card"><span>${escapeHtml(label)}</span><strong class="${tone}">${escapeHtml(value)}</strong><small>${escapeHtml(detail)}</small></div>`).join("");
  attention.innerHTML = ops.attention.length
    ? ops.attention.slice(0, 12).map((item) => `<span class="attention-chip ${escapeHtml(item.severity)}" title="${escapeHtml(item.summary)}">${escapeHtml(item.code)}</span>`).join("")
    : '<span class="attention-chip">No operator attention items</span>';
  const controls = ops.controls ?? {};
  setDockToggle("#ops-research-toggle", Boolean(controls.research_paused || ops.research.paused), "research");
  setDockToggle("#ops-release-toggle", Boolean(controls.release_paused), "release");
  setDockToggle("#ops-execution-toggle", Boolean(controls.execution_paused), "execution");
}

function setDockToggle(selector, paused, noun) {
  const button = $(selector);
  if (!button) return;
  button.dataset.command = paused ? `resume_${noun}` : `pause_${noun}`;
  button.textContent = `${paused ? "Resume" : "Pause"} ${noun}`;
}

function rollingSharpe(history) {
  const returns = [];
  const result = [];
  for (let index = 1; index < history.length; index += 1) {
    const previousWealth = 1 + Number(history[index - 1].profit_loss_pct);
    const currentWealth = 1 + Number(history[index].profit_loss_pct);
    if (!(previousWealth > 0) || !Number.isFinite(currentWealth)) continue;
    returns.push(currentWealth / previousWealth - 1);
    const window = returns.slice(-20);
    if (window.length < 5) continue;
    const average = window.reduce((sum, value) => sum + value, 0) / window.length;
    const variance = window.reduce((sum, value) => sum + (value - average) ** 2, 0) / window.length;
    const deviation = Math.sqrt(variance);
    result.push({ timestamp: history[index].timestamp, value: deviation > 1e-9 ? average / deviation * Math.sqrt(252) : 0 });
  }
  return result;
}

function deterministicDisplaySeries(values, limit = 240) {
  if (values.length <= limit) return values;
  const sampled = [];
  for (let index = 0; index < limit; index += 1) sampled.push(values[Math.round(index * (values.length - 1) / (limit - 1))]);
  return sampled;
}

function renderAccountSeries(svgId, points, { formatAxis, emptyText }) {
  const svg = $(svgId);
  const clean = points.filter((point) => Number.isFinite(point.value));
  if (clean.length < 2) {
    svg.innerHTML = `<text class="account-chart-empty" x="360" y="120" text-anchor="middle">${escapeHtml(emptyText)}</text>`;
    return;
  }
  const width = 720, height = 240, left = 20, right = 74, top = 18, bottom = 31;
  const values = clean.map((point) => point.value);
  let minimum = Math.min(0, ...values), maximum = Math.max(0, ...values);
  if (maximum - minimum < 0.0001) { maximum += 1; minimum -= 1; }
  const padding = (maximum - minimum) * 0.08;
  maximum += padding; minimum -= padding;
  const x = (index) => left + index / (clean.length - 1) * (width - left - right);
  const y = (value) => top + (maximum - value) / (maximum - minimum) * (height - top - bottom);
  const path = clean.map((point, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(point.value).toFixed(1)}`).join(" ");
  const area = `${path} L${x(clean.length - 1)},${height - bottom} L${left},${height - bottom} Z`;
  const latest = clean.at(-1).value;
  const gradientId = `${svg.id}-fill`;
  let grid = "";
  for (let index = 0; index < 4; index += 1) {
    const lineY = top + index * (height - top - bottom) / 3;
    const value = maximum - (maximum - minimum) * index / 3;
    grid += `<line class="account-chart-gridline" x1="${left}" y1="${lineY}" x2="${width - right}" y2="${lineY}"/><text class="account-chart-axis" x="${width - right + 8}" y="${lineY + 3}">${escapeHtml(formatAxis(value))}</text>`;
  }
  const firstDate = new Date(clean[0].timestamp);
  const lastDate = new Date(clean.at(-1).timestamp);
  const dateLabel = (date) => Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString([], { month: "short", day: "numeric" }).toUpperCase();
  svg.innerHTML = `<defs><linearGradient id="${gradientId}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${latest >= 0 ? "#a8f05a" : "#ee736a"}" stop-opacity=".18"/><stop offset="1" stop-color="${latest >= 0 ? "#a8f05a" : "#ee736a"}" stop-opacity="0"/></linearGradient></defs>
    ${grid}<line class="account-chart-zero" x1="${left}" y1="${y(0)}" x2="${width - right}" y2="${y(0)}"/>
    <path class="account-chart-area" style="fill:url(#${gradientId})" d="${area}"/><path class="account-chart-line ${latest < 0 ? "negative" : ""}" d="${path}"/>
    <circle class="account-chart-dot ${latest < 0 ? "negative" : ""}" cx="${x(clean.length - 1)}" cy="${y(latest)}" r="4"/>
    <text class="account-chart-axis" x="${left}" y="${height - 8}">${dateLabel(firstDate)}</text><text class="account-chart-axis" x="${width - right}" y="${height - 8}" text-anchor="end">${dateLabel(lastDate)}</text>`;
}

function renderPortfolio() {
  const alpaca = state.alpaca;
  const connected = Boolean(alpaca?.connected);
  const refresh = $("#portfolio-refresh-button");
  refresh.disabled = !("alpaca" in state);
  const market = $("#portfolio-market-status");
  const positions = connected ? alpaca.positions ?? [] : [];
  const orders = connected ? alpaca.open_orders ?? [] : [];
  const history = connected ? alpaca.portfolio_history?.points ?? [] : [];
  const managed = new Set(alpaca?.managed_symbols ?? []);
  const account = alpaca?.account ?? {};
  const dayPnl = connected ? Number(account.equity ?? 0) - Number(account.last_equity ?? 0) : null;
  const dayPnlPct = connected && Number(account.last_equity) ? dayPnl / Number(account.last_equity) : null;
  const fetchedAt = connected ? new Date(alpaca.fetched_at).getTime() : 0;
  const stale = connected && (!Number.isFinite(fetchedAt) || Date.now() - fetchedAt > 2 * 60 * 60 * 1000);
  const pnlSeries = history.map((point) => ({ timestamp: point.timestamp, value: Number(point.profit_loss) }));
  const sharpeSeries = rollingSharpe(history);
  const latestPnl = pnlSeries.filter((point) => Number.isFinite(point.value)).at(-1)?.value;
  const latestSharpe = sharpeSeries.at(-1)?.value;

  $("#account-pnl-value").textContent = connected && latestPnl != null ? usd(latestPnl) : "—";
  $("#account-pnl-value").className = latestPnl > 0 ? "positive" : latestPnl < 0 ? "negative" : "";
  $("#account-sharpe-value").textContent = connected && latestSharpe != null ? number(latestSharpe, 2) : "—";
  $("#account-sharpe-value").className = latestSharpe > 0 ? "positive" : latestSharpe < 0 ? "negative" : "";
  renderAccountSeries("#account-pnl-chart", pnlSeries, { formatAxis: (value) => money(value), emptyText: "Refresh account to load Alpaca P/L history" });
  renderAccountSeries("#account-sharpe-chart", sharpeSeries, { formatAxis: (value) => number(value, 1), emptyText: "At least six daily observations are required" });

  market.textContent = connected ? alpaca.clock?.is_open ? "MARKET OPEN" : "MARKET CLOSED" : "DISCONNECTED";
  market.className = `status-badge ${connected ? alpaca.clock?.is_open ? "healthy" : "watch" : ""}`;
  $("#portfolio-updated").innerHTML = connected
    ? `<span>UPDATED ${escapeHtml(localTime(alpaca.fetched_at))}</span><span>${escapeHtml(String(alpaca.feed || "iex").toUpperCase())} FEED</span>`
    : `<span>${"alpaca" in state ? "Press Refresh account to connect" : "Cloudflare deployment required"}</span>`;

  const alert = $("#portfolio-alert");
  if (!connected) {
    alert.className = "portfolio-alert visible";
    alert.textContent = "No Alpaca account snapshot is loaded. Configure the paper API secrets, then press Refresh account.";
  } else if (account.account_blocked || account.trading_blocked) {
    alert.className = "portfolio-alert visible danger";
    alert.textContent = "Alpaca reports that this paper account is blocked from trading. Monitoring remains available.";
  } else if (stale) {
    alert.className = "portfolio-alert visible warning";
    alert.textContent = "This account snapshot is more than two hours old. Refresh it before relying on the figures below.";
  } else {
    alert.className = "portfolio-alert";
    alert.textContent = "";
  }

  $("#account-metric-grid").innerHTML = [
    metric("ACCOUNT EQUITY", connected ? usd(account.equity) : "—"),
    metric("DAY P/L", connected ? `${usd(dayPnl)}${dayPnlPct == null ? "" : ` · ${signedPct(dayPnlPct)}`}` : "—", dayPnl > 0 ? "positive" : dayPnl < 0 ? "negative" : ""),
    metric("CASH", connected ? usd(account.cash) : "—"),
    metric("BUYING POWER", connected ? usd(account.buying_power) : "—"),
    metric("PORTFOLIO VALUE", connected ? usd(account.portfolio_value) : "—"),
    metric("DAY TRADES", connected ? number(account.daytrade_count, 0) : "—"),
  ].join("");

  $("#position-count").textContent = `${positions.length} POSITION${positions.length === 1 ? "" : "S"}`;
  $("#position-table").innerHTML = positions.map((position) => {
    const attributed = managed.has(position.symbol);
    const pnl = Number(position.unrealized_pl ?? 0);
    return `<tr><td class="symbol-cell"><strong>${escapeHtml(position.symbol)}</strong><span>${escapeHtml(position.asset_class || "asset")}</span></td>
      <td><span class="ownership-badge ${attributed ? "axiom" : "manual"}">${attributed ? "AXIOM / MIXED" : "MANUAL / UNKNOWN"}</span></td>
      <td>${escapeHtml(String(position.side || "long").toUpperCase())}<span class="cell-sub">${escapeHtml(number(position.qty, 6))} units</span></td>
      <td>${usd(position.avg_entry_price)}</td><td>${usd(position.current_price)}</td><td>${usd(position.market_value)}</td>
      <td class="${pnl > 0 ? "positive" : pnl < 0 ? "negative" : ""}"><strong>${usd(pnl)}</strong><span class="cell-sub">${signedPct(position.unrealized_plpc)}</span></td></tr>`;
  }).join("");
  const positionsEmpty = $("#positions-empty");
  positionsEmpty.hidden = positions.length > 0;
  positionsEmpty.textContent = connected ? "No open positions in the Alpaca paper account." : "Connect Alpaca to load positions.";

  $("#order-count").textContent = `${orders.length} ORDER${orders.length === 1 ? "" : "S"}`;
  $("#order-table").innerHTML = orders.map((order) => {
    const axiom = String(order.client_order_id || "").startsWith("axiom-");
    const amount = Number(order.notional) > 0 ? usd(order.notional) : `${number(order.qty, 6)} units`;
    return `<tr><td class="symbol-cell"><strong>${escapeHtml(order.symbol)}</strong><span>${escapeHtml(order.client_order_id || order.id || "")}</span></td>
      <td><span class="ownership-badge ${axiom ? "axiom" : "manual"}">${axiom ? "AXIOM" : "MANUAL"}</span></td>
      <td>${escapeHtml(String(order.side || "").toUpperCase())}<span class="cell-sub">${escapeHtml(String(order.type || "").toUpperCase())}</span></td>
      <td>${escapeHtml(amount)}</td><td>${escapeHtml(number(order.filled_qty, 6))}</td><td>${escapeHtml(String(order.status || "").toUpperCase())}</td><td>${escapeHtml(localTime(order.submitted_at))}</td></tr>`;
  }).join("");
  const ordersEmpty = $("#orders-empty");
  ordersEmpty.hidden = orders.length > 0;
  ordersEmpty.textContent = connected ? "No open paper orders." : "Connect Alpaca to load open orders.";
}

function renderChart(strategy) {
  const svg = $("#equity-chart");
  $("#chart-title").textContent = "OUT-OF-SAMPLE EQUITY";
  $("#market-chart-legend").hidden = true;
  $("#curve-legend-button").hidden = true;
  $("#curve-legend-button").setAttribute("aria-expanded", "false");
  const values = deterministicDisplaySeries(strategy?.metrics?.curve || [1, 1, 1, 1]);
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

function focusStrategy(strategyId) {
  deskOverview = false;
  selectedId = strategyId;
  render();
}

function renderCombinedChart(strategies, chartTitle) {
  const svg = $("#equity-chart");
  const palette = ["#a8f05a", "#70a7ee", "#a28bdd", "#e9b655", "#ee736a", "#70d7c7", "#d99fe8", "#c7d36f"];
  const renderedStrategies = strategies.slice(0, 120);
  const curves = renderedStrategies.map((strategy, index) => ({
    strategy,
    color: palette[index % palette.length],
    values: deterministicDisplaySeries((strategy.metrics?.curve ?? []).map(Number).filter(Number.isFinite)),
  })).filter((item) => item.values.length >= 2);
  $("#chart-title").textContent = chartTitle;
  $("#chart-delta").textContent = strategies.length > renderedStrategies.length
    ? `${curves.length}/${strategies.length} CURVES DISPLAYED` : `${curves.length} CURVE${curves.length === 1 ? "" : "S"}`;
  const legend = $("#market-chart-legend");
  legend.hidden = curves.length === 0 || !curveLegendVisible;
  legend.innerHTML = curves.map(({ strategy, color }) => `<button type="button" data-strategy-id="${escapeHtml(strategy.id)}"><i style="background:${color}"></i><span>${escapeHtml(strategy.name)}</span><small>${escapeHtml(strategy.asset)}</small></button>`).join("");
  const legendButton = $("#curve-legend-button");
  legendButton.hidden = curves.length === 0;
  legendButton.textContent = curveLegendVisible ? "Hide legend" : "Show legend";
  legendButton.setAttribute("aria-expanded", String(curves.length > 0 && curveLegendVisible));
  $$("#market-chart-legend button").forEach((button) => button.addEventListener("click", () => focusStrategy(button.dataset.strategyId)));
  if (!curves.length) {
    svg.innerHTML = '<text class="market-chart-empty" x="450" y="128" text-anchor="middle">NO STRATEGY CURVES IN THIS FILTER YET</text>';
    return;
  }
  const width = 900, height = 255, left = 18, right = 64, top = 14, bottom = 30;
  const allValues = curves.flatMap((item) => item.values);
  const minimum = Math.min(...allValues, 0.96), maximum = Math.max(...allValues, 1.04);
  const spread = Math.max(maximum - minimum, 0.04);
  const x = (index, length) => left + index / Math.max(length - 1, 1) * (width - left - right);
  const y = (value) => top + (maximum - value) / spread * (height - top - bottom);
  let grid = "";
  for (let index = 0; index < 5; index += 1) {
    const gridY = top + index * (height - top - bottom) / 4;
    const label = maximum - spread * index / 4;
    grid += `<line class="grid-line" x1="${left}" y1="${gridY}" x2="${width - right}" y2="${gridY}"/><text class="axis-label" x="${width - right + 9}" y="${gridY + 3}">${label.toFixed(2)}×</text>`;
  }
  const paths = curves.map(({ values, color }) => {
    const path = values.map((value, index) => `${index ? "L" : "M"}${x(index, values.length).toFixed(1)},${y(value).toFixed(1)}`).join(" ");
    return `<path class="market-equity-line" stroke="${color}" d="${path}"/><circle class="market-end-dot" fill="${color}" cx="${x(values.length - 1, values.length)}" cy="${y(values.at(-1))}" r="4"/>`;
  }).join("");
  svg.innerHTML = `${grid}<line class="benchmark-line" x1="${left}" y1="${y(1)}" x2="${width - right}" y2="${y(1)}"/>${paths}
    <text class="axis-label" x="${left}" y="${height - 8}">START</text><text class="axis-label" x="${width - right}" y="${height - 8}" text-anchor="end">LATEST</text>`;
}

function metric(label, value, className = "") {
  return `<div class="metric"><span>${label}</span><strong class="${className}">${value}</strong></div>`;
}

function renderDeskOverview() {
  const strategies = filteredStrategies();
  const desks = {
    overview: { name: "Foundry strategy book", empty: "No strategies in the foundry", chart: "ALL FOUNDRY EQUITY CURVES", noun: "research strategy" },
    testing: { name: "Testing strategy queue", empty: "No strategies in testing", chart: "ALL TEST EQUITY CURVES", noun: "testing strategy" },
    released: { name: "Paper market strategy book", empty: "No paper-released strategies", chart: "ALL PAPER-MARKET EQUITY CURVES", noun: "paper-released strategy" },
  };
  const desk = desks[activeView] || desks.overview;
  const metrics = strategies.map((strategy) => strategy.metrics).filter(Boolean);
  const validations = strategies.map((strategy) => strategy.validation).filter(Boolean);
  const average = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  $("#selected-name").textContent = strategies.length ? desk.name : desk.empty;
  $("#selected-meta").innerHTML = strategies.length
    ? `<span>${strategies.length} STRATEG${strategies.length === 1 ? "Y" : "IES"}</span><span>CLICK A CURVE OR ROW TO FOCUS</span>`
    : "<span>Choose another filter or generate new strategies</span>";
  const status = $("#selected-status");
  status.textContent = strategies.length ? "All" : "Empty";
  status.className = `status-badge ${activeView === "released" && strategies.length ? "released" : ""}`;
  $("#show-all-curves-button").hidden = true;
  $("#reproduce-button").disabled = true;
  $("#selected-id").textContent = "ALL";
  const averageScore = average(metrics.map((item) => item.score));
  const averageAnnualized = average(metrics.map((item) => item.annualized));
  const averageSharpe = average(metrics.map((item) => item.sharpe));
  const averageUnseen = average(validations.map((item) => item.sharpe));
  const worstDrawdown = metrics.length ? Math.max(...metrics.map((item) => item.drawdown)) : null;
  $("#metric-row").innerHTML = [
    metric("AVG SUPERVISOR SCORE", averageScore == null ? "—" : number(averageScore, 1), averageScore >= 61 ? "positive" : ""),
    metric("AVG ANNUALIZED", averageAnnualized == null ? "—" : signedPct(averageAnnualized), averageAnnualized >= 0 ? "positive" : "negative"),
    metric("AVG DEV SHARPE", averageSharpe == null ? "—" : number(averageSharpe), averageSharpe >= .55 ? "positive" : ""),
    metric("AVG UNSEEN SHARPE", averageUnseen == null ? "—" : number(averageUnseen), averageUnseen >= .30 ? "positive" : ""),
    metric("WORST MAX DRAWDOWN", worstDrawdown == null ? "—" : pct(worstDrawdown), worstDrawdown > .2 ? "negative" : ""),
  ].join("");
  renderCombinedChart(strategies, desk.chart);
  const contextStrip = $("#strategy-context-strip");
  contextStrip.hidden = true;
  contextStrip.innerHTML = "";
  $("#dna-content").innerHTML = `<div class="empty-state">Select a ${desk.noun} to inspect its DNA and lineage.</div>`;
  $("#regime-content").innerHTML = `<div class="empty-state">Select a ${desk.noun} to inspect its regime fitness.</div>`;
  renderEvidence(null);
}

async function operatorRequest(path, { body = null, token = adminToken, allowAuthRetry = true } = {}) {
  const headers = body ? { "Content-Type": "application/json" } : {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(path, { method: body ? "POST" : "GET", headers, body: body ? JSON.stringify(body) : null });
  const result = await response.json().catch(() => ({ error: "Invalid service response" }));
  if (response.status === 401 && allowAuthRetry) {
    const supplied = window.prompt("Enter the Cloudflare ADMIN_TOKEN for this deployment:");
    if (!supplied) throw new Error("Admin token required");
    adminToken = supplied.trim();
    sessionStorage.setItem("axiom-admin-token", adminToken);
    return operatorRequest(path, { body, token: adminToken, allowAuthRetry: false });
  }
  if (!response.ok) throw new Error(result.error || "Operator request failed");
  return result;
}

async function loadOperations() {
  try {
    operationsState = await operatorRequest("/api/v1/operations");
    operationsError = null;
  } catch (error) {
    operationsState = null;
    operationsError = error.message;
  }
  renderOperations();
}

async function loadOperatorLogs({ append = false } = {}) {
  const category = $("#log-category")?.value ?? operatorLogsState.category;
  const params = new URLSearchParams({ limit: "50" });
  if (category) params.set("category", category);
  if (append && operatorLogsState.next_cursor) params.set("cursor", operatorLogsState.next_cursor);
  try {
    const page = await operatorRequest(`/api/v1/logs?${params}`);
    operatorLogsState = { items: append ? [...operatorLogsState.items, ...page.items] : page.items,
      next_cursor: page.next_cursor, total: page.total, category };
  } catch (error) {
    if (!append) operatorLogsState = { items: [], next_cursor: null, total: 0, category };
    showToast(error.message, true);
  }
  renderAudit();
}

function renderSelected() {
  if (multiStrategyViews.has(activeView) && deskOverview) {
    renderDeskOverview();
    return;
  }
  const strategy = getSelected();
  if (!strategy) {
    $("#selected-name").textContent = "No strategy selected";
    $("#selected-meta").innerHTML = "<span>Seed your first cohort to begin</span>";
    const emptyStatus = $("#selected-status");
    emptyStatus.textContent = "Empty";
    emptyStatus.className = "status-badge";
    $("#reproduce-button").disabled = true;
    $("#show-all-curves-button").hidden = true;
    $("#selected-id").textContent = "—";
    $("#metric-row").innerHTML = [
      metric("SUPERVISOR SCORE", "—"), metric("ANNUALIZED", "—"),
      metric("DEV SHARPE", "—"), metric("UNSEEN SHARPE", "—"), metric("MAX DRAWDOWN", "—")
    ].join("");
    renderChart(null);
    const contextStrip = $("#strategy-context-strip");
    contextStrip.hidden = true;
    contextStrip.innerHTML = "";
    $("#dna-content").innerHTML = '<div class="empty-state">No strategy DNA yet.</div>';
    $("#regime-content").innerHTML = '<div class="empty-state">No regime evidence yet.</div>';
    renderEvidence(null);
    return;
  }
  const metrics = strategy.metrics;
  $("#selected-name").textContent = strategy.name;
  const attempt = strategy.rework?.attempt ? `<span>REWORK ${strategy.rework.attempt}/${strategy.rework.max_attempts || 3}</span>` : "";
  const engineRun = strategy.backtest_runs?.development ?? strategy.backtest_runs?.holdout;
  const engineName = strategy.engine_family ? strategy.engine_family.toUpperCase() : "UNASSIGNED";
  const engineVersion = engineRun?.engine?.version ? ` ${engineRun.engine.version}` : "";
  const shadow = strategy.backtest_runs?.shadow || strategy.backtest_runs?.shadow_validation ? "<span>SHADOW COMPARED</span>" : "";
  $("#selected-meta").innerHTML = `<span>${escapeHtml(strategy.archetype)}</span><span>${escapeHtml(strategy.asset)}</span><span>GEN ${strategy.generation}</span><span>${escapeHtml(engineName + engineVersion)} ENGINE</span>${shadow}${attempt}`;
  const status = $("#selected-status");
  const displayedState = strategy.operational_status === "operational_blocked"
    ? "operational_blocked" : strategy.state;
  status.textContent = statusLabels[displayedState] || displayedState;
  status.className = `status-badge ${displayedState}`;
  $("#selected-id").textContent = strategy.id;
  const allowed = ["released", "healthy", "watch", "quarantined"].includes(strategy.state);
  $("#reproduce-button").disabled = !allowed;
  $("#show-all-curves-button").hidden = !multiStrategyViews.has(activeView);
  $("#metric-row").innerHTML = [
    metric("SUPERVISOR SCORE", metrics ? number(metrics.score, 1) : "PENDING", metrics?.score >= 61 ? "positive" : ""),
    metric("ANNUALIZED", metrics ? signedPct(metrics.annualized) : "—", metrics?.annualized >= 0 ? "positive" : "negative"),
    metric("DEV SHARPE", metrics ? number(metrics.sharpe) : "—", metrics?.sharpe >= .55 ? "positive" : ""),
    metric("UNSEEN SHARPE", strategy.validation ? number(strategy.validation.sharpe) : "PENDING", strategy.validation?.sharpe >= .30 ? "positive" : ""),
    metric("MAX DRAWDOWN", metrics ? pct(metrics.drawdown) : "—", metrics?.drawdown > .2 ? "negative" : ""),
  ].join("");
  renderChart(strategy);
  renderStrategyContext(strategy);
  renderDNA(strategy);
  renderRegimes(strategy);
  renderEvidence(evidenceCache.get(strategy.id) ?? { strategy_id: strategy.id, loading: true });
  loadStrategyEvidence(strategy.id);
}

async function loadStrategyEvidence(strategyId) {
  if (evidenceCache.has(strategyId) || evidencePending.has(strategyId)) return;
  evidencePending.add(strategyId);
  try {
    const evidence = await operatorRequest(`/api/v1/strategies/${encodeURIComponent(strategyId)}/evidence`);
    evidenceCache.set(strategyId, evidence);
    if (selectedId === strategyId) renderEvidence(evidence);
  } catch (error) {
    evidenceCache.set(strategyId, { strategy_id: strategyId, error: error.message });
    if (selectedId === strategyId) renderEvidence(evidenceCache.get(strategyId));
  } finally { evidencePending.delete(strategyId); }
}

function artifactLink(id, label) {
  return id ? `<button type="button" data-artifact-id="${escapeHtml(id)}">${escapeHtml(label)}</button>` : "";
}

async function downloadPrivateArtifact(id, button) {
  button.disabled = true;
  try {
    const artifact = await operatorRequest(`/api/v1/artifacts/${encodeURIComponent(id)}/download`);
    const url = URL.createObjectURL(new Blob([JSON.stringify(artifact, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url; link.download = `${id.replace(/[^A-Za-z0-9._-]/g, "_")}.json`; link.click();
    URL.revokeObjectURL(url);
  } catch (error) { showToast(error.message, true); }
  finally { button.disabled = false; }
}

function renderEvidence(evidence) {
  const context = $("#evidence-context"), content = $("#evidence-content");
  if (!context || !content) return;
  if (!evidence) {
    context.textContent = "NO STRATEGY";
    content.innerHTML = '<div class="empty-state">Select a strategy to inspect its evidence and provenance.</div>';
    return;
  }
  if (evidence.loading) {
    context.textContent = "LOADING";
    content.innerHTML = '<div class="empty-state">Loading the private evidence chain…</div>';
    return;
  }
  if (evidence.error) {
    context.textContent = "UNAVAILABLE";
    content.innerHTML = `<div class="empty-state">Evidence could not be loaded: ${escapeHtml(evidence.error)}</div>`;
    return;
  }
  const labels = {
    hypothetical_vector_screen: ["HYPOTHETICAL VECTOR SCREEN", "Cheap evolutionary screening only; this is not an exact historical backtest."],
    exact_historical_backtest: ["EXACT HISTORICAL BACKTEST", "Development folds use the assigned engine and next-bar-open execution."],
    sealed_validation_pending: ["SEALED VALIDATION", "The untouched holdout is isolated and has not been revealed to research."],
    live_shadow: ["LIVE SHADOW", "Future five-minute bars are observed without candidate orders reaching Alpaca."],
    alpaca_paper_monitoring: ["ALPACA PAPER", "Released means paper-released. No real-money execution is represented."],
  };
  const [contextLabel, contextDetail] = labels[evidence.evidence_context] ?? [String(evidence.evidence_context).toUpperCase(), "Evidence context reported by the control plane."];
  context.textContent = contextLabel;
  const dev = evidence.provenance?.development, validation = evidence.provenance?.validation;
  const supervisor = evidence.decisions?.supervisor, validationDecision = evidence.decisions?.validation;
  const laterDecision = evidence.decisions?.health ?? evidence.decisions?.incubation;
  content.innerHTML = `<div class="evidence-column"><span>CURRENT CONTEXT</span><strong>${escapeHtml(contextLabel)}</strong><small>${escapeHtml(contextDetail)}</small></div>
    <div class="evidence-column"><span>PROVENANCE</span><strong>${escapeHtml(evidence.provenance?.engine_family || "UNASSIGNED ENGINE")}</strong><small>DNA ${escapeHtml(evidence.provenance?.dna_hash || "not frozen")}<br>Development ${escapeHtml(dev?.result_hash || "not completed")}<br>Validation ${escapeHtml(validation?.access_status || "not consumed")} · raw bars never exposed</small><div class="evidence-links">${artifactLink(dev?.artifact_id, "Development artifact")}${artifactLink(validation?.artifact_id, "Validation artifact")}</div></div>
    <div class="evidence-column"><span>GATE DECISIONS</span><strong>${escapeHtml(supervisor?.outcome || "SUPERVISOR PENDING")}</strong><small>${escapeHtml((supervisor?.reasons || []).join(", ") || "No supervisor reason recorded")}<br>${escapeHtml(validationDecision?.outcome || "Validation pending")}<br>${escapeHtml(laterDecision?.outcome || "Future-market evidence pending")}</small></div>
    <div class="evidence-column"><span>OPERATOR ACTIONS</span><strong>${evidence.release_label === "released_paper" ? "RELEASED PAPER" : escapeHtml(evidence.state.toUpperCase())}</strong><small>Commands are idempotent, auditable and never reinterpret infrastructure failure as strategy quality.</small><div class="evidence-links"><button class="dock-button" data-strategy-command="retry_operational" data-strategy-id="${escapeHtml(evidence.strategy_id)}">Retry fault</button><button class="dock-button warning" data-strategy-command="quarantine_strategy" data-strategy-id="${escapeHtml(evidence.strategy_id)}">Quarantine</button><button class="dock-button danger" data-strategy-command="retire_strategy" data-strategy-id="${escapeHtml(evidence.strategy_id)}">Retire</button></div></div>`;
  $$('[data-strategy-command]').forEach((button) => button.addEventListener("click", () => runOperatorCommand(button.dataset.strategyCommand, { strategy_id: button.dataset.strategyId, button })));
  $$('[data-artifact-id]').forEach((button) => button.addEventListener("click", () => downloadPrivateArtifact(button.dataset.artifactId, button)));
}

function labelParam(key) {
  return key.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

const dnaParameterBounds = {
  fast: [5, 14], slow: [17, 52], threshold: [.001, .018], lookback: [9, 38],
  entry_z: [.75, 1.75], exit_z: [0, 1], buffer: [.0005, .006], vol_ceiling: [.16, .42], position_size: [.2, 1],
};

function normalizeDNAParameter(key, value) {
  const bounds = dnaParameterBounds[key];
  if (!bounds) return .5;
  return Math.max(0, Math.min(1, (Number(value) - bounds[0]) / (bounds[1] - bounds[0])));
}

function formatDNAParameter(key, value) {
  if (["threshold", "buffer"].includes(key)) return Number(value).toFixed(4);
  if (Number.isInteger(Number(value))) return String(value);
  return number(value, 2);
}

function renderStrategyContext(strategy) {
  const strip = $("#strategy-context-strip");
  const monitor = strategy.monitor ?? {};
  const rework = strategy.rework ?? {};
  const activeMarketState = ["incubation", "release_blocked_short", "released", "healthy", "watch", "quarantined"].includes(strategy.state);
  const hasMarketHistory = activeMarketState
    || (monitor.returns?.length ?? 0) > 0
    || Number(monitor.adjustments ?? 0) > 0;
  const hasReworkContext = strategy.state === "rework" || Number(rework.attempt ?? 0) > 0;

  if (strategy.state === "incubation") {
    const evidence = strategy.incubation ?? {};
    const invalidDays = Object.values(evidence.sessions ?? {}).filter((day) => day.completed && !day.valid);
    const exclusions = [...new Set(invalidDays.flatMap((day) => day.exclusions ?? []))];
    const statusText = evidence.status === "incubation_blocked"
      ? "Counters paused while an operational or data fault is resolved."
      : "Shadow execution is running on genuinely future five-minute bars; no candidate orders reach Alpaca.";
    strip.className = `strategy-context-strip ${evidence.status === "incubation_blocked" ? "watch" : "rework"}`;
    strip.innerHTML = `<span class="context-marker" aria-hidden="true">I</span>
      <div class="context-copy"><span class="context-kicker">LIVE INCUBATION</span><strong>Future-market release evidence</strong><small>${escapeHtml(statusText)}${exclusions.length ? ` Excluded: ${escapeHtml(exclusions.join(", "))}.` : ""}</small></div>
      <div class="context-metrics"><div class="context-metric"><span>VALID DAYS</span><strong>${Number(evidence.valid_trading_days ?? 0)}/10</strong><small>20 DAY MAX</small></div><div class="context-metric"><span>ELIGIBLE TRADES</span><strong>${Number(evidence.eligible_trades ?? 0)}/67</strong><small>${Number(evidence.excluded_trades ?? 0)} EXCLUDED</small></div></div>`;
    strip.hidden = false;
    return;
  }

  if (strategy.state === "release_blocked_short") {
    strip.className = "strategy-context-strip watch";
    strip.innerHTML = `<span class="context-marker" aria-hidden="true">!</span>
      <div class="context-copy"><span class="context-kicker">RELEASE SAFETY</span><strong>Paper short execution is not enabled</strong><small>This strategy passed incubation but can open short positions. It remains blocked until the independent paper-short switch and execution mode are explicitly enabled.</small></div>`;
    strip.hidden = false;
    return;
  }

  if (strategy.operational_status === "operational_blocked") {
    const findings = strategy.health?.decision?.findings ?? ["monitoring evidence unavailable"];
    strip.className = "strategy-context-strip operational";
    strip.innerHTML = `<span class="context-marker" aria-hidden="true">||</span>
      <div class="context-copy"><span class="context-kicker">OPERATIONAL BLOCK</span><strong>New risk is paused; strategy quality is unchanged</strong><small>${escapeHtml(findings.map(labelParam).join(", "))}. A complete fault-free session is required before risk resumes.</small></div>
      <div class="context-metrics"><div class="context-metric"><span>QUALITY</span><strong>${escapeHtml(statusLabels[strategy.state] || strategy.state)}</strong><small>PRESERVED</small></div><div class="context-metric"><span>RISK OVERLAY</span><strong>0%</strong><small>FAULT PAUSE</small></div></div>`;
    strip.hidden = false;
    return;
  }

  if (strategy.state === "quarantined") {
    const findings = strategy.health?.decision?.findings ?? ["hard release-health breach"];
    const summary = strategy.health?.summary ?? {};
    strip.className = "strategy-context-strip quarantine";
    strip.innerHTML = `<span class="context-marker" aria-hidden="true">Q</span>
      <div class="context-copy"><span class="context-kicker">QUARANTINED</span><strong>No new risk; shadow observation continues</strong><small>${escapeHtml(findings.map(labelParam).join(", "))}. DNA remains frozen${strategy.health_challenger_id ? `; challenger ${escapeHtml(strategy.health_challenger_id)} must repeat every gate` : ""}.</small></div>
      <div class="context-metrics"><div class="context-metric failed"><span>ROLLING DD</span><strong>${pct(summary.drawdown)}</strong><small>HEALTH WINDOW</small></div><div class="context-metric"><span>TRADES</span><strong>${Number(summary.trades ?? 0)}</strong><small>OBSERVED</small></div><div class="context-metric"><span>RISK OVERLAY</span><strong>0%</strong><small>FLATTEN</small></div></div>`;
    strip.hidden = false;
    return;
  }

  if (strategy.state === "watch") {
    const summary = strategy.health?.summary ?? {};
    const reasons = strategy.health?.decision?.findings ?? ["persistent daily evidence is weak or uncertain"];
    const checks = [
      { label: "DAILY SHARPE", value: summary.daily_sharpe == null ? "PENDING" : number(summary.daily_sharpe), failed: reasons.some((item) => item.includes("sharpe")), limit: "DISTRIBUTION" },
      { label: "DRAWDOWN", value: summary.drawdown == null ? "PENDING" : pct(summary.drawdown), failed: reasons.some((item) => item.includes("drawdown")), limit: "ROLLING" },
      { label: "EXPECTANCY", value: summary.expectancy == null ? "PENDING" : signedPct(summary.expectancy), failed: reasons.some((item) => item.includes("expectancy")), limit: "TRADE WINDOW" },
      { label: "RISK OVERLAY", value: pct(strategy.risk_overlay?.effective_multiplier ?? .5, 0), failed: false, limit: "NO DNA CHANGE" },
    ];
    strip.className = "strategy-context-strip watch";
    strip.innerHTML = `<span class="context-marker" aria-hidden="true">!</span>
      <div class="context-copy"><span class="context-kicker">MARKET WATCH</span><strong>Why ${escapeHtml(strategy.name)} is being watched</strong><small>${escapeHtml(reasons.map(labelParam).join(", "))}. Recovery requires sustained healthy daily evidence; DNA is unchanged.</small></div>
      <div class="context-metrics">${checks.map((check) => `<div class="context-metric ${check.failed ? "failed" : "passed"}"><span>${check.label}</span><strong>${check.value}</strong><small>${check.limit}</small></div>`).join("")}</div>`;
    strip.hidden = false;
    return;
  }

  if (hasMarketHistory || !hasReworkContext) {
    strip.hidden = true;
    strip.innerHTML = "";
    return;
  }

  const attempt = Number(rework.attempt ?? 0);
  const maxAttempts = Number(rework.max_attempts ?? 3);
  const change = rework.change;
  const source = rework.source_stage ? `${labelParam(rework.source_stage)} evidence` : "Supervisor evidence";
  const changeMarkup = change
    ? `<div class="context-metric changed"><span>${escapeHtml(labelParam(change.parameter))}</span><strong>${escapeHtml(formatDNAParameter(change.parameter, change.from))} &rarr; ${escapeHtml(formatDNAParameter(change.parameter, change.to))}</strong><small>ONE DNA CHANGE</small></div>`
    : "";
  strip.className = "strategy-context-strip rework";
  strip.innerHTML = `<span class="context-marker" aria-hidden="true">R</span>
    <div class="context-copy"><span class="context-kicker">REWORK ${attempt ? `ATTEMPT ${attempt}/${maxAttempts}` : "QUEUED"}</span><strong>${escapeHtml(source)}</strong><small>${escapeHtml(rework.diagnosis || "The supervisor requested another focused research pass before market release.")}</small></div>
    <div class="context-metrics">${changeMarkup}</div>`;
  strip.hidden = false;
}

function bindDNAPlane(dimensions) {
  const viewport = $("#dna-plane-viewport");
  const svg = $("#dna-plane-svg");
  if (!viewport || !svg) return;
  const axes = Array.from({ length: 3 }, (_, index) => {
    const [key, value] = dimensions[index] || ["unused", 0];
    return { key, value, level: dimensions[index] ? normalizeDNAParameter(key, value) : 0, available: Boolean(dimensions[index]) };
  });
  let rotateX = -20, rotateY = -35, dragging = false, previousX = 0, previousY = 0;
  const project = ({ x, y, z }) => {
    const radiansY = rotateY * Math.PI / 180, radiansX = rotateX * Math.PI / 180;
    const rotatedX = x * Math.cos(radiansY) + z * Math.sin(radiansY);
    const rotatedZ = -x * Math.sin(radiansY) + z * Math.cos(radiansY);
    const rotatedY = y * Math.cos(radiansX) - rotatedZ * Math.sin(radiansX);
    return { x: 180 + rotatedX * 105, y: 170 - rotatedY * 105 };
  };
  const line = (from, to, className) => {
    const start = project(from), end = project(to);
    return `<line class="${className}" x1="${start.x.toFixed(1)}" y1="${start.y.toFixed(1)}" x2="${end.x.toFixed(1)}" y2="${end.y.toFixed(1)}"/>`;
  };
  const update = () => {
    const origin = { x: 0, y: 0, z: 0 };
    const axisEnds = [{ x: 1.12, y: 0, z: 0 }, { x: 0, y: 1.12, z: 0 }, { x: 0, y: 0, z: 1.12 }];
    const dataPoints = [{ x: axes[0].level, y: 0, z: 0 }, { x: 0, y: axes[1].level, z: 0 }, { x: 0, y: 0, z: axes[2].level }];
    const baseCorners = [origin, { x: 1, y: 0, z: 0 }, { x: 1, y: 0, z: 1 }, { x: 0, y: 0, z: 1 }].map(project);
    const basePlane = baseCorners.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
    let grid = "";
    for (let index = 1; index < 4; index += 1) {
      const level = index / 4;
      grid += line({ x: level, y: 0, z: 0 }, { x: level, y: 0, z: 1 }, "dna-plane-gridline");
      grid += line({ x: 0, y: 0, z: level }, { x: 1, y: 0, z: level }, "dna-plane-gridline");
    }
    const projectedData = dataPoints.map(project);
    const dataPlane = projectedData.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
    const axisLabels = axisEnds.map(project);
    const pointMarkup = projectedData.map((point, index) => axes[index].available
      ? `<circle class="dna-plane-point point-${index}" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="4"><title>${escapeHtml(labelParam(axes[index].key))}: ${escapeHtml(formatDNAParameter(axes[index].key, axes[index].value))}</title></circle>`
      : "").join("");
    const labelMarkup = axisLabels.map((point, index) => `<text class="dna-plane-axis-label label-${index}" x="${point.x.toFixed(1)}" y="${point.y.toFixed(1)}">${axes[index].available ? escapeHtml(labelParam(axes[index].key)) : "—"}</text>`).join("");
    svg.innerHTML = `<polygon class="dna-coordinate-base" points="${basePlane}"/>${grid}
      ${line(origin, axisEnds[0], "dna-plane-axis axis-0")}${line(origin, axisEnds[1], "dna-plane-axis axis-1")}${line(origin, axisEnds[2], "dna-plane-axis axis-2")}
      <polygon class="dna-parameter-plane" points="${dataPlane}"/>
      ${dataPoints.map((point, index) => axes[index].available ? line(origin, point, `dna-plane-guide guide-${index}`) : "").join("")}
      ${pointMarkup}${labelMarkup}<circle class="dna-plane-origin" cx="180" cy="170" r="3"/>`;
  };
  viewport.addEventListener("pointerdown", (event) => {
    dragging = true;
    previousX = event.clientX;
    previousY = event.clientY;
    viewport.classList.add("dragging");
    viewport.setPointerCapture(event.pointerId);
  });
  viewport.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    rotateY += (event.clientX - previousX) * .65;
    rotateX = Math.max(-72, Math.min(24, rotateX - (event.clientY - previousY) * .5));
    previousX = event.clientX;
    previousY = event.clientY;
    update();
  });
  const stop = (event) => {
    dragging = false;
    viewport.classList.remove("dragging");
    if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
  };
  viewport.addEventListener("pointerup", stop);
  viewport.addEventListener("pointercancel", stop);
  viewport.addEventListener("dblclick", () => { rotateX = -20; rotateY = -35; update(); });
  viewport.addEventListener("keydown", (event) => {
    const moves = { ArrowLeft: [0, -8], ArrowRight: [0, 8], ArrowUp: [8, 0], ArrowDown: [-8, 0] };
    if (!moves[event.key]) return;
    event.preventDefault();
    rotateX = Math.max(-72, Math.min(24, rotateX + moves[event.key][0]));
    rotateY += moves[event.key][1];
    update();
  });
  update();
}

function renderDNA(strategy) {
  const lineage = strategy.parent
    ? `<span>PARENT</span><strong>${escapeHtml(strategy.parent)}</strong><span class="arrow">→</span><strong>${escapeHtml(strategy.id)}</strong>`
    : `<span>ORIGIN</span><strong>FIRST-PRINCIPLE SEED</strong><span class="arrow">→</span><strong>${escapeHtml(strategy.id)}</strong>`;
  const positionSize = Math.max(0, Math.min(1, Number(strategy.params.position_size) || 0));
  const dimensions = Object.entries(strategy.params).filter(([key]) => key !== "position_size").slice(0, 3);
  const legend = dimensions.map(([key, value], index) => `<div><i class="axis-color-${index}"></i><span>${escapeHtml(labelParam(key))}</span><strong>${escapeHtml(formatDNAParameter(key, value))}</strong></div>`).join("");
  const dna = strategy.strategy_format === "dsl-v1" ? strategy.strategy_dna : null;
  const identity = dna ? `<section class="dsl-identity" aria-label="Typed strategy definition">
      <div><span>TYPED DSL</span><strong>${escapeHtml(dna.strategy_id)}</strong></div>
      <p>${escapeHtml(strategy.explanation?.summary || "A frozen, typed rule graph evaluated only from data available at each decision bar.")}</p>
      <div class="dsl-badges">
        <span>${dna.features.length} NODES</span><span>${dna.warmup_bars} BAR WARMUP</span><span>${pct(dna.target.max_strategy_gross, 1)} MAX GROSS</span><span>${dna.scope.symbols.length} SYMBOLS</span>
      </div>
    </section>` : "";
  $("#dna-content").innerHTML = `<div class="dna-lineage compact">${lineage}</div>
    ${identity}
    <section class="dna-position-chart" aria-label="Position size ${pct(positionSize, 0)}">
      <div><span>POSITION SIZE</span><strong>${pct(positionSize, 0)}</strong></div>
      <div class="dna-position-track"><i style="width:${(positionSize * 100).toFixed(1)}%"></i><span></span><span></span><span></span></div>
      <small><span>0%</span><span>RISK ALLOCATION</span><span>100%</span></small>
    </section>
    <section class="dna-parameter-chart">
      <div class="dna-chart-head"><span>3D PARAMETER PLANE</span><small>DRAG TO ROTATE · DOUBLE-CLICK TO RESET</small></div>
      <div class="dna-plane-viewport" id="dna-plane-viewport" tabindex="0" role="img" aria-label="Rotatable three-dimensional strategy parameter plane">
        <svg id="dna-plane-svg" viewBox="0 0 360 230" aria-hidden="true"></svg>
      </div>
      <div class="dna-axis-legend">${legend}</div>
    </section>`;
  bindDNAPlane(dimensions);
}

function renderRegimes(strategy) {
  const scores = strategy.metrics?.regime_scores;
  if (!scores) {
    $("#regime-content").innerHTML = `<div class="empty-state">Run the supervisor to expose regime fitness.</div>`;
    return;
  }
  const entries = Object.entries(scores).map(([name, score]) => [name, Number(score)]).filter(([, score]) => Number.isFinite(score));
  if (entries.length !== 4) {
    $("#regime-content").innerHTML = `<div class="empty-state">The 3D generalization map requires exactly four regime dimensions.</div>`;
    return;
  }
  const center = { x: 210, y: 158 };
  const vertices = [
    { x: 210, y: 36 },
    { x: 55, y: 184 },
    { x: 365, y: 184 },
    { x: 210, y: 270 },
  ];
  const labels = [
    { x: 210, y: 14, anchor: "middle" },
    { x: 40, y: 181, anchor: "end" },
    { x: 380, y: 181, anchor: "start" },
    { x: 210, y: 292, anchor: "middle" },
  ];
  const project = (vertex, level) => ({
    x: center.x + (vertex.x - center.x) * level,
    y: center.y + (vertex.y - center.y) * level,
  });
  const scorePoints = entries.map(([, score], index) => project(vertices[index], (Math.max(-1, Math.min(1, score)) + 1) / 2));
  const neutralPoints = vertices.map((vertex) => project(vertex, .5));
  const edgePairs = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];
  const faces = [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]];
  const lineSet = (points, className) => edgePairs.map(([from, to]) => `<line class="${className}" x1="${points[from].x}" y1="${points[from].y}" x2="${points[to].x}" y2="${points[to].y}"/>`).join("");
  const axes = vertices.map((vertex) => `<line class="tetra-axis" x1="${center.x}" y1="${center.y}" x2="${vertex.x}" y2="${vertex.y}"/>`).join("");
  const scoreFaces = faces.map((face, index) => {
    const average = face.reduce((sum, vertexIndex) => sum + entries[vertexIndex][1], 0) / face.length;
    const points = face.map((vertexIndex) => `${scorePoints[vertexIndex].x.toFixed(1)},${scorePoints[vertexIndex].y.toFixed(1)}`).join(" ");
    return `<polygon class="tetra-face face-${index} ${average < 0 ? "negative" : ""}" points="${points}"/>`;
  }).join("");
  const scoreEdges = lineSet(scorePoints, "tetra-score-edge");
  const dots = scorePoints.map((point, index) => {
    const [name, score] = entries[index];
    return `<g class="tetra-node ${score < 0 ? "negative" : ""}"><circle class="tetra-node-halo" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="8"/><circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="4"><title>${escapeHtml(name)}: ${score >= 0 ? "+" : ""}${number(score, 2)}</title></circle></g>`;
  }).join("");
  const vertexLabels = entries.map(([name, score], index) => `<text class="tetra-label" x="${labels[index].x}" y="${labels[index].y}" text-anchor="${labels[index].anchor}"><tspan>${escapeHtml(name)}</tspan><tspan class="tetra-value ${score < 0 ? "negative" : ""}" x="${labels[index].x}" dy="12">${score >= 0 ? "+" : ""}${number(score, 2)}</tspan></text>`).join("");
  const values = entries.map(([, score]) => score);
  const mean = values.reduce((sum, score) => sum + score, 0) / values.length;
  const weakest = entries.reduce((lowest, entry) => entry[1] < lowest[1] ? entry : lowest, entries[0]);
  const positive = values.filter((score) => score > 0).length;
  $("#regime-content").innerHTML = `<div class="regime-tetra-shell">
    <div class="tetra-caption"><span>4D REGIME TETRAHEDRON</span><small>CENTER −1 · MID 0 · EDGE +1</small></div>
    <svg class="regime-tetra" viewBox="0 0 420 314" role="img" aria-label="Three-dimensional tetrahedral generalization chart">
      <title>Four-dimensional strategy generalization projected as a three-dimensional tetrahedron.</title>
      <g class="tetra-frame">${axes}${lineSet(vertices, "tetra-outer-edge")}${lineSet(neutralPoints, "tetra-neutral-edge")}<circle class="tetra-center" cx="${center.x}" cy="${center.y}" r="2"/></g>
      <g class="tetra-score-shape">${scoreFaces}${scoreEdges}${dots}</g>
      ${vertexLabels}
    </svg>
    <div class="tetra-summary">
      <div><span>POSITIVE VERTICES</span><strong>${positive}/4</strong></div>
      <div><span>MEAN EDGE</span><strong class="${mean < 0 ? "negative" : ""}">${mean >= 0 ? "+" : ""}${number(mean, 2)}</strong></div>
      <div><span>WEAKEST</span><strong class="${weakest[1] < 0 ? "negative" : ""}">${escapeHtml(weakest[0])} ${weakest[1] >= 0 ? "+" : ""}${number(weakest[1], 2)}</strong></div>
    </div>
  </div>`;
}

function renderAudit() {
  const fallback = (state?.events ?? []).map((event, index) => ({ id: event.id ?? `legacy-${index}`, at: event.at, time: event.time,
    category: String(event.kind ?? "system").toLowerCase(), severity: "info", title: event.title, detail: event.detail }));
  const events = operatorLogsState.items.length || operatorLogsState.category ? operatorLogsState.items : fallback;
  $("#log-count").textContent = operatorLogsState.total ? `${events.length}/${operatorLogsState.total}` : String(events.length);
  $("#load-more-logs").hidden = !operatorLogsState.next_cursor;
  $("#audit-feed").innerHTML = events.length
    ? events.map((event) => `<article class="audit-item"><span class="audit-time">${escapeHtml(event.at ? localTime(event.at) : event.time || "—")}</span><div class="audit-copy"><strong><i class="event-dot ${escapeHtml(String(event.category).toUpperCase())}"></i>${escapeHtml(event.title)}</strong><p>${escapeHtml(event.detail)}${event.correlation_id ? `<br>CORRELATION ${escapeHtml(event.correlation_id)}` : ""}${event.strategy_id ? ` · STRATEGY ${escapeHtml(event.strategy_id)}` : ""}</p></div></article>`).join("")
    : '<div class="empty-state">No supervisor decisions yet.</div>';
}

function renderStrategyFilters() {
  const container = $("#strategy-filters");
  const config = filterConfigs[activeView];
  if (!config) {
    container.hidden = true;
    container.innerHTML = "";
    return;
  }
  const strategies = strategiesForView();
  const current = activeFilters[activeView] || "all";
  container.hidden = false;
  container.innerHTML = config.map((filter) => {
    const count = filter.states ? strategies.filter((strategy) => filter.states.includes(strategy.state)).length : strategies.length;
    const active = filter.id === current;
    return `<button type="button" class="strategy-filter ${active ? "active" : ""}" data-filter="${escapeHtml(filter.id)}" aria-pressed="${active}"><span>${escapeHtml(filter.label)}</span><small>${count}</small></button>`;
  }).join("");
  $$("#strategy-filters .strategy-filter").forEach((button) => button.addEventListener("click", () => {
    activeFilters[activeView] = button.dataset.filter;
    deskOverview = true;
    curveLegendVisible = false;
    selectedId = null;
    render();
  }));
}

function renderTable() {
  const strategies = filteredStrategies();
  const titles = { overview: "All research units", testing: "Generation & rework queue", released: "Alpaca paper market book" };
  $("#roster-title").textContent = titles[activeView] || titles.overview;
  renderStrategyFilters();
  const scored = strategies.map((strategy) => strategy.metrics?.score).filter(Number.isFinite);
  $("#average-score").textContent = scored.length ? number(scored.reduce((sum, score) => sum + score, 0) / scored.length, 1) : "—";
  $("#empty-state").hidden = strategies.length > 0;
  $("#empty-state").textContent = strategiesForView().length ? "No strategies match this filter." : "No strategies match this desk.";
  $("#strategy-table").innerHTML = strategies.map((strategy) => {
    const m = strategy.metrics;
    const displayedState = strategy.operational_status === "operational_blocked"
      ? "operational_blocked" : strategy.state;
    const incubationProgress = strategy.incubation
      ? `${Number(strategy.incubation.valid_trading_days ?? 0)}/10 days · ${Number(strategy.incubation.eligible_trades ?? 0)}/67 trades`
      : null;
    return `<tr data-id="${escapeHtml(strategy.id)}" class="${strategy.id === selectedId ? "selected" : ""}">
      <td class="unit-cell"><strong>${escapeHtml(strategy.name)}</strong><span>${escapeHtml(strategy.id)}${strategy.parent ? ` · CHILD OF ${escapeHtml(strategy.parent)}` : ""}${strategy.rework?.attempt ? ` · TRY ${strategy.rework.attempt}/${strategy.rework.max_attempts || 3}` : ""}</span></td>
      <td class="archetype-cell"><strong>${escapeHtml(strategy.archetype)}</strong><span>${escapeHtml(strategy.asset)}</span></td>
      <td><span class="status-badge ${displayedState}">${escapeHtml(statusLabels[displayedState] || displayedState)}</span></td>
      <td>${incubationProgress ?? (strategy.backtests ? `${Math.min(strategy.backtests, 3)} dev${strategy.validation ? " · 1 unseen" : ""}` : "not tested")}</td><td>${m ? number(m.sharpe) : "—"}</td><td>${m ? pct(m.drawdown) : "—"}</td>
      <td class="score-cell">${m ? number(m.score, 1) : "—"}${m ? `<div class="score-bar"><i style="width:${Math.min(m.score, 100)}%"></i></div>` : ""}</td><td class="row-arrow">›</td></tr>`;
  }).join("");
  $$("#strategy-table tr").forEach((row) => row.addEventListener("click", () => {
    if (multiStrategyViews.has(activeView)) focusStrategy(row.dataset.id);
    else {
      selectedId = row.dataset.id;
      renderSelected(); renderTable();
    }
  }));
}

function render() {
  ensureSelection();
  renderView();
  renderSummary();
  renderDeskObserver();
  renderPortfolio();
  renderOperations();
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

const operationConfigs = {
  generate: {
    button: "#generate-button",
    code: "PROCESS / GENESIS",
    kicker: "STRATEGY SYNTHESIS",
    title: "Generating strategy DNA",
    glyph: "DNA",
    description: (detail) => `Mapping ${detail} across the permitted parameter space.`,
    steps: ["Seed first-principle archetypes", "Mutate parameter genomes", "Check structural constraints", "Register research cohort"],
    duration: 2400,
  },
  review: {
    button: "#review-button",
    code: "PROCESS / SUPERVISOR",
    kicker: "SELF-SUPERVISION CYCLE",
    title: "Reviewing strategy evidence",
    glyph: "SCAN",
    description: (detail) => `Auditing ${detail} against development regimes and release policy.`,
    steps: ["Replay regime backtests", "Measure robustness and drawdown", "Compare supervisor gates", "Issue promote, rework, or drop decisions"],
    duration: 2700,
  },
  validate: {
    button: "#validate-button",
    code: "PROCESS / HOLDOUT",
    kicker: "UNSEEN DATA VALIDATION",
    title: "Opening sealed holdout data",
    glyph: "LOCK",
    description: (detail) => `Validating ${detail} without exposing the final quarter to generation or supervision.`,
    steps: ["Freeze learned parameters", "Unlock untouched final 25%", "Replay out-of-sample signals", "Apply final release gates"],
    duration: 2800,
  },
};

const operationCurvePalette = [
  "#a8f05a", "#70a7ee", "#a28bdd", "#e9b655", "#ee736a", "#70d7c7",
  "#d99fe8", "#c7d36f", "#f09a5a", "#73c8ee", "#c18bdd", "#8ee1a8",
];

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
let operationBusy = false;

function resetOperationCurveChart(kind, candidateCount) {
  const chart = $("#operation-equity-chart");
  const caption = $("#operation-curve-caption");
  chart.removeAttribute("hidden");
  caption.hidden = false;
  chart.classList.remove("dragging");
  chart.onpointerdown = null;
  chart.onpointermove = null;
  chart.onpointerup = null;
  chart.onpointercancel = null;
  chart.ondblclick = null;
  if (kind === "generate") {
    chart.dataset.visual = "dna";
    chart.innerHTML = `<path class="operation-dna-await-grid" d="M58 145 L190 106 L303 148 L171 187 Z M58 145 L58 45 M58 145 L190 106 M58 145 L171 187 M58 120 L190 81 M58 95 L190 56 M58 70 L190 31"/>
      <text class="operation-curve-wait" x="181" y="211" text-anchor="middle">ASSEMBLING ACTUAL DNA LANDSCAPE</text>`;
    caption.textContent = "WAITING FOR GENERATED DNA";
    return;
  }
  chart.dataset.visual = "equity";
  const grid = Array.from({ length: 5 }, (_, index) => {
    const y = 18 + index * 44;
    return `<line class="operation-curve-grid" x1="12" y1="${y}" x2="350" y2="${y}"/>`;
  }).join("");
  chart.innerHTML = `${grid}<line class="operation-curve-baseline" x1="12" y1="106" x2="350" y2="106"/>
    <text class="operation-curve-wait" x="181" y="111" text-anchor="middle">AWAITING BACKTEST OUTPUT</text>`;
  caption.textContent = `0 / ${candidateCount} ACTUAL CURVES`;
}

function idempotencyKey(kind) {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `ui:${kind}:${suffix}`;
}

async function runOperatorCommand(kind, { strategy_id = null, payload = {}, button = null, token = adminToken, skipConfirm = false } = {}) {
  const confirmations = {
    cancel_open_orders: "Cancel all open orders managed by Axiom? Manual orders are excluded.",
    flatten_all: "Flatten every Axiom-managed paper position?",
    kill_switch: "Activate the kill switch, cancel managed orders, and flatten managed paper positions?",
    quarantine_strategy: "Quarantine this strategy and block new risk?",
    retire_strategy: "Retire this strategy? This lifecycle action is not an infrastructure retry.",
  };
  if (!skipConfirm && confirmations[kind] && !window.confirm(confirmations[kind])) return null;
  const key = idempotencyKey(kind), receipt = $("#command-receipt");
  if (button) { button.disabled = true; button.setAttribute("aria-busy", "true"); }
  receipt.textContent = `${kind} · submitting`;
  try {
    let result = await operatorRequest("/api/v1/admin/commands", { body: { kind, strategy_id, payload,
      idempotency_key: key, correlation_id: key }, token });
    receipt.textContent = `${result.command_id} · ${result.status}`;
    showToast(`Command ${result.command_id}: ${result.status}.`);
    for (let attempt = 0; result.terminal === false && attempt < 12; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      result = await operatorRequest(`/api/v1/commands/${encodeURIComponent(result.command_id)}`, { token });
      receipt.textContent = `${result.command_id} · ${result.status}`;
    }
    if (result.terminal === false) showToast(`${result.command_id} is still queued; its receipt remains available.`, true);
    await Promise.allSettled([api("/api/state", null, false), loadOperations(), loadOperatorLogs()]);
    return result;
  } catch (error) {
    receipt.textContent = `${kind} · failed`;
    showToast(error.message, true);
    throw error;
  } finally {
    if (button) { button.disabled = false; button.removeAttribute("aria-busy"); }
  }
}

function landscapeParameterKeys(strategy) {
  const keys = Object.keys(strategy.params ?? {}).filter((key) => key !== "position_size").slice(0, 3);
  if (keys.length < 3 && "position_size" in (strategy.params ?? {})) keys.push("position_size");
  return keys.slice(0, 3);
}

function formatLandscapeParameter(key, value) {
  return key === "position_size" ? pct(Number(value), 0) : formatDNAParameter(key, value);
}

function landscapeSurfaceColor(level) {
  const hue = 225 - Math.max(0, Math.min(1, level)) * 190;
  return `hsl(${hue.toFixed(0)} 84% 57%)`;
}

function renderDNALandscapeFrame(session, result, strategy, index, total, animate = true) {
  const chart = $("#operation-equity-chart");
  const caption = $("#operation-curve-caption");
  const keys = landscapeParameterKeys(strategy);
  if (keys.length < 3) {
    chart.innerHTML = '<text class="operation-curve-wait" x="181" y="111" text-anchor="middle">THREE DNA VARIABLES REQUIRED</text>';
    return;
  }
  const comparablePool = (result.strategies ?? []).filter((item) =>
    item.archetype === strategy.archetype
    && keys.every((key) => Number.isFinite(Number(item.params?.[key])))
  );
  const comparable = [strategy, ...comparablePool.filter((item) => item.id !== strategy.id)].slice(0, 48);
  const controls = comparable.map((item) => ({
    strategy: item,
    x: normalizeDNAParameter(keys[0], item.params[keys[0]]),
    y: normalizeDNAParameter(keys[1], item.params[keys[1]]),
    z: normalizeDNAParameter(keys[2], item.params[keys[2]]),
  }));
  const target = {
    x: normalizeDNAParameter(keys[0], strategy.params[keys[0]]),
    y: normalizeDNAParameter(keys[1], strategy.params[keys[1]]),
    z: normalizeDNAParameter(keys[2], strategy.params[keys[2]]),
  };
  const surfaceAt = (x, y) => {
    const exact = controls.find((point) => (point.x - x) ** 2 + (point.y - y) ** 2 < .000001);
    if (exact) return exact.z;
    let weighted = 0, weights = 0;
    controls.forEach((point) => {
      const distance = (point.x - x) ** 2 + (point.y - y) ** 2;
      const weight = 1 / (distance + .012) ** 1.35;
      weighted += point.z * weight;
      weights += weight;
    });
    return weights ? weighted / weights : target.z;
  };
  const azimuth = (session.dnaAzimuth ?? -40) * Math.PI / 180;
  const project = ({ x, y, z }) => {
    const dx = x - .5, dy = y - .5;
    const horizontal = dx * Math.cos(azimuth) - dy * Math.sin(azimuth);
    const depth = dx * Math.sin(azimuth) + dy * Math.cos(azimuth);
    return { x: 180 + horizontal * 170, y: 141 + depth * 56 - z * 104, depth };
  };
  const points = (values) => values.map((value) => {
    const point = project(value);
    return `${point.x.toFixed(1)},${point.y.toFixed(1)}`;
  }).join(" ");
  const resolution = 10;
  const cells = [];
  for (let row = 0; row < resolution; row += 1) {
    for (let column = 0; column < resolution; column += 1) {
      const x0 = column / resolution, x1 = (column + 1) / resolution;
      const y0 = row / resolution, y1 = (row + 1) / resolution;
      const world = [
        { x: x0, y: y0, z: surfaceAt(x0, y0) }, { x: x1, y: y0, z: surfaceAt(x1, y0) },
        { x: x1, y: y1, z: surfaceAt(x1, y1) }, { x: x0, y: y1, z: surfaceAt(x0, y1) },
      ];
      const level = world.reduce((sum, point) => sum + point.z, 0) / world.length;
      const depth = world.reduce((sum, point) => sum + project(point).depth, 0) / world.length;
      const delay = Math.round((row + column) * 9);
      cells.push({ world, level, depth, delay, x0, x1, y0, y1 });
    }
  }
  const floor = cells.map((cell) => `<polygon class="operation-dna-floor-cell" fill="${landscapeSurfaceColor(cell.level)}" points="${points([
    { x: cell.x0, y: cell.y0, z: 0 }, { x: cell.x1, y: cell.y0, z: 0 },
    { x: cell.x1, y: cell.y1, z: 0 }, { x: cell.x0, y: cell.y1, z: 0 },
  ])}"/>`).join("");
  const surface = cells.sort((left, right) => left.depth - right.depth).map((cell) => `<polygon class="operation-dna-surface-cell${animate ? "" : " instant"}" style="animation-delay:${cell.delay}ms" fill="${landscapeSurfaceColor(cell.level)}" points="${points(cell.world)}"/>`).join("");
  const baseGrid = Array.from({ length: 6 }, (_, gridIndex) => {
    const level = gridIndex / 5;
    const xLine = [project({ x: level, y: 0, z: 0 }), project({ x: level, y: 1, z: 0 })];
    const yLine = [project({ x: 0, y: level, z: 0 }), project({ x: 1, y: level, z: 0 })];
    return `<line class="operation-dna-grid" x1="${xLine[0].x.toFixed(1)}" y1="${xLine[0].y.toFixed(1)}" x2="${xLine[1].x.toFixed(1)}" y2="${xLine[1].y.toFixed(1)}"/><line class="operation-dna-grid" x1="${yLine[0].x.toFixed(1)}" y1="${yLine[0].y.toFixed(1)}" x2="${yLine[1].x.toFixed(1)}" y2="${yLine[1].y.toFixed(1)}"/>`;
  }).join("");
  const origin = project({ x: 0, y: 0, z: 0 });
  const xEnd = project({ x: 1.12, y: 0, z: 0 });
  const yEnd = project({ x: 0, y: 1.12, z: 0 });
  const zEnd = project({ x: 0, y: 0, z: 1.08 });
  const axis = (end, axisIndex) => `<line class="operation-dna-axis axis-${axisIndex}" x1="${origin.x.toFixed(1)}" y1="${origin.y.toFixed(1)}" x2="${end.x.toFixed(1)}" y2="${end.y.toFixed(1)}"/>`;
  const walls = `<polygon class="operation-dna-wall" points="${points([{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 1, y: 0, z: 1 }, { x: 0, y: 0, z: 1 }])}"/><polygon class="operation-dna-wall" points="${points([{ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: 1 }, { x: 0, y: 0, z: 1 }])}"/>`;
  const controlDots = controls.slice(0, 24).map((control) => {
    const point = project(control);
    return `<circle class="operation-dna-control" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="1.8"><title>${escapeHtml(control.strategy.name)}</title></circle>`;
  }).join("");
  const marker = project(target);
  const markerFloor = project({ ...target, z: 0 });
  const instant = animate ? "" : " instant";
  chart.innerHTML = `${walls}${floor}${baseGrid}${surface}${controlDots}
    ${axis(xEnd, 0)}${axis(yEnd, 1)}${axis(zEnd, 2)}
    <line class="operation-dna-marker-stem${instant}" x1="${markerFloor.x.toFixed(1)}" y1="${markerFloor.y.toFixed(1)}" x2="${marker.x.toFixed(1)}" y2="${marker.y.toFixed(1)}"/>
    <circle class="operation-dna-marker-halo${instant}" cx="${marker.x.toFixed(1)}" cy="${marker.y.toFixed(1)}" r="9"/><circle class="operation-dna-marker${instant}" cx="${marker.x.toFixed(1)}" cy="${marker.y.toFixed(1)}" r="4"><title>${escapeHtml(strategy.name)}</title></circle>
    <text class="operation-dna-axis-label axis-0" x="${(xEnd.x + 4).toFixed(1)}" y="${(xEnd.y + 5).toFixed(1)}">${escapeHtml(labelParam(keys[0]).toUpperCase())}</text>
    <text class="operation-dna-axis-label axis-1" x="${(yEnd.x + 4).toFixed(1)}" y="${(yEnd.y + 5).toFixed(1)}">${escapeHtml(labelParam(keys[1]).toUpperCase())}</text>
    <text class="operation-dna-axis-label axis-2" x="${(zEnd.x + 4).toFixed(1)}" y="${(zEnd.y - 3).toFixed(1)}">${escapeHtml(labelParam(keys[2]).toUpperCase())}</text>`;
  caption.textContent = `${index + 1} / ${total} · ${strategy.name} · ${strategy.archetype}`;
  $("#operation-description").textContent = `${strategy.asset} · ${keys.map((key) => `${labelParam(key)} ${formatLandscapeParameter(key, strategy.params[key])}`).join(" · ")}`;
}

function renderOperationDNA(session, result) {
  if (session.kind !== "generate") return 0;
  const previousIds = new Set(session.strategyIds);
  const generated = (result.strategies ?? []).filter((strategy) => !previousIds.has(strategy.id)).slice(0, 12);
  const chart = $("#operation-equity-chart");
  if (!generated.length) {
    chart.innerHTML = '<text class="operation-curve-wait" x="181" y="111" text-anchor="middle">NO NEW DNA PRODUCED</text>';
    $("#operation-curve-caption").textContent = "0 ACTUAL STRATEGIES";
    return 0;
  }
  session.dnaAzimuth = -40;
  session.dnaIndex = 0;
  const show = (index, animate = true) => {
    session.dnaIndex = index;
    renderDNALandscapeFrame(session, result, generated[index], index, generated.length, animate);
  };
  show(0);
  if (generated.length > 1) {
    session.dnaTimer = setInterval(() => {
      if (session.dnaIndex >= generated.length - 1) {
        clearInterval(session.dnaTimer);
        session.dnaTimer = null;
        return;
      }
      show(session.dnaIndex + 1);
    }, 520);
  }
  let dragging = false, previousX = 0;
  chart.onpointerdown = (event) => {
    dragging = true;
    previousX = event.clientX;
    chart.classList.add("dragging");
    chart.setPointerCapture(event.pointerId);
  };
  chart.onpointermove = (event) => {
    if (!dragging) return;
    session.dnaAzimuth += (event.clientX - previousX) * .55;
    previousX = event.clientX;
    show(session.dnaIndex, false);
  };
  const stop = (event) => {
    dragging = false;
    chart.classList.remove("dragging");
    if (chart.hasPointerCapture(event.pointerId)) chart.releasePointerCapture(event.pointerId);
  };
  chart.onpointerup = stop;
  chart.onpointercancel = stop;
  chart.ondblclick = () => { session.dnaAzimuth = -40; show(session.dnaIndex, false); };
  return generated.length;
}

function renderOperationCurves(session, result) {
  if (!["review", "validate"].includes(session.kind)) return 0;
  const chart = $("#operation-equity-chart");
  const caption = $("#operation-curve-caption");
  const candidateIds = new Set(session.strategyIds);
  const curveFor = (strategy) => session.kind === "validate" ? strategy.validation?.curve : strategy.metrics?.curve;
  const related = (result.strategies ?? []).filter((strategy) =>
    (candidateIds.has(strategy.id) || (session.kind === "review" && candidateIds.has(strategy.parent)))
    && (curveFor(strategy)?.length ?? 0) >= 2
  );
  const visible = related.slice(0, 12).map((strategy, index) => ({
    strategy,
    color: operationCurvePalette[index],
    values: curveFor(strategy).map(Number).filter(Number.isFinite),
  })).filter((item) => item.values.length >= 2);

  const grid = Array.from({ length: 5 }, (_, index) => {
    const y = 18 + index * 44;
    return `<line class="operation-curve-grid" x1="12" y1="${y}" x2="350" y2="${y}"/>`;
  }).join("");
  if (!visible.length) {
    chart.innerHTML = `${grid}<text class="operation-curve-wait" x="181" y="111" text-anchor="middle">NO EQUITY CURVES PRODUCED</text>`;
    caption.textContent = `0 / ${related.length} ACTUAL CURVES`;
    return 0;
  }

  const allValues = visible.flatMap((item) => item.values);
  const rawMinimum = Math.min(...allValues);
  const rawMaximum = Math.max(...allValues);
  const padding = Math.max((rawMaximum - rawMinimum) * .10, .012);
  const minimum = rawMinimum - padding;
  const maximum = rawMaximum + padding;
  const left = 12, right = 350, top = 18, bottom = 194;
  const x = (index, length) => left + index / Math.max(length - 1, 1) * (right - left);
  const y = (value) => top + (maximum - value) / Math.max(maximum - minimum, .001) * (bottom - top);
  const paths = visible.map(({ strategy, color, values }, index) => {
    const path = values.map((value, pointIndex) => `${pointIndex ? "L" : "M"}${x(pointIndex, values.length).toFixed(1)},${y(value).toFixed(1)}`).join(" ");
    const endX = x(values.length - 1, values.length).toFixed(1);
    const endY = y(values.at(-1)).toFixed(1);
    return `<path class="operation-equity-path" data-curve-index="${index}" stroke="${color}" d="${path}"><title>${escapeHtml(strategy.name)} · ${escapeHtml(strategy.asset)}</title></path>
      <circle class="operation-equity-end" data-curve-index="${index}" fill="${color}" cx="${endX}" cy="${endY}" r="2.8"/>`;
  }).join("");
  const baselineY = y(1);
  chart.innerHTML = `${grid}${baselineY >= top && baselineY <= bottom ? `<line class="operation-curve-baseline" x1="${left}" y1="${baselineY.toFixed(1)}" x2="${right}" y2="${baselineY.toFixed(1)}"/>` : ""}${paths}
    <text class="operation-curve-axis" x="12" y="211">START</text><text class="operation-curve-axis" x="350" y="211" text-anchor="end">LATEST</text>`;
  caption.textContent = related.length > 12
    ? `12 / ${related.length} ACTUAL CURVES SHOWN`
    : `${visible.length} ACTUAL CURVE${visible.length === 1 ? "" : "S"}`;

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  $$("#operation-equity-chart .operation-equity-path").forEach((path, index) => {
    if (reducedMotion) return;
    const length = path.getTotalLength();
    path.style.strokeDasharray = String(length);
    path.style.strokeDashoffset = String(length);
    path.style.animationDelay = `${index * 65}ms`;
    path.addEventListener("animationend", () => {
      path.classList.remove("drawing");
      path.style.strokeDasharray = "none";
      path.style.strokeDashoffset = "0";
      chart.querySelector(`.operation-equity-end[data-curve-index="${index}"]`)?.classList.add("drawing");
    }, { once: true });
  });
  if (!reducedMotion) requestAnimationFrame(() => {
    $$("#operation-equity-chart .operation-equity-path").forEach((path) => path.classList.add("drawing"));
  });
  return visible.length;
}

function setOperationStep(session, index) {
  const steps = $$("#operation-steps .operation-step");
  const bounded = Math.min(index, steps.length - 1);
  steps.forEach((step, stepIndex) => {
    step.classList.toggle("done", stepIndex < bounded);
    step.classList.toggle("active", stepIndex === bounded);
    step.querySelector("small").textContent = stepIndex < bounded ? "DONE" : stepIndex === bounded ? "RUN" : "WAIT";
  });
  const denominator = Math.max(steps.length - 1, 1);
  const progress = Math.round(12 + bounded / denominator * 70);
  $("#operation-current-step").textContent = session.config.steps[bounded].toUpperCase();
  $("#operation-progress").style.width = `${progress}%`;
  $("#operation-progress-label").textContent = `${progress}%`;
  session.step = bounded;
}

function beginOperation(kind, detail, strategyIds = []) {
  const config = operationConfigs[kind];
  const overlay = $("#operation-overlay");
  const terminal = $("#operation-terminal");
  const button = $(config.button);
  overlay.dataset.phase = kind;
  terminal.className = "operation-terminal";
  $("#operation-code").textContent = config.code;
  $("#operation-state").textContent = "RUNNING";
  $("#operation-kicker").textContent = config.kicker;
  $("#operation-title").textContent = config.title;
  $("#operation-glyph").textContent = config.glyph;
  $("#operation-description").textContent = config.description(detail);
  resetOperationCurveChart(kind, strategyIds.length);
  $("#operation-steps").innerHTML = config.steps.map((step) => `<div class="operation-step"><i></i><span>${escapeHtml(step)}</span><small>WAIT</small></div>`).join("");
  $("#operation-progress").style.width = "4%";
  $("#operation-progress-label").textContent = "4%";
  button.setAttribute("aria-busy", "true");
  document.body.classList.add(`operation-${kind}`);
  overlay.hidden = false;
  requestAnimationFrame(() => overlay.classList.add("visible"));
  overlay.focus({ preventScroll: true });
  const session = { kind, config, overlay, terminal, button, strategyIds: [...strategyIds], step: 0, timer: null };
  setOperationStep(session, 0);
  const interval = Math.max(480, Math.round(config.duration / (config.steps.length + 1)));
  session.timer = setInterval(() => {
    if (session.step < config.steps.length - 1) setOperationStep(session, session.step + 1);
  }, interval);
  return session;
}

async function finishOperation(session, succeeded) {
  clearInterval(session.timer);
  if (session.dnaTimer) clearInterval(session.dnaTimer);
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (succeeded) {
    $$("#operation-steps .operation-step").forEach((step) => {
      step.classList.remove("active");
      step.classList.add("done");
      step.querySelector("small").textContent = "DONE";
    });
    session.terminal.classList.add("complete");
    $("#operation-state").textContent = "COMPLETE";
    $("#operation-current-step").textContent = "PROCESS COMPLETE";
    $("#operation-progress").style.width = "100%";
    $("#operation-progress-label").textContent = "100%";
    await wait(reducedMotion ? 80 : 520);
  } else {
    session.terminal.classList.add("failed");
    $("#operation-state").textContent = "HALTED";
    $("#operation-current-step").textContent = "PROCESS HALTED";
    $("#operation-progress").style.width = "100%";
    $("#operation-progress-label").textContent = "ERROR";
    $("#operation-description").textContent = "The operation stopped safely. Review the error message and try again.";
    await wait(reducedMotion ? 120 : 850);
  }
  session.overlay.classList.remove("visible");
  await wait(reducedMotion ? 10 : 230);
  session.overlay.hidden = true;
  const operationChart = $("#operation-equity-chart");
  operationChart.onpointerdown = null;
  operationChart.onpointermove = null;
  operationChart.onpointerup = null;
  operationChart.onpointercancel = null;
  operationChart.ondblclick = null;
  document.body.classList.remove(`operation-${session.kind}`);
  session.button.removeAttribute("aria-busy");
  session.button.focus({ preventScroll: true });
}

function triggerOperationReveal(kind) {
  const revealClasses = ["reveal-generate", "reveal-review", "reveal-validate"];
  document.body.classList.remove(...revealClasses);
  void document.body.offsetWidth;
  document.body.classList.add(`reveal-${kind}`);
  setTimeout(() => document.body.classList.remove(`reveal-${kind}`), 1300);
}

async function animatedAction(kind, path, payload, successMessage, detail, strategyIds = []) {
  if (operationBusy) return;
  operationBusy = true;
  const session = beginOperation(kind, detail, strategyIds);
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  try {
    const minimumDuration = wait(reducedMotion ? 180 : session.config.duration);
    const result = await api(path, payload);
    const visualCount = session.kind === "generate" ? renderOperationDNA(session, result) : renderOperationCurves(session, result);
    const visualDuration = visualCount
      ? wait(reducedMotion ? 20 : session.kind === "generate" ? 700 + visualCount * 520 : 1050 + Math.min(visualCount, 12) * 65)
      : Promise.resolve();
    await Promise.all([minimumDuration, visualDuration]);
    await finishOperation(session, true);
    triggerOperationReveal(kind);
    showToast(successMessage);
  } catch (_) {
    await finishOperation(session, false);
  } finally {
    operationBusy = false;
  }
}

$("#generate-button").addEventListener("click", () => {
  const count = Number($("#cohort-size").value);
  const existingIds = state.strategies.map((strategy) => strategy.id);
  animatedAction("generate", "/api/generate", { count }, "Evolutionary cohort screened and finalists registered.", `${count} FINALIST SLOT${count === 1 ? "" : "S"}`, existingIds);
});
$("#review-button").addEventListener("click", () => {
  const candidates = state.strategies.filter((strategy) => ["generated", "rework"].includes(strategy.state));
  const count = candidates.length;
  animatedAction("review", "/api/review", {}, "Supervisor review cycle complete.", `${count} CANDIDATE${count === 1 ? "" : "S"}`, candidates.map((strategy) => strategy.id));
});
$("#research-toggle-button").addEventListener("click", () => {
  const paused = Boolean(state.research?.paused);
  action(paused ? "/api/research/resume" : "/api/research/pause",
    paused ? {} : { reason: "operator_paused" }, paused ? "Evolutionary research resumed." : "Evolutionary research paused.");
});
$("#validate-button").addEventListener("click", () => {
  const candidates = state.strategies.filter((strategy) => strategy.state === "validation");
  const count = candidates.length;
  animatedAction("validate", "/api/validate", {}, "Untouched holdout validation complete.", `${count} STRATEG${count === 1 ? "Y" : "IES"}`, candidates.map((strategy) => strategy.id));
});
$("#advance-button").addEventListener("click", () => action("/api/advance", { periods: 1 }, "Paper market advanced by 21 sessions."));
$("#sync-button").addEventListener("click", () => action("/api/alpaca/sync", {}, "Alpaca account and market data synchronized."));
$("#portfolio-refresh-button").addEventListener("click", () => action("/api/alpaca/portfolio", {}, "Alpaca balances, positions, and orders refreshed read-only."));
$("#curve-legend-button").addEventListener("click", () => {
  const legend = $("#market-chart-legend");
  if (!legend.children.length) return;
  curveLegendVisible = !curveLegendVisible;
  legend.hidden = !curveLegendVisible;
  $("#curve-legend-button").textContent = curveLegendVisible ? "Hide legend" : "Show legend";
  $("#curve-legend-button").setAttribute("aria-expanded", String(curveLegendVisible));
});
$("#show-all-curves-button").addEventListener("click", () => {
  deskOverview = true;
  curveLegendVisible = false;
  selectedId = null;
  render();
});
$("#reproduce-button").addEventListener("click", async () => {
  const parent = getSelected();
  if (!parent) return;
  const before = new Set(state.strategies.map((item) => item.id));
  try {
    await api("/api/reproduce", { id: parent.id });
    const child = state.strategies.find((item) => !before.has(item.id));
    if (child) selectedId = child.id;
    activeView = "overview";
    activeFilters.overview = "all";
    deskOverview = false;
    $$(".rail-button").forEach((button) => button.classList.toggle("active", button.dataset.view === activeView));
    render();
    showToast(`Child DNA created from ${parent.id}.`);
  } catch (_) { /* handled */ }
});
$$('#safety-dock [data-command]').forEach((button) => button.addEventListener("click", () =>
  runOperatorCommand(button.dataset.command, { button }).catch(() => {})));
$("#ops-approval-button").addEventListener("click", () => {
  const kind = window.prompt("Approval type: configuration, universe, or policy", "configuration")?.trim().toLowerCase();
  const commands = { configuration: "approve_configuration", universe: "approve_universe", policy: "approve_policy" };
  if (!commands[kind]) { if (kind) showToast("Approval type must be configuration, universe, or policy.", true); return; }
  const subjectHash = window.prompt(`Paste the exact SHA-256 hash to approve for ${kind}:`)?.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(subjectHash || "")) { showToast("Approval requires an exact 64-character SHA-256 hash.", true); return; }
  if (!window.confirm(`Approve ${kind} hash ${subjectHash}?`)) return;
  runOperatorCommand(commands[kind], { button: $("#ops-approval-button"), skipConfirm: true,
    payload: { subject_hash: subjectHash } }).catch(() => {});
});
$("#log-category").addEventListener("change", () => loadOperatorLogs());
$("#load-more-logs").addEventListener("click", () => loadOperatorLogs({ append: true }));

$("#reset-button").addEventListener("click", () => {
  resetManifest = null;
  $("#reset-form").reset();
  $("#reset-manifest").textContent = "Prepare a manifest before execution.";
  $("#execute-reset-button").disabled = true;
  $("#reset-dialog").showModal();
});
$("#prepare-reset-button").addEventListener("click", async () => {
  const token = $("#reset-admin-token").value.trim();
  if (!token) { showToast("Re-enter the admin token first.", true); return; }
  const button = $("#prepare-reset-button");
  try {
    const result = await runOperatorCommand("prepare_workspace_reset", { token, button, skipConfirm: true });
    resetManifest = result?.reset_manifest ?? null;
    if (!resetManifest) throw new Error("The server did not return a reset manifest summary");
    const counts = resetManifest.counts ?? {};
    $("#reset-manifest").textContent = `MANIFEST ${resetManifest.manifest_hash} · ${counts.d1 ?? "?"} D1 targets · ${counts.r2 ?? "?"} R2 targets · ${counts.durable_object ?? "?"} Durable Object keys · prepared ${localTime(resetManifest.prepared_at)}`;
    $("#execute-reset-button").disabled = false;
  } catch (_) { resetManifest = null; $("#execute-reset-button").disabled = true; }
});
$("#execute-reset-button").addEventListener("click", async () => {
  const token = $("#reset-admin-token").value.trim();
  const confirmation = $("#reset-confirmation").value;
  if (!resetManifest || confirmation !== "RESET NONPRODUCTION WORKSPACE") {
    showToast("Prepare the manifest and type the exact confirmation phrase.", true); return;
  }
  if (!window.confirm("Execute this exact reset manifest now? This cannot be undone.")) return;
  try {
    await runOperatorCommand("execute_workspace_reset", { token, button: $("#execute-reset-button"), skipConfirm: true,
      payload: { manifest_hash: resetManifest.manifest_hash, confirmation } });
    $("#reset-dialog").close();
    evidenceCache.clear();
    showToast("Nonproduction workspace reset completed.");
  } catch (_) { /* command helper surfaced the failure */ }
});

$$(".rail-button").forEach((button) => button.addEventListener("click", () => {
  activeView = button.dataset.view;
  if (multiStrategyViews.has(activeView)) {
    deskOverview = true;
    curveLegendVisible = false;
    selectedId = null;
    if (activeView in activeFilters) activeFilters[activeView] = "all";
  }
  $$(".rail-button").forEach((item) => item.classList.toggle("active", item === button));
  render();
}));

api("/api/state").then(() => Promise.allSettled([loadOperations(), loadOperatorLogs()])).catch(() => {
  operationsError = "Application state could not be loaded";
  renderOperations();
});
