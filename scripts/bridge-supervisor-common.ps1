# Windows-only coordination helpers shared by source and packaged launch wrappers.

$script:BridgeSupervisorProtocolVersion = 1
$script:BridgeLauncherTerminalExitCode = 64
$script:BridgeLauncherCleanupFailureExitCode = 70
$script:BridgeSupervisorStableSeconds = 300
$script:BridgeSupervisorBackoffBaseSeconds = 5
$script:BridgeSupervisorBackoffCapSeconds = 60
$script:BridgeSupervisorTokenPattern = "^[a-f0-9]{32}$"

function Get-BridgeLauncherTerminalExitCode {
  return $script:BridgeLauncherTerminalExitCode
}

function Get-BridgeSupervisorControlPaths($DataDir, $InstallRoot) {
  $normalizedRoot = [System.IO.Path]::GetFullPath($InstallRoot).TrimEnd("\", "/").ToLowerInvariant()
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $hashBytes = $sha256.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($normalizedRoot))
  } finally {
    $sha256.Dispose()
  }
  $installKey = ([System.BitConverter]::ToString($hashBytes) -replace "-", "").Substring(0, 16).ToLowerInvariant()

  return [pscustomobject]@{
    HaltPath = Join-Path $DataDir "supervisor-halt.json"
    StatePath = Join-Path $DataDir "supervisor-state.json"
    StartRequestPath = Join-Path $DataDir "supervisor-start-request.json"
    OrderPath = Join-Path $DataDir "supervisor-order.json"
    ControlLockPath = Join-Path $DataDir "supervisor-control.lock"
    InstallKey = $installKey
  }
}

function Write-BridgeSupervisorJson($Path, $Value) {
  $directory = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $directory)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
  }

  $tempPath = "$Path.$PID.$([guid]::NewGuid().ToString('N')).tmp"
  try {
    $json = $Value | ConvertTo-Json -Depth 8
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($tempPath, $json, $utf8NoBom)
    Move-Item -LiteralPath $tempPath -Destination $Path -Force
  } finally {
    Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
  }
}

function Read-BridgeSupervisorJson($Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return $null
  }
  try {
    return Get-Content -LiteralPath $Path -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
  } catch {
    return $null
  }
}

function Get-NextBridgeSupervisorOrder($Paths) {
  $maximumOrder = 0L
  $orderState = Read-BridgeSupervisorJson $Paths.OrderPath
  $orderStateValue = 0L
  if (
    $null -ne $orderState -and
    [long]::TryParse([string]$orderState.order, [ref]$orderStateValue) -and
    $orderStateValue -gt 0
  ) {
    $maximumOrder = $orderStateValue
  }

  $startRequest = Get-BridgeSupervisorStartRequest $Paths
  if ($null -ne $startRequest -and [long]$startRequest.order -gt $maximumOrder) {
    $maximumOrder = [long]$startRequest.order
  }
  $halt = Get-BridgeSupervisorHalt $Paths
  if ($null -ne $halt -and [long]$halt.order -gt $maximumOrder) {
    $maximumOrder = [long]$halt.order
  }

  if ($maximumOrder -ge [long]::MaxValue) {
    throw "Copilot Bridge supervisor request order is exhausted."
  }
  $nextOrder = $maximumOrder + 1L
  Write-BridgeSupervisorJson $Paths.OrderPath ([ordered]@{ order = $nextOrder })
  return $nextOrder
}

function Write-BridgeSupervisorHalt($Paths, $Reason, $Detail = $null, [long]$Order = 0) {
  if ($Order -le 0) {
    $Order = Get-NextBridgeSupervisorOrder $Paths
  }
  Write-BridgeSupervisorJson $Paths.HaltPath ([ordered]@{
    version = $script:BridgeSupervisorProtocolVersion
    order = $Order
    reason = $Reason
    detail = $Detail
    requestedAtUtc = [DateTime]::UtcNow.ToString("o")
    requestedByPid = $PID
  })
}

