# Start Copilot Bridge as hidden background processes
$workDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

# Find Node.js — override with BRIDGE_NODE_PATH env var if needed
if ($env:BRIDGE_NODE_PATH) {
  $nodePath = $env:BRIDGE_NODE_PATH
} elseif (Get-Command node -ErrorAction SilentlyContinue) {
  $nodePath = (Get-Command node).Source
} else {
  Write-Error "Node.js not found in PATH. Install Node 22+ or set BRIDGE_NODE_PATH."
  exit 1
}

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

# Ensure data directory exists
$dataDir = Join-Path $workDir "data"
if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir | Out-Null }

# Start server (hidden)
Start-Process -FilePath $nodePath `
  -ArgumentList "node_modules\tsx\dist\cli.mjs","src\server\index.ts" `
  -WorkingDirectory $workDir `
  -WindowStyle Hidden `
  -RedirectStandardOutput "$dataDir\bridge.log" `
  -RedirectStandardError "$dataDir\bridge-error.log"

# Start devtunnel (hidden)
Start-Process -FilePath "devtunnel" `
  -ArgumentList "host","copilot-bridge" `
  -WorkingDirectory $workDir `
  -WindowStyle Hidden

# Start keep-alive to prevent idle timeout (hidden)
Start-Process -FilePath "pwsh.exe" `
  -ArgumentList "-NoProfile","-WindowStyle","Hidden","-File","$workDir\scripts\keep-alive.ps1" `
  -WorkingDirectory $workDir `
  -WindowStyle Hidden
