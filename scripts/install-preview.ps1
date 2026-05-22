param(
  [string]$ManifestUrl = "https://github.com/TimStewartJ/copilot-bridge/releases/download/latest-preview/preview-win-x64.manifest.json",
  [string]$SignatureUrl,
  [string]$ManifestPublicKeyPem,
  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA "Programs\CopilotBridge"),
  [string]$StateRoot = (Join-Path $env:LOCALAPPDATA "CopilotBridge"),
  [int]$StartTimeoutSeconds = 60,
  [switch]$NoStart,
  [switch]$Force
)

$ErrorActionPreference = "Stop"

$embeddedManifestPublicKeyPem = @'
__BRIDGE_UPDATE_MANIFEST_PUBLIC_KEY_PEM__
'@
$embeddedManifestPublicKeyPlaceholder = "__BRIDGE_UPDATE_MANIFEST_" + "PUBLIC_KEY_PEM__"
$embeddedReleaseCommonScriptBase64 = "__BRIDGE_RELEASE_COMMON_SCRIPT_BASE64__"
$embeddedReleaseCommonScriptPlaceholder = "__BRIDGE_RELEASE_" + "COMMON_SCRIPT_BASE64__"

$bridgeReleaseCommonScript = if (-not [string]::IsNullOrWhiteSpace($PSScriptRoot)) {
  Join-Path $PSScriptRoot "release-common.ps1"
} else {
  $null
}
if ($bridgeReleaseCommonScript -and (Test-Path $bridgeReleaseCommonScript)) {
  . $bridgeReleaseCommonScript
} elseif ($embeddedReleaseCommonScriptBase64 -ne $embeddedReleaseCommonScriptPlaceholder) {
  $embeddedReleaseCommonScript = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($embeddedReleaseCommonScriptBase64.Trim()))
  . ([scriptblock]::Create($embeddedReleaseCommonScript))
} else {
  throw "Shared release helper not found. Download the published install-preview.ps1 asset or run this script from the repository scripts directory."
}

try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
} catch {
}

function Assert-HttpsUrl($Name, $Value) {
  [System.Uri]$uri = $null
  if (-not [System.Uri]::TryCreate($Value, [System.UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -ne [System.Uri]::UriSchemeHttps) {
    throw "$Name must be an absolute HTTPS URL. Received: $Value"
  }
  return $uri.AbsoluteUri
}

function Assert-Sha256($Name, $Value) {
  if ([string]::IsNullOrWhiteSpace($Value) -or $Value -notmatch '^[a-fA-F0-9]{64}$') {
    throw "$Name must be a 64-character SHA256 hash."
  }
  return $Value.ToLowerInvariant()
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
      $lastError = $_
      Start-Sleep -Milliseconds 250
    }
  } while ((Get-Date) -lt $deadline)

  throw "Timed out waiting to remove $Path. Last error: $($lastError.Exception.Message)"
}

function Resolve-CommandPath($CommandName) {
  $command = Get-Command $CommandName -ErrorAction SilentlyContinue
  if (-not $command) {
    return $null
  }
  return $command.Source
}

