param(
  [string]$PackagePath,
  [string]$DownloadUrl,
  [string]$ExpectedSha256,
  [string]$StateRoot = $env:BRIDGE_STATE_ROOT,
  [string]$InstallId,
  [string]$FromVersion,
  [string]$TargetVersion,
  [string]$Channel,
  [string]$SourceCommit,
  [string]$StatusPath = $env:BRIDGE_UPDATE_INSTALL_STATUS_PATH,
  [string]$LogPath = $env:BRIDGE_UPDATE_INSTALL_LOG_PATH
)

$ErrorActionPreference = "Stop"

if (-not $PackagePath -and -not $DownloadUrl) {
  throw "Provide either -PackagePath or -DownloadUrl."
}

if ($DownloadUrl) {
  if ([string]::IsNullOrWhiteSpace($ExpectedSha256)) {
    throw "Remote updates require -ExpectedSha256 so the downloaded package can be verified."
  }
  [System.Uri]$downloadUri = $null
  if (-not [System.Uri]::TryCreate($DownloadUrl, [System.UriKind]::Absolute, [ref]$downloadUri) -or $downloadUri.Scheme -ne [System.Uri]::UriSchemeHttps) {
    throw "Remote update URL must be an absolute HTTPS URL."
  }
}

$installRoot = (Resolve-Path $PSScriptRoot).Path
$appDir = Join-Path $installRoot "app"
$stateRootFile = Join-Path $installRoot ".bridge-state-root"
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) "copilot-bridge-update-$timestamp"
$bridgeStopped = $false
$appBackedUp = $false
$appExistedBefore = $false

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

function Get-EnvPathOrDefault($Name, $DefaultPath) {
  $value = [Environment]::GetEnvironmentVariable($Name)
  if ([string]::IsNullOrWhiteSpace($value)) {
    return $DefaultPath
  }
  return $value
}

function Get-StoredStateRoot($Path) {
  if (-not (Test-Path $Path)) { return $null }
  $value = (Get-Content $Path -Raw).Trim()
  if ([string]::IsNullOrWhiteSpace($value)) { return $null }
  return $value
}

