param()

$ErrorActionPreference = "Stop"

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

function Test-AbsolutePath($Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
  $root = [System.IO.Path]::GetPathRoot($Path)
  if ([string]::IsNullOrWhiteSpace($root)) { return $false }
  if ($env:OS -eq "Windows_NT") {
    return ($root -match '^[A-Za-z]:[\\/]$') -or ($root -match '^[\\/]{2}[^\\/]+[\\/]+[^\\/]+[\\/]?$')
  }
  return $root -eq "/"
}

function Assert-AbsolutePath($Name, $Path) {
  if (-not (Test-AbsolutePath $Path)) {
    throw "$Name must be an absolute path in release mode. Received: $Path"
  }
}

function Get-ConfiguredStateRoot($InstallRoot) {
  if (-not [string]::IsNullOrWhiteSpace($env:BRIDGE_STATE_ROOT)) {
    return $env:BRIDGE_STATE_ROOT
  }
  $stateRootFile = Join-Path $InstallRoot ".bridge-state-root"
  if (Test-Path $stateRootFile) {
    $storedStateRoot = (Get-Content $stateRootFile -Raw).Trim()
    if (-not [string]::IsNullOrWhiteSpace($storedStateRoot)) {
      return $storedStateRoot
    }
  }
  return Join-Path $env:LOCALAPPDATA "CopilotBridge"
}

function Set-DefaultEnv($Name, $Value) {
  $existing = Get-Item -Path "Env:$Name" -ErrorAction SilentlyContinue
  if (-not $existing -or [string]::IsNullOrWhiteSpace($existing.Value)) {
    Set-Item -Path "Env:$Name" -Value $Value
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
Set-DefaultEnv "BRIDGE_DATA_DIR" $defaultDataDir
$effectiveDataDir = (Get-Item -Path "Env:BRIDGE_DATA_DIR").Value
Set-DefaultEnv "BRIDGE_DOCS_DIR" (Join-Path $effectiveDataDir "docs")
Set-DefaultEnv "COPILOT_HOME" (Join-Path $effectiveDataDir ".copilot")
Set-DefaultEnv "BRIDGE_LAUNCHER_LOG_PATH" (Join-Path $logsDir "launcher.log")
Assert-AbsolutePath "BRIDGE_DATA_DIR" $effectiveDataDir
Assert-AbsolutePath "BRIDGE_DOCS_DIR" $env:BRIDGE_DOCS_DIR
Assert-AbsolutePath "COPILOT_HOME" $env:COPILOT_HOME
New-Item -ItemType Directory -Path $effectiveDataDir, $env:BRIDGE_DOCS_DIR, $env:COPILOT_HOME -Force | Out-Null

$appRoot = Join-Path $installRoot "app"
if (Test-Path (Join-Path $installRoot "app\current\dist\launcher.js")) {
  $appRoot = Join-Path $installRoot "app\current"
}
if (-not (Test-Path (Join-Path $appRoot "dist\launcher.js"))) {
  throw "Packaged launcher not found at $appRoot\dist\launcher.js. Rebuild or reinstall the release bundle."
}

$stopScript = Join-Path $installRoot "stop.ps1"
if (Test-Path $stopScript) {
  & $stopScript
  Start-Sleep -Seconds 2
}

if ($env:BRIDGE_NODE_PATH) {
  $nodePath = $env:BRIDGE_NODE_PATH
} elseif (Get-Command node -ErrorAction SilentlyContinue) {
  $nodePath = (Get-Command node).Source
} else {
  throw "Node.js not found in PATH. Install Node 22+ or set BRIDGE_NODE_PATH in $envFile."
}

$launcherPath = Join-Path $appRoot "dist\launcher.js"
Start-Process -FilePath $nodePath `
  -ArgumentList "`"$launcherPath`"" `
  -WorkingDirectory $appRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $logsDir "bridge.log") `
  -RedirectStandardError (Join-Path $logsDir "bridge-error.log")

$keepAlive = Join-Path $appRoot "scripts\keep-alive.ps1"
if (Test-Path $keepAlive) {
  $powerShellPath = if (Get-Command pwsh -ErrorAction SilentlyContinue) {
    (Get-Command pwsh).Source
  } elseif (Get-Command powershell -ErrorAction SilentlyContinue) {
    (Get-Command powershell).Source
  } else {
    $null
  }

  if ($powerShellPath) {
    try {
      Start-Process -FilePath $powerShellPath `
        -ArgumentList "-NoProfile","-WindowStyle","Hidden","-File","`"$keepAlive`"" `
        -WorkingDirectory $appRoot `
        -WindowStyle Hidden
    } catch {
      Write-Warning "Bridge started, but keep-alive could not be launched: $($_.Exception.Message)"
    }
  } else {
    Write-Warning "Bridge started, but no PowerShell executable was found for keep-alive."
  }
}

Write-Output "Copilot Bridge release started. Logs: $logsDir"
