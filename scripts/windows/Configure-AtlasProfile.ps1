[CmdletBinding()]
param([string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA "Atlas Companion"))
$ErrorActionPreference = "Stop"
$templatePath = Join-Path $env:TEMP "atlas-profile.json"
$template = [ordered]@{
  identity = [ordered]@{ name = ""; email = ""; phone = ""; location = ""; links = @() }
  career = [ordered]@{ targetRoles = @(); workAuthorization = ""; salaryPreference = ""; skills = @(); workHistory = @(); education = @() }
  business = [ordered]@{ company = ""; offer = ""; targetAudience = ""; proofPoints = @(); preferredTone = "" }
  preferences = [ordered]@{ remotePreference = ""; excludedCompanies = @(); notes = "" }
}
$template | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $templatePath -Encoding UTF8
Write-Host "Complete the local Atlas profile in Notepad. Leave unknown fields blank. Do not add passwords, payment data, government IDs, tokens, or private keys."
Start-Process notepad.exe -ArgumentList $templatePath -Wait
$raw = Get-Content -Raw -LiteralPath $templatePath
$null = $raw | ConvertFrom-Json -ErrorAction Stop
if ($raw.Length -gt 32000) { throw "The profile is larger than 32 KB." }
foreach ($blocked in @("password", "passcode", "secret", "token", "privateKey", "ssn", "socialSecurity", "creditCard", "cvv", "routingNumber", "bankAccount")) {
  if ($raw -match ('"' + [regex]::Escape($blocked) + '"\s*:')) { throw "Remove the prohibited credential field: $blocked" }
}
New-Item -ItemType Directory -Path $InstallDirectory -Force | Out-Null
$secure = ConvertTo-SecureString $raw -AsPlainText -Force
$secure | ConvertFrom-SecureString | Set-Content -LiteralPath (Join-Path $InstallDirectory "profile.dat") -Encoding UTF8
Remove-Item -LiteralPath $templatePath -Force
Write-Host "Your encrypted local profile is ready." -ForegroundColor Green

