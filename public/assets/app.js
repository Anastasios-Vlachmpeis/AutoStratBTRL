const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

let state = null;
let selectedId = null;
let activeView = "portfolio";
let deskOverview = true;
let toastTimer = null;
let adminToken = sessionStorage.getItem("axiom-admin-token") || "";

const multiStrategyViews = new Set(["overview", "testing", "released", "lineage"]);
const activeFilters = { overview: "all", testing: "all", released: "all" };
const filterConfigs = {
  overview: [
    { id: "all", label: "All" },
    { id: "generated", label: "Generated", states: ["generated"] },
    { id: "rework", label: "Rework", states: ["rework"] },
    { id: "validation", label: "Validation", states: ["validation"] },
    { id: "market", label: "Market", states: ["released", "healthy", "watch", "adjusted"] },
    { id: "retired", label: "Retired", states: ["dropped", "superseded"] },
  ],
  testing: [
    { id: "all", label: "All" },
    { id: "generated", label: "Generated", states: ["generated"] },
    { id: "rework", label: "Rework", states: ["rework"] },
    { id: "validation", label: "Validation", states: ["validation"] },
  ],
  released: [
    { id: "all", label: "All" },
    { id: "released", label: "New", states: ["released"] },
    { id: "healthy", label: "Healthy", states: ["healthy"] },
    { id: "watch", label: "Watch", states: ["watch"] },
    { id: "adjusted", label: "Adjusted", states: ["adjusted"] },
  ],
};

const statusLabels = {
  generated: "Generated", rework: "Rework", validation: "Validation", released: "Released", healthy: "Healthy",
  watch: "Watch", adjusted: "Adjusted", dropped: "Dropped", superseded: "Superseded"
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
  if (view === "testing") return state.strategies.filter((item) => ["generated", "rework", "validation"].includes(item.state));
  if (view === "released") return state.strategies.filter((item) => ["released", "healthy", "watch", "adjusted"].includes(item.state));
  if (view === "lineage") return state.strategies.filter((item) => item.parent || item.generation > 1);
  return state.strategies;
}

function filteredStrategies() {
  const strategies = strategiesForView();
  const config = filterConfigs[activeView];
  if (!config) return strategies;
  const selectedFilter = config.find((filter) => filter.id === activeFilters[activeView]) || config[0];
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
    const best = state.strategies.find((item) => ["healthy", "released", "watch", "adjusted"].includes(item.state));
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
  $("#average-score").textContent = state.strategies.length ? number(state.summary.average_score, 1) : "—";
}

