<#
.SYNOPSIS
  Builds the Atlas MSI, signs it when a certificate is configured, and writes
  the checksums, SBOM and signed update manifest beside it.

.DESCRIPTION
  The MSI has to be built on Windows. Everything that proves what is in it --
  checksums, SBOM, update manifest -- is produced by a cross-platform Node
  script, so a reviewer can reproduce the verification without a Windows
  machine.

  Nothing here installs a prerequisite. Missing dependencies are reported and
  the build continues, because the developer building an installer and the
  operator running it are not the same person.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$OutputDirectory = "dist",
  [string]$SigningKeyPath,
  [string]$RollbackTo,
  [switch]$SkipSigning
)

$ErrorActionPreference = "Stop"
$repository = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$staging = Join-Path $repository "$OutputDirectory\staging"
$artifacts = Join-Path $repository "$OutputDirectory\artifacts"

if ($Version -notmatch '^\d+\.\d+\.\d+$') {
  throw "Version must be a three-part version such as 1.2.0; MSI does not accept anything else."
}

Write-Host "Staging the Atlas payload..."
Remove-Item -Recurse -Force $staging, $artifacts -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $staging, $artifacts -Force | Out-Null

& npm --prefix (Join-Path $repository 'packages\atlas-cli') run build
if ($LASTEXITCODE -ne 0) { throw 'The release coding runner must compile before packaging.' }
& node (Join-Path $repository 'scripts\release\stage-local.mjs') --output $staging
if ($LASTEXITCODE -ne 0) { throw 'Atlas runtime payload could not be staged.' }
Copy-Item -LiteralPath (Join-Path $repository 'SOVEREIGN-MODE.md') -Destination $staging

# node_modules is deliberately excluded: the local control plane has no
# third-party runtime dependencies, and shipping a companion's node_modules
# would make the SBOM a lie by omission.
Get-ChildItem -Path $staging -Directory -Recurse -Filter node_modules |
  ForEach-Object { Remove-Item -Recurse -Force $_.FullName }

Write-Host "Checking prerequisites on this machine (installing nothing)..."
& node (Join-Path $repository "scripts\windows\report-requirements.mjs")

Write-Host "Harvesting the payload into a component group..."
$harvested = Join-Path $repository "$OutputDirectory\AtlasFiles.wxs"
& wix extension add WixToolset.UI.wixext --global 2>&1 | Out-Null
& wix build --help | Out-Null  # Fails loudly here if the WiX toolset is absent.
& heat dir $staging -cg AtlasFiles -dr INSTALLFOLDER -gg -g1 -sfrag -srd -sreg -var var.StagingPath -out $harvested

$msi = Join-Path $artifacts "Atlas-$Version.msi"
& wix build `
  (Join-Path $repository "installer\windows\Atlas.wxs") $harvested `
  -ext WixToolset.UI.wixext `
  -d AtlasVersion=$Version `
  -d StagingPath=$staging `
  -d LicenseRtf=(Join-Path $repository "installer\windows\License.rtf") `
  -o $msi
if ($LASTEXITCODE -ne 0) { throw "wix build failed with exit code $LASTEXITCODE." }

if (-not $SkipSigning) {
  if (-not $env:ATLAS_WINDOWS_CERTIFICATE_BASE64) {
    throw "No Authenticode certificate is configured. Public releases must be signed; pass -SkipSigning for a development build."
  }
  $pfx = Join-Path $env:TEMP "atlas-signing.pfx"
  try {
    [IO.File]::WriteAllBytes($pfx, [Convert]::FromBase64String($env:ATLAS_WINDOWS_CERTIFICATE_BASE64))
    & signtool sign /fd SHA256 /td SHA256 /tr http://timestamp.digicert.com `
      /f $pfx /p $env:ATLAS_WINDOWS_CERTIFICATE_PASSWORD $msi
    if ($LASTEXITCODE -ne 0) { throw "signtool failed with exit code $LASTEXITCODE." }
    & signtool verify /pa /v $msi
    if ($LASTEXITCODE -ne 0) { throw "The signed MSI did not verify." }
  } finally {
    # The certificate never outlives the build that used it.
    if (Test-Path $pfx) { Remove-Item -Force $pfx }
  }
} else {
  Write-Warning "Producing an unsigned development build. SmartScreen will warn on this artifact."
}

Write-Host "Writing checksums, SBOM and update manifest..."
$arguments = @("scripts/release/make-release.mjs", "--version", $Version, "--artifacts", $artifacts, "--product", "Atlas")
if ($RollbackTo) { $arguments += @("--rollback-to", $RollbackTo) }
if ($SigningKeyPath) { $arguments += @("--signing-key", $SigningKeyPath) }
& node @arguments
if ($LASTEXITCODE -ne 0) { throw "Release metadata generation failed." }

Write-Host "Done. Artifacts are in $artifacts."
Get-ChildItem $artifacts | Format-Table Name, Length