function Assert-StateRootDoesNotSwitch($StoredStateRoot, $InputStateRoot, $StateRootFile) {
  if ([string]::IsNullOrWhiteSpace($StoredStateRoot) -or [string]::IsNullOrWhiteSpace($InputStateRoot)) { return }
  $storedFullPath = [System.IO.Path]::GetFullPath($StoredStateRoot).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
  $inputFullPath = [System.IO.Path]::GetFullPath($InputStateRoot).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
  if (-not [string]::Equals($storedFullPath, $inputFullPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to switch release state root from '$StoredStateRoot' to '$InputStateRoot'. Remove or update $StateRootFile intentionally before changing the active state root."
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

function Normalize-BackupPath($Path) {
  $fullPath = [System.IO.Path]::GetFullPath($Path)
  $trimmed = $fullPath.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
  if ([string]::IsNullOrWhiteSpace($trimmed)) {
    return $fullPath
  }
  return $trimmed
}

function Test-SameOrChildPath($Path, $ParentPath) {
  $normalizedPath = Normalize-BackupPath $Path
  $normalizedParent = Normalize-BackupPath $ParentPath
  if ([string]::Equals($normalizedPath, $normalizedParent, [System.StringComparison]::OrdinalIgnoreCase)) {
    return $true
  }
  return $normalizedPath.StartsWith("$normalizedParent$([System.IO.Path]::DirectorySeparatorChar)", [System.StringComparison]::OrdinalIgnoreCase)
}

function Copy-ReleaseWrappers($SourceRoot, $DestinationRoot) {
  foreach ($scriptName in @("start.ps1", "stop.ps1", "update.ps1", "install-startup-task.ps1", "uninstall-startup-task.ps1")) {
    $source = Join-Path $SourceRoot $scriptName
    if (Test-Path $source) {
      Copy-Item -Path $source -Destination (Join-Path $DestinationRoot $scriptName) -Force
    }
  }
}

function Assert-BackupPathSafe($Path) {
  if ((Test-SameOrChildPath $backupRoot $Path) -or (Test-SameOrChildPath $Path $backupRoot)) {
    throw "Configured durable path $Path overlaps the backup root $backupRoot. Choose a data/docs/COPILOT_HOME path outside the backups folder before updating."
  }
  if ((Test-SameOrChildPath $appDir $Path) -or (Test-SameOrChildPath $Path $appDir)) {
    throw "Configured durable path $Path overlaps the app folder $appDir. Move Bridge data/config outside the app folder before updating."
  }
}

$backupEntries = @()

function Add-BackupEntry($Name, $Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) { return }
  $normalizedPath = Normalize-BackupPath $Path
  Assert-BackupPathSafe $normalizedPath

  $remainingEntries = @()
  foreach ($entry in $script:backupEntries) {
    if (Test-SameOrChildPath $normalizedPath $entry.NormalizedPath) {
      return
    }
    if (-not (Test-SameOrChildPath $entry.NormalizedPath $normalizedPath)) {
      $remainingEntries += $entry
    }
  }

  $script:backupEntries = $remainingEntries + [pscustomobject]@{
    Name = $Name
    Path = $normalizedPath
    NormalizedPath = $normalizedPath
    BackupPath = Join-Path $backupDir $Name
    BackedUp = $false
    ExistedBefore = $false
  }
}

function Backup-ConfiguredDirectories {
  foreach ($entry in $backupEntries) {
    if (Test-Path $entry.Path) {
      Copy-Item -Path $entry.Path -Destination $entry.BackupPath -Recurse -Force
      $entry.ExistedBefore = $true
    }
    $entry.BackedUp = $true
  }
}

function Restore-BackupEntry($Entry) {
  if (-not $Entry.BackedUp) {
    return
  }
  if ($Entry.ExistedBefore -and -not (Test-Path $Entry.BackupPath)) {
    Write-Warning "Skipping restore for $($Entry.Path) because its backup was not found at $($Entry.BackupPath)."
    return
  }
  if (Test-Path $Entry.Path) {
    Remove-Item -Path $Entry.Path -Recurse -Force
  }
  if ($Entry.ExistedBefore) {
    Copy-Item -Path $Entry.BackupPath -Destination $Entry.Path -Recurse -Force
  }
}

function Get-BridgePort {
  $rawPort = $env:BRIDGE_PORT
  if (-not $rawPort) { return 3333 }
  $port = 0
  if ([int]::TryParse($rawPort, [ref]$port) -and $port -gt 0) {
    return $port
  }
  throw "Invalid BRIDGE_PORT value: $rawPort"
}

$storedStateRoot = Get-StoredStateRoot $stateRootFile
$stateRootFromInput = -not [string]::IsNullOrWhiteSpace($StateRoot)
$stateRoot = if ($stateRootFromInput) {
  $StateRoot
} elseif (-not [string]::IsNullOrWhiteSpace($storedStateRoot)) {
  $storedStateRoot
} else {
  Join-Path $env:LOCALAPPDATA "CopilotBridge"
}
$backupRoot = Join-Path $stateRoot "backups"
$backupDir = Join-Path $backupRoot "update-$timestamp"

function Wait-BridgeHealth {
  param(
    [int]$TimeoutSeconds = 120
  )

  $port = Get-BridgePort
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $healthUrl = "http://localhost:$port/api/health"
  do {
    try {
      $response = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 3
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300) {
        return
      }
    } catch {
      Start-Sleep -Seconds 2
    }
  } while ((Get-Date) -lt $deadline)

  throw "Copilot Bridge did not become healthy at $healthUrl within $TimeoutSeconds seconds."
}

Assert-StateRootDoesNotSwitch $storedStateRoot $StateRoot $stateRootFile
Assert-AbsolutePath "BRIDGE_STATE_ROOT" $stateRoot
Set-Item -Path "Env:BRIDGE_STATE_ROOT" -Value $stateRoot
New-Item -ItemType Directory -Path $backupDir, $tempDir -Force | Out-Null
Import-BridgeEnvFile (Join-Path $stateRoot "config\.env")

$effectiveDataDir = Get-EnvPathOrDefault "BRIDGE_DATA_DIR" (Join-Path $stateRoot "data")
$effectiveDocsDir = Get-EnvPathOrDefault "BRIDGE_DOCS_DIR" (Join-Path $effectiveDataDir "docs")
$effectiveCopilotHome = Get-EnvPathOrDefault "COPILOT_HOME" (Join-Path $effectiveDataDir ".copilot")
Assert-AbsolutePath "BRIDGE_DATA_DIR" $effectiveDataDir
Assert-AbsolutePath "BRIDGE_DOCS_DIR" $effectiveDocsDir
Assert-AbsolutePath "COPILOT_HOME" $effectiveCopilotHome
Add-BackupEntry "config" (Join-Path $stateRoot "config")
Add-BackupEntry "data" $effectiveDataDir
Add-BackupEntry "docs" $effectiveDocsDir
Add-BackupEntry "copilot-home" $effectiveCopilotHome

if ([string]::IsNullOrWhiteSpace($StatusPath)) {
  $StatusPath = Join-Path $effectiveDataDir "update-status.json"
}
if ([string]::IsNullOrWhiteSpace($LogPath)) {
  $LogPath = Join-Path $stateRoot "logs\update-$timestamp.log"
}
New-Item -ItemType Directory -Path (Split-Path -Parent $StatusPath), (Split-Path -Parent $LogPath) -Force | Out-Null
$statusStartedAt = (Get-Date).ToUniversalTime().ToString("o")

function Write-UpdateStatus($Phase, [string]$ErrorMessage = $null, [bool]$RollbackAttempted = $false) {
  $now = (Get-Date).ToUniversalTime().ToString("o")
  $status = [ordered]@{
    id = if (-not [string]::IsNullOrWhiteSpace($InstallId)) { $InstallId } else { $timestamp }
    phase = $Phase
    channel = $Channel
    fromVersion = $FromVersion
    toVersion = $TargetVersion
    sourceCommit = $SourceCommit
    packageUrl = $DownloadUrl
    packageSha256 = $ExpectedSha256
    startedAt = $statusStartedAt
    updatedAt = $now
    logPath = $LogPath
  }
  if ($Phase -eq "succeeded" -or $Phase -eq "failed") {
    $status.completedAt = $now
  }
  if (-not [string]::IsNullOrWhiteSpace($ErrorMessage)) {
    $status.error = $ErrorMessage
  }
  if ($RollbackAttempted) {
    $status.rollbackAttempted = $true
  }
  $status | ConvertTo-Json -Depth 4 | Set-Content -Path $StatusPath -Encoding UTF8
}

try {
  Write-UpdateStatus "started"
  $resolvedPackage = $PackagePath
  if ($DownloadUrl) {
    Write-UpdateStatus "downloading"
    $resolvedPackage = Join-Path $tempDir "copilot-bridge-update.zip"
    Invoke-WebRequest -Uri $DownloadUrl -OutFile $resolvedPackage
  }
  $resolvedPackage = (Resolve-Path $resolvedPackage).Path

  if ($ExpectedSha256) {
    Write-UpdateStatus "verifying"
    $hash = (Get-FileHash -Path $resolvedPackage -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ne $ExpectedSha256.ToLowerInvariant()) {
      throw "Package SHA256 mismatch. Expected $ExpectedSha256 but got $hash."
    }
  }

  $expandedDir = Join-Path $tempDir "expanded"
  Write-UpdateStatus "staging"
  Expand-Archive -Path $resolvedPackage -DestinationPath $expandedDir -Force
  $newApp = Join-Path $expandedDir "CopilotBridge\app"
  if (-not (Test-Path $newApp)) {
    $newApp = Join-Path $expandedDir "app"
  }
  if (-not (Test-Path (Join-Path $newApp "dist\launcher.js"))) {
    throw "Update package does not contain app\dist\launcher.js."
  }
  if (-not (Test-Path (Join-Path $newApp "node_modules"))) {
    throw "Update package does not include app\node_modules. Rebuild the package with -IncludeNodeModules before using update.ps1."
  }

  $stopScript = Join-Path $installRoot "stop.ps1"
  if (Test-Path $stopScript) {
    Write-UpdateStatus "stopping"
    & $stopScript
    $bridgeStopped = $true
    Start-Sleep -Seconds 2
  }

  $appExistedBefore = Test-Path $appDir
  if ($appExistedBefore) {
    Copy-Item -Path $appDir -Destination (Join-Path $backupDir "app") -Recurse -Force
  }
  $appBackedUp = $true
  Copy-ReleaseWrappers $installRoot $backupDir
  Backup-ConfiguredDirectories

  Write-UpdateStatus "installing"
  if (Test-Path $appDir) {
    Remove-Item -Path $appDir -Recurse -Force
  }
  Copy-Item -Path $newApp -Destination $appDir -Recurse -Force
  $newReleaseRoot = Split-Path -Parent $newApp
  Copy-ReleaseWrappers $newReleaseRoot $installRoot

  $startScript = Join-Path $installRoot "start.ps1"
  if (Test-Path $startScript) {
    Write-UpdateStatus "starting"
    & $startScript
    Wait-BridgeHealth
    if ($stateRootFromInput) {
      Set-Content -Path $stateRootFile -Value $stateRoot -Encoding UTF8
    }
  } else {
    throw "Installed start.ps1 not found after update."
  }

  Write-UpdateStatus "succeeded"
  Write-Output "Copilot Bridge updated. Backup: $backupDir"
} catch {
  $updateError = $_.Exception.Message
  if ($bridgeStopped) {
    $stopScript = Join-Path $installRoot "stop.ps1"
    if (Test-Path $stopScript) {
      & $stopScript
      Start-Sleep -Seconds 2
    }
  }

  $appBackup = Join-Path $backupDir "app"
  if ($appBackedUp) {
    if ($appExistedBefore -and -not (Test-Path $appBackup)) {
      Write-Warning "Skipping app restore because its backup was not found at $appBackup."
    } else {
      if (Test-Path $appDir) {
        Remove-Item -Path $appDir -Recurse -Force
      }
      if ($appExistedBefore) {
        Copy-Item -Path $appBackup -Destination $appDir -Recurse -Force
      }
    }
  }
  foreach ($entry in $backupEntries) {
    Restore-BackupEntry $entry
  }
  Copy-ReleaseWrappers $backupDir $installRoot
  if ($bridgeStopped) {
    $startScript = Join-Path $installRoot "start.ps1"
    if (Test-Path $startScript) {
      & $startScript
    }
  }
  Write-UpdateStatus "failed" $updateError $true
  throw
} finally {
  if (Test-Path $tempDir) {
    Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}
