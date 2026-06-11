param(
  [string]$Version,
  [string]$Channel = "stable",
  [ValidateSet("win-x64")]
  [string]$Platform = "win-x64",
  [string]$OutputDir,
  [switch]$IncludeNodeModules,
  [switch]$Analyze,
  [switch]$SmokeTest
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$packageJson = Get-Content (Join-Path $repoRoot "package.json") -Raw | ConvertFrom-Json
$packageLockPath = Join-Path $repoRoot "package-lock.json"
if (-not $Version) {
  $Version = $packageJson.version
}
if (-not $OutputDir) {
  $OutputDir = Join-Path $repoRoot "release"
}

function Get-DependencyMap($Source, [string[]]$Names) {
  $map = [ordered]@{}
  foreach ($name in $Names) {
    $property = $Source.PSObject.Properties[$name]
    if (-not $property) {
      throw "Runtime dependency '$name' was not found in package.json dependencies."
    }
    $map[$name] = $property.Value
  }
  return $map
}

function Remove-PathIfExists([string]$Path) {
  if (Test-Path $Path) {
    Remove-Item -Path $Path -Recurse -Force
  }
}

function Remove-ChildrenExcept([string]$Path, [string[]]$Keep) {
  if (-not (Test-Path $Path)) {
    return
  }
  Get-ChildItem -Path $Path -Force | Where-Object { $Keep -notcontains $_.Name } | ForEach-Object {
    Remove-PathIfExists $_.FullName
  }
}

function Optimize-RuntimeNodeModules([string]$AppDir) {
  $copilotRoot = Join-Path $AppDir "node_modules\@github\copilot"
  if (-not (Test-Path $copilotRoot)) {
    return
  }

  Remove-ChildrenExcept (Join-Path $copilotRoot "prebuilds") @("win32-x64")
  Remove-ChildrenExcept (Join-Path $copilotRoot "ripgrep\bin") @("win32-x64")
  Remove-ChildrenExcept (Join-Path $copilotRoot "mxc-bin") @("x64")
  Remove-ChildrenExcept (Join-Path $copilotRoot "koffi\build\koffi") @("win32_x64")
  Remove-ChildrenExcept (Join-Path $copilotRoot "clipboard\node_modules\@teddyzhu") @("clipboard", "clipboard-win32-x64-msvc")
  Remove-PathIfExists (Join-Path $AppDir "node_modules\@github\copilot-win32-x64")
}

function Read-UpdateManifestPublicKeyPem {
  if (-not [string]::IsNullOrWhiteSpace($env:BRIDGE_UPDATE_MANIFEST_PUBLIC_KEY_PEM)) {
    return $env:BRIDGE_UPDATE_MANIFEST_PUBLIC_KEY_PEM
  }
  if (-not [string]::IsNullOrWhiteSpace($env:BRIDGE_UPDATE_MANIFEST_PUBLIC_KEY_BASE64)) {
    return [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($env:BRIDGE_UPDATE_MANIFEST_PUBLIC_KEY_BASE64.Trim()))
  }
  if (-not [string]::IsNullOrWhiteSpace($env:BRIDGE_UPDATE_MANIFEST_PUBLIC_KEY_PATH) -and (Test-Path $env:BRIDGE_UPDATE_MANIFEST_PUBLIC_KEY_PATH)) {
    return Get-Content -Path $env:BRIDGE_UPDATE_MANIFEST_PUBLIC_KEY_PATH -Raw
  }
  return $null
}

$runtimeDependencyNames = @(
  "@github/copilot-sdk",
  "@modelcontextprotocol/sdk",
  "express",
  "gray-matter",
  "multer",
  "node-cron",
  "web-push",
  "yaml"
)

$runtimePackageJson = [ordered]@{
  name = $packageJson.name
  version = $Version
  private = $true
  type = "module"
  description = "Copilot Bridge packaged runtime dependencies"
  license = $packageJson.license
  engines = $packageJson.engines
  dependencies = Get-DependencyMap $packageJson.dependencies $runtimeDependencyNames
}
if ($packageJson.overrides) {
  $runtimePackageJson.overrides = $packageJson.overrides
}

Set-Location $repoRoot
npm run build

$releaseRoot = Join-Path $OutputDir "CopilotBridge"
$appDir = Join-Path $releaseRoot "app"
if (Test-Path $releaseRoot) {
  Remove-Item -Path $releaseRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $appDir -Force | Out-Null

Copy-Item -Path (Join-Path $repoRoot "dist") -Destination (Join-Path $appDir "dist") -Recurse
Copy-Item -Path (Join-Path $repoRoot "src\server\copilot-cli-wrapper.js") -Destination (Join-Path $appDir "dist\server\copilot-cli-wrapper.js")
Copy-Item -Path (Join-Path $repoRoot "src\server\copilot-cli-loader.js") -Destination (Join-Path $appDir "dist\server\copilot-cli-loader.js")
Copy-Item -Path (Join-Path $repoRoot "public") -Destination (Join-Path $appDir "public") -Recurse
$runtimePackageJson | ConvertTo-Json -Depth 8 | Set-Content -Path (Join-Path $appDir "package.json") -Encoding UTF8
if (Test-Path $packageLockPath) {
  Copy-Item -Path $packageLockPath -Destination $appDir
}
Copy-Item -Path (Join-Path $repoRoot ".env.example") -Destination $appDir
Copy-Item -Path (Join-Path $repoRoot "README.md") -Destination $appDir
Copy-Item -Path (Join-Path $repoRoot "scripts\start-release.ps1") -Destination (Join-Path $releaseRoot "start.ps1")
Copy-Item -Path (Join-Path $repoRoot "scripts\stop-release.ps1") -Destination (Join-Path $releaseRoot "stop.ps1")
Copy-Item -Path (Join-Path $repoRoot "scripts\update-release.ps1") -Destination (Join-Path $releaseRoot "update.ps1")
$supervisorHelperSource = Get-Content -LiteralPath (Join-Path $repoRoot "scripts\bridge-supervisor-common.ps1") -Raw
$supervisorHelperBase64 = [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($supervisorHelperSource))
$releaseCommonSource = Get-Content -LiteralPath (Join-Path $repoRoot "scripts\release-common.ps1") -Raw
$supervisorHelperPlaceholder = "__BRIDGE_SUPERVISOR_HELPER_BASE64__"
$placeholderCount = [regex]::Matches(
  $releaseCommonSource,
  [regex]::Escape($supervisorHelperPlaceholder)
).Count
if ($placeholderCount -ne 1) {
  throw "release-common.ps1 must contain exactly one supervisor bootstrap placeholder; found $placeholderCount."
}
$packagedReleaseCommon = $releaseCommonSource.Replace($supervisorHelperPlaceholder, $supervisorHelperBase64)
[System.IO.File]::WriteAllText(
  (Join-Path $releaseRoot "release-common.ps1"),
  $packagedReleaseCommon,
  (New-Object System.Text.UTF8Encoding($false))
)
[System.IO.File]::WriteAllText(
  (Join-Path $releaseRoot "bridge-supervisor-common.ps1"),
  $supervisorHelperSource,
  (New-Object System.Text.UTF8Encoding($false))
)
Copy-Item -Path (Join-Path $repoRoot "scripts\install-startup-task.ps1") -Destination (Join-Path $releaseRoot "install-startup-task.ps1")
Copy-Item -Path (Join-Path $repoRoot "scripts\uninstall-startup-task.ps1") -Destination (Join-Path $releaseRoot "uninstall-startup-task.ps1")

$updateManifestPublicKeyPem = Read-UpdateManifestPublicKeyPem
if (-not [string]::IsNullOrWhiteSpace($updateManifestPublicKeyPem)) {
  Set-Content -Path (Join-Path $appDir "update-manifest-public-key.pem") -Value $updateManifestPublicKeyPem.Trim() -Encoding ASCII
}

if ($IncludeNodeModules) {
  Push-Location $appDir
  try {
    npm install --omit=dev --omit=optional --no-audit --no-fund
  } finally {
    Pop-Location
  }
  Optimize-RuntimeNodeModules $appDir
}

$sourceCommit = "unknown"
try {
  $sourceCommit = (git rev-parse HEAD).Trim()
} catch {
  $sourceCommit = "unknown"
}

$manifest = [ordered]@{
  schemaVersion = 1
  appId = "copilot-bridge"
  version = $Version
  channel = $Channel
  platform = $Platform
  sourceCommit = $sourceCommit
  createdAt = (Get-Date).ToUniversalTime().ToString("o")
  packageLayoutVersion = 4
  distributionMode = "release"
  includesNodeModules = [bool]$IncludeNodeModules
  nodeModulesMode = if ($IncludeNodeModules) { "runtime" } else { "none" }
  nodeModulesOptimization = if ($IncludeNodeModules) { "win-x64-pruned" } else { "none" }
  updateManifestPublicKeyPath = if (-not [string]::IsNullOrWhiteSpace($updateManifestPublicKeyPem)) { "update-manifest-public-key.pem" } else { $null }
  runtimeDependencies = $runtimeDependencyNames
}
$manifest | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $appDir ".bridge-release.json") -Encoding UTF8

$zipPath = Join-Path $OutputDir "copilot-bridge-$Version-$Channel-$Platform.zip"
if (Test-Path $zipPath) {
  Remove-Item -Path $zipPath -Force
}
Compress-Archive -Path $releaseRoot -DestinationPath $zipPath -Force

$zipHash = (Get-FileHash -Path $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
$shaPath = "$zipPath.sha256"
Set-Content -Path $shaPath -Value "$zipHash  $(Split-Path -Leaf $zipPath)" -Encoding ASCII

Write-Output "Release package created: $zipPath"
Write-Output "SHA256 file created: $shaPath"
if (-not $IncludeNodeModules) {
  Write-Output "Package does not include node_modules. Run npm install in the app folder before starting, or rebuild with -IncludeNodeModules."
}

if ($Analyze) {
  $analysisPath = [System.IO.Path]::ChangeExtension($zipPath, ".analysis.json")
  & (Join-Path $PSScriptRoot "analyze-release-package.ps1") -PackagePath $zipPath -JsonOutput $analysisPath -FailOnSensitiveFiles
}

if ($SmokeTest) {
  $smokeScript = Join-Path $PSScriptRoot "test-release-package.ps1"
  if ($IncludeNodeModules) {
    & $smokeScript -PackagePath $zipPath -Start
  } else {
    Write-Warning "Package does not include node_modules. Running layout-only smoke test."
    & $smokeScript -PackagePath $zipPath
  }
}
