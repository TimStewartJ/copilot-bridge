param(
  [Parameter(Mandatory = $true)]
  [string]$PackagePath,
  [switch]$Start,
  [int]$Port = 0,
  [int]$TimeoutSeconds = 120,
  [string]$StateRoot
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Get-FreeTcpPort {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  try {
    $listener.Start()
    return $listener.LocalEndpoint.Port
  } finally {
    $listener.Stop()
  }
}

function Find-ReleaseRoot($ExpandedPath) {
  $candidate = Join-Path $ExpandedPath "CopilotBridge"
  if (Test-Path $candidate) { return (Resolve-Path $candidate).Path }
  return (Resolve-Path $ExpandedPath).Path
}

function Find-AppRoot($ReleaseRoot) {
  $appRoot = Join-Path $ReleaseRoot "app"
  if (Test-Path $appRoot) { return $appRoot }
  return $null
}

function Expand-WithArchiveTool($ArchivePath, $DestinationPath) {
  $tarCommand = Get-Command "tar.exe" -ErrorAction SilentlyContinue
  if ($tarCommand) {
    & $tarCommand.Source -xf $ArchivePath -C $DestinationPath
    if ($LASTEXITCODE -eq 0) {
      $global:LASTEXITCODE = 0
      return $true
    }
    $global:LASTEXITCODE = 0
  }

  $unzipCommand = Get-Command "unzip" -ErrorAction SilentlyContinue
  if ($unzipCommand) {
    & $unzipCommand.Source -q $ArchivePath -d $DestinationPath
    if ($LASTEXITCODE -eq 0) {
      $global:LASTEXITCODE = 0
      return $true
    }
    $global:LASTEXITCODE = 0
  }

  return $false
}

function Expand-BridgePackage($ArchivePath, $DestinationPath) {
  if (Test-Path $DestinationPath) {
    Remove-Item -Path $DestinationPath -Recurse -Force
  }
  New-Item -ItemType Directory -Path $DestinationPath -Force | Out-Null

  if (Expand-WithArchiveTool $ArchivePath $DestinationPath) {
    return
  }

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::ExtractToDirectory((Resolve-Path $ArchivePath).Path, (Resolve-Path $DestinationPath).Path, $true)
}

function Assert-PathExists($Name, $Path) {
  if (-not (Test-Path $Path)) {
    throw "$Name not found at $Path"
  }
}

function Assert-PathAbsent($Name, $Path) {
  if (-not (Test-Path $Path)) {
    return
  }

  $entries = @(Get-ChildItem -Path $Path -Recurse -Force -ErrorAction SilentlyContinue | Select-Object -First 10 | ForEach-Object {
    $_.FullName
  })
  $detail = if ($entries.Count -gt 0) { " Found: $($entries -join ', ')" } else { "" }
  throw "$Name should not be included at $Path.$detail"
}

function Wait-Health($HealthUrl, $TimeoutSeconds) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    try {
      $response = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec 3
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300) {
        return
      }
    } catch {
      Start-Sleep -Seconds 2
    }
  } while ((Get-Date) -lt $deadline)

  throw "Copilot Bridge did not become healthy at $HealthUrl within $TimeoutSeconds seconds."
}

$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) "copilot-bridge-package-smoke-$([System.Guid]::NewGuid().ToString('N'))"
$expandedDir = Join-Path $tempDir "expanded"
$resolvedPackagePath = (Resolve-Path $PackagePath).Path
$previousEnv = @{}
$envNames = @(
  "BRIDGE_STATE_ROOT",
  "BRIDGE_DATA_DIR",
  "BRIDGE_DOCS_DIR",
  "COPILOT_HOME",
  "BRIDGE_PORT",
  "BRIDGE_ENABLE_TUNNEL",
  "BRIDGE_WEBHOOK_URL",
  "BRIDGE_TUNNEL_NAME",
  "BRIDGE_TUNNEL_URL",
  "BRIDGE_PUBLIC_BASE_URL",
  "BRIDGE_DISABLE_UPDATE_CHECK",
  "BRIDGE_DISTRIBUTION_MODE",
  "COMPUTER_USE",
  "BRIDGE_TRANSCRIPTION_PROVIDER"
)

