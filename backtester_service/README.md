# Axiom Backtester Service

This is the isolated Backtrader execution service. Cloudflare remains responsible for strategy state, data sealing, release decisions, Alpaca orders and scheduling. This service receives one already-authorized bar slice, runs frozen strategy DNA and returns deterministic artifacts.

The current `backtest-request-v2` contract evaluates each DSL strategy as an isolated USD 100,000 multi-symbol portfolio on canonical adjusted regular-session five-minute bars. The legacy single-symbol request remains replayable.

## Contract

`GET /healthz` is public. `POST /v1/backtests/batch` requires:

- `X-Axiom-Timestamp`: Unix seconds
- `X-Axiom-Job-Id`: body `job_id`
- `X-Axiom-Key-Id`: active signing-key identifier
- `X-Axiom-Signature`: lowercase hex HMAC-SHA256 of `timestamp + "." + job_id + "." + raw request body`, using `AXIOM_BACKTEST_SECRET`

`job_id` is the lowercase SHA-256 of the canonical complete request object with
only `job_id` removed. This makes conflicting reuse impossible across separate
Cloud Run instances; the in-memory replay window is only an optimization.

For V2, `dataset.sha256` hashes the sorted `bars_by_symbol` object and every symbol also has its own count, bounds and SHA-256. The immutable manifest binds the universe, calendar, feed, adjustment and regular-session contract. The service rejects mismatched, unsorted or out-of-scope data before execution.

V2 `windows` use timezone-qualified ISO timestamps with an end-exclusive bound; legacy V1 windows retain zero-based indexes. Cloudflare must submit only development bars for development runs and only the sealed holdout bars for holdout runs. The API does not accept hidden bar references or fetch market data itself.

V2 execution uses close decisions and next-tradable-open fills, signed long/short targets, a 0.5% isolated-strategy gross cap, DSL-derived warmup, forced session flattening, flatten-first reversals and deterministic partial-fill participation limits. Adverse base/range/participation slippage and the stress scenario are versioned execution configuration—not strategy DNA.

Each V2 window returns approved base-cost and stressed evidence, portfolio and per-symbol curves, signals, targets, orders, fills, closed round trips, rejected fills, session events, five-minute and end-of-day metrics, hashes and replay metadata. Lifecycle gates use the stressed window while retaining both artifacts.

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
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com
gcloud artifacts repositories create axiom-containers --repository-format=docker --location=europe-west1 --description="Axiom immutable backtester images"
gcloud secrets create axiom-backtest-secret --replication-policy=automatic
# Add the secret value in Google Cloud Console, or from a protected local file:
gcloud secrets versions add axiom-backtest-secret --data-file=.\protected-secret.txt
$projectNumber = gcloud projects describe YOUR_PROJECT_ID --format="value(projectNumber)"
gcloud secrets add-iam-policy-binding axiom-backtest-secret --member="serviceAccount:$projectNumber-compute@developer.gserviceaccount.com" --role="roles/secretmanager.secretAccessor"
.\deploy-cloud-run.ps1 -ProjectId YOUR_PROJECT_ID -CurrentKeyId production-paper-current
```

The deployment script pushes a unique tag to the regional `axiom-containers` Artifact Registry repository, resolves its immutable `sha256:` digest,
deploys that exact image and exposes the same digest as
`BACKTEST_IMAGE_DIGEST` for artifact provenance. A Cloud Run revision name is
never reported as an image digest.

The deployment is deliberately public at the HTTP layer because this integration uses signed requests rather than Google IAM identity tokens; HMAC authentication protects the only non-health endpoint. It allows zero minimum instances, so the container can scale down while idle and wake on demand. Set Cloudflare `BACKTEST_SERVICE_URL`, `BACKTEST_SERVICE_KEY_ID`, and `BACKTEST_SERVICE_SECRET` to the matching values.

For a bounded rotation, deploy with `-PreviousSecretName` and `-PreviousKeyId`, then switch Cloudflare to the new current key. Remove the previous pair after in-flight requests and the five-minute replay window have expired. Unknown key IDs, stale timestamps, conflicting deterministic job IDs, body mutations, and invalid signatures are rejected.

Smoke test after deployment:

```powershell
Invoke-RestMethod "$env:BACKTEST_SERVICE_URL/healthz"
```

Backtrader is GPLv3. Review its license obligations before production distribution.
