# Axiom Strategy Foundry

A dependency-light strategy generation, multi-regime backtest, reproduction, and paper-release terminal. It can run locally with Python or as an event-driven Cloudflare Worker.

## Run

```powershell
python main.py
```

Open `http://127.0.0.1:8765`. The application uses only the Python standard library.

The local server keeps its state in memory and starts with an empty strategy workspace whenever it restarts. Nothing is generated until you press **Seed cohort**.

## Cloudflare deployment

The Cloudflare version does not keep a process alive. Static assets are served from Cloudflare's edge, API requests wake a Worker, and one SQLite-backed Durable Object stores the complete supervisor state. An hourly Cron Trigger wakes the same object to run one 21-session monitoring window.

```text
Browser ── static files ──> Workers Static Assets
        └─ /api/* ───────> Worker ──> AxiomLab Durable Object ──> persistent state
Cron (hourly) ──────────────────────> AxiomLab Durable Object ──> monitor/adjust/drop
```

### 1. Install and preview

Install Node.js 20 or newer, then run:

```powershell
npm install
Copy-Item .dev.vars.example .dev.vars
```

Replace the placeholders in `.dev.vars` with a long random admin token and your **paper** Alpaca key pair. The file is ignored by Git. Never use live-account credentials in this project.

```powershell
npm run dev:cloudflare
```

Open the URL printed by Wrangler, normally `http://127.0.0.1:8787`. The dashboard asks for the token before loading private API state and keeps it only in that browser tab's session storage.

Test the scheduler locally:

```powershell
Invoke-WebRequest "http://127.0.0.1:8787/cdn-cgi/handler/scheduled?format=json"
```

### 2. Authenticate and deploy

```powershell
npx wrangler login
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put ALPACA_API_KEY
npx wrangler secret put ALPACA_API_SECRET
npm run deploy
```

Wrangler prints the resulting `*.workers.dev` URL. Configure a custom domain later from **Cloudflare Dashboard → Workers & Pages → axiom-strategy-foundry → Settings → Domains & Routes**.

Each command asks for the value without writing it to the repository. In the Cloudflare dashboard, the equivalent location is **Worker → Settings → Variables & Secrets → Add → Secret**. These are runtime secrets; do not put them in Workers Builds variables.

Required secrets:

| Secret | Value |
|---|---|
| `ADMIN_TOKEN` | Your own long random dashboard password |
| `ALPACA_API_KEY` | Alpaca paper API key ID |
| `ALPACA_API_SECRET` | Alpaca paper secret key |

The same Alpaca paper key pair authenticates paper-account and market-data requests. No additional data key is needed for the default IEX feed.

`ADMIN_TOKEN` is never stored in `wrangler.jsonc` or the repository. When configured, it protects both read and write API requests, including account balances and positions. Without the secret, the API is intentionally open for local/demo use. Cloudflare Access can add full identity-based protection in front of the Worker.

## Alpaca paper connection

The Cloudflare Worker connects only to:

- `https://paper-api.alpaca.markets` for the account, positions, clock, assets, open orders, and paper orders.
- `https://data.alpaca.markets` for historical and monitoring bars.

The first integration supports four US equity ETFs: `SPY`, `QQQ`, `IWM`, and `TLT`. It uses three years of daily IEX bars for supervisor reviews and 45 days of hourly IEX bars for monitoring. IEX is Alpaca's free single-exchange feed; it is not the full consolidated SIP market feed.

Press **Sync Alpaca** to verify the credentials and load account equity, positions, market status, and current bars. Scheduled hourly runs perform the same synchronization automatically.

The **Account** desk is the default landing page. It displays Alpaca's three-month daily P/L history, a locally calculated 20-session rolling Sharpe chart, equity, cash, buying power, daily P/L, open positions, and working paper orders. Sharpe uses the daily portfolio-return series with a zero risk-free rate and annualizes by `sqrt(252)`. Its **Refresh account** button is read-only: it never evaluates strategies or submits orders, even when automated paper trading is enabled. Positions are marked `AXIOM / MIXED` only when Axiom has previously bought that symbol; Alpaca aggregates manual and automated shares, so exact share-level attribution is not implied.

Automated orders are disabled by default:

```json
"ALPACA_TRADING_ENABLED": "false"
```

While disabled, the terminal calculates and displays proposed orders but submits nothing. To enable paper orders after reviewing the proposals and logs, change that value in `wrangler.jsonc` to `"true"` and redeploy.

Paper execution is deliberately restricted:

- Long-only market orders; no shorts, leverage targets, options, or crypto.
- Maximum 2% of account equity per released strategy.
- Maximum 20% aggregate strategy allocation.
- Orders only while the US equity market is open and the account is not blocked.
- Sells only reduce symbols previously bought by Axiom; existing manual positions are not adopted automatically.
- Stable client order IDs prevent scheduler retries from placing the same order twice.

### Monitoring cadence

The default schedule in `wrangler.jsonc` is hourly, in UTC:

```json
"crons": ["0 * * * *"]
```

Each invocation synchronizes the Alpaca paper account and evaluates a new hourly-bar monitor window. For one daily evaluation, change it before deployment to `"0 0 * * *"`. Scheduled invocations and paper orders use stable UTC-hour identifiers so Cloudflare retries do not intentionally duplicate the same cycle.

Cloudflare and local Python states are intentionally separate. Resetting or running one environment does not affect the other.

## Lifecycle

1. **Seed cohort** creates new strategy DNA across momentum, mean-reversion, breakout, and volatility-filter archetypes.
2. **Run supervisor** evaluates each waiting strategy on the first 75% of its chronological research data. The final quarter is excluded from every development calculation. Strategies in rework are diagnosed from development evidence, archived, and replaced by a traceable child with exactly one adjusted parameter.
3. Strong candidates enter **Validation**. Parameters are frozen, then **Validate holdout** runs one final backtest on the untouched 25%.
4. Validation releases strategies only when unseen return, Sharpe, trade count, drawdown, robustness, and degradation gates pass. Soft failures can trigger a new rework child, but holdout values never select its mutation. After three unsuccessful rework attempts, the lineage is dropped.
5. Hourly Alpaca monitoring moves released strategies through healthy, watch, adjusted, and retired states.
6. **Reproduce DNA** makes a traceable, mutated child from a released strategy; the child must pass both supervision and validation.

The local Python server uses deterministic synthetic data. The Cloudflare Worker uses Alpaca IEX market data and can route guarded paper orders only when explicitly enabled. It never connects to Alpaca's live-money endpoint.

## Tests

```powershell
python -m unittest discover -s tests -v
```

Cloudflare engine tests and syntax checks:

```powershell
npm run check
```
