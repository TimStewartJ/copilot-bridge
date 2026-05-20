param(
  [Parameter(Mandatory = $true)]
  [string]$PackagePath,
  [string]$ManifestPath,
  [string]$InstallerPath,
  [string]$ExpectedVersion,
  [string]$ExpectedCommit,
  [string]$EvidenceDir,
  [int]$TimeoutSeconds = 120,
  [switch]$KeepArtifacts
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Resolve-ExistingPath($Name, $Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) {
    throw "$Name is required."
  }
  if (-not (Test-Path -LiteralPath $Path)) {
    throw "$Name not found at $Path"
  }
  return (Resolve-Path -LiteralPath $Path).Path
}

function Write-JsonFile($Path, $Value, [int]$Depth = 8) {
  $parent = Split-Path -Parent $Path
  if (-not [string]::IsNullOrWhiteSpace($parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
  $Value | ConvertTo-Json -Depth $Depth | Set-Content -Path $Path -Encoding UTF8
}

function Read-JsonFile($Path) {
  if (-not (Test-Path -LiteralPath $Path)) {
    return $null
  }
  return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
}

function Get-FreeTcpPort {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  try {
    $listener.Start()
    return $listener.LocalEndpoint.Port
  } finally {
    $listener.Stop()
  }
}

function Remove-PathWithRetry($Path, [int]$TimeoutSeconds = 30) {
  if (-not (Test-Path -LiteralPath $Path)) {
    return
  }

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $lastError = $null
  do {
    try {
      [System.IO.Directory]::Delete([System.IO.Path]::GetFullPath($Path), $true)
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

function Expand-BridgePackage($ArchivePath, $DestinationPath) {
  if (Test-Path -LiteralPath $DestinationPath) {
    Remove-PathWithRetry $DestinationPath
  }
  New-Item -ItemType Directory -Path $DestinationPath -Force | Out-Null

  $tarCommand = Get-Command "tar.exe" -ErrorAction SilentlyContinue
  if ($tarCommand) {
    & $tarCommand.Source -xf $ArchivePath -C $DestinationPath
    if ($LASTEXITCODE -eq 0) {
      $global:LASTEXITCODE = 0
      return
    }
    $global:LASTEXITCODE = 0
    Remove-PathWithRetry $DestinationPath
    New-Item -ItemType Directory -Path $DestinationPath -Force | Out-Null
  }

  Expand-Archive -Path $ArchivePath -DestinationPath $DestinationPath -Force
}

function Find-ReleaseRoot($ExpandedPath) {
  $candidate = Join-Path $ExpandedPath "CopilotBridge"
  if (Test-Path -LiteralPath $candidate) {
    return (Resolve-Path -LiteralPath $candidate).Path
  }
  return (Resolve-Path -LiteralPath $ExpandedPath).Path
}

function Assert-PathExists($Name, $Path) {
  if (-not (Test-Path -LiteralPath $Path)) {
    throw "$Name not found at $Path"
  }
}

function Resolve-CommandPath($CommandName) {
  $command = Get-Command $CommandName -ErrorAction SilentlyContinue
  if (-not $command) {
    return $null
  }
  return $command.Source
}

function Resolve-NodePath {
  $nodePath = Resolve-CommandPath "node.exe"
  if (-not $nodePath) {
    $nodePath = Resolve-CommandPath "node"
  }
  if (-not $nodePath) {
    throw "Node.js 22+ was not found."
  }

  $versionText = (& $nodePath --version).Trim()
  if ($LASTEXITCODE -ne 0 -or $versionText -notmatch '^v?(\d+)\.') {
    throw "Could not determine Node.js version from $nodePath."
  }
  if ([int]$Matches[1] -lt 22) {
    throw "Node.js 22+ is required. Found $versionText at $nodePath."
  }
  return $nodePath
}

function Wait-Health($Port, [int]$TimeoutSeconds) {
  $healthUrl = "http://localhost:$Port/api/health"
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $lastError = $null
  do {
    try {
      $response = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 5
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300) {
        return $healthUrl
      }
    } catch {
      $lastError = $_.Exception.Message
      Start-Sleep -Milliseconds 500
    }
  } while ((Get-Date) -lt $deadline)

  throw "Copilot Bridge did not become healthy at $healthUrl within $TimeoutSeconds seconds. Last error: $lastError"
}

function Wait-UpdateStaged($DataDir, [int]$TimeoutSeconds) {
  $statusPath = Join-Path $DataDir "update-status.json"
  $signalPath = Join-Path $DataDir "restart.signal"
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $lastPhase = $null
  do {
    $status = Read-JsonFile $statusPath
    if ($status) {
      $lastPhase = [string]$status.phase
      if ($status.phase -eq "staged" -and (Test-Path -LiteralPath $signalPath)) {
        return $status
      }
      if ($status.phase -eq "failed" -or $status.phase -eq "rollback_failed") {
        throw "Update failed before activation. Phase: $($status.phase). Message: $($status.message)"
      }
    }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)

  throw "Timed out waiting for update.ps1 to stage a release candidate. Last phase: $lastPhase"
}

function Wait-UpdateSucceeded($DataDir, $ExpectedCommit, [int]$TimeoutSeconds) {
  $statusPath = Join-Path $DataDir "update-status.json"
  $activeReleasePath = Join-Path $DataDir "active-release.json"
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $lastPhase = $null
  do {
    $status = Read-JsonFile $statusPath
    $activeRelease = Read-JsonFile $activeReleasePath
    if ($status) {
      $lastPhase = [string]$status.phase
      if ($status.phase -eq "failed" -or $status.phase -eq "rollback_failed") {
        throw "Release candidate activation failed. Phase: $($status.phase). Message: $($status.message)"
      }
    }
    if (
      $status -and
      $status.phase -eq "succeeded" -and
      $activeRelease -and
      $activeRelease.commitSha -eq $ExpectedCommit -and
      (Test-Path -LiteralPath $activeRelease.root)
    ) {
      return [pscustomobject]@{
        Status = $status
        ActiveRelease = $activeRelease
      }
    }
    Start-Sleep -Seconds 1
  } while ((Get-Date) -lt $deadline)

  throw "Timed out waiting for release candidate activation. Last phase: $lastPhase"
}

function Test-CommandLineContains($CommandLine, $Needle) {
  if ([string]::IsNullOrWhiteSpace($CommandLine)) {
    return $false
  }
  return $CommandLine.IndexOf($Needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Get-IsolatedProcesses($RootPath) {
  @(Get-CimInstance Win32_Process | Where-Object { Test-CommandLineContains $_.CommandLine $RootPath })
}

function Stop-IsolatedProcesses($RootPath) {
  $processes = @(Get-IsolatedProcesses $RootPath | Sort-Object ProcessId -Descending)
  foreach ($process in $processes) {
    $processId = [int]$process.ProcessId
    if ($processId -le 4 -or $processId -eq $PID) {
      continue
    }
    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
  }
}

function Copy-IfExists($Source, $Destination) {
  if (Test-Path -LiteralPath $Source) {
    Copy-Item -LiteralPath $Source -Destination $Destination -Force
  }
}

function Write-LogTail($Source, $Destination, [int]$Tail = 200) {
  if (Test-Path -LiteralPath $Source) {
    Get-Content -LiteralPath $Source -Tail $Tail | Set-Content -Path $Destination -Encoding UTF8
  }
}

function Write-StepSummary($SummaryPath) {
  if ([string]::IsNullOrWhiteSpace($env:GITHUB_STEP_SUMMARY) -or -not (Test-Path -LiteralPath $SummaryPath)) {
    return
  }
  $summary = Get-Content -LiteralPath $SummaryPath -Raw | ConvertFrom-Json
  @(
    "## Release-mode install/update E2E",
    "",
    "| Field | Value |",
    "| --- | --- |",
    "| Result | $($summary.result) |",
    "| Version | $($summary.version) |",
    "| Commit | $($summary.sourceCommit) |",
    "| Port | $($summary.port) |",
    "| Update phase | $($summary.update.finalPhase) |",
    "| Active release | $($summary.update.activeReleaseId) |"
  ) | Add-Content -Path $env:GITHUB_STEP_SUMMARY -Encoding UTF8
}

$resolvedPackagePath = Resolve-ExistingPath "PackagePath" $PackagePath
$resolvedManifestPath = if ([string]::IsNullOrWhiteSpace($ManifestPath)) { $null } else { Resolve-ExistingPath "ManifestPath" $ManifestPath }
$resolvedInstallerPath = if ([string]::IsNullOrWhiteSpace($InstallerPath)) { $null } else { Resolve-ExistingPath "InstallerPath" $InstallerPath }
if ([string]::IsNullOrWhiteSpace($EvidenceDir)) {
  $EvidenceDir = Join-Path (Join-Path (Get-Location).Path "release") "release-mode-e2e"
}
$EvidenceDir = [System.IO.Path]::GetFullPath($EvidenceDir)
if (Test-Path -LiteralPath $EvidenceDir) {
  Remove-PathWithRetry $EvidenceDir
}
New-Item -ItemType Directory -Path $EvidenceDir -Force | Out-Null

$testRootBase = if (-not [string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
$testRoot = Join-Path $testRootBase "copilot-bridge-release-e2e-$([guid]::NewGuid().ToString('N'))"
$installRoot = Join-Path $testRoot "install"
$stateRoot = Join-Path $testRoot "state"
$dataDir = Join-Path $stateRoot "data"
$logsDir = Join-Path $stateRoot "logs"
$configDir = Join-Path $stateRoot "config"
$extractDir = Join-Path $testRoot "extract"
$summaryPath = Join-Path $EvidenceDir "summary.json"
$startedAt = (Get-Date).ToUniversalTime()
$summary = [ordered]@{
  result = "started"
  startedAt = $startedAt.ToString("o")
  packagePath = $resolvedPackagePath
  manifestPath = $resolvedManifestPath
  installerPath = $resolvedInstallerPath
  evidenceDir = $EvidenceDir
  testRoot = $testRoot
}
Write-JsonFile $summaryPath $summary

try {
  $packageHash = (Get-FileHash -Path $resolvedPackagePath -Algorithm SHA256).Hash.ToLowerInvariant()
  $manifest = if ($resolvedManifestPath) { Read-JsonFile $resolvedManifestPath } else { $null }
  if ($manifest -and $manifest.package -and $manifest.package.sha256 -and $manifest.package.sha256 -ne $packageHash) {
    throw "Package SHA256 mismatch. Manifest has $($manifest.package.sha256), but local package is $packageHash."
  }
  if ($resolvedInstallerPath) {
    $installerText = Get-Content -LiteralPath $resolvedInstallerPath -Raw
    if ($installerText.Contains("__BRIDGE_UPDATE_MANIFEST_PUBLIC_KEY_PEM__")) {
      throw "Installer still contains the update manifest public key placeholder."
    }
  }

  New-Item -ItemType Directory -Path $testRoot, $stateRoot, $dataDir, $logsDir, $configDir -Force | Out-Null
  Expand-BridgePackage $resolvedPackagePath $extractDir
  $releaseRoot = Find-ReleaseRoot $extractDir
  $appRoot = Join-Path $releaseRoot "app"
  Assert-PathExists "release start.ps1" (Join-Path $releaseRoot "start.ps1")
  Assert-PathExists "release update.ps1" (Join-Path $releaseRoot "update.ps1")
  Assert-PathExists "release app launcher" (Join-Path $appRoot "dist\launcher.js")
  Assert-PathExists "release app server" (Join-Path $appRoot "dist\server\index.js")
  Assert-PathExists "release node_modules" (Join-Path $appRoot "node_modules")

  $releaseManifest = Read-JsonFile (Join-Path $appRoot ".bridge-release.json")
  if (-not $releaseManifest) {
    throw "Package did not include app\.bridge-release.json."
  }

  $version = if (-not [string]::IsNullOrWhiteSpace($ExpectedVersion)) { $ExpectedVersion } elseif ($manifest) { [string]$manifest.version } else { [string]$releaseManifest.version }
  $sourceCommit = if (-not [string]::IsNullOrWhiteSpace($ExpectedCommit)) { $ExpectedCommit } elseif ($manifest) { [string]$manifest.sourceCommit } else { [string]$releaseManifest.sourceCommit }
  $channel = if ($manifest) { [string]$manifest.channel } else { [string]$releaseManifest.channel }
  $platform = if ($manifest) { [string]$manifest.platform } else { [string]$releaseManifest.platform }
  if ($releaseManifest.version -ne $version) {
    throw "Release metadata version '$($releaseManifest.version)' did not match expected version '$version'."
  }
  if ($releaseManifest.sourceCommit -ne $sourceCommit) {
    throw "Release metadata commit '$($releaseManifest.sourceCommit)' did not match expected commit '$sourceCommit'."
  }

  Move-Item -Path $releaseRoot -Destination $installRoot -Force
  Set-Content -Path (Join-Path $installRoot ".bridge-state-root") -Value $stateRoot -Encoding UTF8
  [ordered]@{
    schemaVersion = 1
    installedAt = (Get-Date).ToUniversalTime().ToString("o")
    version = $version
    channel = $channel
    platform = $platform
    sourceCommit = $sourceCommit
    manifestUrl = if ($manifest) { [string]$manifest.releaseUrl } else { $null }
    packageUrl = if ($manifest -and $manifest.package) { [string]$manifest.package.url } else { $resolvedPackagePath }
    packageSha256 = $packageHash
    stateRoot = $stateRoot
  } | ConvertTo-Json -Depth 5 | Set-Content -Path (Join-Path $installRoot ".bridge-install.json") -Encoding UTF8

  $port = Get-FreeTcpPort
  @(
    "BRIDGE_PORT=$port",
    "BRIDGE_ENABLE_TUNNEL=false",
    "BRIDGE_DISABLE_UPDATE_CHECK=true",
    "BRIDGE_DATA_DIR=$dataDir",
    "BRIDGE_DOCS_DIR=$(Join-Path $dataDir "docs")",
    "COPILOT_HOME=$(Join-Path $dataDir ".copilot")",
    "BRIDGE_WEBHOOK_URL=",
    "BRIDGE_TUNNEL_NAME=release-e2e-$port",
    "BRIDGE_TUNNEL_URL=",
    "BRIDGE_PUBLIC_BASE_URL=",
    "COMPUTER_USE=",
    "BRIDGE_TRANSCRIPTION_PROVIDER="
  ) | Set-Content -Path (Join-Path $configDir ".env") -Encoding UTF8

  Set-Item -Path "Env:BRIDGE_STATE_ROOT" -Value $stateRoot
  Set-Item -Path "Env:BRIDGE_PORT" -Value ([string]$port)
  Set-Item -Path "Env:BRIDGE_ENABLE_TUNNEL" -Value "false"
  Set-Item -Path "Env:BRIDGE_DISABLE_UPDATE_CHECK" -Value "true"
  Set-Item -Path "Env:BRIDGE_DISTRIBUTION_MODE" -Value "release"
  Set-Item -Path "Env:BRIDGE_RELEASE_ROOT" -Value $installRoot
  Set-Item -Path "Env:BRIDGE_DATA_DIR" -Value $dataDir
  Set-Item -Path "Env:BRIDGE_DOCS_DIR" -Value (Join-Path $dataDir "docs")
  Set-Item -Path "Env:COPILOT_HOME" -Value (Join-Path $dataDir ".copilot")
  Set-Item -Path "Env:BRIDGE_LAUNCHER_LOG_PATH" -Value (Join-Path $logsDir "launcher.log")
  Set-Item -Path "Env:BRIDGE_WEBHOOK_URL" -Value ""
  Set-Item -Path "Env:BRIDGE_TUNNEL_NAME" -Value "release-e2e-$port"
  Set-Item -Path "Env:BRIDGE_TUNNEL_URL" -Value ""
  Set-Item -Path "Env:BRIDGE_PUBLIC_BASE_URL" -Value ""
  Set-Item -Path "Env:COMPUTER_USE" -Value ""
  Set-Item -Path "Env:BRIDGE_TRANSCRIPTION_PROVIDER" -Value ""

  $nodePath = Resolve-NodePath
  $installedAppRoot = Join-Path $installRoot "app"
  $launcherPath = Join-Path $installedAppRoot "dist\launcher.js"
  $stdoutLog = Join-Path $logsDir "bridge.log"
  $stderrLog = Join-Path $logsDir "bridge-error.log"
  $launcherProcess = Start-Process -FilePath $nodePath `
    -ArgumentList "`"$launcherPath`"" `
    -WorkingDirectory $installedAppRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog `
    -PassThru
  $healthUrl = Wait-Health $port $TimeoutSeconds

  & (Join-Path $installRoot "update.ps1") `
    -PackagePath $resolvedPackagePath `
    -ExpectedSha256 $packageHash `
    -StateRoot $stateRoot `
    -FromVersion $version `
    -TargetVersion $version `
    -Channel $channel `
    -SourceCommit $sourceCommit
  if ($LASTEXITCODE -ne 0) {
    throw "update.ps1 exited with $LASTEXITCODE."
  }

  $stagedStatus = Wait-UpdateStaged $dataDir $TimeoutSeconds
  $activation = Wait-UpdateSucceeded $dataDir $sourceCommit $TimeoutSeconds
  Wait-Health $port $TimeoutSeconds | Out-Null

  $slotManifest = Read-JsonFile (Join-Path ([string]$activation.ActiveRelease.root) "release-slot.json")
  if (-not $slotManifest -or $slotManifest.commitSha -ne $sourceCommit) {
    throw "Active release slot metadata did not match expected commit '$sourceCommit'."
  }

  $summary = [ordered]@{
    result = "passed"
    startedAt = $startedAt.ToString("o")
    completedAt = (Get-Date).ToUniversalTime().ToString("o")
    durationSeconds = [math]::Round(((Get-Date).ToUniversalTime() - $startedAt).TotalSeconds, 3)
    version = $version
    channel = $channel
    platform = $platform
    sourceCommit = $sourceCommit
    port = $port
    healthUrl = $healthUrl
    package = [ordered]@{
      path = $resolvedPackagePath
      sha256 = $packageHash
      name = Split-Path -Leaf $resolvedPackagePath
    }
    launcher = [ordered]@{
      pid = $launcherProcess.Id
      path = $launcherPath
    }
    update = [ordered]@{
      stagedPhase = [string]$stagedStatus.phase
      finalPhase = [string]$activation.Status.phase
      releaseCandidateId = [string]$activation.Status.releaseCandidateId
      activeReleaseId = [string]$activation.ActiveRelease.id
      activeReleaseRoot = [string]$activation.ActiveRelease.root
      activeReleaseCommit = [string]$activation.ActiveRelease.commitSha
    }
    evidenceDir = $EvidenceDir
  }
  Write-JsonFile $summaryPath $summary
} catch {
  $summary.result = "failed"
  $summary.completedAt = (Get-Date).ToUniversalTime().ToString("o")
  $summary.error = $_.Exception.Message
  Write-JsonFile $summaryPath $summary
  throw
} finally {
  try {
    Get-IsolatedProcesses $testRoot |
      Select-Object ProcessId, ParentProcessId, Name, CommandLine |
      ConvertTo-Json -Depth 4 |
      Set-Content -Path (Join-Path $EvidenceDir "processes-before-cleanup.json") -Encoding UTF8
  } catch {
    Write-Warning "Could not capture isolated process list: $($_.Exception.Message)"
  }

  Copy-IfExists (Join-Path $installRoot ".bridge-install.json") (Join-Path $EvidenceDir "bridge-install.json")
  Copy-IfExists (Join-Path $dataDir "update-status.json") (Join-Path $EvidenceDir "update-status.json")
  Copy-IfExists (Join-Path $dataDir "active-release.json") (Join-Path $EvidenceDir "active-release.json")
  Write-LogTail (Join-Path $logsDir "launcher.log") (Join-Path $EvidenceDir "launcher-tail.log")
  Write-LogTail (Join-Path $logsDir "bridge.log") (Join-Path $EvidenceDir "bridge-tail.log")
  Write-LogTail (Join-Path $logsDir "bridge-error.log") (Join-Path $EvidenceDir "bridge-error-tail.log")

  try {
    Stop-IsolatedProcesses $testRoot
    Start-Sleep -Seconds 2
  } catch {
    Write-Warning "Could not stop isolated release-mode E2E processes cleanly: $($_.Exception.Message)"
  }

  try {
    if (-not $KeepArtifacts -and (Test-Path -LiteralPath $testRoot)) {
      Remove-PathWithRetry $testRoot
    }
  } catch {
    Write-Warning "Could not remove isolated release-mode E2E root ${testRoot}: $($_.Exception.Message)"
  }

  Write-StepSummary $summaryPath
}

