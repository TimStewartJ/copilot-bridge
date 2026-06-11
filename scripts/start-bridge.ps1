# Start Copilot Bridge under the durable Windows launcher supervisor.
param(
  [switch]$Wait,
  [switch]$ClearIntentionalStop,
  [string]$SupervisorToken,
  [long]$StartRequestOrder
)

$ErrorActionPreference = "Stop"
$workDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$dataDir = Join-Path $workDir "data"
if (-not (Test-Path -LiteralPath $dataDir)) {
  New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
}

$bridgeReleaseCommonScript = Join-Path $PSScriptRoot "release-common.ps1"
if (-not (Test-Path -LiteralPath $bridgeReleaseCommonScript)) {
  throw "Shared release helper not found at $bridgeReleaseCommonScript. The script directory may be incomplete; reinstall Copilot Bridge."
}
. $bridgeReleaseCommonScript

$bridgeSupervisorCommonScript = Join-Path $PSScriptRoot "bridge-supervisor-common.ps1"
if (-not (Test-Path -LiteralPath $bridgeSupervisorCommonScript)) {
  throw "Supervisor helper not found at $bridgeSupervisorCommonScript. The script directory may be incomplete; reinstall Copilot Bridge."
}
. $bridgeSupervisorCommonScript

$controlPaths = Get-BridgeSupervisorControlPaths $dataDir $workDir
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
  Write-Output "Copilot Bridge supervisor started (PID $($child.process.Id))."
  return
}

# Load .env into the supervisor environment inherited by launcher descendants.
$envFile = Join-Path $workDir ".env"
if (Test-Path -LiteralPath $envFile) {
  Get-Content -LiteralPath $envFile | ForEach-Object {
    if ($_ -match '^\s*([^#][^=]+)=(.*)$') {
      $envName = $Matches[1].Trim()
      $envValue = $Matches[2].Trim()
      Set-Item -Path "Env:$envName" -Value $envValue
    }
  }
}

$globalNpm = "C:\ProgramData\global-npm"
if ((Test-Path -LiteralPath $globalNpm) -and ($env:PATH -notlike "*$globalNpm*")) {
  $env:PATH = "$globalNpm;$env:PATH"
}

if ($env:BRIDGE_NODE_PATH) {
  $nodePath = $env:BRIDGE_NODE_PATH
} elseif (Get-Command node -ErrorAction SilentlyContinue) {
  $nodePath = (Get-Command node).Source
} else {
  throw "Node.js not found in PATH. Install Node 22+ or set BRIDGE_NODE_PATH."
}

$bridgeStdoutLog = Join-Path $dataDir "bridge.log"
$bridgeStderrLog = Join-Path $dataDir "bridge-error.log"
$bridgeLogArchiveRetention = 20
$tsxCli = Join-Path $workDir "node_modules\tsx\dist\cli.mjs"
$launcherEntry = Join-Path $workDir "src\launcher.ts"
$stopScript = Join-Path $PSScriptRoot "stop-bridge.ps1"

$startLauncher = {
  Move-ExistingBridgeLog $bridgeStdoutLog $bridgeLogArchiveRetention
  Move-ExistingBridgeLog $bridgeStderrLog $bridgeLogArchiveRetention
  return Start-Process -FilePath $nodePath `
    -ArgumentList "`"$tsxCli`"","`"$launcherEntry`"" `
    -WorkingDirectory $workDir `
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
    $workDir `
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
