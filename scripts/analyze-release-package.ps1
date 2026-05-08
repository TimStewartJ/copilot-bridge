param(
  [string]$PackagePath,
  [string]$PackageRoot,
  [int]$Top = 15,
  [string]$JsonOutput,
  [switch]$FailOnSensitiveFiles
)

$ErrorActionPreference = "Stop"

if (($PackagePath -and $PackageRoot) -or (-not $PackagePath -and -not $PackageRoot)) {
  throw "Provide exactly one of -PackagePath or -PackageRoot."
}

function Format-Bytes($Bytes) {
  if ($null -eq $Bytes) { return "0 B" }
  if ($Bytes -ge 1GB) { return "{0:N2} GB" -f ($Bytes / 1GB) }
  if ($Bytes -ge 1MB) { return "{0:N2} MB" -f ($Bytes / 1MB) }
  if ($Bytes -ge 1KB) { return "{0:N2} KB" -f ($Bytes / 1KB) }
  return "$Bytes B"
}

function Get-TreeSummary($Path) {
  if (-not (Test-Path $Path)) {
    return [pscustomobject]@{ bytes = 0; files = 0 }
  }

  $measure = Get-ChildItem -Path $Path -Recurse -Force -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum
  $sum = if ($null -eq $measure.Sum) { 0 } else { $measure.Sum }
  return [pscustomobject]@{
    bytes = [int64]$sum
    files = [int]$measure.Count
  }
}

function Get-TopDirectorySummaries($Path, $Limit) {
  if (-not (Test-Path $Path)) { return @() }

  return @(Get-ChildItem -Path $Path -Force -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    $summary = Get-TreeSummary $_.FullName
    [pscustomobject]@{
      name = $_.Name
      path = $_.FullName
      bytes = $summary.bytes
      files = $summary.files
      size = Format-Bytes $summary.bytes
    }
  } | Sort-Object -Property bytes -Descending | Select-Object -First $Limit)
}

function Find-ReleaseRoot($ExpandedPath) {
  $candidate = Join-Path $ExpandedPath "CopilotBridge"
  if (Test-Path $candidate) { return (Resolve-Path $candidate).Path }
  return (Resolve-Path $ExpandedPath).Path
}

function Find-AppRoot($ReleaseRoot) {
  $currentApp = Join-Path $ReleaseRoot "app\current"
  if (Test-Path (Join-Path $currentApp "dist\launcher.js")) { return $currentApp }

  $flatApp = Join-Path $ReleaseRoot "app"
  if (Test-Path $flatApp) { return $flatApp }
  return $null
}

function Test-SensitiveFileName($RelativePath) {
  $name = [System.IO.Path]::GetFileName($RelativePath)
  return $name -match '(^\.env$|\.pem$|\.key$|\.pfx$|^id_rsa|^\.bridge-release-token)'
}

$tempDir = $null

