# Start Copilot Bridge as hidden background process (via launcher supervisor)
$workDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

$bridgeReleaseCommonScript = Join-Path $PSScriptRoot "release-common.ps1"
if (-not (Test-Path $bridgeReleaseCommonScript)) {
  throw "Shared release helper not found at $bridgeReleaseCommonScript. The script directory may be incomplete; reinstall Copilot Bridge."
}
. $bridgeReleaseCommonScript

# Stop any existing bridge processes first
& "$workDir\scripts\stop-bridge.ps1"
Start-Sleep 3

# Load .env file into current process environment (inherited by child)
$envFile = Join-Path $workDir ".env"
if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*([^#][^=]+)=(.*)$') {
      $env = $Matches[1].Trim()
      $val = $Matches[2].Trim()
      Set-Item -Path "Env:$env" -Value $val
    }
  }
}

# Ensure global npm bin dir is on PATH (may be missing when launched by Task Scheduler)
$globalNpm = "C:\ProgramData\global-npm"
if ((Test-Path $globalNpm) -and ($env:PATH -notlike "*$globalNpm*")) {
  $env:PATH = "$globalNpm;$env:PATH"
}

# Find Node.js — override with BRIDGE_NODE_PATH env var (from .env or environment)
if ($env:BRIDGE_NODE_PATH) {
  $nodePath = $env:BRIDGE_NODE_PATH
} elseif (Get-Command node -ErrorAction SilentlyContinue) {
  $nodePath = (Get-Command node).Source
} else {
  Write-Error "Node.js not found in PATH. Install Node 22+ or set BRIDGE_NODE_PATH."
  exit 1
}

# Ensure data directory exists
$dataDir = Join-Path $workDir "data"
if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir | Out-Null }

# Start launcher (manages server, devtunnel, health checks, crash recovery)
$bridgeStdoutLog = Join-Path $dataDir "bridge.log"
$bridgeStderrLog = Join-Path $dataDir "bridge-error.log"
$bridgeLogArchiveRetention = 20
Move-ExistingBridgeLog $bridgeStdoutLog $bridgeLogArchiveRetention
Move-ExistingBridgeLog $bridgeStderrLog $bridgeLogArchiveRetention
Start-Process -FilePath $nodePath `
  -ArgumentList "node_modules\tsx\dist\cli.mjs","src\launcher.ts" `
  -WorkingDirectory $workDir `
  -WindowStyle Hidden `
  -RedirectStandardOutput $bridgeStdoutLog `
  -RedirectStandardError $bridgeStderrLog
