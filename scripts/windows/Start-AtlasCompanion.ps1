[CmdletBinding()]
param([string]$Model = "", [string]$OllamaUrl = "http://127.0.0.1:11434")
$ErrorActionPreference = "Stop"
$installDirectory = $PSScriptRoot
$appDirectory = Join-Path $installDirectory "windows-companion"
$credentialFile = Join-Path $installDirectory "pairing.dat"
if (-not (Test-Path -LiteralPath $credentialFile)) { throw "Atlas pairing is missing. Run Install-AtlasCompanion.ps1 again." }
if (-not (Get-Command "ollama" -ErrorAction SilentlyContinue)) { throw "Ollama is required. Install it from https://ollama.com/download/windows." }
$installedModels = @(& ollama list 2>$null | Select-Object -Skip 1 | ForEach-Object { ($_ -split '\s+')[0] })
$memoryGiB = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB, 1)
if (-not $Model) {
  $preferred = if ($memoryGiB -ge 30) { @("qwen2.5-coder:14b", "qwen2.5-coder:7b", "qwen2.5-coder:3b") } elseif ($memoryGiB -ge 14) { @("qwen2.5-coder:7b", "qwen2.5-coder:3b") } else { @("qwen2.5-coder:3b", "qwen2.5-coder:1.5b") }
  $Model = $preferred | Where-Object { $installedModels -contains $_ } | Select-Object -First 1
  if (-not $Model) { throw "No suitable local model is installed for this ${memoryGiB} GiB PC. Run: ollama pull $($preferred[0])" }
}
if ($installedModels -notcontains $Model) { throw "Local model '$Model' is not installed. Run: ollama pull $Model" }
$secureCredential = Get-Content -Raw -LiteralPath $credentialFile | ConvertTo-SecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureCredential)
try { $env:ATLAS_DEVICE_CREDENTIAL = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
$env:ATLAS_COMPUTER_MODEL = $Model
$env:ATLAS_OLLAMA_URL = $OllamaUrl
$profileFile = Join-Path $installDirectory "profile.dat"
if (Test-Path -LiteralPath $profileFile) {
  $secureProfile = Get-Content -Raw -LiteralPath $profileFile | ConvertTo-SecureString
  $profilePointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureProfile)
  try { $env:ATLAS_PROFILE_JSON = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($profilePointer) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($profilePointer) }
}
try { Set-Location -LiteralPath $appDirectory; & node "src\index.mjs" } finally { Remove-Item Env:ATLAS_DEVICE_CREDENTIAL -ErrorAction SilentlyContinue; Remove-Item Env:ATLAS_PROFILE_JSON -ErrorAction SilentlyContinue }
