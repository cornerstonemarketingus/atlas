[CmdletBinding()]
param(
  [string]$Model = "qwen2.5-coder:7b",
  [switch]$SkipModelCheck
)

$ErrorActionPreference = "Stop"
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

if (-not $SkipModelCheck) {
  $ollama = Get-Command "ollama" -ErrorAction SilentlyContinue
  if (-not $ollama) {
    Write-Host "No local model runtime yet. Open Models in Atlas to install one, or get Ollama from https://ollama.com/download/windows." -ForegroundColor Yellow
  } else {
  $installedModels = @(& $ollama.Source list 2>$null | Select-Object -Skip 1 | ForEach-Object { ($_ -split '\s+')[0] })
  if ($installedModels -notcontains $Model) {
    Write-Host "Local model '$Model' was not found. Install it from Models in Atlas, or run: ollama pull $Model" -ForegroundColor Yellow
  }
  }
}

Set-Location -LiteralPath $controlPath
# Signs the browser in as this Windows account: the owner token stays in DPAPI and goes to the page in the URL fragment.
$env:ATLAS_OPEN_BROWSER = "1"
& node (Join-Path $atlasRoot 'scripts\windows\Start-AtlasSupervised.mjs')

