[CmdletBinding()]
param([switch]$Disable)
$ErrorActionPreference = 'Stop'
$taskName = 'Atlas Free Local AI'
if ($Disable) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue; return }
$atlasRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$entry = Join-Path $atlasRoot 'scripts\windows\Start-AtlasSupervised.mjs'
if (-not (Test-Path -LiteralPath $entry)) { throw 'Atlas runtime is missing.' }
if ($entry.Contains('"')) { throw 'Unsupported installation path.' }
$node = (Get-Command node -ErrorAction Stop).Source
$owner = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute $node -Argument ('"' + $entry + '"') -WorkingDirectory $atlasRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $owner
$principal = New-ScheduledTaskPrincipal -UserId $owner -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Restore this user''s Atlas local AI after sign-in. No administrator privileges or stored password.' -Force | Out-Null
Write-Output 'Atlas will start after you sign in to Windows.'