function renderView() {
  const portfolio = activeView === "portfolio";
  $("#foundry-controls").hidden = portfolio;
  $("#portfolio-dashboard").hidden = !portfolio;
  $("#release-pipeline").hidden = portfolio;
  $("#strategy-overview").hidden = portfolio;
  $("#strategy-roster").hidden = portfolio;
  $("#strategy-detail").hidden = portfolio;
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

function focusStrategy(strategyId) {
  deskOverview = false;
  selectedId = strategyId;
  render();
}

function renderCombinedChart(strategies, chartTitle) {
  const svg = $("#equity-chart");
  const palette = ["#a8f05a", "#70a7ee", "#a28bdd", "#e9b655", "#ee736a", "#70d7c7", "#d99fe8", "#c7d36f"];
  const curves = strategies.map((strategy, index) => ({
    strategy,
    color: palette[index % palette.length],
    values: (strategy.metrics?.curve ?? []).map(Number).filter(Number.isFinite),
  })).filter((item) => item.values.length >= 2);
  $("#chart-title").textContent = chartTitle;
  $("#chart-delta").textContent = `${curves.length} CURVE${curves.length === 1 ? "" : "S"}`;
  const legend = $("#market-chart-legend");
  legend.hidden = curves.length === 0;
  legend.innerHTML = curves.map(({ strategy, color }) => `<button type="button" data-strategy-id="${escapeHtml(strategy.id)}"><i style="background:${color}"></i><span>${escapeHtml(strategy.name)}</span><small>${escapeHtml(strategy.asset)}</small></button>`).join("");
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
    released: { name: "Released strategy book", empty: "No released strategies", chart: "ALL RELEASED EQUITY CURVES", noun: "released strategy" },
    lineage: { name: "Reproduction lineage", empty: "No reproduced strategies", chart: "ALL LINEAGE EQUITY CURVES", noun: "lineage strategy" },
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
  $("#dna-content").innerHTML = `<div class="empty-state">Select a ${desk.noun} to inspect its DNA and lineage.</div>`;
  $("#regime-content").innerHTML = `<div class="empty-state">Select a ${desk.noun} to inspect its regime fitness.</div>`;
  $("#gate-content").innerHTML = `<div class="empty-state">Select a ${desk.noun} to inspect its release gates.</div>`;
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
    $("#dna-content").innerHTML = '<div class="empty-state">No strategy DNA yet.</div>';
    $("#regime-content").innerHTML = '<div class="empty-state">No regime evidence yet.</div>';
    $("#gate-content").innerHTML = '<div class="empty-state">No supervisor decision yet.</div>';
    return;
  }
  const metrics = strategy.metrics;
  $("#selected-name").textContent = strategy.name;
  const attempt = strategy.rework?.attempt ? `<span>REWORK ${strategy.rework.attempt}/${strategy.rework.max_attempts || 3}</span>` : "";
  $("#selected-meta").innerHTML = `<span>${escapeHtml(strategy.archetype)}</span><span>${escapeHtml(strategy.asset)}</span><span>GEN ${strategy.generation}</span>${attempt}`;
  const status = $("#selected-status");
  status.textContent = statusLabels[strategy.state] || strategy.state;
  status.className = `status-badge ${strategy.state}`;
  $("#selected-id").textContent = strategy.id;
  const allowed = ["released", "healthy", "watch", "adjusted"].includes(strategy.state);
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
  const rework = strategy.rework?.attempt
    ? `<div class="rework-note"><span>REWORK ${strategy.rework.attempt}/${strategy.rework.max_attempts || 3}</span><strong>${escapeHtml(strategy.rework.diagnosis || "Development improvement pass")}</strong>${strategy.rework.change ? `<small>${escapeHtml(labelParam(strategy.rework.change.parameter))}: ${escapeHtml(strategy.rework.change.from)} → ${escapeHtml(strategy.rework.change.to)}</small>` : ""}</div>`
    : "";
  $("#dna-content").innerHTML = `<div class="dna-lineage">${lineage}</div>${rework}<div class="param-grid">${params}</div>`;
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
    ["Development Sharpe", state.policy.min_sharpe, m?.sharpe, (v, t) => v >= t, (v) => number(v, 2)],
    ["Unseen return", 0, strategy.validation?.return, (v, t) => v > t, (v) => signedPct(v)],
    ["Unseen Sharpe", state.policy.validation_min_sharpe || .30, strategy.validation?.sharpe, (v, t) => v >= t, (v) => number(v, 2)],
    ["Unseen drawdown", state.policy.validation_max_drawdown || .20, strategy.validation?.drawdown, (v, t) => v <= t, (v) => pct(v)]
  ];
  $("#gate-content").innerHTML = gates.map(([label, threshold, value, test, format]) => {
    const known = value != null, pass = known && test(value, threshold);
    return `<div class="gate ${known ? pass ? "pass" : "fail" : ""}"><span class="gate-mark">${known ? pass ? "✓" : "×" : "·"}</span><span>${label}</span><strong>${known ? format(value) : "PENDING"}</strong></div>`;
  }).join("");
}

function renderAudit() {
  $("#audit-feed").innerHTML = state.events.length
    ? state.events.map((event) => `<article class="audit-item"><span class="audit-time">${escapeHtml(event.time)}</span><div class="audit-copy"><strong><i class="event-dot ${escapeHtml(event.kind)}"></i>${escapeHtml(event.title)}</strong><p>${escapeHtml(event.detail)}</p></div></article>`).join("")
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
    selectedId = null;
    render();
  }));
}

