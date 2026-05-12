param()

$ErrorActionPreference = "Stop"

$installRoot = (Resolve-Path $PSScriptRoot).Path
$installRootPattern = [regex]::Escape($installRoot) + "[\\/]"
$releaseProcessPattern = "dist[\\/]+launcher\.js|dist[\\/]+server[\\/]+index\.js|keep-alive\.ps1"
$updaterProcessPattern = $installRootPattern + 'update\.ps1(?:"|''|\s|$)'

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

function Test-ReleaseInstallProcess($Process) {
  return $Process.CommandLine -and $Process.CommandLine -match $installRootPattern
}

function Test-ReleaseUpdaterProcess($Process) {
  return $Process.CommandLine -and $Process.CommandLine -match $updaterProcessPattern
}

function Add-ProcessTree($Process, [bool]$RequireReleaseInstallProcess = $true) {
  $processId = [int]$Process.ProcessId
  if ($processId -le 4 -or $processId -eq $PID -or $processesToStop.ContainsKey($processId)) {
    return
  }
  if (Test-ReleaseUpdaterProcess $Process) {
    return
  }
  if ($RequireReleaseInstallProcess -and -not (Test-ReleaseInstallProcess $Process)) {
    return
  }
  $processesToStop[$processId] = $Process
  foreach ($child in @($processesByParent[$processId])) {
    Add-ProcessTree $child $false
  }
}

$allProcesses | Where-Object {
  $_.ProcessId -ne $PID -and
  (Test-ReleaseInstallProcess $_) -and
  -not (Test-ReleaseUpdaterProcess $_) -and
  $_.CommandLine -match $releaseProcessPattern
} | ForEach-Object {
  Add-ProcessTree $_
}

$processesToStop.Values | ForEach-Object {
  Write-Output "Stopping PID $($_.ProcessId)"
  Stop-Process -Id ([int]$_.ProcessId) -Force -ErrorAction SilentlyContinue
}

$stoppedProcessIds = @($processesToStop.Keys | ForEach-Object { [int]$_ })
if ($stoppedProcessIds.Count -gt 0) {
  $deadline = (Get-Date).AddSeconds(30)
  do {
    $runningProcessIds = @($stoppedProcessIds | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
    if ($runningProcessIds.Count -eq 0) {
      break
    }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)

  if ($runningProcessIds.Count -gt 0) {
    Write-Warning "Timed out waiting for stopped Bridge process IDs to exit: $($runningProcessIds -join ', ')"
  }
}

Write-Output "Copilot Bridge release stopped"