function Resolve-NodePath {
  $candidate = $env:BRIDGE_NODE_PATH
  if (-not [string]::IsNullOrWhiteSpace($candidate)) {
    if (Test-Path $candidate) {
      $nodePath = (Resolve-Path $candidate).Path
    } else {
      $nodePath = Resolve-CommandPath $candidate
    }
  } else {
    $nodePath = Resolve-CommandPath "node.exe"
    if (-not $nodePath) {
      $nodePath = Resolve-CommandPath "node"
    }
  }

  if (-not $nodePath) {
    throw "Node.js 22+ was not found. Install Node 22+ or set BRIDGE_NODE_PATH before installing Copilot Bridge."
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

function Invoke-Download($Url, $OutFile) {
  $safeUrl = Assert-HttpsUrl "Download URL" $Url
  New-Item -ItemType Directory -Path (Split-Path -Parent $OutFile) -Force | Out-Null
  Write-Output "Downloading $safeUrl"
  Invoke-WebRequest -Uri $safeUrl -OutFile $OutFile -UseBasicParsing
}

function Test-ManifestSignature($NodePath, $ManifestPath, $SignaturePath, $PublicKeyPath, $TempDir) {
  $verifierPath = Join-Path $TempDir "verify-manifest-signature.cjs"
  @'
const { createPublicKey, verify } = require("node:crypto");
const { readFileSync } = require("node:fs");

const [manifestPath, signaturePath, publicKeyPath] = process.argv.slice(2);
const manifest = readFileSync(manifestPath);
const signature = Buffer.from(readFileSync(signaturePath, "utf8").trim(), "base64");
const publicKey = createPublicKey(readFileSync(publicKeyPath, "utf8"));
if (!verify(null, manifest, publicKey, signature)) {
  console.error("Update manifest signature verification failed.");
  process.exit(1);
}
'@ | Set-Content -Path $verifierPath -Encoding ASCII

  & $NodePath $verifierPath $ManifestPath $SignaturePath $PublicKeyPath
  if ($LASTEXITCODE -ne 0) {
    throw "Update manifest signature verification failed."
  }
}

function Expand-BridgePackage($PackagePath, $Destination) {
  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  $tarPath = Resolve-CommandPath "tar.exe"
  if ($tarPath) {
    Write-Output "Extracting package with tar.exe"
    & $tarPath -xf $PackagePath -C $Destination
    if ($LASTEXITCODE -eq 0) {
      $global:LASTEXITCODE = 0
      return
    }
    Write-Warning "tar.exe extraction failed with exit code $LASTEXITCODE. Falling back to Expand-Archive."
    $global:LASTEXITCODE = 0
    Remove-PathWithRetry $Destination 10
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  }

  Write-Output "Extracting package with Expand-Archive"
  Expand-Archive -Path $PackagePath -DestinationPath $Destination -Force
}

function Test-BridgeReleaseRoot($ReleaseRoot) {
  return (Test-Path (Join-Path $ReleaseRoot "start.ps1")) -and
    (Test-Path (Join-Path $ReleaseRoot "stop.ps1")) -and
    (Test-Path (Join-Path $ReleaseRoot "app\dist\launcher.js")) -and
    (Test-Path (Join-Path $ReleaseRoot "app\.bridge-release.json"))
}

function Assert-ExistingInstallRootCanBeReplaced($Path, [bool]$AllowReplace) {
  if (-not (Test-Path $Path)) {
    return
  }
  if ($AllowReplace -or (Test-BridgeReleaseRoot $Path) -or (Test-Path (Join-Path $Path ".bridge-install.json"))) {
    return
  }
  throw "InstallRoot already exists but does not look like a Copilot Bridge install: $Path. Choose another -InstallRoot or pass -Force."
}

function Invoke-UnblockTree($Path) {
  if (-not (Get-Command Unblock-File -ErrorAction SilentlyContinue)) {
    return
  }
  Get-ChildItem -Path $Path -Recurse -Force | ForEach-Object {
    try {
      Unblock-File -Path $_.FullName -ErrorAction Stop
    } catch {
    }
  }
}

function Read-BridgePort($StateRoot) {
  $envPort = [Environment]::GetEnvironmentVariable("BRIDGE_PORT")
  if (-not [string]::IsNullOrWhiteSpace($envPort)) {
    return [int]$envPort
  }

  $envFile = Join-Path $StateRoot "config\.env"
  if (Test-Path $envFile) {
    foreach ($line in Get-Content $envFile) {
      if ($line -match '^\s*BRIDGE_PORT\s*=\s*(\d+)\s*$') {
        return [int]$Matches[1]
      }
    }
  }
  return 3333
}

function Wait-BridgeHealth($Port, [int]$TimeoutSeconds) {
  $healthUrl = "http://localhost:$Port/api/health"
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 5
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300) {
        return $healthUrl
      }
    } catch {
    }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)

  throw "Copilot Bridge did not become healthy at $healthUrl within $TimeoutSeconds seconds. Check logs under $(Join-Path $StateRoot "logs")."
}

