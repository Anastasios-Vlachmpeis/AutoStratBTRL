param(
  [Parameter(Mandatory=$true)][string]$ProjectId,
  [string]$Region = "europe-west1",
  [string]$Service = "axiom-backtester"
)

$RepositoryRoot = Split-Path -Parent $PSScriptRoot
gcloud builds submit $RepositoryRoot --config "$PSScriptRoot/cloudbuild.yaml" --substitutions "_IMAGE=gcr.io/$ProjectId/$Service"
gcloud run deploy $Service --image "gcr.io/$ProjectId/$Service" --region $Region --platform managed --cpu 1 --memory 512Mi --concurrency 1 --min-instances 0 --max-instances 3 --timeout 300 --allow-unauthenticated --set-secrets "AXIOM_BACKTEST_SECRET=axiom-backtest-secret:latest"
