param(
  [Parameter(Mandatory=$true)][string]$ProjectId,
  [string]$Region = "europe-west1",
  [string]$Service = "axiom-backtester",
  [string]$ArtifactRepository = "axiom-containers",
  [string]$CurrentSecretName = "axiom-backtest-secret",
  [string]$CurrentKeyId = "production-paper-current",
  [string]$PreviousSecretName = "",
  [string]$PreviousKeyId = "",
  [string]$ServiceAccount = ""
)

$ErrorActionPreference = "Stop"
$RepositoryRoot = Split-Path -Parent $PSScriptRoot
$Tag = [DateTimeOffset]::UtcNow.ToString("yyyyMMddHHmmss")
$ImagePath = "${Region}-docker.pkg.dev/${ProjectId}/${ArtifactRepository}/${Service}"
$TaggedImage = "$ImagePath`:$Tag"
gcloud builds submit $RepositoryRoot --config "$PSScriptRoot/cloudbuild.yaml" --substitutions "_IMAGE=$TaggedImage"
if ($LASTEXITCODE -ne 0) { throw "Cloud Build failed" }

$Digest = (gcloud artifacts docker images describe $TaggedImage --format="value(image_summary.digest)").Trim()
if ($LASTEXITCODE -ne 0 -or $Digest -notmatch '^sha256:[a-f0-9]{64}$') {
  throw "Could not resolve an immutable container digest for $TaggedImage"
}
$ImmutableImage = "$ImagePath@$Digest"
$SecretBindings = "AXIOM_BACKTEST_SECRET=$CurrentSecretName`:latest"
$EnvironmentVariables = "BACKTEST_IMAGE_DIGEST=$Digest,AXIOM_BACKTEST_KEY_ID=$CurrentKeyId"
if ($PreviousSecretName -or $PreviousKeyId) {
  if (-not $PreviousSecretName -or -not $PreviousKeyId) {
    throw "PreviousSecretName and PreviousKeyId must be supplied together during rotation"
  }
  $SecretBindings += ",AXIOM_BACKTEST_PREVIOUS_SECRET=$PreviousSecretName`:latest"
  $EnvironmentVariables += ",AXIOM_BACKTEST_PREVIOUS_KEY_ID=$PreviousKeyId"
}

$DeployArguments = @("run", "deploy", $Service, "--image", $ImmutableImage, "--region", $Region,
  "--platform", "managed", "--cpu", "1", "--memory", "512Mi", "--concurrency", "1",
  "--min-instances", "0", "--max-instances", "3", "--timeout", "300", "--allow-unauthenticated",
  "--set-secrets", $SecretBindings, "--set-env-vars", $EnvironmentVariables)
if ($ServiceAccount) { $DeployArguments += @("--service-account", $ServiceAccount) }
& gcloud @DeployArguments
if ($LASTEXITCODE -ne 0) { throw "Cloud Run deployment failed" }

Write-Host "Deployed $ImmutableImage"
