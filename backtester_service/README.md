# Axiom Backtester Service

This is the isolated Backtrader execution service. Cloudflare remains responsible for strategy state, data sealing, release decisions, Alpaca orders and scheduling. This service is stateless: it receives one already-authorized bar slice, runs frozen strategy DNA and returns deterministic artifacts.

## Contract

`GET /healthz` is public. `POST /v1/backtests/batch` requires:

- `X-Axiom-Timestamp`: Unix seconds
- `X-Axiom-Job-Id`: body `job_id`
- `X-Axiom-Signature`: lowercase hex HMAC-SHA256 of `timestamp + "." + job_id + "." + raw request body`, using `AXIOM_BACKTEST_SECRET`

The request's `dataset.sha256` is the SHA-256 of canonical JSON (`sort_keys`, compact separators) for the submitted `bars` array. Each strategy's `dna_hash` is the SHA-256 of canonical JSON for `{id,asset,archetype,params}`. The service validates both before executing.

`windows` use zero-based, end-exclusive indexes within the submitted bar slice. Cloudflare must submit only development bars for development runs and only the sealed holdout bars for holdout runs. The API does not accept hidden bar references or fetch market data itself.

Execution is $100,000 cash, next-bar-open market orders, long/short targets, 5 bps slippage, no commission and a 52-bar warmup. Signal rules are intentionally a direct port of `worker/engine.js`, including the currently unused `exit_z` mean-reversion parameter.

## Local run

```powershell
cd backtester_service
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
$env:AXIOM_BACKTEST_SECRET = "development-only-secret"
uvicorn app.main:app --reload --port 8080
pytest
```

## Cloud Run

Create the secret once, then run the included script from this directory:

```powershell
gcloud services enable run.googleapis.com cloudbuild.googleapis.com secretmanager.googleapis.com
gcloud secrets create axiom-backtest-secret --replication-policy=automatic
# Add the secret value in Google Cloud Console, or from a protected local file:
gcloud secrets versions add axiom-backtest-secret --data-file=.\protected-secret.txt
$projectNumber = gcloud projects describe YOUR_PROJECT_ID --format="value(projectNumber)"
gcloud secrets add-iam-policy-binding axiom-backtest-secret --member="serviceAccount:$projectNumber-compute@developer.gserviceaccount.com" --role="roles/secretmanager.secretAccessor"
.\deploy-cloud-run.ps1 -ProjectId YOUR_PROJECT_ID
```

The deployment is deliberately public at the HTTP layer because this integration uses signed requests rather than Google IAM identity tokens; HMAC authentication protects the only non-health endpoint. It allows zero minimum instances, so the container can scale down while idle and wake on demand. Set Cloudflare `BACKTEST_SERVICE_URL` to the resulting service URL and its matching `BACKTEST_SERVICE_SECRET` to the same secret value.

Smoke test after deployment:

```powershell
Invoke-RestMethod "$env:BACKTEST_SERVICE_URL/healthz"
```

Backtrader is GPLv3. Review its license obligations before production distribution.
