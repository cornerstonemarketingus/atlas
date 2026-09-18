[CmdletBinding()]
param([string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA "Atlas Companion"), [switch]$NoShortcut)
$ErrorActionPreference = "Stop"
if ($env:OS -ne "Windows_NT") { throw "The Atlas companion installer supports Windows only." }
$sourceRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$sourceApp = Join-Path $sourceRoot "apps\windows-companion"
foreach ($required in @("package.json", "src\index.mjs", "src\policy.mjs")) { if (-not (Test-Path -LiteralPath (Join-Path $sourceApp $required))) { throw "Package is incomplete: $required is missing." } }
foreach ($commandName in @("node", "npm")) { if (-not (Get-Command $commandName -ErrorAction SilentlyContinue)) { throw "$commandName is required and was not found on PATH." } }
$edgePath = Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe"
if (-not (Test-Path -LiteralPath $edgePath)) { throw "Microsoft Edge is required." }
New-Item -ItemType Directory -Path $InstallDirectory -Force | Out-Null
Copy-Item -LiteralPath $sourceApp -Destination $InstallDirectory -Recurse -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "Start-AtlasCompanion.ps1") -Destination $InstallDirectory -Force
$installedApp = Join-Path $InstallDirectory "windows-companion"
Push-Location $installedApp
try { & npm ci --omit=dev --ignore-scripts } finally { Pop-Location }
$secureCredential = Read-Host "Paste the one-time Atlas pairing credential" -AsSecureString
$credentialFile = Join-Path $InstallDirectory "pairing.dat"
$secureCredential | ConvertFrom-SecureString | Set-Content -LiteralPath $credentialFile -Encoding UTF8
if (-not $NoShortcut) {
  $startMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
  $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $startMenu "Atlas Companion.lnk"))
  $shortcut.TargetPath = (Get-Command powershell.exe).Source
  $shortcut.Arguments = "-NoProfile -ExecutionPolicy RemoteSigned -WindowStyle Minimized -File `"$(Join-Path $InstallDirectory 'Start-AtlasCompanion.ps1')`""
  $shortcut.WorkingDirectory = $InstallDirectory
  $shortcut.Save()
}
Write-Host "Atlas Companion installed. Launch it from the Start menu." -ForegroundColor Green
