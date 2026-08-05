param(
  [string]$Config = "wrangler.staging.example.jsonc",
  [string]$BacktestServiceUrl = ""
)

$ErrorActionPreference = "Stop"
$RepositoryRoot = Split-Path -Parent $PSScriptRoot
Push-Location $RepositoryRoot
try {
  npm.cmd run scan:secrets
  if ($LASTEXITCODE -ne 0) { throw "Secret scan failed" }
  npm.cmd run test:plan13
  if ($LASTEXITCODE -ne 0) { throw "Plan 13 tests failed" }

  $Configuration = Get-Content $Config -Raw | ConvertFrom-Json
  if ($Configuration.vars.ALPACA_TRADING_ENABLED -ne "false" -or
      $Configuration.vars.ALPACA_LONG_TRADING_ENABLED -ne "false" -or
      $Configuration.vars.ALPACA_SHORT_TRADING_ENABLED -ne "false") {
    throw "Smoke tests require all Alpaca submission switches to remain false"
  }
  if ($Configuration.vars.COST_CONTROL_ENABLED -ne "true") { throw "Remote cost control must be enabled" }
  if ($BacktestServiceUrl) {
    $Health = Invoke-RestMethod "$($BacktestServiceUrl.TrimEnd('/'))/healthz"
    if ($Health.status -ne "ok") { throw "Backtrader health check failed" }
  }
  Write-Host "Plan 13 smoke checks passed for $Config"
} finally {
  Pop-Location
}