function renderTable() {
  const strategies = filteredStrategies();
  const titles = { overview: "All research units", testing: "Generation & rework queue", released: "Released market book", lineage: "Reproduction lineage" };
  $("#roster-title").textContent = titles[activeView] || titles.overview;
  renderStrategyFilters();
  const scored = strategies.map((strategy) => strategy.metrics?.score).filter(Number.isFinite);
  $("#average-score").textContent = scored.length ? number(scored.reduce((sum, score) => sum + score, 0) / scored.length, 1) : "—";
  $("#empty-state").hidden = strategies.length > 0;
  $("#empty-state").textContent = strategiesForView().length ? "No strategies match this filter." : "No strategies match this desk.";
  $("#strategy-table").innerHTML = strategies.map((strategy) => {
    const m = strategy.metrics;
    return `<tr data-id="${escapeHtml(strategy.id)}" class="${strategy.id === selectedId ? "selected" : ""}">
      <td class="unit-cell"><strong>${escapeHtml(strategy.name)}</strong><span>${escapeHtml(strategy.id)}${strategy.parent ? ` · CHILD OF ${escapeHtml(strategy.parent)}` : ""}${strategy.rework?.attempt ? ` · TRY ${strategy.rework.attempt}/${strategy.rework.max_attempts || 3}` : ""}</span></td>
      <td class="archetype-cell"><strong>${escapeHtml(strategy.archetype)}</strong><span>${escapeHtml(strategy.asset)}</span></td>
      <td><span class="status-badge ${strategy.state}">${escapeHtml(statusLabels[strategy.state] || strategy.state)}</span></td>
      <td>${strategy.backtests ? `${Math.min(strategy.backtests, 3)} dev${strategy.validation ? " · 1 unseen" : ""}` : "not tested"}</td><td>${m ? number(m.sharpe) : "—"}</td><td>${m ? pct(m.drawdown) : "—"}</td>
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
  renderPortfolio();
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

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
let operationBusy = false;

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

function beginOperation(kind, detail) {
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
  $("#operation-steps").innerHTML = config.steps.map((step) => `<div class="operation-step"><i></i><span>${escapeHtml(step)}</span><small>WAIT</small></div>`).join("");
  $("#operation-progress").style.width = "4%";
  $("#operation-progress-label").textContent = "4%";
  button.setAttribute("aria-busy", "true");
  document.body.classList.add(`operation-${kind}`);
  overlay.hidden = false;
  requestAnimationFrame(() => overlay.classList.add("visible"));
  overlay.focus({ preventScroll: true });
  const session = { kind, config, overlay, terminal, button, step: 0, timer: null };
  setOperationStep(session, 0);
  const interval = Math.max(480, Math.round(config.duration / (config.steps.length + 1)));
  session.timer = setInterval(() => {
    if (session.step < config.steps.length - 1) setOperationStep(session, session.step + 1);
  }, interval);
  return session;
}

async function finishOperation(session, succeeded) {
  clearInterval(session.timer);
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

async function animatedAction(kind, path, payload, successMessage, detail) {
  if (operationBusy) return;
  operationBusy = true;
  const session = beginOperation(kind, detail);
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  try {
    await Promise.all([api(path, payload), wait(reducedMotion ? 180 : session.config.duration)]);
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
  animatedAction("generate", "/api/generate", { count }, `${count} new strategy DNA${count === 1 ? "" : "s"} seeded.`, `${count} NEW GENOME${count === 1 ? "" : "S"}`);
});
$("#review-button").addEventListener("click", () => {
  const count = state.strategies.filter((strategy) => ["generated", "rework"].includes(strategy.state)).length;
  animatedAction("review", "/api/review", {}, "Supervisor review cycle complete.", `${count} CANDIDATE${count === 1 ? "" : "S"}`);
});
$("#validate-button").addEventListener("click", () => {
  const count = state.strategies.filter((strategy) => strategy.state === "validation").length;
  animatedAction("validate", "/api/validate", {}, "Untouched holdout validation complete.", `${count} STRATEG${count === 1 ? "Y" : "IES"}`);
});
$("#advance-button").addEventListener("click", () => action("/api/advance", { periods: 1 }, "Paper market advanced by 21 sessions."));
$("#sync-button").addEventListener("click", () => action("/api/alpaca/sync", {}, "Alpaca account and market data synchronized."));
$("#portfolio-refresh-button").addEventListener("click", () => action("/api/alpaca/portfolio", {}, "Alpaca balances, positions, and orders refreshed read-only."));
$("#show-all-curves-button").addEventListener("click", () => {
  deskOverview = true;
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
    activeView = "lineage";
    deskOverview = false;
    $$(".rail-button").forEach((button) => button.classList.toggle("active", button.dataset.view === activeView));
    render();
    showToast(`Child DNA created from ${parent.id}.`);
  } catch (_) { /* handled */ }
});
$("#reset-button").addEventListener("click", () => action("/api/reset", {}, "Strategy workspace cleared."));

$$(".rail-button").forEach((button) => button.addEventListener("click", () => {
  activeView = button.dataset.view;
  if (multiStrategyViews.has(activeView)) {
    deskOverview = true;
    selectedId = null;
    if (activeView in activeFilters) activeFilters[activeView] = "all";
  }
  $$(".rail-button").forEach((item) => item.classList.toggle("active", item === button));
  render();
}));

api("/api/state").catch(() => {});
