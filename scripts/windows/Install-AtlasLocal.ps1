[CmdletBinding()]
param(
  [string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA "Atlas Local"),
  [switch]$NoShortcut
)

$ErrorActionPreference = "Stop"
if ($env:OS -ne "Windows_NT") { throw "This installer supports Windows only." }
$sourceRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$required = @("apps\local-control", "scripts\local", "scripts\windows\Start-AtlasLocal.ps1", "scripts\release\stage-local.mjs", "packages\atlas-cli\dist\src\cli.js")
foreach ($relativePath in $required) {
  if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot $relativePath))) { throw "Package is incomplete: $relativePath is missing." }
}
foreach ($commandName in @("node", "git")) {
  if (-not (Get-Command $commandName -ErrorAction SilentlyContinue)) { throw "$commandName is required and was not found on PATH." }
}
$nodeMajor = [int]((& node --version).TrimStart("v").Split(".")[0])
if ($nodeMajor -lt 22) { throw "Atlas Local requires Node.js 22 or newer." }

New-Item -ItemType Directory -Path $InstallDirectory -Force | Out-Null
& node (Join-Path $sourceRoot 'scripts\release\stage-local.mjs') --output $InstallDirectory
if ($LASTEXITCODE -ne 0) { throw 'Atlas runtime payload could not be installed.' }

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
  Write-Host "Open Models -> Free Local AI in Atlas to install and verify a runtime automatically."
}
Write-Host "Atlas Local installed at $InstallDirectory" -ForegroundColor Green
Write-Host "Launcher: $launcher"

