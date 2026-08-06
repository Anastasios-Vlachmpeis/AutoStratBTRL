param(
  [string]$Python = "",
  [switch]$SkipBacktester
)

$ErrorActionPreference = "Stop"
$RepositoryRoot = Split-Path -Parent $PSScriptRoot
Push-Location $RepositoryRoot
try {
  npm.cmd run scan:secrets
  if ($LASTEXITCODE -ne 0) { throw "Secret scan failed" }
  npm.cmd run check
  if ($LASTEXITCODE -ne 0) { throw "Existing regression suite failed" }
  npm.cmd run test:plan13
  if ($LASTEXITCODE -ne 0) { throw "Plan 13 suite failed" }
  npm.cmd run test:plan14
  if ($LASTEXITCODE -ne 0) { throw "Plan 14 suite failed" }
  npm.cmd run test:plan14:coverage
  if ($LASTEXITCODE -ne 0) { throw "Plan 14 rollout-control coverage fell below 90 percent" }

  if (-not $Python) {
    $Candidates = @(".venv\Scripts\python.exe", ".venv-plan13\Scripts\python.exe", "python")
    $Python = $Candidates | Where-Object { $_ -eq "python" -or (Test-Path $_) } | Select-Object -First 1
  }
  if (-not $Python) { throw "Python 3.11 is required for migration and service verification" }
  & $Python -m unittest discover -s tests -v
  if ($LASTEXITCODE -ne 0) { throw "Python migration/legacy suite failed" }
  if (-not $SkipBacktester) {
    & $Python -m pytest backtester_service/tests -q
    if ($LASTEXITCODE -ne 0) { throw "Pinned FastAPI/Backtrader suite failed" }
  }
  Write-Host "Plan 14 local verification passed. Cloud and paper rollout gates remain separate."
} finally {
  Pop-Location
}
