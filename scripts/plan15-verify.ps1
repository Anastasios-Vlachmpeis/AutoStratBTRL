param(
  [string]$Python = "",
  [switch]$SkipBacktester
)

$ErrorActionPreference = "Stop"
$RepositoryRoot = Split-Path -Parent $PSScriptRoot
Push-Location $RepositoryRoot
try {
  $Plan14Arguments = @{}
  if ($Python) { $Plan14Arguments.Python = $Python }
  if ($SkipBacktester) { $Plan14Arguments.SkipBacktester = $true }
  & "$PSScriptRoot\plan14-verify.ps1" @Plan14Arguments
  if ($LASTEXITCODE -ne 0) { throw "Plan 14 prerequisite verification failed" }

  npm.cmd run test:plan15
  if ($LASTEXITCODE -ne 0) { throw "Plan 15 boundary suite failed" }
  npm.cmd run test:plan15:coverage
  if ($LASTEXITCODE -ne 0) { throw "Plan 15 boundary coverage fell below 90 percent" }
  Write-Host "Plan 15 local verification passed. SIP and real-money remain non-activating future gates."
} finally {
  Pop-Location
}
