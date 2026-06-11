param(
  [switch]$Wait,
  [switch]$ClearIntentionalStop,
  [string]$SupervisorToken,
  [long]$StartRequestOrder
)

$ErrorActionPreference = "Stop"

$bridgeReleaseCommonScript = Join-Path $PSScriptRoot "release-common.ps1"
if (-not (Test-Path $bridgeReleaseCommonScript)) {
  throw "Shared release helper not found at $bridgeReleaseCommonScript. The install package may be incomplete; reinstall Copilot Bridge."
}
. $bridgeReleaseCommonScript

. (Get-BridgeSupervisorHelperScriptBlock $PSScriptRoot)

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

function Set-DefaultEnv($Name, $Value) {
  $existing = Get-Item -Path "Env:$Name" -ErrorAction SilentlyContinue
  if (-not $existing -or [string]::IsNullOrWhiteSpace($existing.Value)) {
    Set-Item -Path "Env:$Name" -Value $Value
  }
}

function Get-ActiveReleaseAppRoot($DataDir) {
  $activeReleasePath = Join-Path $DataDir "active-release.json"
  if (-not (Test-Path $activeReleasePath)) {
    return $null
  }
  try {
    $activeRelease = Get-Content $activeReleasePath -Raw | ConvertFrom-Json
    $activeRoot = [string]$activeRelease.root
    $activeId = [string]$activeRelease.id
    if ([string]::IsNullOrWhiteSpace($activeRoot) -or [string]::IsNullOrWhiteSpace($activeId)) {
      Write-Warning "Ignoring active release pointer without id/root at $activeReleasePath."
      return $null
    }
    $releaseSlotsDir = Join-Path $DataDir "release-slots"
    if (-not (Test-SameOrChildPath $activeRoot $releaseSlotsDir)) {
      Write-Warning "Ignoring active release outside release slot directory: $activeRoot"
      return $null
    }
    if ((Split-Path -Leaf (Normalize-FullPath $activeRoot)) -ne $activeId) {
      Write-Warning "Ignoring active release whose root does not match id '$activeId': $activeRoot"
      return $null
    }
    if (-not (Test-Path (Join-Path $activeRoot "dist\launcher.js"))) {
      Write-Warning "Ignoring active release without packaged launcher: $activeRoot"
      return $null
    }
    if (-not (Test-Path (Join-Path $activeRoot "release-slot.json"))) {
      Write-Warning "Ignoring active release without release-slot.json: $activeRoot"
      return $null
    }
    return $activeRoot
  } catch {
    Write-Warning "Could not read active release pointer at ${activeReleasePath}: $($_.Exception.Message)"
    return $null
  }
}

$installRoot = (Resolve-Path $PSScriptRoot).Path
$stateRoot = Get-ConfiguredStateRoot $installRoot
Assert-AbsolutePath "BRIDGE_STATE_ROOT" $stateRoot
$configDir = Join-Path $stateRoot "config"
$defaultDataDir = Join-Path $stateRoot "data"
$logsDir = Join-Path $stateRoot "logs"

New-Item -ItemType Directory -Path $configDir, $defaultDataDir, $logsDir -Force | Out-Null

$envFile = Join-Path $configDir ".env"
if (-not (Test-Path $envFile)) {
  Set-Content -Path $envFile -Value "# Copilot Bridge release configuration`n" -Encoding UTF8
}
Import-BridgeEnvFile $envFile
Set-Item -Path "Env:BRIDGE_ENV_FILE" -Value $envFile

