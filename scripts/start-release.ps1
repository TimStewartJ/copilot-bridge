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

function Normalize-FullPath($Path) {
  $fullPath = [System.IO.Path]::GetFullPath($Path)
  $trimmed = $fullPath.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
  if ([string]::IsNullOrWhiteSpace($trimmed)) {
    return $fullPath
  }
  return $trimmed
}

function Test-SameOrChildPath($Path, $ParentPath) {
  $normalizedPath = Normalize-FullPath $Path
  $normalizedParent = Normalize-FullPath $ParentPath
  if ([string]::Equals($normalizedPath, $normalizedParent, [System.StringComparison]::OrdinalIgnoreCase)) {
    return $true
  }
  return $normalizedPath.StartsWith("$normalizedParent$([System.IO.Path]::DirectorySeparatorChar)", [System.StringComparison]::OrdinalIgnoreCase)
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

$appRoot = Join-Path $installRoot "app"
$activeReleaseRoot = Get-ActiveReleaseAppRoot $effectiveDataDir
if ($activeReleaseRoot) {
  $appRoot = $activeReleaseRoot
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
$bridgeStdoutLog = Join-Path $logsDir "bridge.log"
$bridgeStderrLog = Join-Path $logsDir "bridge-error.log"
$bridgeLogArchiveRetention = 20
Move-ExistingBridgeLog $bridgeStdoutLog $bridgeLogArchiveRetention
Move-ExistingBridgeLog $bridgeStderrLog $bridgeLogArchiveRetention
Start-Process -FilePath $nodePath `
  -ArgumentList "`"$launcherPath`"" `
  -WorkingDirectory $appRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput $bridgeStdoutLog `
  -RedirectStandardError $bridgeStderrLog

Write-Output "Copilot Bridge release started. Logs: $logsDir"