$ManifestUrl = Assert-HttpsUrl "ManifestUrl" $ManifestUrl
if ([string]::IsNullOrWhiteSpace($SignatureUrl)) {
  $SignatureUrl = "$ManifestUrl.sig"
}
$SignatureUrl = Assert-HttpsUrl "SignatureUrl" $SignatureUrl
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
$StateRoot = [System.IO.Path]::GetFullPath($StateRoot)
Assert-AbsolutePath "InstallRoot" $InstallRoot ""
Assert-AbsolutePath "StateRoot" $StateRoot ""

$nodePath = Resolve-NodePath
if (-not [string]::IsNullOrWhiteSpace($ManifestPublicKeyPem)) {
  $publicKeyPem = $ManifestPublicKeyPem
} elseif (-not [string]::IsNullOrWhiteSpace($env:BRIDGE_UPDATE_MANIFEST_PUBLIC_KEY_PEM)) {
  $publicKeyPem = $env:BRIDGE_UPDATE_MANIFEST_PUBLIC_KEY_PEM
} elseif (-not [string]::IsNullOrWhiteSpace($env:BRIDGE_UPDATE_MANIFEST_PUBLIC_KEY_BASE64)) {
  $publicKeyPem = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($env:BRIDGE_UPDATE_MANIFEST_PUBLIC_KEY_BASE64.Trim()))
} else {
  $embedded = $embeddedManifestPublicKeyPem.Trim()
  if ([string]::IsNullOrWhiteSpace($embedded) -or $embedded -eq $embeddedManifestPublicKeyPlaceholder) {
    throw "The update manifest public key is not embedded in this installer. Download the published install-preview.ps1 asset or set BRIDGE_UPDATE_MANIFEST_PUBLIC_KEY_PEM."
  }
  $publicKeyPem = $embedded
}
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) "copilot-bridge-install-$timestamp-$PID"
$manifestPath = Join-Path $tempDir "manifest.json"
$signaturePath = Join-Path $tempDir "manifest.json.sig"
$publicKeyPath = Join-Path $tempDir "manifest-public-key.pem"
$packagePath = Join-Path $tempDir "package.zip"
$extractDir = Join-Path $tempDir "extract"
$stateRootFile = Join-Path $InstallRoot ".bridge-state-root"
$backupRoot = $null
$oldInstallMoved = $false

