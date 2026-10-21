[CmdletBinding()]
param(
  [string]$Model = "",
  [string]$DataDirectory = "",
  [switch]$SkipModelCheck
)

$ErrorActionPreference = "Stop"
if ($DataDirectory) { $env:ATLAS_LOCAL_DATA_DIR = $DataDirectory }
$atlasRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$controlPath = Join-Path $atlasRoot "apps\local-control"
if (-not (Test-Path -LiteralPath (Join-Path $controlPath "src\main.mjs"))) {
  throw "Atlas Local files are missing from $controlPath."
}

foreach ($commandName in @("node", "git")) {
  if (-not (Get-Command $commandName -ErrorAction SilentlyContinue)) {
    throw "$commandName is required but was not found on PATH."
  }
}

$localPort = if ($env:ATLAS_LOCAL_PORT) { $env:ATLAS_LOCAL_PORT } else { "4317" }
$running = $null
try { $running = Invoke-RestMethod -Uri "http://127.0.0.1:$localPort/health" -TimeoutSec 2 } catch { }
if ($running.status -eq "ok" -and $running.mode -eq "sovereign") {
  Write-Host "Atlas is already running with $($running.model). Opening it."
  & node (Join-Path $atlasRoot "scripts\local\open-atlas.mjs")
  return
}

if (-not $SkipModelCheck) {
  $ollama = Get-Command "ollama" -ErrorAction SilentlyContinue
  if (-not $ollama) {
    Write-Host "No local model runtime yet. Open Models in Atlas to install one, or get Ollama from https://ollama.com/download/windows." -ForegroundColor Yellow
  } else {
  $installedModels = @(& $ollama.Source list 2>$null | Select-Object -Skip 1 | ForEach-Object { ($_ -split '\s+')[0] })
  if (-not $Model) {
    $memoryGiB = (Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB
    $preferred = if ($memoryGiB -ge 14) { @("qwen2.5-coder:7b", "qwen3:4b", "qwen3:1.7b", "qwen2.5-coder:1.5b", "qwen3:0.6b") } else { @("qwen3:1.7b", "qwen2.5-coder:1.5b", "qwen3:0.6b") }
    $Model = $preferred | Where-Object { $installedModels -contains $_ } | Select-Object -First 1
  }
  if ($installedModels -notcontains $Model) {
    Write-Host "Local model '$Model' was not found. Install it from Models in Atlas, or run: ollama pull $Model" -ForegroundColor Yellow
  }
  }
}

if ($Model) {
  $env:ATLAS_MODEL = $Model
  $env:ATLAS_TEAM_MODEL = $Model
  $env:ATLAS_WORKFORCE_MODEL = $Model
  Write-Host "Atlas local model: $Model (no provider API key required)."
}
Set-Location -LiteralPath $controlPath
# Signs the browser in as this Windows account: the owner token stays in DPAPI and goes to the page in the URL fragment.
$env:ATLAS_OPEN_BROWSER = "1"
& node "src\main.mjs"

