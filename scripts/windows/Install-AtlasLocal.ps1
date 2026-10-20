[CmdletBinding()]
param(
  [string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA "Atlas Local"),
  [switch]$NoShortcut
)

$ErrorActionPreference = "Stop"
if ($env:OS -ne "Windows_NT") { throw "This installer supports Windows only." }
$sourceRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$required = @("apps\local-control", "scripts\local", "scripts\windows\Start-AtlasLocal.ps1", "scripts\runner\merge-decision.mjs", "packages\atlas-contracts\src\index.mjs")
foreach ($relativePath in $required) {
  if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot $relativePath))) { throw "Package is incomplete: $relativePath is missing." }
}
foreach ($commandName in @("node", "git")) {
  if (-not (Get-Command $commandName -ErrorAction SilentlyContinue)) { throw "$commandName is required and was not found on PATH." }
}
$nodeMajor = [int]((& node --version).TrimStart("v").Split(".")[0])
if ($nodeMajor -lt 22) { throw "Atlas Local requires Node.js 22 or newer." }

New-Item -ItemType Directory -Path $InstallDirectory -Force | Out-Null
foreach ($relativePath in @("apps", "scripts")) {
  Copy-Item -LiteralPath (Join-Path $sourceRoot $relativePath) -Destination $InstallDirectory -Recurse -Force
}
# The daemon imports these dependency-free shared contracts by relative path.
$packagesDirectory = Join-Path $InstallDirectory "packages"
New-Item -ItemType Directory -Path $packagesDirectory -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $sourceRoot "packages\atlas-contracts") -Destination $packagesDirectory -Recurse -Force

$launcher = Join-Path $InstallDirectory "scripts\windows\Start-AtlasLocal.ps1"
if (-not $NoShortcut) {
  $startMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
  $shortcutPath = Join-Path $startMenu "Atlas Local.lnk"
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = (Get-Command powershell.exe).Source
  $shortcut.Arguments = "-NoProfile -ExecutionPolicy RemoteSigned -File `"$launcher`""
  $shortcut.WorkingDirectory = $InstallDirectory
  $shortcut.Save()
}

$ollama = Get-Command "ollama" -ErrorAction SilentlyContinue
if ($ollama) {
  $models = @(& $ollama.Source list 2>$null | Select-Object -Skip 1 | ForEach-Object { ($_ -split '\s+')[0] })
  Write-Host "Discovered local models: $($models -join ', ')"
} else {
  Write-Warning "Ollama was not found. Install it before starting a coding task: https://ollama.com/download/windows"
}
Write-Host "Atlas Local installed at $InstallDirectory" -ForegroundColor Green
Write-Host "Launcher: $launcher"