function Get-BridgeSupervisorHalt($Paths) {
  $halt = Read-BridgeSupervisorJson $Paths.HaltPath
  if ($null -eq $halt) {
    return $null
  }

  $version = 0
  $requestedByPid = 0
  $order = 0L
  $requestedAt = [DateTime]::MinValue
  if (
    -not [int]::TryParse([string]$halt.version, [ref]$version) -or
    $version -ne $script:BridgeSupervisorProtocolVersion -or
    [string]::IsNullOrWhiteSpace([string]$halt.reason) -or
    -not [int]::TryParse([string]$halt.requestedByPid, [ref]$requestedByPid) -or
    $requestedByPid -le 0 -or
    -not [DateTime]::TryParse([string]$halt.requestedAtUtc, [ref]$requestedAt)
  ) {
    return $null
  }
  [void][long]::TryParse([string]$halt.order, [ref]$order)
  if ($order -lt 0) {
    return $null
  }

  return [pscustomobject]@{
    version = $version
    order = $order
    reason = [string]$halt.reason
    detail = [string]$halt.detail
    requestedAtUtc = $requestedAt.ToUniversalTime().ToString("o")
    requestedByPid = $requestedByPid
  }
}

function Test-BridgeSupervisorHaltRequested($Paths) {
  return $null -ne (Get-BridgeSupervisorHalt $Paths)
}

function Remove-BridgeSupervisorHalt($Paths) {
  Remove-Item -LiteralPath $Paths.HaltPath -Force -ErrorAction SilentlyContinue
}

function Write-BridgeSupervisorStartRequest($Paths, $Token) {
  if ([string]$Token -notmatch $script:BridgeSupervisorTokenPattern) {
    throw "Supervisor token is malformed."
  }
  $order = Get-NextBridgeSupervisorOrder $Paths
  Write-BridgeSupervisorJson $Paths.StartRequestPath ([ordered]@{
    version = $script:BridgeSupervisorProtocolVersion
    order = $order
    token = $Token
    requestedAtUtc = [DateTime]::UtcNow.ToString("o")
    requestedByPid = $PID
  })
  return $order
}

function Get-BridgeSupervisorStartRequest($Paths) {
  $request = Read-BridgeSupervisorJson $Paths.StartRequestPath
  if ($null -eq $request) {
    return $null
  }
  $version = 0
  $order = 0L
  if (
    -not [int]::TryParse([string]$request.version, [ref]$version) -or
    $version -ne $script:BridgeSupervisorProtocolVersion -or
    -not [long]::TryParse([string]$request.order, [ref]$order) -or
    $order -le 0 -or
    [string]$request.token -notmatch $script:BridgeSupervisorTokenPattern
  ) {
    return $null
  }
  return [pscustomobject]@{
    version = $version
    order = $order
    token = [string]$request.token
  }
}

function Remove-BridgeSupervisorStartRequest($Paths, $Token) {
  $request = Get-BridgeSupervisorStartRequest $Paths
  if ($null -ne $request -and $request.token -eq $Token) {
    Remove-Item -LiteralPath $Paths.StartRequestPath -Force -ErrorAction SilentlyContinue
  }
}

function Get-BridgeExplicitStartDecision($Paths, $Token, [long]$Order) {
  $request = Get-BridgeSupervisorStartRequest $Paths
  if ($null -eq $request -or $request.token -ne $Token -or $request.order -ne $Order) {
    return "invalid"
  }
  $halt = Get-BridgeSupervisorHalt $Paths
  if ($null -ne $halt -and $halt.order -gt $Order) {
    return "superseded"
  }
  return "allow"
}

