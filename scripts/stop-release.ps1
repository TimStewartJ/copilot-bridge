param()

$ErrorActionPreference = "Stop"

$installRoot = (Resolve-Path $PSScriptRoot).Path
$installRootPattern = [regex]::Escape($installRoot) + "[\\/]"
$releaseProcessPattern = "dist[\\/]+launcher\.js|dist[\\/]+server[\\/]+index\.js|keep-alive\.ps1"

$allProcesses = @(Get-CimInstance Win32_Process)
$processesByParent = @{}
foreach ($process in $allProcesses) {
  $parentId = [int]$process.ParentProcessId
  if (-not $processesByParent.ContainsKey($parentId)) {
    $processesByParent[$parentId] = @()
  }
  $processesByParent[$parentId] += $process
}
$processesToStop = @{}

function Add-ProcessTree($Process) {
  $processId = [int]$Process.ProcessId
  if ($processId -eq $PID -or $processesToStop.ContainsKey($processId)) {
    return
  }
  $processesToStop[$processId] = $Process
  foreach ($child in @($processesByParent[$processId])) {
    Add-ProcessTree $child
  }
}

$allProcesses | Where-Object {
  $_.ProcessId -ne $PID -and
  $_.CommandLine -and
  $_.CommandLine -match $installRootPattern -and
  $_.CommandLine -match $releaseProcessPattern
} | ForEach-Object {
  Add-ProcessTree $_
}

$processesToStop.Values | ForEach-Object {
  Write-Output "Stopping PID $($_.ProcessId)"
  Stop-Process -Id ([int]$_.ProcessId) -Force -ErrorAction SilentlyContinue
}

Write-Output "Copilot Bridge release stopped"
