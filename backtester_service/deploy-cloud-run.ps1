param(
  [Parameter(Mandatory=$true)][string]$ProjectId,
  [string]$Region = "europe-west1",
  [string]$Service = "axiom-backtester"
)

$ErrorActionPreference = "Stop"
$RepositoryRoot = Split-Path -Parent $PSScriptRoot
$Tag = [DateTimeOffset]::UtcNow.ToString("yyyyMMddHHmmss")
$TaggedImage = "gcr.io/$ProjectId/${Service}:$Tag"
gcloud builds submit $RepositoryRoot --config "$PSScriptRoot/cloudbuild.yaml" --substitutions "_IMAGE=$TaggedImage"
if ($LASTEXITCODE -ne 0) { throw "Cloud Build failed" }

$Digest = (gcloud container images describe $TaggedImage --format="value(image_summary.digest)").Trim()
if ($LASTEXITCODE -ne 0 -or $Digest -notmatch '^sha256:[a-f0-9]{64}$') {
  throw "Could not resolve an immutable container digest for $TaggedImage"
}
$ImmutableImage = "gcr.io/$ProjectId/${Service}@$Digest"
gcloud run deploy $Service --image $ImmutableImage --region $Region --platform managed --cpu 1 --memory 512Mi --concurrency 1 --min-instances 0 --max-instances 3 --timeout 300 --allow-unauthenticated --set-secrets "AXIOM_BACKTEST_SECRET=axiom-backtest-secret:latest" --set-env-vars "BACKTEST_IMAGE_DIGEST=$Digest"
if ($LASTEXITCODE -ne 0) { throw "Cloud Run deployment failed" }

Write-Host "Deployed $ImmutableImage"