function Write-BridgeSupervisorState($Paths, $InstallRoot, $Token, $LauncherProcess = $null) {
  if ([string]$Token -notmatch $script:BridgeSupervisorTokenPattern) {
    throw "Supervisor token is malformed."
  }
  $process = [System.Diagnostics.Process]::GetCurrentProcess()
  $state = [ordered]@{
    version = $script:BridgeSupervisorProtocolVersion
    token = $Token
    processId = $PID
    processStartTimeUtcTicks = $process.StartTime.ToUniversalTime().Ticks
    installRoot = [System.IO.Path]::GetFullPath($InstallRoot)
    writtenAtUtc = [DateTime]::UtcNow.ToString("o")
  }
  if ($null -ne $LauncherProcess) {
    $state.launcherProcessId = [int]$LauncherProcess.Id
    $state.launcherProcessStartTimeUtcTicks = $LauncherProcess.StartTime.ToUniversalTime().Ticks
  }
  Write-BridgeSupervisorJson $Paths.StatePath $state
}

function Get-BridgeSupervisorState($Paths) {
  $state = Read-BridgeSupervisorJson $Paths.StatePath
  if ($null -eq $state) {
    return $null
  }

  $version = 0
  $processId = 0
  $startTicks = 0L
  $launcherProcessId = 0
  $launcherStartTicks = 0L
  if (
    -not [int]::TryParse([string]$state.version, [ref]$version) -or
    $version -ne $script:BridgeSupervisorProtocolVersion -or
    [string]$state.token -notmatch $script:BridgeSupervisorTokenPattern -or
    -not [int]::TryParse([string]$state.processId, [ref]$processId) -or
    $processId -le 0 -or
    -not [long]::TryParse([string]$state.processStartTimeUtcTicks, [ref]$startTicks) -or
    $startTicks -le 0 -or
    [string]::IsNullOrWhiteSpace([string]$state.installRoot)
  ) {
    return $null
  }

  try {
    $installRoot = [System.IO.Path]::GetFullPath([string]$state.installRoot)
    if (-not [System.IO.Path]::IsPathRooted($installRoot)) {
      return $null
    }
  } catch {
    return $null
  }

  return [pscustomobject]@{
    version = $version
    token = [string]$state.token
    processId = $processId
    processStartTimeUtcTicks = $startTicks
    installRoot = $installRoot
    launcherProcessId = if (
      [int]::TryParse([string]$state.launcherProcessId, [ref]$launcherProcessId) -and
      $launcherProcessId -gt 0
    ) { $launcherProcessId } else { 0 }
    launcherProcessStartTimeUtcTicks = if (
      [long]::TryParse([string]$state.launcherProcessStartTimeUtcTicks, [ref]$launcherStartTicks) -and
      $launcherStartTicks -gt 0
    ) { $launcherStartTicks } else { 0L }
  }
}

function Get-BridgeProcessStartTimeUtcTicks($Process) {
  if ($null -eq $Process -or $null -eq $Process.CreationDate) {
    return 0L
  }
  try {
    return ([DateTime]$Process.CreationDate).ToUniversalTime().Ticks
  } catch {
    return 0L
  }
}

function New-BridgeProcessIdentity($Process) {
  $processId = 0
  if (
    $null -eq $Process -or
    -not [int]::TryParse([string]$Process.ProcessId, [ref]$processId) -or
    $processId -le 0
  ) {
    return $null
  }
  $startTicks = Get-BridgeProcessStartTimeUtcTicks $Process
  if ($startTicks -le 0) {
    return $null
  }
  return [pscustomobject]@{
    processId = $processId
    processStartTimeUtcTicks = $startTicks
    commandLine = [string]$Process.CommandLine
  }
}

function Get-BridgeTunnelRuntimeProcess($DataDir, $Processes) {
  $statePath = Join-Path $DataDir "tunnel-runtime.json"
  if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
    return $null
  }
  try {
    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    $processId = 0
    $startTicks = 0L
    if (
      -not [int]::TryParse([string]$state.process.pid, [ref]$processId) -or
      $processId -le 0 -or
      -not [long]::TryParse([string]$state.process.startMarker, [ref]$startTicks) -or
      $startTicks -le 0
    ) {
      return $null
    }
    $process = @($Processes | Where-Object { [int]$_.ProcessId -eq $processId }) | Select-Object -First 1
    if ($null -eq $process -or (Get-BridgeProcessStartTimeUtcTicks $process) -ne $startTicks) {
      return $null
    }
    return $process
  } catch {
    return $null
  }
}

