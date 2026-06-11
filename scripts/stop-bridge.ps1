# Stop Copilot Bridge processes. Manual stops also persist a supervisor halt request.
param(
  [switch]$CleanupOnly
)

$ErrorActionPreference = "Stop"
$workDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$dataDir = Join-Path $workDir "data"
if (-not (Test-Path -LiteralPath $dataDir)) {
  New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
}

$bridgeSupervisorCommonScript = Join-Path $PSScriptRoot "bridge-supervisor-common.ps1"
if (-not (Test-Path -LiteralPath $bridgeSupervisorCommonScript)) {
  throw "Supervisor helper not found at $bridgeSupervisorCommonScript. The script directory may be incomplete; reinstall Copilot Bridge."
}
. $bridgeSupervisorCommonScript

$controlPaths = Get-BridgeSupervisorControlPaths $dataDir $workDir

function Invoke-BridgeProcessCleanup {
  $allProcesses = @(Get-CimInstance Win32_Process)
  $processesByParent = @{}
  foreach ($process in $allProcesses) {
    $parentId = [int]$process.ParentProcessId
    if (-not $processesByParent.ContainsKey($parentId)) {
      $processesByParent[$parentId] = @()
    }
    $processesByParent[$parentId] += $process
  }

  $workDirPattern = [regex]::Escape($workDir) + "[\\/]"
  $bridgeEntryPattern = "(?:src[\\/]+launcher\.ts|src[\\/]+server[\\/]+index\.ts|src[\\/]+management-job-runner\.ts)"
  $tunnelName = "copilot-bridge"
  $envFile = Join-Path $workDir ".env"
  if (Test-Path -LiteralPath $envFile) {
    $configuredTunnel = Get-Content -LiteralPath $envFile | Where-Object {
      $_ -match '^\s*BRIDGE_TUNNEL_NAME\s*='
    } | Select-Object -Last 1
    if ($configuredTunnel -match '^\s*BRIDGE_TUNNEL_NAME\s*=(.*)$' -and -not [string]::IsNullOrWhiteSpace($Matches[1])) {
      $tunnelName = $Matches[1].Trim().Trim('"').Trim("'")
    }
  }
  $tunnelPattern = "(?i)\bdevtunnel(?:\.exe)?\b.*\bhost\b.*(?:^|\s|`")" +
    [regex]::Escape($tunnelName) + "(?:`"|\s|$)"
  $processesToStop = @{}
  $orderedProcessIds = New-Object System.Collections.Generic.List[int]

  function Add-BridgeProcessTree($Process) {
    $processId = [int]$Process.ProcessId
    if ($processId -le 4 -or $processId -eq $PID -or $processesToStop.ContainsKey($processId)) {
      return
    }
    $identity = New-BridgeProcessIdentity $Process
    if ($null -eq $identity) {
      return
    }
    $processesToStop[$processId] = $identity
    [void]$orderedProcessIds.Add($processId)
    foreach ($child in @($processesByParent[$processId])) {
      Add-BridgeProcessTree $child
    }
  }

  $allProcesses | Where-Object {
    $_.ProcessId -ne $PID -and
    $_.CommandLine -and (
      ($_.CommandLine -match $workDirPattern -and $_.CommandLine -match $bridgeEntryPattern) -or
      $_.CommandLine -match $tunnelPattern
    )
  } | ForEach-Object {
    Add-BridgeProcessTree $_
  }

  Stop-BridgeVerifiedProcessIdentities $processesToStop $orderedProcessIds
}

$cleanupProcesses = {
  Invoke-BridgeProcessCleanup
}

if ($CleanupOnly) {
  & $cleanupProcesses
  Write-Output "Bridge processes cleaned up"
  return
}

Stop-BridgeLauncherSupervisor `
  $controlPaths `
  $workDir `
  $cleanupProcesses `
  "Requested by scripts\stop-bridge.ps1."
Write-Output "Bridge stopped"
