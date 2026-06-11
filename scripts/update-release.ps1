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

$bridgeReleaseCommonScript = Join-Path $PSScriptRoot "release-common.ps1"
if (-not (Test-Path $bridgeReleaseCommonScript)) {
  throw "Shared release helper not found at $bridgeReleaseCommonScript. The install package may be incomplete; reinstall Copilot Bridge."
}
. $bridgeReleaseCommonScript

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

function Copy-ReleaseWrappers($SourceRoot, $DestinationRoot) {
  foreach ($scriptName in @("release-common.ps1", "bridge-supervisor-common.ps1", "start.ps1", "stop.ps1", "update.ps1", "install-startup-task.ps1", "uninstall-startup-task.ps1")) {
    $source = Join-Path $SourceRoot $scriptName
    if (Test-Path $source) {
      Copy-Item -Path $source -Destination (Join-Path $DestinationRoot $scriptName) -Force
    }
  }
}

function Copy-ReleaseWrappersWithBackup($SourceRoot, $DestinationRoot, $BackupRoot) {
  New-Item -ItemType Directory -Path $BackupRoot -Force | Out-Null
  Copy-ReleaseWrappers $DestinationRoot $BackupRoot
  try {
    Copy-ReleaseWrappers $SourceRoot $DestinationRoot
  } catch {
    try {
      Copy-ReleaseWrappers $BackupRoot $DestinationRoot
    } catch {
      Write-Warning "Failed to restore previous release wrapper scripts: $($_.Exception.Message)"
    }
    throw
  }
}

function Get-SafeSlotPart([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return "release" }
  $safe = $Value.Trim().ToLowerInvariant() -replace '[^a-z0-9._-]+', '-'
  $safe = $safe.Trim("-")
  if ([string]::IsNullOrWhiteSpace($safe)) { return "release" }
  if ($safe.Length -gt 48) { return $safe.Substring(0, 48) }
  return $safe
}

function New-ReleaseSlotId([string]$CommitSha) {
  $slotTimestamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH-mm-ss-fffffffZ")
  $shortCommit = Get-SafeSlotPart $CommitSha
  if ($shortCommit.Length -gt 12) { $shortCommit = $shortCommit.Substring(0, 12) }
  return "$slotTimestamp-$shortCommit-$([guid]::NewGuid().ToString("N").Substring(0, 8))"
}