function Remove-BridgeTunnelRuntimeState($DataDir) {
  Remove-Item -LiteralPath (Join-Path $DataDir "tunnel-runtime.json") -Force -ErrorAction SilentlyContinue
}

function Test-BridgeProcessIdentity($Identity) {
  if ($null -eq $Identity) {
    return $false
  }
  try {
    $current = Get-CimInstance `
      Win32_Process `
      -Filter "ProcessId = $([int]$Identity.processId)" `
      -ErrorAction Stop
    return (
      (Get-BridgeProcessStartTimeUtcTicks $current) -eq [long]$Identity.processStartTimeUtcTicks -and
      [string]::Equals(
        [string]$current.CommandLine,
        [string]$Identity.commandLine,
        [System.StringComparison]::Ordinal
      )
    )
  } catch {
    return $false
  }
}

function Test-BridgeSupervisorStateProcess($State, $InstallRoot) {
  if ($null -eq $State) {
    return $false
  }

  try {
    $expectedRoot = [System.IO.Path]::GetFullPath($InstallRoot)
    $stateRoot = [System.IO.Path]::GetFullPath([string]$State.installRoot)
    if (-not [string]::Equals($expectedRoot, $stateRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
      return $false
    }

    $process = Get-Process -Id ([int]$State.processId) -ErrorAction Stop
    if ($process.StartTime.ToUniversalTime().Ticks -ne [long]$State.processStartTimeUtcTicks) {
      return $false
    }

    $cimProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$State.processId)" -ErrorAction Stop
    $escapedToken = [regex]::Escape([string]$State.token)
    $tokenPattern = "(?i)(?:^|\s)-SupervisorToken(?:\s+|=)(?:`"|')?$escapedToken(?:`"|'|\s|$)"
    return $cimProcess.CommandLine -match $tokenPattern
  } catch {
    return $false
  }
}

function Remove-BridgeSupervisorState($Paths, $Token) {
  $state = Get-BridgeSupervisorState $Paths
  if ($null -ne $state -and [string]$state.token -eq $Token) {
    Remove-Item -LiteralPath $Paths.StatePath -Force -ErrorAction SilentlyContinue
  }
}

function Enter-BridgeSupervisorControlLock($Paths, $TimeoutSeconds = 30) {
  $directory = Split-Path -Parent $Paths.ControlLockPath
  if (-not (Test-Path -LiteralPath $directory)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
  }

  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    try {
      return [System.IO.File]::Open(
        $Paths.ControlLockPath,
        [System.IO.FileMode]::OpenOrCreate,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None
      )
    } catch [System.IO.IOException] {
      if ([DateTime]::UtcNow -ge $deadline) {
        throw "Timed out waiting for the Copilot Bridge supervisor control lock."
      }
      [System.Threading.Thread]::Sleep(100)
    }
  } while ($true)
}

function Exit-BridgeSupervisorControlLock($LockHandle) {
  if ($null -ne $LockHandle) {
    $LockHandle.Dispose()
  }
}

function Resolve-BridgePowerShellPath {
  $candidate = Join-Path $PSHOME "powershell.exe"
  if (Test-Path -LiteralPath $candidate -PathType Leaf) {
    return $candidate
  }
  $command = Get-Command powershell.exe -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }
  throw "Windows PowerShell 5.1 was not found."
}