Set-Item -Path "Env:BRIDGE_DISTRIBUTION_MODE" -Value "release"
Set-Item -Path "Env:BRIDGE_RELEASE_ROOT" -Value $installRoot
Set-DefaultEnv "BRIDGE_DATA_DIR" $defaultDataDir
$effectiveDataDir = (Get-Item -Path "Env:BRIDGE_DATA_DIR").Value
Set-DefaultEnv "BRIDGE_DOCS_DIR" (Join-Path $effectiveDataDir "docs")
Set-DefaultEnv "COPILOT_HOME" (Join-Path $effectiveDataDir ".copilot")
Set-DefaultEnv "BRIDGE_LAUNCHER_LOG_PATH" (Join-Path $logsDir "launcher.log")
Assert-AbsolutePath "BRIDGE_DATA_DIR" $effectiveDataDir
Assert-AbsolutePath "BRIDGE_DOCS_DIR" $env:BRIDGE_DOCS_DIR
Assert-AbsolutePath "COPILOT_HOME" $env:COPILOT_HOME
New-Item -ItemType Directory -Path $effectiveDataDir, $env:BRIDGE_DOCS_DIR, $env:COPILOT_HOME -Force | Out-Null

$controlPaths = Get-BridgeSupervisorControlPaths $effectiveDataDir $installRoot
if ([string]::IsNullOrWhiteSpace($SupervisorToken)) {
  $explicitStart = $ClearIntentionalStop -or -not $Wait
  $childArguments = if ($explicitStart) {
    @("-ClearIntentionalStop")
  } else {
    @()
  }
  if ($Wait) {
    $child = Start-BridgeSupervisorChild $controlPaths $PSCommandPath $childArguments -Wait -ExplicitStart:$explicitStart
    exit $child.exitCode
  }
  $child = Start-BridgeSupervisorChild $controlPaths $PSCommandPath $childArguments -ExplicitStart:$explicitStart
  Write-Output "Copilot Bridge release supervisor started (PID $($child.process.Id)). Logs: $logsDir"
  return
}

$appRoot = Join-Path $installRoot "app"
$activeReleaseRoot = Get-ActiveReleaseAppRoot $effectiveDataDir
if ($activeReleaseRoot) {
  $appRoot = $activeReleaseRoot
}
if (-not (Test-Path (Join-Path $appRoot "dist\launcher.js"))) {
  throw "Packaged launcher not found at $appRoot\dist\launcher.js. Rebuild or reinstall the release bundle."
}

if ($env:BRIDGE_NODE_PATH) {
  $nodePath = $env:BRIDGE_NODE_PATH
} elseif (Get-Command node -ErrorAction SilentlyContinue) {
  $nodePath = (Get-Command node).Source
} else {
  throw "Node.js not found in PATH. Install Node 22+ or set BRIDGE_NODE_PATH in $envFile."
}

$launcherPath = Join-Path $appRoot "dist\launcher.js"
$bridgeStdoutLog = Join-Path $logsDir "bridge.log"
$bridgeStderrLog = Join-Path $logsDir "bridge-error.log"
$bridgeLogArchiveRetention = 20
$stopScript = Join-Path $installRoot "stop.ps1"

$startLauncher = {
  $launchAppRoot = Join-Path $installRoot "app"
  $activeLaunchRoot = Get-ActiveReleaseAppRoot $effectiveDataDir
  if ($activeLaunchRoot) {
    $launchAppRoot = $activeLaunchRoot
  }
  $launchLauncherPath = Join-Path $launchAppRoot "dist\launcher.js"
  Move-ExistingBridgeLog $bridgeStdoutLog $bridgeLogArchiveRetention
  Move-ExistingBridgeLog $bridgeStderrLog $bridgeLogArchiveRetention
  return Start-Process -FilePath $nodePath `
    -ArgumentList "`"$launchLauncherPath`"" `
    -WorkingDirectory $launchAppRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $bridgeStdoutLog `
    -RedirectStandardError $bridgeStderrLog `
    -PassThru
}

$cleanupProcesses = {
  & $stopScript -CleanupOnly
}

try {
  Invoke-BridgeLauncherSupervisor `
    $controlPaths `
    $installRoot `
    $SupervisorToken `
    $StartRequestOrder `
    $startLauncher `
    $cleanupProcesses
} catch {
  if ($_.Exception.Data["BridgeExitCode"] -eq 70) {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 70
  }
  throw
}
