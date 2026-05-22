param()

$ErrorActionPreference = "Stop"

$installRoot = (Resolve-Path $PSScriptRoot).Path

$bridgeReleaseCommonScript = Join-Path $PSScriptRoot "release-common.ps1"
if (-not (Test-Path $bridgeReleaseCommonScript)) {
  throw "Shared release helper not found at $bridgeReleaseCommonScript. The install package may be incomplete; reinstall Copilot Bridge."
}
. $bridgeReleaseCommonScript

function Import-BridgeEnvFile($Path) {
  if (-not (Test-Path $Path)) { return }
  Get-Content $Path | ForEach-Object {
    if ($_ -match '^\s*([^#][^=]+)=(.*)$') {
      $name = $Matches[1].Trim()
      $value = $Matches[2].Trim()
      if ($name -and -not [string]::IsNullOrWhiteSpace($value)) {
        Set-Item -Path "Env:$name" -Value $value
      }
    }
  }
}

$stateRoot = Get-ConfiguredStateRoot $installRoot
$configEnvFile = Join-Path $stateRoot "config\.env"
Import-BridgeEnvFile $configEnvFile
$effectiveDataDir = if (-not [string]::IsNullOrWhiteSpace($env:BRIDGE_DATA_DIR)) {
  $env:BRIDGE_DATA_DIR
} else {
  Join-Path $stateRoot "data"
}
$releaseSlotsDir = Join-Path $effectiveDataDir "release-slots"
$installRootPattern = [regex]::Escape($installRoot) + "[\\/]"
$releaseSlotsPattern = [regex]::Escape($releaseSlotsDir) + "[\\/]"
$anyReleaseSlotPattern = "release-slots[\\/][^\\/]+[\\/]"
$releaseRootPatterns = @($installRootPattern, $releaseSlotsPattern, $anyReleaseSlotPattern)
$releaseProcessPattern = "dist[\\/]+launcher\.js|dist[\\/]+server[\\/]+index\.js"
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
  if (-not $Process.CommandLine) { return $false }
  foreach ($pattern in $releaseRootPatterns) {
    if ($Process.CommandLine -match $pattern) {
      return $true
    }
  }
  return $false
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