function Start-BridgeSupervisorChild(
  $Paths,
  $ScriptPath,
  [string[]]$AdditionalArguments = @(),
  [switch]$Wait,
  [switch]$ExplicitStart
) {
  $resolvedScript = [System.IO.Path]::GetFullPath($ScriptPath)
  $token = [guid]::NewGuid().ToString("N")
  $startRequestOrder = 0L
  if ($ExplicitStart) {
    $requestLock = Enter-BridgeSupervisorControlLock $Paths
    try {
      $startRequestOrder = Write-BridgeSupervisorStartRequest $Paths $token
    } finally {
      Exit-BridgeSupervisorControlLock $requestLock
    }
  }
  $powerShellPath = Resolve-BridgePowerShellPath
  $invokeArguments = @(
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    $resolvedScript,
    "-Wait",
    "-SupervisorToken",
    $token,
    "-StartRequestOrder",
    [string]$startRequestOrder
  ) + @($AdditionalArguments)

  try {
    if ($Wait) {
      & $powerShellPath @invokeArguments | Out-Host
      $childExitCode = [int]$LASTEXITCODE
      return [pscustomobject]@{
        token = $token
        process = $null
        exitCode = $childExitCode
      }
    }

    $processArguments = @($invokeArguments | ForEach-Object {
      if ($_ -match '[\s"]') {
        '"' + ($_.Replace('"', '\"')) + '"'
      } else {
        $_
      }
    })
    $process = Start-Process `
      -FilePath $powerShellPath `
      -ArgumentList $processArguments `
      -WindowStyle Hidden `
      -PassThru
    return [pscustomobject]@{
      token = $token
      process = $process
      exitCode = $null
    }
  } catch {
    if ($ExplicitStart) {
      $cleanupLock = Enter-BridgeSupervisorControlLock $Paths
      try {
        Remove-BridgeSupervisorStartRequest $Paths $token
      } finally {
        Exit-BridgeSupervisorControlLock $cleanupLock
      }
    }
    throw
  }
}

function Wait-BridgeSupervisorProcessExit($State, $InstallRoot, $TimeoutSeconds) {
  if ($null -eq $State) {
    return $true
  }
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ((Test-BridgeSupervisorStateProcess $State $InstallRoot) -and [DateTime]::UtcNow -lt $deadline) {
    [System.Threading.Thread]::Sleep(100)
  }
  return -not (Test-BridgeSupervisorStateProcess $State $InstallRoot)
}

function Wait-BridgeSupervisorDelay($Paths, [int]$DelaySeconds) {
  $deadline = [DateTime]::UtcNow.AddSeconds($DelaySeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (Test-BridgeSupervisorHaltRequested $Paths) {
      return $false
    }
    [System.Threading.Thread]::Sleep(100)
  }
  return -not (Test-BridgeSupervisorHaltRequested $Paths)
}

function New-BridgeCleanupFailureException($ErrorRecord) {
  $message = "Copilot Bridge process cleanup failed: $($ErrorRecord.Exception.Message)"
  $exception = New-Object System.Exception($message, $ErrorRecord.Exception)
  $exception.Data["BridgeExitCode"] = $script:BridgeLauncherCleanupFailureExitCode
  return $exception
}

function Invoke-BridgeCleanupProcesses([scriptblock]$CleanupProcesses) {
  try {
    & $CleanupProcesses
  } catch {
    throw (New-BridgeCleanupFailureException $_)
  }
}

function Stop-BridgeVerifiedProcessIdentities(
  $ProcessesById,
  $OrderedProcessIds,
  [int]$MaxAttempts = 3,
  [int]$AttemptWaitMilliseconds = 5000
) {
  $remaining = @($OrderedProcessIds | Where-Object {
    Test-BridgeProcessIdentity $ProcessesById[$_]
  })
  for ($attempt = 1; $attempt -le $MaxAttempts -and $remaining.Count -gt 0; $attempt++) {
    for ($index = $remaining.Count - 1; $index -ge 0; $index--) {
      $processId = [int]$remaining[$index]
      if (Test-BridgeProcessIdentity $ProcessesById[$processId]) {
        Write-Output "Stopping PID $processId (attempt $attempt/$MaxAttempts)"
        Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
      }
    }

    $deadline = [DateTime]::UtcNow.AddMilliseconds([Math]::Max(0, $AttemptWaitMilliseconds))
    do {
      $remaining = @($remaining | Where-Object {
        Test-BridgeProcessIdentity $ProcessesById[$_]
      })
      if ($remaining.Count -eq 0 -or [DateTime]::UtcNow -ge $deadline) {
        break
      }
      [System.Threading.Thread]::Sleep(100)
    } while ($true)
  }

  if ($remaining.Count -gt 0) {
    throw "Verified Bridge process IDs survived $MaxAttempts cleanup attempts: $($remaining -join ', ')"
  }
}

