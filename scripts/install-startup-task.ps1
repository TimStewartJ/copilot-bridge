param(
  [string]$TaskName = "Copilot Bridge",
  [string]$StateRoot = $env:BRIDGE_STATE_ROOT,
  [switch]$RunNow
)

$ErrorActionPreference = "Stop"

function ConvertTo-PowerShellSingleQuotedLiteral($Value) {
  return "'" + $Value.Replace("'", "''") + "'"
}

if (-not (Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue)) {
  throw "Windows Scheduled Tasks are not available on this machine."
}

$installRoot = (Resolve-Path $PSScriptRoot).Path
$bridgeReleaseCommonScript = Join-Path $PSScriptRoot "release-common.ps1"
if (-not (Test-Path $bridgeReleaseCommonScript)) {
  throw "Shared release helper not found at $bridgeReleaseCommonScript. The install package may be incomplete; reinstall Copilot Bridge."
}
. $bridgeReleaseCommonScript

$stateRootFile = Join-Path $installRoot ".bridge-state-root"
$storedStateRoot = Get-StoredStateRoot $stateRootFile
$startScript = Join-Path $installRoot "start.ps1"
if (-not (Test-Path $startScript)) {
  throw "start.ps1 was not found at $startScript. Run this script from the Copilot Bridge release root."
}
if (-not [string]::IsNullOrWhiteSpace($StateRoot)) {
  Assert-AbsolutePath "StateRoot" $StateRoot
}
Assert-StateRootDoesNotSwitch $storedStateRoot $StateRoot $stateRootFile
if (-not [string]::IsNullOrWhiteSpace($StateRoot)) {
  Set-Content -Path $stateRootFile -Value $StateRoot -Encoding UTF8
}

$powerShellPath = if (Get-Command powershell.exe -ErrorAction SilentlyContinue) {
  (Get-Command powershell.exe).Source
} elseif (Get-Command powershell -ErrorAction SilentlyContinue) {
  (Get-Command powershell).Source
} else {
  throw "Windows PowerShell was not found."
}

if ([string]::IsNullOrWhiteSpace($StateRoot)) {
  $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$startScript`""
} else {
  $stateRootLiteral = ConvertTo-PowerShellSingleQuotedLiteral $StateRoot
  $startScriptLiteral = ConvertTo-PowerShellSingleQuotedLiteral $startScript
  $arguments = "-NoProfile -ExecutionPolicy Bypass -Command `"`$env:BRIDGE_STATE_ROOT = $stateRootLiteral; & $startScriptLiteral`""
}

$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute $powerShellPath -Argument $arguments -WorkingDirectory $installRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel LeastPrivilege
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Description "Starts Copilot Bridge when $currentUser signs in." `
  -Force | Out-Null

Write-Output "Registered startup task '$TaskName' for $currentUser."
if (-not [string]::IsNullOrWhiteSpace($StateRoot)) {
  Write-Output "The task will set BRIDGE_STATE_ROOT to $StateRoot before starting Bridge."
  Write-Output "Stored state root for start.ps1 and update.ps1 at $stateRootFile."
} elseif (Test-Path $stateRootFile) {
  Write-Output "The task will use the stored state root from $stateRootFile."
}

if ($RunNow) {
  Start-ScheduledTask -TaskName $TaskName
  Write-Output "Started task '$TaskName'."
}
