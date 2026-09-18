[CmdletBinding()]
param([string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA "Atlas Companion"), [switch]$NoShortcut)
$ErrorActionPreference = "Stop"
if ($env:OS -ne "Windows_NT") { throw "The Atlas companion installer supports Windows only." }
$sourceRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$sourceApp = Join-Path $sourceRoot "apps\windows-companion"
foreach ($required in @("package.json", "package-lock.json", "src\index.mjs", "src\policy.mjs", "src\runtime.mjs")) { if (-not (Test-Path -LiteralPath (Join-Path $sourceApp $required))) { throw "Package is incomplete: $required is missing." } }
foreach ($commandName in @("node", "npm")) { if (-not (Get-Command $commandName -ErrorAction SilentlyContinue)) { throw "$commandName is required and was not found on PATH." } }
$edgePath = Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe"
if (-not (Test-Path -LiteralPath $edgePath)) { throw "Microsoft Edge is required." }
New-Item -ItemType Directory -Path $InstallDirectory -Force | Out-Null
$installedApp = Join-Path $InstallDirectory "windows-companion"
$backupApp = Join-Path $InstallDirectory "windows-companion.previous"
if (Test-Path -LiteralPath $backupApp) { Remove-Item -LiteralPath $backupApp -Recurse -Force }
if (Test-Path -LiteralPath $installedApp) { Move-Item -LiteralPath $installedApp -Destination $backupApp }
try { Copy-Item -LiteralPath $sourceApp -Destination $installedApp -Recurse -Force }
catch {
  if (Test-Path -LiteralPath $installedApp) { Remove-Item -LiteralPath $installedApp -Recurse -Force }
  if (Test-Path -LiteralPath $backupApp) { Move-Item -LiteralPath $backupApp -Destination $installedApp }
  throw
}
foreach ($scriptName in @("Start-AtlasCompanion.ps1", "Run-AtlasCompanion.ps1", "Test-AtlasCompanion.ps1", "Configure-AtlasProfile.ps1")) {
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot $scriptName) -Destination $InstallDirectory -Force
}
Push-Location $installedApp
try { & npm ci --omit=dev --ignore-scripts; if ($LASTEXITCODE -ne 0) { throw "npm dependency installation failed." } }
catch {
  Pop-Location
  Remove-Item -LiteralPath $installedApp -Recurse -Force
  if (Test-Path -LiteralPath $backupApp) { Move-Item -LiteralPath $backupApp -Destination $installedApp }
  throw
}
finally { if ((Get-Location).Path -eq $installedApp) { Pop-Location } }
if (Test-Path -LiteralPath $backupApp) { Remove-Item -LiteralPath $backupApp -Recurse -Force }
$secureCredential = Read-Host "Paste the one-time Atlas pairing credential" -AsSecureString
$credentialFile = Join-Path $InstallDirectory "pairing.dat"
$secureCredential | ConvertFrom-SecureString | Set-Content -LiteralPath $credentialFile -Encoding UTF8
if (-not $NoShortcut) {
  $startMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
  $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $startMenu "Atlas Companion.lnk"))
  $shortcut.TargetPath = (Get-Command powershell.exe).Source
  $shortcut.Arguments = "-NoProfile -ExecutionPolicy RemoteSigned -WindowStyle Minimized -File `"$(Join-Path $InstallDirectory 'Run-AtlasCompanion.ps1')`""
  $shortcut.WorkingDirectory = $InstallDirectory
  $shortcut.Save()
}
Write-Host "Atlas Companion installed. Launch it from the Start menu." -ForegroundColor Green
& (Join-Path $InstallDirectory "Test-AtlasCompanion.ps1") -InstallDirectory $InstallDirectory -NonBlocking
if ((Read-Host "Configure your encrypted local work profile now? (Y/n)") -notmatch '^[Nn]') { & (Join-Path $InstallDirectory "Configure-AtlasProfile.ps1") -InstallDirectory $InstallDirectory }