function Start-BridgeLauncherUnderControlLock(
  $Paths,
  $InstallRoot,
  $SupervisorToken,
  [long]$StartRequestOrder,
  [bool]$ValidateExplicitStart,
  [scriptblock]$StartLauncher
) {
  $controlLock = Enter-BridgeSupervisorControlLock $Paths
  try {
    $ownedState = Get-BridgeSupervisorState $Paths
    if (
      $null -eq $ownedState -or
      $ownedState.token -ne $SupervisorToken -or
      -not (Test-BridgeSupervisorStateProcess $ownedState $InstallRoot)
    ) {
      throw "The current supervisor no longer owns the persisted supervisor state."
    }

    if ($ValidateExplicitStart) {
      $startDecision = Get-BridgeExplicitStartDecision $Paths $SupervisorToken $StartRequestOrder
      if ($startDecision -eq "invalid") {
        Write-Warning "Ignoring an explicit start whose persisted request is missing or stale."
        return $null
      }
      if ($startDecision -eq "superseded") {
        Remove-BridgeSupervisorStartRequest $Paths $SupervisorToken
        Write-Host "Copilot Bridge remains stopped because a newer stop request superseded this start."
        return $null
      }
      Remove-BridgeSupervisorHalt $Paths
    } elseif (Test-BridgeSupervisorHaltRequested $Paths) {
      return $null
    }

    $launcherProcess = & $StartLauncher
    if ($null -eq $launcherProcess) {
      throw "The launcher process could not be started."
    }
    Write-BridgeSupervisorState $Paths $InstallRoot $SupervisorToken $launcherProcess
    if ($ValidateExplicitStart) {
      Remove-BridgeSupervisorStartRequest $Paths $SupervisorToken
    }
    return $launcherProcess
  } finally {
    Exit-BridgeSupervisorControlLock $controlLock
  }
}

function Get-BridgeSupervisorDecision(
  [int]$ExitCode,
  [bool]$StopRequested,
  [int]$ConsecutiveFailures,
  [double]$UptimeSeconds
) {
  if ($StopRequested) {
    return [pscustomobject]@{
      action = "terminal"
      reason = "intentional-stop"
      createHalt = $false
      nextFailures = $ConsecutiveFailures
      delaySeconds = 0
    }
  }

  if ($ExitCode -eq 0) {
    return [pscustomobject]@{
      action = "terminal"
      reason = "clean-exit"
      createHalt = $false
      nextFailures = $ConsecutiveFailures
      delaySeconds = 0
    }
  }

  if ($ExitCode -eq $script:BridgeLauncherTerminalExitCode) {
    return [pscustomobject]@{
      action = "terminal"
      reason = "launcher-terminal-exit"
      createHalt = $true
      nextFailures = $ConsecutiveFailures
      delaySeconds = 0
    }
  }

  if ($ExitCode -eq $script:BridgeLauncherCleanupFailureExitCode) {
    return [pscustomobject]@{
      action = "terminal"
      reason = "launcher-cleanup-failure"
      createHalt = $true
      nextFailures = $ConsecutiveFailures
      delaySeconds = 0
    }
  }

  $nextFailures = if ($UptimeSeconds -ge $script:BridgeSupervisorStableSeconds) {
    1
  } else {
    $ConsecutiveFailures + 1
  }
  $exponent = [Math]::Min([Math]::Max($nextFailures - 1, 0), 4)
  $delaySeconds = [int][Math]::Min(
    $script:BridgeSupervisorBackoffBaseSeconds * [Math]::Pow(2, $exponent),
    $script:BridgeSupervisorBackoffCapSeconds
  )
  return [pscustomobject]@{
    action = "restart"
    reason = "unexpected-exit"
    createHalt = $false
    nextFailures = $nextFailures
    delaySeconds = $delaySeconds
  }
}