try {
  New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
  Set-Content -Path $publicKeyPath -Value $publicKeyPem.Trim() -Encoding ASCII

  Invoke-Download $ManifestUrl $manifestPath
  Invoke-Download $SignatureUrl $signaturePath
  Test-ManifestSignature $nodePath $manifestPath $signaturePath $publicKeyPath $tempDir

  $manifestText = Get-Content $manifestPath -Raw
  $manifest = $manifestText | ConvertFrom-Json
  if ($manifest.schemaVersion -ne 1 -or $manifest.appId -ne "copilot-bridge") {
    throw "Update manifest is not for Copilot Bridge."
  }
  if ($manifest.channel -ne "preview") {
    throw "install-preview.ps1 can only install preview packages. Manifest channel was '$($manifest.channel)'."
  }
  if ($manifest.platform -ne "win-x64") {
    throw "install-preview.ps1 can only install win-x64 packages. Manifest platform was '$($manifest.platform)'."
  }
  if (-not $manifest.package -or [string]::IsNullOrWhiteSpace($manifest.package.url)) {
    throw "Update manifest package URL is missing."
  }

  $packageUrl = Assert-HttpsUrl "Package URL" ([string]$manifest.package.url)
  $expectedSha256 = Assert-Sha256 "Package SHA256" ([string]$manifest.package.sha256)

  Invoke-Download $packageUrl $packagePath
  if (Get-Command Unblock-File -ErrorAction SilentlyContinue) {
    Unblock-File -Path $packagePath -ErrorAction SilentlyContinue
  }
  $actualSha256 = (Get-FileHash -Path $packagePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualSha256 -ne $expectedSha256) {
    throw "Downloaded package SHA256 mismatch. Expected $expectedSha256 but got $actualSha256."
  }

  Expand-BridgePackage $packagePath $extractDir
  $extractedReleaseRoot = Join-Path $extractDir "CopilotBridge"
  if (-not (Test-BridgeReleaseRoot $extractedReleaseRoot)) {
    throw "Downloaded package does not contain a valid Copilot Bridge release root."
  }
  Invoke-UnblockTree $extractedReleaseRoot

  Assert-ExistingInstallRootCanBeReplaced $InstallRoot ([bool]$Force)
  $storedStateRoot = Get-StoredStateRoot $stateRootFile
  Assert-StateRootDoesNotSwitch $storedStateRoot $StateRoot $stateRootFile

  if (Test-Path (Join-Path $InstallRoot "stop.ps1")) {
    Write-Output "Stopping existing Copilot Bridge install"
    & (Join-Path $InstallRoot "stop.ps1")
  }

  $installParent = Split-Path -Parent $InstallRoot
  New-Item -ItemType Directory -Path $installParent -Force | Out-Null
  if (Test-Path $InstallRoot) {
    $backupRoot = Join-Path $installParent ("{0}.previous-{1}" -f (Split-Path -Leaf $InstallRoot), $timestamp)
    Remove-PathWithRetry $backupRoot 10
    Move-Item -Path $InstallRoot -Destination $backupRoot -Force
    $oldInstallMoved = $true
  }

  Move-Item -Path $extractedReleaseRoot -Destination $InstallRoot -Force
  Set-Content -Path (Join-Path $InstallRoot ".bridge-state-root") -Value $StateRoot -Encoding UTF8
  [ordered]@{
    schemaVersion = 1
    installedAt = (Get-Date).ToUniversalTime().ToString("o")
    version = [string]$manifest.version
    channel = [string]$manifest.channel
    platform = [string]$manifest.platform
    sourceCommit = [string]$manifest.sourceCommit
    manifestUrl = $ManifestUrl
    packageUrl = $packageUrl
    packageSha256 = $expectedSha256
    stateRoot = $StateRoot
  } | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $InstallRoot ".bridge-install.json") -Encoding UTF8

  New-Item -ItemType Directory -Path (Join-Path $StateRoot "logs") -Force | Out-Null
  $healthUrl = $null
  if (-not $NoStart) {
    Write-Output "Starting Copilot Bridge"
    Set-Item -Path "Env:BRIDGE_STATE_ROOT" -Value $StateRoot
    & (Join-Path $InstallRoot "start.ps1")
    $healthUrl = Wait-BridgeHealth (Read-BridgePort $StateRoot) $StartTimeoutSeconds
  }

  if ($backupRoot -and (Test-Path $backupRoot)) {
    try {
      Remove-PathWithRetry $backupRoot 10
    } catch {
      Write-Warning "Installed the new package, but could not remove the previous app backup at $backupRoot. You can delete it after Bridge is stopped."
    }
  }

  Write-Output ""
  Write-Output "Copilot Bridge preview installed."
  Write-Output "Version: $($manifest.version)"
  Write-Output "Install root: $InstallRoot"
  Write-Output "State root: $StateRoot"
  Write-Output "Logs: $(Join-Path $StateRoot "logs")"
  if ($healthUrl) {
    Write-Output "Open: $($healthUrl -replace '/api/health$', '/')"
  } elseif ($NoStart) {
    Write-Output "Start later: & `"$InstallRoot\start.ps1`""
  }
} catch {
  if ($oldInstallMoved) {
    try {
      $candidateStopScript = Join-Path $InstallRoot "stop.ps1"
      if (Test-Path $candidateStopScript) {
        try {
          & $candidateStopScript
        } catch {
          Write-Warning "Could not stop the failed candidate install before rollback: $($_.Exception.Message)"
        }
      }
      if (Test-Path $InstallRoot) {
        Remove-PathWithRetry $InstallRoot 10
      }
      if ($backupRoot -and (Test-Path $backupRoot)) {
        Move-Item -Path $backupRoot -Destination $InstallRoot -Force
      }
    } catch {
      Write-Warning "Rollback of the previous install failed: $($_.Exception.Message)"
    }
  }
  throw
} finally {
  if (Test-Path $tempDir) {
    try {
      Remove-PathWithRetry $tempDir 10
    } catch {
      Write-Warning "Could not remove temporary installer folder ${tempDir}: $($_.Exception.Message)"
    }
  }
}
