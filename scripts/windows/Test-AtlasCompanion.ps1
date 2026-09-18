[CmdletBinding()]
param([string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA "Atlas Companion"), [switch]$NonBlocking)
$ErrorActionPreference = "Stop"

function Find-Edge {
  foreach ($candidate in @(
    (Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe"),
    (Join-Path $env:ProgramFiles "Microsoft\Edge\Application\msedge.exe")
  )) { if (Test-Path -LiteralPath $candidate) { return $candidate } }
  return $null
}

$memoryBytes = (Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory
$memoryGiB = [math]::Round($memoryBytes / 1GB, 1)
$models = @()
if (Get-Command ollama -ErrorAction SilentlyContinue) {
  $models = @(& ollama list 2>$null | Select-Object -Skip 1 | ForEach-Object { ($_ -split '\s+')[0] } | Where-Object { $_ })
}
$recommendations = if ($memoryGiB -ge 30) { @("qwen2.5-coder:14b", "qwen2.5-coder:7b", "qwen2.5-coder:3b") } elseif ($memoryGiB -ge 14) { @("qwen2.5-coder:7b", "qwen2.5-coder:3b") } else { @("qwen2.5-coder:3b", "qwen2.5-coder:1.5b") }
$selected = $recommendations | Where-Object { $models -contains $_ } | Select-Object -First 1
$result = [ordered]@{
  windows = $env:OS -eq "Windows_NT"
  node = if (Get-Command node -ErrorAction SilentlyContinue) { (& node --version) } else { $null }
  npm = if (Get-Command npm -ErrorAction SilentlyContinue) { (& npm --version) } else { $null }
  edge = Find-Edge
  ollama = if (Get-Command ollama -ErrorAction SilentlyContinue) { (& ollama --version 2>&1 | Out-String).Trim() } else { $null }
  memoryGiB = $memoryGiB
  installedModels = $models
  selectedModel = $selected
  recommendedModel = $recommendations[0]
  paired = Test-Path -LiteralPath (Join-Path $InstallDirectory "pairing.dat")
}
$result | ConvertTo-Json -Depth 3
$ready = $result.windows -and $result.node -and $result.npm -and $result.edge -and $result.ollama -and $selected
if (-not $ready -and -not $NonBlocking) {
  if (-not $selected) { Write-Error "No suitable installed model. Run: ollama pull $($recommendations[0])" }
  exit 1
}
