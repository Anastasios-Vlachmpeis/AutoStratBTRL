# Axiom Strategy Foundry

A self-supervising research and Alpaca paper-trading system for regular-session US equities on canonical five-minute data. It generates typed strategy DNA, screens candidates, runs development and sealed holdout backtests, incubates approved strategies on forward data, and monitors released paper strategies.

The checked-in configuration is deliberately safe: observation mode is enabled, market ingestion is off, the legacy control plane remains readable, Backtrader runs in shadow mode, and all Alpaca order submission is disabled.

## How it stays running

There is no permanently running Cloudflare process. A minute Cron Trigger and Durable Object alarms create deterministic work intents. Cloudflare Queues deliver long-running stages and retries. The Python/Backtrader service on Cloud Run scales to zero while idle and starts when a signed backtest request arrives.

```text
Browser -> Cloudflare Worker API -> Durable Object control state
                                   -> D1 normalized metadata/outbox
                                   -> R2 sealed data and artifacts
Minute Cron -> orchestration -> Queue -> generation/review/validation/incubation
                                      -> signed Cloud Run Backtrader request
Alpaca IEX -> canonical 1-minute input -> finalized 5-minute regular-session bars
Alpaca paper account <- guarded reconciliation only when explicitly enabled
```

## Local UI

Install Node.js 20 or newer, then:

```powershell
npm install
Copy-Item .dev.vars.example .dev.vars
npm run dev:cloudflare
```

Open the Wrangler URL, normally `http://127.0.0.1:8787`. Put only local secrets in `.dev.vars`; it is ignored by Git.

The dependency-free legacy Python demo remains available with:

```powershell
python main.py
```

## Cloudflare preparation

Provision the target resources before enabling normalized/autonomous mode:

```powershell
npx wrangler login
npx wrangler d1 create axiom-control
npx wrangler r2 bucket create axiom-private-artifacts
npx wrangler r2 bucket create axiom-private-artifacts-preview
npx wrangler queues create axiom-jobs
npx wrangler queues create axiom-jobs-dlq
```

Copy the returned D1 database ID into `wrangler.target.example.jsonc`, review every setting, then use it as the deployment configuration. Apply migrations before deployment:

```powershell
npx wrangler d1 migrations apply axiom-control --remote
```

Set secrets interactively; never put their values in Git or Workers Builds variables:

```powershell
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put ALPACA_API_KEY
npx wrangler secret put ALPACA_API_SECRET
npx wrangler secret put BACKTEST_SERVICE_SECRET
```

Required runtime values:

| Name | Purpose |
|---|---|
| `ADMIN_TOKEN` | Long random dashboard/API password |
| `ALPACA_API_KEY` | Dedicated Alpaca paper key ID |
| `ALPACA_API_SECRET` | Dedicated Alpaca paper secret |
| `BACKTEST_SERVICE_SECRET` | HMAC secret shared with Cloud Run |
| `BACKTEST_SERVICE_URL` | HTTPS URL of the Cloud Run backtester |

`ADMIN_TOKEN` protects application APIs. Private artifact routes always require strict authorization, including in local/demo mode.

## Backtrader service

The pinned Python 3.11 service is in `backtester_service/`. It verifies the HMAC signature and complete deterministic job identity, rejects malformed or mismatched sealed inputs, and returns content-hashed metrics, curves, orders, fills, trades, and provenance.

Deploy it only after reviewing `backtester_service/deploy-cloud-run.ps1`. The script builds a unique image, resolves its immutable digest, deploys that exact digest to Cloud Run in `europe-west1`, and supplies the digest to result provenance. Cloud Run should use 1 vCPU, 512 MiB, concurrency 1, zero minimum instances, three maximum instances, and a 300-second timeout.

Use `BACKTEST_ENGINE=shadow` during engine comparison. Switch to `backtrader` only after the documented golden, determinism, leakage, replay, success-rate, and runtime gates pass. `legacy` is the rollback mode. Production-like deployments should keep `BACKTEST_REQUIRE_IMAGE_DIGEST=true`.

## Data and lifecycle

The initial universe is an immutable, hashed set of 40 regular US equities. Research uses Alpaca's free IEX feed and a sealed three-year five-minute dataset:

1. Canonical regular-session data is audited and stored in immutable monthly partitions.
2. The dataset is split once into 75% development and 25% sealed holdout slices.
3. Typed DSL strategies are generated through bounded evolutionary search using development data only.
4. Development confirmation runs three anchored and three rolling, purged/embargoed Backtrader folds with mandatory execution stress.
5. Approved DNA and policy are frozen before the one-time sealed holdout evaluation.
6. Passing strategies enter forward paper incubation. Release requires at least 10 valid trading days and 67 completed trades; a strategy that misses the trade gate after 20 valid days returns to rework.
7. Released strategies are reconciled and monitored on five-minute evidence. Infrastructure failures never create promote, rework, or drop decisions.

Raw holdout bars and secrets are never exposed by frontend APIs. Artifacts retain the strategy, DNA, dataset slice, policy, compiler, engine, configuration, input, and result hashes needed for replay.

## Modes and safety

- `ORCHESTRATION_MODE=observe` plans system work without executing it. Operator commands still work.
- `ORCHESTRATION_MODE=autonomous` executes durable scheduled stages. Enable it only after D1, R2, Queue, market-data, and backtester health checks pass.
- `CONTROL_PLANE_MODE=dual_write` mirrors the Durable Object state into normalized D1/R2 storage. Normalized reads remain behind their separate cutover flag.
- `MARKET_DATA_MODE=shadow` enables canonical ingestion without making it an order-submission switch.
- `ALPACA_TRADING_ENABLED=false` blocks all submitted paper orders.
- `ALPACA_SHORT_TRADING_ENABLED=false` independently blocks new paper shorts.

Paper reconciliation is capped at 0.5% absolute exposure per strategy and 10% portfolio gross exposure. Longs may be fractional. New shorts are whole-share, tradable, shortable, easy-to-borrow paper orders only. Direction flips flatten first and open the opposite direction on a later cycle. Unmanaged positions are skipped. Stable client order IDs and open-order suppression make retries idempotent.

No live-money endpoint, hard-to-borrow locate, options, crypto, or browser-controlled risk-limit changes are included.

## Verification

```powershell
npm run check
npm run test:incubation
python -m unittest discover -s tests -v
```

For the service, install its pinned dependencies in an isolated Python 3.11 environment and run:

```powershell
python -m pytest backtester_service/tests -q
```

No repository push or cloud deployment is performed by the implementation or test commands above.
