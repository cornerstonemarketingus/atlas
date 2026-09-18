[CmdletBinding()]
param(
  [string]$OutputDirectory = (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) "dist"),
  [string]$CertificateThumbprint = $env:ATLAS_WINDOWS_CERTIFICATE_THUMBPRINT
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$manifest = Get-Content -Raw -LiteralPath (Join-Path $root "apps\windows-companion\package.json") | ConvertFrom-Json
$name = "atlas-windows-companion-$($manifest.version)"
$stagingRoot = Join-Path ([IO.Path]::GetTempPath()) ("atlas-package-" + [guid]::NewGuid())
$staging = Join-Path $stagingRoot $name
try {
  New-Item -ItemType Directory -Path (Join-Path $staging "apps") -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $staging "scripts\windows") -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $root "apps\windows-companion") -Destination (Join-Path $staging "apps") -Recurse
  foreach ($scriptName in @("Install-AtlasCompanion.ps1", "Start-AtlasCompanion.ps1", "Run-AtlasCompanion.ps1", "Test-AtlasCompanion.ps1", "Configure-AtlasProfile.ps1")) {
    $target = Join-Path $staging "scripts\windows\$scriptName"
    Copy-Item -LiteralPath (Join-Path $root "scripts\windows\$scriptName") -Destination $target
    if ($CertificateThumbprint) {
      $signature = Set-AuthenticodeSignature -FilePath $target -Certificate (Get-Item "Cert:\CurrentUser\My\$CertificateThumbprint") -HashAlgorithm SHA256
      if ($signature.Status -ne "Valid") { throw "Signing $scriptName failed: $($signature.StatusMessage)" }
    }
  }
  Remove-Item -LiteralPath (Join-Path $staging "apps\windows-companion\node_modules") -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
  $archive = Join-Path $OutputDirectory "$name.zip"
  Compress-Archive -LiteralPath $staging -DestinationPath $archive -CompressionLevel Optimal -Force
  $hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
  "$hash  $([IO.Path]::GetFileName($archive))" | Set-Content -LiteralPath "$archive.sha256" -Encoding ascii
  [ordered]@{ artifact = $archive; sha256 = $hash; version = $manifest.version; signed = [bool]$CertificateThumbprint } | ConvertTo-Json
} finally {
  if (Test-Path -LiteralPath $stagingRoot) { Remove-Item -LiteralPath $stagingRoot -Recurse -Force }
}
