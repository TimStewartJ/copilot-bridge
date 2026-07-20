# Shared release wrapper helpers. Keep this file side-effect-free; wrappers dot-source it.

$script:BridgeEmbeddedSupervisorHelperBase64 = "__BRIDGE_SUPERVISOR_HELPER_BASE64__"

function Get-BridgeSupervisorHelperScriptBlock($ScriptRoot) {
  $helperPath = Join-Path $ScriptRoot "bridge-supervisor-common.ps1"
  if (Test-Path -LiteralPath $helperPath -PathType Leaf) {
    try {
      return [scriptblock]::Create((Get-Content -LiteralPath $helperPath -Raw))
    } catch {
      throw "Could not load supervisor helper at ${helperPath}: $($_.Exception.Message)"
    }
  }

  $embedded = [string]$script:BridgeEmbeddedSupervisorHelperBase64
  $unsubstitutedMarker = "__BRIDGE_SUPERVISOR_" + "HELPER_BASE64__"
  if (
    [string]::IsNullOrWhiteSpace($embedded) -or
    $embedded -eq $unsubstitutedMarker
  ) {
    throw "Supervisor helper not found at $helperPath and no packaged bootstrap fallback is available. Reinstall Copilot Bridge."
  }

  try {
    $helperSource = [System.Text.Encoding]::UTF8.GetString(
      [System.Convert]::FromBase64String($embedded)
    )
    return [scriptblock]::Create($helperSource)
  } catch {
    throw "Could not load the packaged supervisor helper fallback: $($_.Exception.Message)"
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

function Assert-AbsolutePath($Name, $Path, $Context = "in release mode") {
  if (-not (Test-AbsolutePath $Path)) {
    $contextText = if ([string]::IsNullOrWhiteSpace($Context)) { "" } else { " $Context" }
    throw "$Name must be an absolute path$contextText. Received: $Path"
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

function Get-StoredStateRoot($Path) {
  if (-not (Test-Path $Path)) { return $null }
  $value = (Get-Content $Path -Raw).Trim()
  if ([string]::IsNullOrWhiteSpace($value)) { return $null }
  return $value
}

function Get-ConfiguredStateRoot($InstallRoot) {
  if (-not [string]::IsNullOrWhiteSpace($env:BRIDGE_STATE_ROOT)) {
    return $env:BRIDGE_STATE_ROOT
  }

  $stateRootFile = Join-Path $InstallRoot ".bridge-state-root"
  $storedStateRoot = Get-StoredStateRoot $stateRootFile
  if (-not [string]::IsNullOrWhiteSpace($storedStateRoot)) {
    return $storedStateRoot
  }
  return Join-Path $env:LOCALAPPDATA "CopilotBridge"
}

function Assert-StateRootDoesNotSwitch($StoredStateRoot, $InputStateRoot, $StateRootFile) {
  if ([string]::IsNullOrWhiteSpace($StoredStateRoot) -or [string]::IsNullOrWhiteSpace($InputStateRoot)) { return }
  $storedFullPath = Normalize-FullPath $StoredStateRoot
  $inputFullPath = Normalize-FullPath $InputStateRoot
  if (-not [string]::Equals($storedFullPath, $inputFullPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to switch release state root from '$StoredStateRoot' to '$InputStateRoot'. Remove or update $StateRootFile intentionally before changing the active state root."
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
