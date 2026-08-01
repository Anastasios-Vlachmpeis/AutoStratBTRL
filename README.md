# Axiom Strategy Foundry

A dependency-light strategy generation, multi-regime backtest, reproduction, and paper-release terminal. It can run locally with Python or as an event-driven Cloudflare Worker.

## Run

```powershell
python main.py
```

Open `http://127.0.0.1:8765`. The application uses only the Python standard library.

The local server keeps its state in memory and restores the deterministic demo whenever it restarts. It is intended for development.

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

Replace the placeholder in `.dev.vars` with a long random admin token. The file is ignored by Git.

```powershell
npm run dev:cloudflare
```

Open the URL printed by Wrangler, normally `http://127.0.0.1:8787`. The dashboard asks for the token on the first state-changing action and keeps it only in that browser tab's session storage.

Test the scheduler locally:

```powershell
Invoke-WebRequest "http://127.0.0.1:8787/cdn-cgi/handler/scheduled?format=json"
```

### 2. Authenticate and deploy

```powershell
npx wrangler login
npx wrangler secret put ADMIN_TOKEN
npm run deploy
```

Wrangler prints the resulting `*.workers.dev` URL. Configure a custom domain later from **Cloudflare Dashboard → Workers & Pages → axiom-strategy-foundry → Settings → Domains & Routes**.

`ADMIN_TOKEN` is never stored in `wrangler.jsonc` or the repository. Without the secret, mutation endpoints are intentionally open for local/demo use. Read-only strategy state remains public; use Cloudflare Access in front of the Worker if the entire terminal must be private.

### Monitoring cadence

The default schedule in `wrangler.jsonc` is hourly, in UTC:

```json
"crons": ["0 * * * *"]
```

Each invocation advances one simulated 21-session monitor window. For a real daily evaluation, change it before deployment to `"0 0 * * *"`. Scheduled invocations are idempotent per UTC hour, so a Cloudflare retry does not double-advance the same window.

Cloudflare and local Python states are intentionally separate. Resetting or running one environment does not affect the other.

## Lifecycle

1. **Seed cohort** creates new strategy DNA across momentum, mean-reversion, breakout, and volatility-filter archetypes.
2. **Run supervisor** evaluates every waiting strategy across three deterministic, four-regime backtests.
3. Candidates are released, sent to rework, or dropped through explicit score, Sharpe, drawdown, trade-count, and regime gates.
4. **Advance 21 sessions** runs a paper-monitor window. Weak strategies enter watch, have risk reduced after repeated weakness, and are retired if degradation persists.
5. **Reproduce DNA** makes a traceable, mutated child from a released strategy.

All prices and monitoring returns are synthetic. There is no live-broker integration or real order routing.

## Tests

```powershell
python -m unittest discover -s tests -v
```

Cloudflare engine tests and syntax checks:

```powershell
npm run check
```