function Invoke-BridgeLauncherSupervisor(
  $Paths,
  $InstallRoot,
  $SupervisorToken,
  [long]$StartRequestOrder,
  [scriptblock]$StartLauncher,
  [scriptblock]$CleanupProcesses
) {
  if ([string]$SupervisorToken -notmatch $script:BridgeSupervisorTokenPattern) {
    throw "A valid internal supervisor token is required."
  }
  $explicitStart = $StartRequestOrder -gt 0

  while ($true) {
    $stateToReplace = $null
    $claimed = $false
    $controlLock = Enter-BridgeSupervisorControlLock $Paths
    try {
      if ((Test-Path -LiteralPath $Paths.HaltPath) -and -not (Test-BridgeSupervisorHaltRequested $Paths)) {
        Remove-BridgeSupervisorHalt $Paths
      }

      $existingState = Get-BridgeSupervisorState $Paths
      $existingSupervisorActive = Test-BridgeSupervisorStateProcess $existingState $InstallRoot
      if ($explicitStart) {
        $startDecision = Get-BridgeExplicitStartDecision $Paths $SupervisorToken $StartRequestOrder
        if ($startDecision -eq "invalid") {
          Write-Warning "Ignoring an explicit start whose persisted request is missing or stale."
          return
        }
        if ($startDecision -eq "superseded") {
          Remove-BridgeSupervisorStartRequest $Paths $SupervisorToken
          Write-Output "Copilot Bridge remains stopped because a newer stop request superseded this start."
          return
        }
      }
      if ($existingSupervisorActive) {
        if (-not $explicitStart) {
          Write-Output "Copilot Bridge is already supervised by PID $($existingState.processId)."
          return
        }
        Write-BridgeSupervisorHalt `
          $Paths `
          "replaced-by-explicit-start" `
          "An operator explicitly started Copilot Bridge." `
          $StartRequestOrder
        $stateToReplace = $existingState
      } else {
        if (Test-Path -LiteralPath $Paths.StatePath) {
          Remove-Item -LiteralPath $Paths.StatePath -Force -ErrorAction SilentlyContinue
        }
        if ($explicitStart) {
          Remove-BridgeSupervisorHalt $Paths
        } elseif (Test-BridgeSupervisorHaltRequested $Paths) {
          Write-Output "Copilot Bridge remains stopped by a durable halt request."
          return
        }
        Write-BridgeSupervisorState $Paths $InstallRoot $SupervisorToken
        $claimed = $true
      }
    } finally {
      Exit-BridgeSupervisorControlLock $controlLock
    }

    if ($claimed) {
      break
    }

    Invoke-BridgeCleanupProcesses $CleanupProcesses
    if (-not (Wait-BridgeSupervisorProcessExit $stateToReplace $InstallRoot 15)) {
      throw "Existing Copilot Bridge supervisor PID $($stateToReplace.processId) did not exit after it was stopped."
    }
  }

  $launcherProcess = $null
  $consecutiveFailures = 0
  try {
    Invoke-BridgeCleanupProcesses $CleanupProcesses
    $launcherProcess = Start-BridgeLauncherUnderControlLock `
      $Paths `
      $InstallRoot `
      $SupervisorToken `
      $StartRequestOrder `
      $explicitStart `
      $StartLauncher
    if ($null -eq $launcherProcess) {
      Write-Output "Copilot Bridge supervisor exiting after an intentional stop."
      return
    }

    while ($true) {
      $startedAt = [DateTime]::UtcNow
      $launcherProcess.WaitForExit()
      $uptimeSeconds = ([DateTime]::UtcNow - $startedAt).TotalSeconds
      $decision = Get-BridgeSupervisorDecision `
        ([int]$launcherProcess.ExitCode) `
        (Test-BridgeSupervisorHaltRequested $Paths) `
        $consecutiveFailures `
        $uptimeSeconds

      if ($decision.action -eq "terminal") {
        if ($decision.createHalt) {
          $terminalLock = Enter-BridgeSupervisorControlLock $Paths
          try {
            if (-not (Test-BridgeSupervisorHaltRequested $Paths)) {
              Write-BridgeSupervisorHalt `
                $Paths `
                $decision.reason `
                "Launcher exited with code $($launcherProcess.ExitCode)."
            }
          } finally {
            Exit-BridgeSupervisorControlLock $terminalLock
          }
        }
        Write-Output "Copilot Bridge supervisor exiting after $($decision.reason)."
        return
      }

      $consecutiveFailures = $decision.nextFailures
      Write-Warning "Launcher exited unexpectedly with code $($launcherProcess.ExitCode). Restarting in $($decision.delaySeconds)s (failure $consecutiveFailures)."
      if (-not (Wait-BridgeSupervisorDelay $Paths $decision.delaySeconds)) {
        Write-Output "Copilot Bridge supervisor exiting after an intentional stop."
        return
      }

      Invoke-BridgeCleanupProcesses $CleanupProcesses
      $launcherProcess = Start-BridgeLauncherUnderControlLock `
        $Paths `
        $InstallRoot `
        $SupervisorToken `
        0 `
        $false `
        $StartLauncher
      if ($null -eq $launcherProcess) {
        Write-Output "Copilot Bridge supervisor exiting after an intentional stop."
        return
      }
    }
  } finally {
    $cleanupFailure = $null
    try {
      Invoke-BridgeCleanupProcesses $CleanupProcesses
    } catch {
      $cleanupFailure = $_
    }
    $cleanupLock = $null
    try {
      $cleanupLock = Enter-BridgeSupervisorControlLock $Paths
      try {
        Remove-BridgeSupervisorStartRequest $Paths $SupervisorToken
        Remove-BridgeSupervisorState $Paths $SupervisorToken
      } finally {
        Exit-BridgeSupervisorControlLock $cleanupLock
      }
    } catch {
      if ($null -eq $cleanupFailure) {
        throw
      }
      Write-Warning "Supervisor state cleanup also failed: $($_.Exception.Message)"
    }
    if ($null -ne $cleanupFailure) {
      throw $cleanupFailure.Exception
    }
  }
}

function Stop-BridgeLauncherSupervisor(
  $Paths,
  $InstallRoot,
  [scriptblock]$CleanupProcesses,
  $Detail
) {
  $supervisorState = $null
  $controlLock = Enter-BridgeSupervisorControlLock $Paths
  try {
    Write-BridgeSupervisorHalt $Paths "intentional-stop" $Detail
    $supervisorState = Get-BridgeSupervisorState $Paths
  } finally {
    Exit-BridgeSupervisorControlLock $controlLock
  }

  try {
    Invoke-BridgeCleanupProcesses $CleanupProcesses
    if (-not (Wait-BridgeSupervisorProcessExit $supervisorState $InstallRoot 15)) {
      throw "Supervisor PID $($supervisorState.processId) did not exit after the durable halt request."
    }
  } finally {
    $cleanupLock = Enter-BridgeSupervisorControlLock $Paths
    try {
      $currentState = Get-BridgeSupervisorState $Paths
      if (
        (Test-Path -LiteralPath $Paths.StatePath) -and
        ($null -eq $currentState -or -not (Test-BridgeSupervisorStateProcess $currentState $InstallRoot))
      ) {
        Remove-Item -LiteralPath $Paths.StatePath -Force -ErrorAction SilentlyContinue
      }
    } finally {
      Exit-BridgeSupervisorControlLock $cleanupLock
    }
  }
}
