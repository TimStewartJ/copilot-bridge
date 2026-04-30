param(
  [string]$Version,
  [string]$Channel = "stable",
  [string]$OutputDir,
  [switch]$IncludeNodeModules
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$packageJson = Get-Content (Join-Path $repoRoot "package.json") -Raw | ConvertFrom-Json
if (-not $Version) {
  $Version = $packageJson.version
}
if (-not $OutputDir) {
  $OutputDir = Join-Path $repoRoot "release"
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
Copy-Item -Path (Join-Path $repoRoot "public") -Destination (Join-Path $appDir "public") -Recurse
Copy-Item -Path (Join-Path $repoRoot "scripts") -Destination (Join-Path $appDir "scripts") -Recurse
Copy-Item -Path (Join-Path $repoRoot "package.json") -Destination $appDir
Copy-Item -Path (Join-Path $repoRoot "package-lock.json") -Destination $appDir
Copy-Item -Path (Join-Path $repoRoot ".env.example") -Destination $appDir
Copy-Item -Path (Join-Path $repoRoot "README.md") -Destination $appDir
Copy-Item -Path (Join-Path $repoRoot "scripts\start-release.ps1") -Destination (Join-Path $releaseRoot "start.ps1")
Copy-Item -Path (Join-Path $repoRoot "scripts\stop-release.ps1") -Destination (Join-Path $releaseRoot "stop.ps1")
Copy-Item -Path (Join-Path $repoRoot "scripts\update-release.ps1") -Destination (Join-Path $releaseRoot "update.ps1")
Copy-Item -Path (Join-Path $repoRoot "scripts\install-startup-task.ps1") -Destination (Join-Path $releaseRoot "install-startup-task.ps1")
Copy-Item -Path (Join-Path $repoRoot "scripts\uninstall-startup-task.ps1") -Destination (Join-Path $releaseRoot "uninstall-startup-task.ps1")

if ($IncludeNodeModules) {
  Copy-Item -Path (Join-Path $repoRoot "node_modules") -Destination (Join-Path $appDir "node_modules") -Recurse
}

$sourceCommit = "unknown"
try {
  $sourceCommit = (git rev-parse HEAD).Trim()
} catch {
  $sourceCommit = "unknown"
}

$manifest = [ordered]@{
  version = $Version
  channel = $Channel
  sourceCommit = $sourceCommit
  createdAt = (Get-Date).ToUniversalTime().ToString("o")
  distributionMode = "release"
  includesNodeModules = [bool]$IncludeNodeModules
}
$manifest | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $appDir ".bridge-release.json") -Encoding UTF8

$zipPath = Join-Path $OutputDir "copilot-bridge-$Version-$Channel.zip"
if (Test-Path $zipPath) {
  Remove-Item -Path $zipPath -Force
}
Compress-Archive -Path $releaseRoot -DestinationPath $zipPath -Force

Write-Output "Release package created: $zipPath"
if (-not $IncludeNodeModules) {
  Write-Output "Package does not include node_modules. Run npm install in the app folder before starting, or rebuild with -IncludeNodeModules."
}