try {
  Expand-BridgePackage $resolvedPackagePath $expandedDir

  $releaseRoot = Find-ReleaseRoot $expandedDir
  $appRoot = Find-AppRoot $releaseRoot
  Assert-PathExists "start.ps1" (Join-Path $releaseRoot "start.ps1")
  Assert-PathExists "stop.ps1" (Join-Path $releaseRoot "stop.ps1")
  Assert-PathExists "update.ps1" (Join-Path $releaseRoot "update.ps1")
  Assert-PathExists "release-common.ps1" (Join-Path $releaseRoot "release-common.ps1")
  Assert-PathExists "install-startup-task.ps1" (Join-Path $releaseRoot "install-startup-task.ps1")
  Assert-PathExists "uninstall-startup-task.ps1" (Join-Path $releaseRoot "uninstall-startup-task.ps1")
  if (-not $appRoot) {
    throw "Release app root not found under $releaseRoot"
  }
  Assert-PathExists "packaged launcher" (Join-Path $appRoot "dist\launcher.js")
  Assert-PathAbsent "app scripts directory" (Join-Path $appRoot "scripts")

  $nodeModulesRoot = Join-Path $appRoot "node_modules"
  if (Test-Path $nodeModulesRoot) {
    Assert-PathExists "Copilot SDK runtime" (Join-Path $nodeModulesRoot "@github\copilot-sdk\dist\index.js")
    Assert-PathExists "Copilot CLI JavaScript entrypoint" (Join-Path $nodeModulesRoot "@github\copilot\index.js")
    $copilotPrebuildRoot = Join-Path $nodeModulesRoot "@github\copilot\prebuilds\win32-x64"
    Assert-PathExists "Copilot CLI Windows x64 prebuilds" $copilotPrebuildRoot
    Assert-PathExists "Copilot CLI Windows x64 native addon" (Join-Path $copilotPrebuildRoot "cli-native.node")
  }

  Write-Output "Release package layout is valid: $releaseRoot"

  if (-not $Start) {
    Write-Output "Start smoke skipped. Pass -Start to run the packaged Bridge with isolated temporary state."
    return
  }

  $hasBundledNode = Test-Path (Join-Path $appRoot "runtime\node.exe")
  $hasNodeModules = Test-Path (Join-Path $appRoot "node_modules")
  if (-not $hasBundledNode -and -not $hasNodeModules) {
    throw "Package is not runnable without installing dependencies because it has neither app\runtime\node.exe nor app\node_modules."
  }
  $nodeExe = if ($hasBundledNode) { Join-Path $appRoot "runtime\node.exe" } else { "node" }

  if ($hasNodeModules) {
    Push-Location $appRoot
    try {
      & $nodeExe --input-type=module -e "import('@github/copilot-sdk').then(({ CopilotClient }) => { new CopilotClient({ autoStart: false }); console.log('Copilot SDK runtime import passed'); })"
      if ($LASTEXITCODE -ne 0) {
        throw "Copilot SDK runtime import failed with exit code $LASTEXITCODE."
      }
    } finally {
      Pop-Location
    }
  }

  if ($Port -le 0) {
    $Port = Get-FreeTcpPort
  }
  if ([string]::IsNullOrWhiteSpace($StateRoot)) {
    $StateRoot = Join-Path $tempDir "state"
  }

  foreach ($name in $envNames) {
    $previousEnv[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
  }

  $dataDir = Join-Path $StateRoot "data"
  New-Item -ItemType Directory -Path $StateRoot, $dataDir -Force | Out-Null

  Set-Item -Path "Env:BRIDGE_STATE_ROOT" -Value $StateRoot
  Set-Item -Path "Env:BRIDGE_DATA_DIR" -Value $dataDir
  Set-Item -Path "Env:BRIDGE_DOCS_DIR" -Value (Join-Path $dataDir "docs")
  Set-Item -Path "Env:COPILOT_HOME" -Value (Join-Path $dataDir ".copilot")
  Set-Item -Path "Env:BRIDGE_PORT" -Value ([string]$Port)
  Set-Item -Path "Env:BRIDGE_ENABLE_TUNNEL" -Value "false"
  Set-Item -Path "Env:BRIDGE_WEBHOOK_URL" -Value ""
  Set-Item -Path "Env:BRIDGE_TUNNEL_NAME" -Value "copilot-bridge-smoke-$Port"
  Set-Item -Path "Env:BRIDGE_TUNNEL_URL" -Value ""
  Set-Item -Path "Env:BRIDGE_PUBLIC_BASE_URL" -Value ""
  Set-Item -Path "Env:BRIDGE_DISABLE_UPDATE_CHECK" -Value "true"
  Set-Item -Path "Env:BRIDGE_DISTRIBUTION_MODE" -Value "release"
  Set-Item -Path "Env:COMPUTER_USE" -Value ""
  Set-Item -Path "Env:BRIDGE_TRANSCRIPTION_PROVIDER" -Value ""

  Push-Location $releaseRoot
  try {
    & .\start.ps1 | Write-Output
    Wait-Health "http://localhost:$Port/api/health" $TimeoutSeconds
    Write-Output "Release package start smoke passed at http://localhost:$Port/api/health"
  } finally {
    if (Test-Path (Join-Path $releaseRoot "stop.ps1")) {
      try {
        & (Join-Path $releaseRoot "stop.ps1") | Write-Output
      } catch {
        Write-Warning "Failed to stop smoke-test Bridge cleanly: $($_.Exception.Message)"
      }
    }
    Pop-Location
  }
} finally {
  foreach ($name in $envNames) {
    if ($previousEnv.ContainsKey($name)) {
      $value = $previousEnv[$name]
      if ($null -eq $value) {
        Remove-Item -Path "Env:$name" -ErrorAction SilentlyContinue
      } else {
        Set-Item -Path "Env:$name" -Value $value
      }
    }
  }
  if (Test-Path $tempDir) {
    Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}
