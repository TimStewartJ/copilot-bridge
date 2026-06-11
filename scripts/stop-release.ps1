param(
  [switch]$CleanupOnly
)

$ErrorActionPreference = "Stop"
$installRoot = (Resolve-Path $PSScriptRoot).Path

$bridgeReleaseCommonScript = Join-Path $PSScriptRoot "release-common.ps1"
if (-not (Test-Path -LiteralPath $bridgeReleaseCommonScript)) {
  throw "Shared release helper not found at $bridgeReleaseCommonScript. The install package may be incomplete; reinstall Copilot Bridge."
}
. $bridgeReleaseCommonScript

. (Get-BridgeSupervisorHelperScriptBlock $PSScriptRoot)

function Import-BridgeEnvFile($Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  Get-Content -LiteralPath $Path | ForEach-Object {
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
if (-not (Test-Path -LiteralPath $effectiveDataDir)) {
  New-Item -ItemType Directory -Path $effectiveDataDir -Force | Out-Null
}
$controlPaths = Get-BridgeSupervisorControlPaths $effectiveDataDir $installRoot

function Invoke-ReleaseProcessCleanup {
  $releaseSlotsDir = Join-Path $effectiveDataDir "release-slots"
  $installRootPattern = [regex]::Escape($installRoot) + "[\\/]"
  $releaseSlotsPattern = [regex]::Escape($releaseSlotsDir) + "[\\/]"
  $releaseRootPatterns = @($installRootPattern, $releaseSlotsPattern)
  $activeReleasePointerPath = Join-Path $effectiveDataDir "active-release.json"
  if (Test-Path -LiteralPath $activeReleasePointerPath) {
    try {
      $activeReleasePointer = Get-Content -LiteralPath $activeReleasePointerPath -Raw | ConvertFrom-Json
      $activeReleaseRoot = [string]$activeReleasePointer.root
      if (
        -not [string]::IsNullOrWhiteSpace($activeReleaseRoot) -and
        (Test-SameOrChildPath $activeReleaseRoot $releaseSlotsDir)
      ) {
        $releaseRootPatterns += ([regex]::Escape($activeReleaseRoot) + "[\\/]")
      }
    } catch {
      Write-Warning "Could not read active release pointer at ${activeReleasePointerPath}: $($_.Exception.Message)"
    }
  }
  $releaseProcessPattern = "dist[\\/]+launcher\.js|dist[\\/]+server[\\/]+index\.js|dist[\\/]+management-job-runner\.js"
  $updaterProcessPattern = $installRootPattern + 'update\.ps1(?:"|''|\s|$)'
  $tunnelName = Get-BridgeReleaseTunnelName $env:BRIDGE_STATE_ROOT $effectiveDataDir
  $tunnelPattern = "(?i)\bdevtunnel(?:\.exe)?\b.*\bhost\b.*(?:^|\s|`")" +
    [regex]::Escape($tunnelName) + "(?:`"|\s|$)"

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
  $orderedProcessIds = New-Object System.Collections.Generic.List[int]

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
    $identity = New-BridgeProcessIdentity $Process
    if ($null -eq $identity) {
      return
    }
    $processesToStop[$processId] = $identity
    [void]$orderedProcessIds.Add($processId)
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
  $allProcesses | Where-Object {
    $_.ProcessId -ne $PID -and
    $_.CommandLine -and
    $_.CommandLine -match $tunnelPattern
  } | ForEach-Object {
    Add-ProcessTree $_ $false
  }

  Stop-BridgeVerifiedProcessIdentities $processesToStop $orderedProcessIds
}

$cleanupProcesses = {
  Invoke-ReleaseProcessCleanup
}

if ($CleanupOnly) {
  & $cleanupProcesses
  Write-Output "Copilot Bridge release processes cleaned up"
  return
}

Stop-BridgeLauncherSupervisor `
  $controlPaths `
  $installRoot `
  $cleanupProcesses `
  "Requested by stop.ps1."
Write-Output "Copilot Bridge release stopped"