function Write-JsonFile($Path, $Value, [int]$Depth = 6) {
  $parent = Split-Path -Parent $Path
  if (-not [string]::IsNullOrWhiteSpace($parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
  $Value | ConvertTo-Json -Depth $Depth | Set-Content -Path $Path -Encoding UTF8
}

function Remove-PathWithRetry($Path, [int]$TimeoutSeconds = 30) {
  if (-not (Test-Path $Path)) {
    return
  }

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $lastError = $null
  do {
    try {
      Remove-Item -Path $Path -Recurse -Force -ErrorAction Stop
      return
    } catch {
      $lastError = $_.Exception.Message
      if ((Get-Date) -ge $deadline) {
        throw "Timed out waiting to remove $Path. Last error: $lastError"
      }
      Start-Sleep -Milliseconds 500
    }
  } while ($true)
}

function Reset-Directory($Path) {
  if (Test-Path $Path) {
    Remove-PathWithRetry $Path
  }
  New-Item -ItemType Directory -Path $Path -Force | Out-Null
}

function Expand-UpdateArchive($PackagePath, $DestinationPath) {
  Reset-Directory $DestinationPath
  $tarCommand = Get-Command "tar.exe" -ErrorAction SilentlyContinue
  if ($tarCommand) {
    Write-Output "Extracting update package with tar.exe."
    $tarError = $null
    $tarExitCode = 1
    try {
      & $tarCommand.Source -xf $PackagePath -C $DestinationPath
      $tarExitCode = if ($null -eq $LASTEXITCODE) { 0 } else { $LASTEXITCODE }
    } catch {
      $tarError = $_.Exception.Message
      $tarExitCode = if ($null -eq $LASTEXITCODE) { 1 } else { $LASTEXITCODE }
    }
    if ($tarExitCode -eq 0) {
      $global:LASTEXITCODE = 0
      return
    }

    if ([string]::IsNullOrWhiteSpace($tarError)) {
      Write-Warning "tar.exe extraction failed with exit code $tarExitCode. Falling back to Expand-Archive."
    } else {
      Write-Warning "tar.exe extraction failed with exit code $tarExitCode ($tarError). Falling back to Expand-Archive."
    }
    Reset-Directory $DestinationPath
  } else {
    Write-Warning "tar.exe was not found. Falling back to Expand-Archive."
  }

  Expand-Archive -Path $PackagePath -DestinationPath $DestinationPath -Force
}

function Copy-DirectoryTree($SourcePath, $DestinationPath) {
  $destinationParent = Split-Path -Parent $DestinationPath
  if (-not [string]::IsNullOrWhiteSpace($destinationParent)) {
    New-Item -ItemType Directory -Path $destinationParent -Force | Out-Null
  }
  if (Test-Path $DestinationPath) {
    Remove-PathWithRetry $DestinationPath
  }

  $robocopyCommand = Get-Command "robocopy.exe" -ErrorAction SilentlyContinue
  if ($robocopyCommand) {
    Write-Output "Copying directory tree with robocopy.exe."
    $robocopyError = $null
    $robocopyExitCode = 16
    try {
      & $robocopyCommand.Source $SourcePath $DestinationPath /E /NFL /NDL /NJH /NJS /NC /NS /NP /MT:8
      $robocopyExitCode = if ($null -eq $LASTEXITCODE) { 16 } else { $LASTEXITCODE }
    } catch {
      $robocopyError = $_.Exception.Message
      $robocopyExitCode = if ($null -eq $LASTEXITCODE) { 16 } else { $LASTEXITCODE }
    }
    if ($robocopyExitCode -le 7) {
      $global:LASTEXITCODE = 0
      return
    }

    if ([string]::IsNullOrWhiteSpace($robocopyError)) {
      Write-Warning "robocopy.exe failed with exit code $robocopyExitCode. Falling back to Copy-Item."
    } else {
      Write-Warning "robocopy.exe failed with exit code $robocopyExitCode ($robocopyError). Falling back to Copy-Item."
    }
    if (Test-Path $DestinationPath) {
      Remove-PathWithRetry $DestinationPath
    }
  } else {
    Write-Warning "robocopy.exe was not found. Falling back to Copy-Item."
  }

  Copy-Item -Path $SourcePath -Destination $DestinationPath -Recurse -Force
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

Assert-StateRootDoesNotSwitch $storedStateRoot $StateRoot $stateRootFile
Assert-AbsolutePath "BRIDGE_STATE_ROOT" $stateRoot
Set-Item -Path "Env:BRIDGE_STATE_ROOT" -Value $stateRoot
New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
Import-BridgeEnvFile (Join-Path $stateRoot "config\.env")

$effectiveDataDir = Get-EnvPathOrDefault "BRIDGE_DATA_DIR" (Join-Path $stateRoot "data")
$effectiveDocsDir = Get-EnvPathOrDefault "BRIDGE_DOCS_DIR" (Join-Path $effectiveDataDir "docs")
$effectiveCopilotHome = Get-EnvPathOrDefault "COPILOT_HOME" (Join-Path $effectiveDataDir ".copilot")
Assert-AbsolutePath "BRIDGE_DATA_DIR" $effectiveDataDir
Assert-AbsolutePath "BRIDGE_DOCS_DIR" $effectiveDocsDir
Assert-AbsolutePath "COPILOT_HOME" $effectiveCopilotHome

if ([string]::IsNullOrWhiteSpace($StatusPath)) {
  $StatusPath = Join-Path $effectiveDataDir "update-status.json"
}
if ([string]::IsNullOrWhiteSpace($LogPath)) {
  $LogPath = Join-Path $stateRoot "logs\update-$timestamp.log"
}
New-Item -ItemType Directory -Path (Split-Path -Parent $StatusPath), (Split-Path -Parent $LogPath) -Force | Out-Null
$statusStartedAt = (Get-Date).ToUniversalTime().ToString("o")
$releaseCandidateId = $null
$releaseCandidateRoot = $null
$resolvedPackageSha256 = $ExpectedSha256

function Write-UpdateStatus($Phase, [string]$Message = $null) {
  $now = (Get-Date).ToUniversalTime().ToString("o")
  $status = [ordered]@{
    id = if (-not [string]::IsNullOrWhiteSpace($InstallId)) { $InstallId } else { $timestamp }
    phase = $Phase
    channel = $Channel
    fromVersion = $FromVersion
    toVersion = $TargetVersion
    sourceCommit = $SourceCommit
    packageUrl = $DownloadUrl
    packageSha256 = $resolvedPackageSha256
    startedAt = $statusStartedAt
    updatedAt = $now
    logPath = $LogPath
  }
  if ($Phase -eq "succeeded" -or $Phase -eq "failed") {
    $status.completedAt = $now
  }
  if (-not [string]::IsNullOrWhiteSpace($Message)) {
    $status.message = $Message
  }
  if ($Phase -eq "failed" -and -not [string]::IsNullOrWhiteSpace($Message)) {
    $status.error = $Message
  }
  if (-not [string]::IsNullOrWhiteSpace($script:releaseCandidateId)) {
    $status.releaseCandidateId = $script:releaseCandidateId
  }
  if (-not [string]::IsNullOrWhiteSpace($script:releaseCandidateRoot)) {
    $status.releaseCandidateRoot = $script:releaseCandidateRoot
  }
  if ($Phase -eq "staged") {
    $status.pendingRestart = $true
  } elseif ($Phase -eq "succeeded" -or $Phase -eq "failed") {
    $status.pendingRestart = $false
  }
  $status | ConvertTo-Json -Depth 4 | Set-Content -Path $StatusPath -Encoding UTF8
}

try {
  Write-UpdateStatus "started" "Preparing update from $FromVersion to $TargetVersion."
  $resolvedPackage = $PackagePath
  if ($DownloadUrl) {
    Write-UpdateStatus "downloading" "Downloading update package."
    $resolvedPackage = Join-Path $tempDir "copilot-bridge-update.zip"
    Invoke-WebRequest -Uri $DownloadUrl -OutFile $resolvedPackage
  }
  $resolvedPackage = (Resolve-Path $resolvedPackage).Path

  Write-UpdateStatus "verifying" "Verifying package SHA256."
  $hash = (Get-FileHash -Path $resolvedPackage -Algorithm SHA256).Hash.ToLowerInvariant()
  $resolvedPackageSha256 = $hash
  if ($ExpectedSha256 -and $hash -ne $ExpectedSha256.ToLowerInvariant()) {
    throw "Package SHA256 mismatch. Expected $ExpectedSha256 but got $hash."
  }

  $expandedDir = Join-Path $tempDir "expanded"
  Write-UpdateStatus "staging" "Extracting update package with tar.exe when available."
  Expand-UpdateArchive $resolvedPackage $expandedDir
  Write-UpdateStatus "staging" "Validating extracted update package."
  $newApp = Join-Path $expandedDir "CopilotBridge\app"
  if (-not (Test-Path $newApp)) {
    $newApp = Join-Path $expandedDir "app"
  }
  if (-not (Test-Path (Join-Path $newApp "dist\launcher.js"))) {
    throw "Update package does not contain app\dist\launcher.js."
  }
  if (-not (Test-Path (Join-Path $newApp "dist\server\index.js"))) {
    throw "Update package does not contain app\dist\server\index.js."
  }
  if (-not (Test-Path (Join-Path $newApp "node_modules"))) {
    throw "Update package does not include app\node_modules. Rebuild the package with -IncludeNodeModules before using update.ps1."
  }
  if (-not (Test-Path (Join-Path $newApp "package.json"))) {
    throw "Update package does not contain app\package.json."
  }
  $releaseManifestPath = Join-Path $newApp ".bridge-release.json"
  if (-not (Test-Path $releaseManifestPath)) {
    throw "Update package does not contain app\.bridge-release.json."
  }
  $releaseMetadata = Get-Content $releaseManifestPath -Raw | ConvertFrom-Json
  if ([string]::IsNullOrWhiteSpace($TargetVersion)) {
    $TargetVersion = $releaseMetadata.version
  } elseif (-not [string]::IsNullOrWhiteSpace($releaseMetadata.version) -and $TargetVersion -ne $releaseMetadata.version) {
    throw "Update package version '$($releaseMetadata.version)' does not match signed manifest version '$TargetVersion'."
  }
  if ([string]::IsNullOrWhiteSpace($SourceCommit)) {
    $SourceCommit = $releaseMetadata.sourceCommit
  } elseif (-not [string]::IsNullOrWhiteSpace($releaseMetadata.sourceCommit) -and $SourceCommit -ne $releaseMetadata.sourceCommit) {
    throw "Update package source commit '$($releaseMetadata.sourceCommit)' does not match signed manifest commit '$SourceCommit'."
  }
  if ([string]::IsNullOrWhiteSpace($SourceCommit)) {
    $SourceCommit = "release-$TargetVersion"
  }

  $releaseSlotsDir = Join-Path $effectiveDataDir "release-slots"
  New-Item -ItemType Directory -Path $releaseSlotsDir -Force | Out-Null
  $slotId = New-ReleaseSlotId $SourceCommit
  $slotRoot = Join-Path $releaseSlotsDir $slotId
  $tempSlotRoot = Join-Path $releaseSlotsDir ".$slotId.$PID.tmp"
  $restartQueued = $false
  if (Test-Path $slotRoot) {
    throw "Release slot already exists at $slotRoot."
  }
  if (Test-Path $tempSlotRoot) {
    Remove-PathWithRetry $tempSlotRoot
  }

  Write-UpdateStatus "staging" "Copying update package into inactive release slot $slotId."
  Copy-DirectoryTree $newApp $tempSlotRoot
  $dependencyHash = "package-sha256:$hash"
  $releaseSlotManifest = [ordered]@{
    version = 1
    id = $slotId
    root = $slotRoot
    commitSha = $SourceCommit
    source = "release_update"
    dependencyHash = $dependencyHash
    createdAt = (Get-Date).ToUniversalTime().ToString("o")
    validationMode = "deploy"
  }
  Write-JsonFile (Join-Path $tempSlotRoot "release-slot.json") $releaseSlotManifest
  Move-Item -Path $tempSlotRoot -Destination $slotRoot -ErrorAction Stop
  $script:releaseCandidateId = $slotId
  $script:releaseCandidateRoot = $slotRoot

  Write-UpdateStatus "staging" "Refreshing release wrapper scripts."
  $newReleaseRoot = Split-Path -Parent $newApp
  $wrapperBackupRoot = Join-Path (Join-Path (Join-Path $stateRoot "backups") "update-$timestamp") "wrappers"
  Copy-ReleaseWrappersWithBackup $newReleaseRoot $installRoot $wrapperBackupRoot

  if ($stateRootFromInput) {
    Set-Content -Path $stateRootFile -Value $stateRoot -Encoding UTF8
  }

  Write-UpdateStatus "staged" "Update candidate $TargetVersion is staged. The launcher will activate it after active sessions are idle."
  $restartSignal = [ordered]@{
    requestedAt = (Get-Date).ToUniversalTime().ToString("o")
    validationMode = "deploy"
    source = "release_update"
    releaseCandidate = [ordered]@{
      id = $slotId
      root = $slotRoot
      commitSha = $SourceCommit
      source = "release_update"
      dependencyHash = $dependencyHash
    }
  }
  $restartSignalPath = Join-Path $effectiveDataDir "restart.signal"
  $restartSignalTempPath = Join-Path $effectiveDataDir ".restart.signal.$PID.tmp"
  Write-JsonFile $restartSignalTempPath $restartSignal
  Move-Item -Path $restartSignalTempPath -Destination $restartSignalPath -Force
  $restartQueued = $true

  Write-Output "Copilot Bridge update staged in release slot $slotId. Launcher activation queued."
} catch {
  $updateError = $_.Exception.Message
  if (-not $restartQueued) {
    if ($tempSlotRoot -and (Test-Path $tempSlotRoot)) {
      Remove-Item -Path $tempSlotRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ($slotRoot -and (Test-Path $slotRoot)) {
      Remove-Item -Path $slotRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
  Write-UpdateStatus "failed" $updateError
  throw
} finally {
  if (Test-Path $tempDir) {
    Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}