try {
  $zipBytes = $null
  $releaseRoot = $null
  $resolvedPackagePath = $null

  if ($PackagePath) {
    $resolvedPackagePath = (Resolve-Path $PackagePath).Path
    $zipBytes = (Get-Item $resolvedPackagePath).Length
    $tempDir = Join-Path ([System.IO.Path]::GetTempPath()) "copilot-bridge-package-analysis-$([System.Guid]::NewGuid().ToString('N'))"
    $expandedDir = Join-Path $tempDir "expanded"
    New-Item -ItemType Directory -Path $expandedDir -Force | Out-Null
    Expand-Archive -Path $resolvedPackagePath -DestinationPath $expandedDir -Force
    $releaseRoot = Find-ReleaseRoot $expandedDir
  } else {
    $releaseRoot = Find-ReleaseRoot ((Resolve-Path $PackageRoot).Path)
  }

  $appRoot = Find-AppRoot $releaseRoot
  $distRoot = if ($appRoot) { Join-Path $appRoot "dist" } else { $null }
  $nodeModulesRoot = if ($appRoot) { Join-Path $appRoot "node_modules" } else { $null }
  $runtimeRoot = if ($appRoot) { Join-Path $appRoot "runtime" } else { $null }
  $manifestPath = if ($appRoot) { Join-Path $appRoot ".bridge-release.json" } else { $null }

  $requiredChecks = [ordered]@{
    startScript = Test-Path (Join-Path $releaseRoot "start.ps1")
    stopScript = Test-Path (Join-Path $releaseRoot "stop.ps1")
    updateScript = Test-Path (Join-Path $releaseRoot "update.ps1")
    appRoot = $null -ne $appRoot -and (Test-Path $appRoot)
    launcher = $null -ne $appRoot -and (Test-Path (Join-Path $appRoot "dist\launcher.js"))
  }

  $optionalChecks = [ordered]@{
    serverEntry = $null -ne $appRoot -and (Test-Path (Join-Path $appRoot "dist\server\index.js"))
    nodeModules = $null -ne $nodeModulesRoot -and (Test-Path $nodeModulesRoot)
    bundledNode = $null -ne $runtimeRoot -and (Test-Path (Join-Path $runtimeRoot "node.exe"))
    manifest = $null -ne $manifestPath -and (Test-Path $manifestPath)
  }

  $manifest = $null
  $manifestWarnings = @()
  if ($optionalChecks.manifest) {
    try {
      $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
      if ([string]::IsNullOrWhiteSpace($manifest.version)) {
        $manifestWarnings += ".bridge-release.json does not contain a version."
      }
      if ([string]::IsNullOrWhiteSpace($manifest.sourceCommit) -or $manifest.sourceCommit -eq "unknown") {
        $manifestWarnings += ".bridge-release.json sourceCommit is unknown."
      }
      if ($resolvedPackagePath -and -not [string]::IsNullOrWhiteSpace($manifest.version)) {
        $packageName = [System.IO.Path]::GetFileNameWithoutExtension($resolvedPackagePath)
        if (-not $packageName.Contains([string]$manifest.version)) {
          $manifestWarnings += "Package filename does not include manifest version $($manifest.version)."
        }
      }
    } catch {
      $manifestWarnings += ".bridge-release.json could not be parsed: $($_.Exception.Message)"
    }
  }

  $allFiles = @(Get-ChildItem -Path $releaseRoot -Recurse -Force -File -ErrorAction SilentlyContinue)
  $sensitiveFiles = @($allFiles | ForEach-Object {
    $relative = $_.FullName
    if ($relative.StartsWith($releaseRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
      $relative = $relative.Substring($releaseRoot.Length).TrimStart([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
    }
    if (Test-SensitiveFileName $relative) { $relative }
  })

  $releaseSummary = Get-TreeSummary $releaseRoot
  $appSummary = if ($appRoot) { Get-TreeSummary $appRoot } else { [pscustomobject]@{ bytes = 0; files = 0 } }
  $distSummary = if ($distRoot) { Get-TreeSummary $distRoot } else { [pscustomobject]@{ bytes = 0; files = 0 } }
  $nodeModulesSummary = if ($nodeModulesRoot) { Get-TreeSummary $nodeModulesRoot } else { [pscustomobject]@{ bytes = 0; files = 0 } }

  $analysis = [ordered]@{
    packagePath = $resolvedPackagePath
    releaseRoot = $releaseRoot
    appRoot = $appRoot
    zipBytes = $zipBytes
    zipSize = if ($zipBytes -ne $null) { Format-Bytes $zipBytes } else { $null }
    releaseBytes = $releaseSummary.bytes
    releaseSize = Format-Bytes $releaseSummary.bytes
    releaseFiles = $releaseSummary.files
    appBytes = $appSummary.bytes
    appSize = Format-Bytes $appSummary.bytes
    appFiles = $appSummary.files
    distBytes = $distSummary.bytes
    distSize = Format-Bytes $distSummary.bytes
    distFiles = $distSummary.files
    nodeModulesBytes = $nodeModulesSummary.bytes
    nodeModulesSize = Format-Bytes $nodeModulesSummary.bytes
    nodeModulesFiles = $nodeModulesSummary.files
    requiredChecks = $requiredChecks
    optionalChecks = $optionalChecks
    manifest = $manifest
    manifestWarnings = $manifestWarnings
    sensitiveFiles = $sensitiveFiles
    topAppDirectories = if ($appRoot) { Get-TopDirectorySummaries $appRoot $Top } else { @() }
    topNodeModulesDirectories = if ($nodeModulesRoot) { Get-TopDirectorySummaries $nodeModulesRoot $Top } else { @() }
  }

  Write-Output "Copilot Bridge release package analysis"
  Write-Output "Release root: $releaseRoot"
  if ($resolvedPackagePath) { Write-Output "Package: $resolvedPackagePath ($($analysis.zipSize))" }
  Write-Output "Release contents: $($analysis.releaseSize), $($analysis.releaseFiles) files"
  Write-Output "App contents: $($analysis.appSize), $($analysis.appFiles) files"
  Write-Output "dist: $($analysis.distSize), $($analysis.distFiles) files"
  Write-Output "node_modules: $($analysis.nodeModulesSize), $($analysis.nodeModulesFiles) files"
  Write-Output ""

  Write-Output "Layout checks:"
  foreach ($key in $requiredChecks.Keys) {
    Write-Output ("  {0}: {1}" -f $key, $(if ($requiredChecks[$key]) { "ok" } else { "missing" }))
  }
  foreach ($key in $optionalChecks.Keys) {
    Write-Output ("  {0}: {1}" -f $key, $(if ($optionalChecks[$key]) { "present" } else { "not present" }))
  }

  foreach ($warning in $manifestWarnings) {
    Write-Warning $warning
  }
  foreach ($file in $sensitiveFiles) {
    Write-Warning "Potentially sensitive file included in release package: $file"
  }

  if ($analysis.topAppDirectories.Count -gt 0) {
    Write-Output ""
    Write-Output "Top app directories:"
    $analysis.topAppDirectories | Select-Object name, size, files | Format-Table -AutoSize | Out-String | Write-Output
  }

  if ($analysis.topNodeModulesDirectories.Count -gt 0) {
    Write-Output "Top node_modules directories:"
    $analysis.topNodeModulesDirectories | Select-Object name, size, files | Format-Table -AutoSize | Out-String | Write-Output
  }

  if ($JsonOutput) {
    $jsonPath = $JsonOutput
    $jsonParent = Split-Path -Parent $jsonPath
    if (-not [string]::IsNullOrWhiteSpace($jsonParent)) {
      New-Item -ItemType Directory -Path $jsonParent -Force | Out-Null
    }
    $analysis | ConvertTo-Json -Depth 8 | Set-Content -Path $jsonPath -Encoding UTF8
    Write-Output "Analysis JSON: $jsonPath"
  }

  $missingRequired = @($requiredChecks.Keys | Where-Object { -not $requiredChecks[$_] })
  if ($missingRequired.Count -gt 0) {
    throw "Release package layout is invalid. Missing: $($missingRequired -join ', ')"
  }
  if ($FailOnSensitiveFiles -and $sensitiveFiles.Count -gt 0) {
    throw "Release package contains potentially sensitive files."
  }
} finally {
  if ($tempDir -and (Test-Path $tempDir)) {
    Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}
