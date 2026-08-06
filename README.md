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

The browser opens on **Overview**, which combines paper-account performance, active strategy curves, pipeline progress,
actionable alerts, and current autonomous work. **Strategies** contains the full lifecycle book; infrastructure and
operator tools live behind the **Advanced** gear. There are no manual generation or pipeline-advance controls in the
normal product. The admin token is kept in `sessionStorage` only and is discarded on sign-out or when the browser
session ends.

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

Use `wrangler.staging.example.jsonc` or `wrangler.production-paper.example.jsonc` as the reviewed starting point. They deliberately use different Worker, D1, R2, Queue, and DLQ names. Staging runs a separately hashed five-symbol universe; production-paper uses the frozen 40-symbol universe. Copy each template to the ignored `wrangler.target.jsonc`, replace its placeholders, and apply migrations before deployment:

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
| `BACKTEST_SERVICE_KEY_ID` | Active HMAC rotation identifier |
| `BACKTEST_SERVICE_URL` | HTTPS URL of the Cloud Run backtester |

`ADMIN_TOKEN` protects application APIs. Private artifact routes always require strict authorization, including in local/demo mode.

Staging and production-paper reject absent or weak admin tokens. During a bounded rotation, `ADMIN_TOKEN_PREVIOUS` and `BACKTEST_SERVICE_PREVIOUS_SECRET` may coexist with the new current values; remove previous keys after clients have moved. Keep admin, Alpaca, Backtrader, and any future callback secrets distinct.

## Backtrader service

The pinned Python 3.11 service is in `backtester_service/`. It verifies the HMAC signature and complete deterministic job identity, rejects malformed or mismatched sealed inputs, and returns content-hashed metrics, curves, orders, fills, trades, and provenance.

Deploy it only after reviewing `backtester_service/deploy-cloud-run.ps1`. The script builds a unique image in regional Artifact Registry, resolves its immutable digest, deploys that exact digest to Cloud Run in `europe-west1`, and supplies the digest to result provenance. Cloud Run should use 1 vCPU, 512 MiB, concurrency 1, zero minimum instances, three maximum instances, and a 300-second timeout.

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

The deployable configuration is additionally pinned by `TRADING_ENVIRONMENT=paper`,
`BROKER_ACCOUNT_CLASS=paper`, `ALPACA_DATA_FEED=iex`, and
`DATA_FEED_VERSION=alpaca-iex-5min-adjusted-v1`. API, scheduler, queue, broker,
and persistence paths fail closed if those boundaries are relabeled. There is
no configurable Alpaca live endpoint in this build.

## Cost and operations

The runtime records daily provider usage and projects the calendar month against a USD 50 limit. At 50% it informs; at 75% it halves new research and disables optional deep work; at 90% it pauses optional generation and backfills; at 100%, or when telemetry is stale/unavailable, optional cloud research stops. An already sealed validation may finish, while market-data safety and risk supervision remain active at every tier.

The Operations page exposes the measured month-to-date/projected cost, subsystem-specific heartbeats, structured correlated events, and alerts classified as `info`, `research_degraded`, `execution_blocked`, or `critical_risk`. Secrets are recursively redacted before events enter state or logs.

After collecting real staging usage samples, calculate the 30-day projection with:

```powershell
node scripts/estimate-monthly-cost.mjs .\protected-staging-usage.json
```

Do not commit the usage file. Billing alerts should also be configured at the providers; they complement rather than replace the application controller.

## Evidence-bound rollout

Replacement of the prototype is controlled by phases A–I: foundations, data shadow, DSL/research shadow, Backtrader shadow, normalized-storage cutover, incubation shadow, paper canary, bounded autonomous paper, and legacy retirement. A phase advances only when every quantitative gate has immutable evidence and an authenticated operator submits the exact current phase with an idempotency key. Advancement records approval; it never changes Wrangler variables, enables Alpaca switches, deploys infrastructure, or submits an order.

The Operations page shows the active phase and gate progress. Authenticated rollout endpoints are:

- `POST /api/v1/admin/rollout/evidence`
- `POST /api/v1/admin/rollout/advance`
- `POST /api/v1/admin/rollout/domain-cutover`
- `POST /api/v1/admin/rollback/rehearse`

Rollback rehearsal writes a secret-free private replay bundle to R2, stores only hashes/metadata in D1, verifies the restore, and forces execution, entries, research, release, and global operation into paused state. Broker reconciliation and a fresh operator resume are mandatory after any real restore.

## Future SIP and real-money gates

SIP is represented as a separate versioned dataset and release lineage, never
as a replacement string for IEX. A future SIP assessment requires a distinct
three-year/40-symbol backfill, bar/volume/signal/target/fill/performance
comparisons, rerun development plus sealed validation plus incubation, a
precommitted bridge policy, preserved late-revision semantics, visible feed
labels, and a revised cost projection. Even a passing assessment records only
`ready_for_separate_sip_rollout`; it cannot switch the feed.

Real-money readiness is likewise evidence-only. It requires sustained paper
evidence across regimes; seven independent reviews; separate credentials,
account, deployment, storage, queue, access and audit resources; materially
tighter capital limits; manual releases; independent kill/flatten drills;
fill/slippage calibration; formal model-change control; and an explicit user
approval artifact. A passing result can only request a separate live design
review. It never authorizes orders, and this repository contains no live-order
adapter.

Migration `0007_future_gates.sql` makes these boundaries durable: live release
rows are rejected, broker rows require a registered `alpaca-paper-*` account,
and future assessment tables are constrained to non-activating records. The
Operations API exposes the current boundary and explicitly reports that no
browser switch exists.

## Verification

```powershell
npm run check
npm run test:incubation
npm run test:plan13
npm run test:plan14
npm run test:plan14:coverage
npm run test:plan15
npm run test:plan15:coverage
npm run scan:secrets
python -m unittest discover -s tests -v
```

For the service, install its pinned dependencies in an isolated Python 3.11 environment and run:

```powershell
python -m pytest backtester_service/tests -q
```

Before a reviewed remote deployment, run `.\scripts\plan13-smoke.ps1`. After deployment, pass `-BacktestServiceUrl` to include the public health endpoint. The script never deploys or submits an Alpaca order.

The complete pre-rollout command is `.\scripts\plan14-verify.ps1`. Use `-SkipBacktester` only for local development when the pinned Python service dependencies are unavailable; it is forbidden for a staging or paper rollout decision.

After Plan 14 passes, `.\scripts\plan15-verify.ps1` adds the paper/IEX boundary,
SIP isolation, non-activating real-money assessment, database-trigger, and
configuration tests. It accepts the same `-Python` and `-SkipBacktester`
arguments; skipping Backtrader remains forbidden for any rollout decision.

No repository push or cloud deployment is performed by the implementation or test commands above.
