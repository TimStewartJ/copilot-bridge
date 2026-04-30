param(
  [string]$TaskName = "Copilot Bridge",
  [switch]$StopBridge
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue)) {
  throw "Windows Scheduled Tasks are not available on this machine."
}

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
  Write-Output "Startup task '$TaskName' is not registered."
  return
}

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Output "Unregistered startup task '$TaskName'."

if ($StopBridge) {
  $stopScript = Join-Path (Resolve-Path $PSScriptRoot).Path "stop.ps1"
  if (-not (Test-Path $stopScript)) {
    throw "stop.ps1 was not found at $stopScript. Bridge may still be running."
  }
  & $stopScript
}

