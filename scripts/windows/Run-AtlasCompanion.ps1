[CmdletBinding()]
param([int]$MaximumRestarts = 5)
$ErrorActionPreference = "Stop"
$launcher = Join-Path $PSScriptRoot "Start-AtlasCompanion.ps1"
$logDirectory = Join-Path $PSScriptRoot "logs"
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$log = Join-Path $logDirectory "companion.log"
if ((Test-Path -LiteralPath $log) -and (Get-Item -LiteralPath $log).Length -gt 5MB) { Move-Item -LiteralPath $log -Destination "$log.previous" -Force }

for ($attempt = 0; $attempt -le $MaximumRestarts; $attempt += 1) {
  try { & $launcher *>> $log; $code = $LASTEXITCODE } catch { $_ | Out-String | Add-Content -LiteralPath $log; $code = 1 }
  if ($code -eq 0) { exit 0 }
  if ($attempt -eq $MaximumRestarts) { throw "Atlas Companion stopped after $MaximumRestarts restart attempts. See $log" }
  $delay = [math]::Min(60, [math]::Pow(2, $attempt + 1))
  "$(Get-Date -Format o) Companion exited with code $code; restarting in ${delay}s." | Add-Content -LiteralPath $log
  Start-Sleep -Seconds $delay
}
