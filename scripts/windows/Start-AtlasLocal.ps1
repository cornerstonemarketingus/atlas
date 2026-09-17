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
  if (-not $ollama) { throw "Ollama is not installed. Install it from https://ollama.com/download/windows and rerun Atlas Local." }
  $installedModels = @(& $ollama.Source list 2>$null | Select-Object -Skip 1 | ForEach-Object { ($_ -split '\s+')[0] })
  if ($installedModels -notcontains $Model) {
    Write-Host "Local model '$Model' was not found. Download it with: ollama pull $Model" -ForegroundColor Yellow
  }
}

Set-Location -LiteralPath $controlPath
& node "src\main.mjs"

