# Start Copilot Bridge as hidden background process (via launcher supervisor)
$workDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

function Remove-OldBridgeLogArchives($Path, $MaxArchives) {
  $logDirectory = [System.IO.Path]::GetDirectoryName($Path)
  if ([string]::IsNullOrWhiteSpace($logDirectory)) { return }
  if (-not (Test-Path -LiteralPath $logDirectory -PathType Container)) { return }

  $baseName = [System.IO.Path]::GetFileNameWithoutExtension($Path)
  $extension = [System.IO.Path]::GetExtension($Path)
  $archivePattern = "^" + [regex]::Escape($baseName) + "-\d{8}-\d{6}(-\d+)?" + [regex]::Escape($extension) + "$"

  try {
    $oldArchives = Get-ChildItem -LiteralPath $logDirectory -File -ErrorAction Stop |
      Where-Object { $_.Name -match $archivePattern } |
      Sort-Object -Property LastWriteTimeUtc -Descending |
      Select-Object -Skip $MaxArchives
  } catch {
    Write-Warning "Could not list Bridge log archives for retention in ${logDirectory}: $($_.Exception.Message)"
    return
  }

  foreach ($archive in $oldArchives) {
    try {
      Remove-Item -LiteralPath $archive.FullName -Force -ErrorAction Stop
    } catch {
      Write-Warning "Could not remove old Bridge log archive $($archive.FullName): $($_.Exception.Message)"
    }
  }
}

function Move-ExistingBridgeLog($Path, $MaxArchives) {
  if (-not (Test-Path -LiteralPath $Path)) { return }

  $logDirectory = [System.IO.Path]::GetDirectoryName($Path)
  $baseName = [System.IO.Path]::GetFileNameWithoutExtension($Path)
  $extension = [System.IO.Path]::GetExtension($Path)
  $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $archivePath = Join-Path $logDirectory ("{0}-{1}{2}" -f $baseName, $timestamp, $extension)
  $suffix = 1
  while (Test-Path -LiteralPath $archivePath) {
    $archivePath = Join-Path $logDirectory ("{0}-{1}-{2}{3}" -f $baseName, $timestamp, $suffix, $extension)
    $suffix += 1
    if ($suffix -gt 1000) {
      throw "Could not find an available archive path for $Path"
    }
  }

  $attempt = 1
  while ($true) {
    try {
      Move-Item -LiteralPath $Path -Destination $archivePath -ErrorAction Stop
    } catch {
      if ($attempt -ge 5) {
        throw "Could not rotate existing Bridge log $Path to $archivePath after $attempt attempts: $($_.Exception.Message)"
      }
      Start-Sleep -Milliseconds 500
      $attempt += 1
      continue
    }
    Remove-OldBridgeLogArchives $Path $MaxArchives
    return
  }
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
