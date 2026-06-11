import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { makeTestDir } from "./server/__tests__/helpers.js";
import { LAUNCHER_TERMINAL_EXIT_CODE } from "./launcher-exit.js";

const describeWindows = process.platform === "win32" ? describe : describe.skip;
const powerShell = join(
  process.env.SystemRoot ?? String.raw`C:\Windows`,
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const helperPath = join(process.cwd(), "scripts", "bridge-supervisor-common.ps1");

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function invokePowerShell<T>(body: string, trailingArguments: string[] = []): T {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `. ${quotePowerShell(helperPath)}`,
    body,
  ].join("; ");
  const output = execFileSync(powerShell, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
    ...trailingArguments,
  ], { encoding: "utf8" });
  return JSON.parse(output.trim()) as T;
}

function invokePowerShellFile<T>(scriptPath: string, body: string, token: string): T {
  writeFileSync(scriptPath, [
    "param([string]$SupervisorToken)",
    "$ErrorActionPreference = 'Stop'",
    `. ${quotePowerShell(helperPath)}`,
    body,
  ].join("\r\n"));
  const output = execFileSync(powerShell, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    "-SupervisorToken",
    token,
  ], { encoding: "utf8" });
  return JSON.parse(output.trim()) as T;
}

describeWindows("Windows launcher supervisor decisions", () => {
  it("keeps an intentional manual stop terminal even when the launcher was force-killed", () => {
    const decision = invokePowerShell<Record<string, unknown>>(
      "Get-BridgeSupervisorDecision 1 $true 2 10 | ConvertTo-Json -Compress",
    );

    expect(decision).toMatchObject({
      action: "terminal",
      reason: "intentional-stop",
      createHalt: false,
    });
  });

  it("treats retry-budget exhaustion as a durable terminal exit", () => {
    const decision = invokePowerShell<Record<string, unknown>>(
      `Get-BridgeSupervisorDecision ${LAUNCHER_TERMINAL_EXIT_CODE} $false 2 10 | ConvertTo-Json -Compress`,
    );

    expect(decision).toMatchObject({
      action: "terminal",
      reason: "launcher-terminal-exit",
      createHalt: true,
    });
  });

  it("keeps a clean launcher exit terminal", () => {
    const decision = invokePowerShell<Record<string, unknown>>(
      "Get-BridgeSupervisorDecision 0 $false 0 10 | ConvertTo-Json -Compress",
    );

    expect(decision).toMatchObject({
      action: "terminal",
      reason: "clean-exit",
      createHalt: false,
    });
  });

  it("uses capped exponential backoff and resets it after a stable run", () => {
    const decisions = invokePowerShell<Array<Record<string, unknown>>>(
      "@("
      + "(Get-BridgeSupervisorDecision 1 $false 0 10),"
      + "(Get-BridgeSupervisorDecision 1 $false 1 10),"
      + "(Get-BridgeSupervisorDecision 1 $false 5 10),"
      + "(Get-BridgeSupervisorDecision 1 $false 5 301)"
      + ") | ConvertTo-Json -Compress",
    );

    expect(decisions).toEqual([
      expect.objectContaining({ action: "restart", nextFailures: 1, delaySeconds: 5 }),
      expect.objectContaining({ action: "restart", nextFailures: 2, delaySeconds: 10 }),
      expect.objectContaining({ action: "restart", nextFailures: 6, delaySeconds: 60 }),
      expect.objectContaining({ action: "restart", nextFailures: 1, delaySeconds: 5 }),
    ]);
  });

  it("writes and explicitly clears the durable halt sentinel without temp-file leaks", () => {
    const dataDir = makeTestDir("windows-supervisor-halt");
    const result = invokePowerShell<{
      haltPresent: boolean;
      reason: string;
      cleared: boolean;
    }>(
      `$paths = Get-BridgeSupervisorControlPaths ${quotePowerShell(dataDir)} ${quotePowerShell(process.cwd())}; `
      + "Write-BridgeSupervisorHalt $paths 'intentional-stop' 'test'; "
      + "$halt = Read-BridgeSupervisorJson $paths.HaltPath; "
      + "$present = Test-BridgeSupervisorHaltRequested $paths; "
      + "Remove-BridgeSupervisorHalt $paths; "
      + "[pscustomobject]@{ haltPresent = $present; reason = $halt.reason; cleared = -not (Test-BridgeSupervisorHaltRequested $paths) } "
      + "| ConvertTo-Json -Compress",
    );

    expect(result).toEqual({
      haltPresent: true,
      reason: "intentional-stop",
      cleared: true,
    });
    expect(readdirSync(dataDir)).toEqual(["supervisor-order.json"]);
  });

  it("uses an install-scoped cross-session file lock without named Local synchronization", () => {
    const dataDir = makeTestDir("windows-supervisor-lock");
    const result = invokePowerShell<{
      controlLockPath: string;
      competingOpenBlocked: boolean;
      reacquired: boolean;
      hasMutexName: boolean;
    }>(
      `$paths = Get-BridgeSupervisorControlPaths ${quotePowerShell(dataDir)} ${quotePowerShell(process.cwd())}; `
      + "$lock = Enter-BridgeSupervisorControlLock $paths 1; "
      + "$blocked = $false; "
      + "try { "
      + "  try { "
      + "    $competing = [System.IO.File]::Open($paths.ControlLockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None); "
      + "    $competing.Dispose() "
      + "  } catch [System.IO.IOException] { $blocked = $true } "
      + "} finally { Exit-BridgeSupervisorControlLock $lock }; "
      + "$second = Enter-BridgeSupervisorControlLock $paths 1; "
      + "$reacquired = $null -ne $second; "
      + "Exit-BridgeSupervisorControlLock $second; "
      + "[pscustomobject]@{ "
      + "controlLockPath = $paths.ControlLockPath; "
      + "competingOpenBlocked = $blocked; "
      + "reacquired = $reacquired; "
      + "hasMutexName = $null -ne $paths.PSObject.Properties['MutexName'] "
      + "} | ConvertTo-Json -Compress",
    );

    expect(result.controlLockPath).toBe(join(dataDir, "supervisor-control.lock"));
    expect(result).toMatchObject({
      competingOpenBlocked: true,
      reacquired: true,
      hasMutexName: false,
    });
  });

  it("treats malformed state and halt files as stale recoverable data", () => {
    const dataDir = makeTestDir("windows-supervisor-malformed");
    const result = invokePowerShell<{
      brokenJsonRejected: boolean;
      badSchemaRejected: boolean;
      badHaltRejected: boolean;
    }>(
      `$paths = Get-BridgeSupervisorControlPaths ${quotePowerShell(dataDir)} ${quotePowerShell(process.cwd())}; `
      + "Set-Content -LiteralPath $paths.StatePath -Value '{broken-json'; "
      + "$brokenJsonRejected = $null -eq (Get-BridgeSupervisorState $paths); "
      + "Set-Content -LiteralPath $paths.StatePath -Value '{\"version\":\"bad\",\"token\":42,\"processId\":\"nope\",\"processStartTimeUtcTicks\":{},\"installRoot\":[]}'; "
      + "$badSchemaRejected = $null -eq (Get-BridgeSupervisorState $paths); "
      + "Set-Content -LiteralPath $paths.HaltPath -Value '{\"version\":\"bad\",\"reason\":[],\"requestedByPid\":\"nope\"}'; "
      + "$badHaltRejected = -not (Test-BridgeSupervisorHaltRequested $paths); "
      + "[pscustomobject]@{ brokenJsonRejected = $brokenJsonRejected; badSchemaRejected = $badSchemaRejected; badHaltRejected = $badHaltRejected } "
      + "| ConvertTo-Json -Compress",
    );

    expect(result).toEqual({
      brokenJsonRejected: true,
      badSchemaRejected: true,
      badHaltRejected: true,
    });
  });

  it("validates supervisor PID reuse with start time and the dedicated command-line token", () => {
    const dataDir = makeTestDir("windows-supervisor-identity");
    const token = "0123456789abcdef0123456789abcdef";
    const scriptPath = join(dataDir, "identity probe.ps1");
    const result = invokePowerShellFile<{
      active: boolean;
      reusedPidRejected: boolean;
    }>(scriptPath,
      `$paths = Get-BridgeSupervisorControlPaths ${quotePowerShell(dataDir)} ${quotePowerShell(process.cwd())}; `
      + `Write-BridgeSupervisorState $paths ${quotePowerShell(process.cwd())} ${quotePowerShell(token)}; `
      + "$state = Get-BridgeSupervisorState $paths; "
      + `$active = Test-BridgeSupervisorStateProcess $state ${quotePowerShell(process.cwd())}; `
      + "$state.processStartTimeUtcTicks = $state.processStartTimeUtcTicks + 1; "
      + `$reusedPidRejected = -not (Test-BridgeSupervisorStateProcess $state ${quotePowerShell(process.cwd())}); `
      + "[pscustomobject]@{ active = $active; reusedPidRejected = $reusedPidRejected } | ConvertTo-Json -Compress",
      token,
    );

    expect(result).toEqual({
      active: true,
      reusedPidRejected: true,
    });
  });

  it("starts the dedicated supervisor child with paths and arguments containing spaces", () => {
    const dataDir = makeTestDir("windows-supervisor-child");
    const scriptPath = join(dataDir, "supervisor child probe.ps1");
    const resultPath = join(dataDir, "child result.json");
    writeFileSync(scriptPath, [
      "param([switch]$Wait, [string]$SupervisorToken, [long]$StartRequestOrder, [string]$Marker)",
      "[pscustomobject]@{",
      "  waited = [bool]$Wait",
      "  token = $SupervisorToken",
      "  startRequestOrder = $StartRequestOrder",
      "  marker = $Marker",
      `} | ConvertTo-Json -Compress | Set-Content -LiteralPath ${quotePowerShell(resultPath)}`,
    ].join("\r\n"));

    const result = invokePowerShell<{
      waited: boolean;
      tokenLength: number;
      marker: string;
      startRequestOrder: number;
      exitCode: number;
    }>(
      `$paths = Get-BridgeSupervisorControlPaths ${quotePowerShell(dataDir)} ${quotePowerShell(process.cwd())}; `
      + `$child = Start-BridgeSupervisorChild $paths ${quotePowerShell(scriptPath)} @('-Marker', 'value with spaces'); `
      + "$child.process.WaitForExit(); "
      + `$payload = Get-Content -LiteralPath ${quotePowerShell(resultPath)} -Raw | ConvertFrom-Json; `
      + "[pscustomobject]@{ waited = $payload.waited; tokenLength = $payload.token.Length; startRequestOrder = $payload.startRequestOrder; marker = $payload.marker; exitCode = $child.process.ExitCode } "
      + "| ConvertTo-Json -Compress",
    );

    expect(result).toEqual({
      waited: true,
      tokenLength: 32,
      startRequestOrder: 0,
      marker: "value with spaces",
      exitCode: 0,
    });
  });

  it("orders explicit starts and stops deterministically", () => {
    const dataDir = makeTestDir("windows-supervisor-ordering");
    const firstToken = "11111111111111111111111111111111";
    const secondToken = "22222222222222222222222222222222";
    const result = invokePowerShell<{
      newerStop: string;
      newerStart: string;
      staleRequest: string;
      startOrder: number;
      stopOrder: number;
      secondStartOrder: number;
    }>(
      `$paths = Get-BridgeSupervisorControlPaths ${quotePowerShell(dataDir)} ${quotePowerShell(process.cwd())}; `
      + `$startOrder = Write-BridgeSupervisorStartRequest $paths ${quotePowerShell(firstToken)}; `
      + "Write-BridgeSupervisorHalt $paths 'intentional-stop' 'newer stop'; "
      + "$stopOrder = (Get-BridgeSupervisorHalt $paths).order; "
      + `$newerStop = Get-BridgeExplicitStartDecision $paths ${quotePowerShell(firstToken)} $startOrder; `
      + `$secondStartOrder = Write-BridgeSupervisorStartRequest $paths ${quotePowerShell(secondToken)}; `
      + `$newerStart = Get-BridgeExplicitStartDecision $paths ${quotePowerShell(secondToken)} $secondStartOrder; `
      + `$staleRequest = Get-BridgeExplicitStartDecision $paths ${quotePowerShell(firstToken)} $startOrder; `
      + "[pscustomobject]@{ newerStop = $newerStop; newerStart = $newerStart; staleRequest = $staleRequest; "
      + "startOrder = $startOrder; stopOrder = $stopOrder; secondStartOrder = $secondStartOrder } "
      + "| ConvertTo-Json -Compress",
    );

    expect(result).toEqual({
      newerStop: "superseded",
      newerStart: "allow",
      staleRequest: "invalid",
      startOrder: 1,
      stopOrder: 2,
      secondStartOrder: 3,
    });
  });

  it("recovers a corrupt order counter above valid persisted requests", () => {
    const dataDir = makeTestDir("windows-supervisor-order-recovery");
    const firstToken = "33333333333333333333333333333333";
    const secondToken = "44444444444444444444444444444444";
    const result = invokePowerShell<{
      fromStartRequest: number;
      fromHalt: number;
      finalCounter: number;
    }>(
      `$paths = Get-BridgeSupervisorControlPaths ${quotePowerShell(dataDir)} ${quotePowerShell(process.cwd())}; `
      + "Set-Content -LiteralPath $paths.OrderPath -Value '{malformed'; "
      + `Write-BridgeSupervisorJson $paths.StartRequestPath ([ordered]@{ version = 1; order = 41; token = ${quotePowerShell(firstToken)}; requestedAtUtc = [DateTime]::UtcNow.ToString('o'); requestedByPid = $PID }); `
      + "$lock = Enter-BridgeSupervisorControlLock $paths; "
      + "try { $fromStartRequest = Get-NextBridgeSupervisorOrder $paths } finally { Exit-BridgeSupervisorControlLock $lock }; "
      + `Write-BridgeSupervisorJson $paths.HaltPath ([ordered]@{ version = 1; order = 75; reason = 'intentional-stop'; detail = 'test'; requestedAtUtc = [DateTime]::UtcNow.ToString('o'); requestedByPid = $PID }); `
      + "Set-Content -LiteralPath $paths.OrderPath -Value '{\"order\":\"broken\"}'; "
      + "$lock = Enter-BridgeSupervisorControlLock $paths; "
      + "try { $fromHalt = Write-BridgeSupervisorStartRequest $paths "
      + `${quotePowerShell(secondToken)} } finally { Exit-BridgeSupervisorControlLock $lock }; `
      + "$finalCounter = [long](Read-BridgeSupervisorJson $paths.OrderPath).order; "
      + "[pscustomobject]@{ fromStartRequest = $fromStartRequest; fromHalt = $fromHalt; finalCounter = $finalCounter } "
      + "| ConvertTo-Json -Compress",
    );

    expect(result).toEqual({
      fromStartRequest: 42,
      fromHalt: 76,
      finalCounter: 76,
    });
  });

  it("holds the control lock through launch and tracked child-state publication", () => {
    const dataDir = makeTestDir("windows-supervisor-atomic-launch");
    const token = "55555555555555555555555555555555";
    const scriptPath = join(dataDir, "atomic launch probe.ps1");
    const result = invokePowerShellFile<{
      competingOpenBlocked: boolean;
      launcherProcessId: number;
      requestRemoved: boolean;
    }>(scriptPath,
      `$paths = Get-BridgeSupervisorControlPaths ${quotePowerShell(dataDir)} ${quotePowerShell(process.cwd())}; `
      + `Write-BridgeSupervisorState $paths ${quotePowerShell(process.cwd())} $SupervisorToken; `
      + "$lock = Enter-BridgeSupervisorControlLock $paths; "
      + "try { $order = Write-BridgeSupervisorStartRequest $paths $SupervisorToken } finally { Exit-BridgeSupervisorControlLock $lock }; "
      + "$script:blocked = $false; "
      + "$start = { "
      + "  try { "
      + "    $competing = [IO.File]::Open($paths.ControlLockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None); "
      + "    $competing.Dispose() "
      + "  } catch [IO.IOException] { $script:blocked = $true }; "
      + "  [Diagnostics.Process]::GetCurrentProcess() "
      + "}; "
      + `$launched = Start-BridgeLauncherUnderControlLock $paths ${quotePowerShell(process.cwd())} $SupervisorToken $order $true $start; `
      + "$state = Get-BridgeSupervisorState $paths; "
      + "[pscustomobject]@{ competingOpenBlocked = $script:blocked; launcherProcessId = $state.launcherProcessId; "
      + "requestRemoved = -not (Test-Path -LiteralPath $paths.StartRequestPath) } | ConvertTo-Json -Compress",
      token,
    );

    expect(result).toEqual({
      competingOpenBlocked: true,
      launcherProcessId: expect.any(Number),
      requestRemoved: true,
    });
    expect(result.launcherProcessId).toBeGreaterThan(0);
  });

  it("removes supervisor state and reports exit 70 when cleanup throws", () => {
    const dataDir = makeTestDir("windows-supervisor-cleanup-failure");
    const token = "66666666666666666666666666666666";
    const scriptPath = join(dataDir, "cleanup failure probe.ps1");
    const result = invokePowerShellFile<{
      exitCode: number;
      stateRemoved: boolean;
      starts: number;
    }>(scriptPath,
      `$paths = Get-BridgeSupervisorControlPaths ${quotePowerShell(dataDir)} ${quotePowerShell(process.cwd())}; `
      + "$script:starts = 0; "
      + "$cleanup = { throw 'simulated cleanup failure' }; "
      + "$start = { $script:starts++; [Diagnostics.Process]::GetCurrentProcess() }; "
      + "$exitCode = 0; "
      + "try { "
      + `  Invoke-BridgeLauncherSupervisor $paths ${quotePowerShell(process.cwd())} $SupervisorToken 0 $start $cleanup `
      + "} catch { $exitCode = [int]$_.Exception.Data['BridgeExitCode'] }; "
      + "[pscustomobject]@{ exitCode = $exitCode; stateRemoved = -not (Test-Path -LiteralPath $paths.StatePath); starts = $script:starts } "
      + "| ConvertTo-Json -Compress",
      token,
    );

    expect(result).toEqual({
      exitCode: 70,
      stateRemoved: true,
      starts: 0,
    });
  });

  it("fails verified process cleanup after bounded identity-safe retries", () => {
    const result = invokePowerShell<{ failed: boolean; stopAttempts: number }>(
      "$script:stopAttempts = 0; "
      + "function Test-BridgeProcessIdentity($Identity) { return $true }; "
      + "function Stop-Process { param([int]$Id, [switch]$Force, $ErrorAction) $script:stopAttempts++ }; "
      + "$failed = $false; "
      + "try { $null = Stop-BridgeVerifiedProcessIdentities @{ 900 = [pscustomobject]@{ processId = 900 } } @(900) 3 0 } "
      + "catch { $failed = $true }; "
      + "[pscustomobject]@{ failed = $failed; stopAttempts = $script:stopAttempts } | ConvertTo-Json -Compress",
    );

    expect(result).toEqual({ failed: true, stopAttempts: 3 });
  });

  it("treats launcher cleanup failure as a durable terminal outcome", () => {
    const decision = invokePowerShell<Record<string, unknown>>(
      "Get-BridgeSupervisorDecision 70 $false 0 1 | ConvertTo-Json -Compress",
    );

    expect(decision).toMatchObject({
      action: "terminal",
      reason: "launcher-cleanup-failure",
      createHalt: true,
    });
  });

  it("keeps v4 start and stop wrappers usable after the prior v3 updater omits the new helper", () => {
    const installRoot = makeTestDir("windows-v3-v4-upgrade");
    const scriptsRoot = join(process.cwd(), "scripts");

    // This is the exact relevant v3 updater allowlist: wrappers/common are replaced,
    // but bridge-supervisor-common.ps1 is unknown to that updater and is not copied.
    writeFileSync(join(installRoot, "start.ps1"), readFileSync(join(scriptsRoot, "start-release.ps1")));
    writeFileSync(join(installRoot, "stop.ps1"), readFileSync(join(scriptsRoot, "stop-release.ps1")));
    writeFileSync(join(installRoot, "update.ps1"), readFileSync(join(scriptsRoot, "update-release.ps1")));

    const command = [
      "$ErrorActionPreference = 'Stop'",
      `$root = ${quotePowerShell(installRoot)}`,
      `$releaseCommonSource = Get-Content -LiteralPath ${quotePowerShell(join(scriptsRoot, "release-common.ps1"))} -Raw`,
      `$supervisorHelperSource = Get-Content -LiteralPath ${quotePowerShell(join(scriptsRoot, "bridge-supervisor-common.ps1"))} -Raw`,
      "$placeholder = '__BRIDGE_SUPERVISOR_HELPER_BASE64__'",
      "$placeholderCount = [regex]::Matches($releaseCommonSource, [regex]::Escape($placeholder)).Count",
      "$payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($supervisorHelperSource))",
      "$packagedReleaseCommon = $releaseCommonSource.Replace($placeholder, $payload)",
      "[IO.File]::WriteAllText((Join-Path $root 'release-common.ps1'), $packagedReleaseCommon, (New-Object Text.UTF8Encoding($false)))",
      "$parseErrors = @()",
      "$tokens = $null; $errors = $null",
      "[void][System.Management.Automation.Language.Parser]::ParseFile((Join-Path $root 'start.ps1'), [ref]$tokens, [ref]$errors)",
      "$parseErrors += @($errors)",
      "$tokens = $null; $errors = $null",
      "[void][System.Management.Automation.Language.Parser]::ParseFile((Join-Path $root 'stop.ps1'), [ref]$tokens, [ref]$errors)",
      "$parseErrors += @($errors)",
      ". (Join-Path $root 'release-common.ps1')",
      ". (Get-BridgeSupervisorHelperScriptBlock $root)",
      "[pscustomobject]@{ "
        + "placeholderCount = $placeholderCount; "
        + "payloadSubstituted = $packagedReleaseCommon.Contains($payload); "
        + "standaloneHelperAbsent = -not (Test-Path (Join-Path $root 'bridge-supervisor-common.ps1')); "
        + "wrappersParse = $parseErrors.Count -eq 0; "
        + "startCommandAvailable = $null -ne (Get-Command Start-BridgeSupervisorChild -ErrorAction SilentlyContinue); "
        + "supervisorCommandAvailable = $null -ne (Get-Command Invoke-BridgeLauncherSupervisor -ErrorAction SilentlyContinue); "
        + "stopCommandAvailable = $null -ne (Get-Command Stop-BridgeLauncherSupervisor -ErrorAction SilentlyContinue) "
        + "} | ConvertTo-Json -Compress",
    ].join("; ");
    const output = execFileSync(powerShell, [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      command,
    ], { encoding: "utf8" });

    expect(JSON.parse(output.trim())).toEqual({
      placeholderCount: 1,
      payloadSubstituted: true,
      standaloneHelperAbsent: true,
      wrappersParse: true,
      startCommandAvailable: true,
      supervisorCommandAvailable: true,
      stopCommandAvailable: true,
    });
  });

  it("derives the same per-install release tunnel identity used by the launcher", () => {
    const stateRoot = join(process.cwd(), `.windows-release-tunnel-${randomUUID()}`);
    mkdirSync(stateRoot);
    const commonPath = join(process.cwd(), "scripts", "release-common.ps1");
    const env = {
      ...process.env,
      USERDOMAIN: "ExampleDomain",
      USERNAME: "ExampleUser",
      COMPUTERNAME: "ExampleMachine",
      BRIDGE_TUNNEL_NAME: "",
    };
    const identity = [
      env.USERDOMAIN,
      env.USERNAME,
      env.COMPUTERNAME,
      resolve(stateRoot),
    ].map((value) => value.trim().toLowerCase()).join("|");
    const expected = `copilot-bridge-${createHash("sha256").update(identity).digest("hex").slice(0, 8)}`;
    const command = [
      `$env:USERDOMAIN = 'ExampleDomain'`,
      `$env:USERNAME = 'ExampleUser'`,
      `$env:COMPUTERNAME = 'ExampleMachine'`,
      `$env:BRIDGE_TUNNEL_NAME = ''`,
      `. ${quotePowerShell(commonPath)}`,
      `Get-BridgeReleaseTunnelName ${quotePowerShell(stateRoot)} ${quotePowerShell(join(stateRoot, "data"))}`,
    ].join("; ");

    let actual: string;
    try {
      actual = execFileSync(powerShell, [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        command,
      ], { encoding: "utf8", env }).trim();
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
    }

    expect(actual).toBe(expected);
  });

  it("uses a custom data directory as the release tunnel identity fallback", () => {
    const customDataDir = join(process.cwd(), `.windows-custom-data-${randomUUID()}`);
    mkdirSync(customDataDir);
    const commonPath = join(process.cwd(), "scripts", "release-common.ps1");
    const identityValue = resolve(customDataDir).toLowerCase();
    const identity = [
      "exampledomain",
      "exampleuser",
      "examplemachine",
      identityValue,
    ].join("|");
    const expected = `copilot-bridge-${createHash("sha256").update(identity).digest("hex").slice(0, 8)}`;
    const command = [
      `$env:USERDOMAIN = 'ExampleDomain'`,
      `$env:USERNAME = 'ExampleUser'`,
      `$env:COMPUTERNAME = 'ExampleMachine'`,
      `$env:BRIDGE_STATE_ROOT = ''`,
      `$env:BRIDGE_TUNNEL_NAME = ''`,
      `. ${quotePowerShell(commonPath)}`,
      `Get-BridgeReleaseTunnelName $env:BRIDGE_STATE_ROOT ${quotePowerShell(customDataDir)}`,
    ].join("; ");

    try {
      const actual = execFileSync(powerShell, [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        command,
      ], { encoding: "utf8" }).trim();
      expect(actual).toBe(expected);
    } finally {
      rmSync(customDataDir, { recursive: true, force: true });
    }
  });
});
