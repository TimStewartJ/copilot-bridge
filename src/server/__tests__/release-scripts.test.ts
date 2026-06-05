import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("release scripts", () => {
  const commonHelperFunctions = [
    "Test-AbsolutePath",
    "Assert-AbsolutePath",
    "Normalize-FullPath",
    "Test-SameOrChildPath",
    "Get-StoredStateRoot",
    "Get-ConfiguredStateRoot",
    "Assert-StateRootDoesNotSwitch",
    "Remove-OldBridgeLogArchives",
    "Move-ExistingBridgeLog",
  ];

  function readScript(scriptName: string) {
    return readFileSync(join(process.cwd(), "scripts", scriptName), "utf-8");
  }

  function expectReleaseCommonDotSource(script: string) {
    expect(script).toContain('$bridgeReleaseCommonScript = Join-Path $PSScriptRoot "release-common.ps1"');
    expect(script).toContain(". $bridgeReleaseCommonScript");
  }

  function expectNoLocalCommonHelperDefinitions(script: string) {
    const localDefinitions = commonHelperFunctions.filter((name) =>
      new RegExp(`function\\s+${name}\\b`).test(script),
    );
    expect(localDefinitions).toEqual([]);
  }

  function expectBridgeLogRotationBeforeRedirect(script: string, stdoutRoot: string, stderrRoot: string) {
    const commonScript = readScript("release-common.ps1");

    expectReleaseCommonDotSource(script);
    expectNoLocalCommonHelperDefinitions(script);
    expect(commonScript).toContain("function Remove-OldBridgeLogArchives($Path, $MaxArchives)");
    expect(commonScript).toContain("function Move-ExistingBridgeLog($Path, $MaxArchives)");
    expect(script).toContain(`$bridgeStdoutLog = Join-Path $${stdoutRoot} "bridge.log"`);
    expect(script).toContain(`$bridgeStderrLog = Join-Path $${stderrRoot} "bridge-error.log"`);
    expect(script).toContain("$bridgeLogArchiveRetention = 20");
    expect(commonScript).toContain("Test-Path -LiteralPath $logDirectory -PathType Container");
    expect(commonScript).toContain("Where-Object { $_.Name -match $archivePattern }");
    expect(commonScript).toContain("Select-Object -Skip $MaxArchives");
    expect(commonScript).toContain("Move-Item -LiteralPath $Path -Destination $archivePath -ErrorAction Stop");
    expect(commonScript).toContain("Remove-OldBridgeLogArchives $Path $MaxArchives");
    expect(commonScript).toContain("Remove-Item -LiteralPath $archive.FullName -Force -ErrorAction Stop");
    expect(commonScript).toContain(
      'Write-Warning "Could not remove old Bridge log archive $($archive.FullName): $($_.Exception.Message)"',
    );
    expect(commonScript).toContain(
      'throw "Could not rotate existing Bridge log $Path to $archivePath after $attempt attempts: $($_.Exception.Message)"',
    );

    const moveExistingLog = commonScript.indexOf(
      "Move-Item -LiteralPath $Path -Destination $archivePath -ErrorAction Stop",
    );
    const pruneArchives = commonScript.indexOf("Remove-OldBridgeLogArchives $Path $MaxArchives");
    const stdoutRotation = script.indexOf("Move-ExistingBridgeLog $bridgeStdoutLog $bridgeLogArchiveRetention");
    const stderrRotation = script.indexOf("Move-ExistingBridgeLog $bridgeStderrLog $bridgeLogArchiveRetention");
    const stdoutRedirect = script.indexOf("-RedirectStandardOutput $bridgeStdoutLog");
    const stderrRedirect = script.indexOf("-RedirectStandardError $bridgeStderrLog");

    expect(pruneArchives).toBeGreaterThan(moveExistingLog);
    expect(stdoutRotation).toBeGreaterThanOrEqual(0);
    expect(stderrRotation).toBeGreaterThanOrEqual(0);
    expect(stdoutRedirect).toBeGreaterThan(stdoutRotation);
    expect(stderrRedirect).toBeGreaterThan(stderrRotation);
  }

  it("keeps release wrapper helper logic in the shared common script", () => {
    const commonScript = readScript("release-common.ps1");
    const wrappers = [
      "start-release.ps1",
      "stop-release.ps1",
      "update-release.ps1",
      "install-preview.ps1",
      "install-startup-task.ps1",
      "start-bridge.ps1",
    ];

    for (const functionName of commonHelperFunctions) {
      expect(commonScript).toContain(`function ${functionName}`);
    }
    expect(commonScript).not.toContain("Import-BridgeEnvFile");
    expect(commonScript).not.toContain("$ErrorActionPreference");
    expect(commonScript).not.toMatch(/^\s*param\s*\(/m);

    for (const wrapperName of wrappers) {
      const script = readScript(wrapperName);
      expectNoLocalCommonHelperDefinitions(script);
      expect(script).toContain("release-common.ps1");
    }
  });

  it("stages release updates as inactive slots and queues launcher activation", () => {
    const script = readScript("update-release.ps1");

    expectReleaseCommonDotSource(script);
    expect(script).toContain('$releaseSlotsDir = Join-Path $effectiveDataDir "release-slots"');
    expect(script).toContain('Write-JsonFile (Join-Path $tempSlotRoot "release-slot.json") $releaseSlotManifest');
    expect(script).toContain('$restartSignalPath = Join-Path $effectiveDataDir "restart.signal"');
    expect(script).toContain('Write-UpdateStatus "staged"');
    expect(script).toContain("Copy-ReleaseWrappersWithBackup");
    expect(script).toContain("Copy-ReleaseWrappers $DestinationRoot $BackupRoot");
    expect(script).toContain("Copy-ReleaseWrappers $BackupRoot $DestinationRoot");
    expect(script).toContain('$wrapperBackupRoot = Join-Path (Join-Path (Join-Path $stateRoot "backups") "update-$timestamp") "wrappers"');
    expect(script).toContain("Copy-ReleaseWrappersWithBackup $newReleaseRoot $installRoot $wrapperBackupRoot");
    expect(script).toContain('"release-common.ps1"');
    expect(script.indexOf('"release-common.ps1"')).toBeLessThan(script.indexOf('"start.ps1"'));
    expect(script).toContain("function Remove-PathWithRetry");
    expect(script).toContain("Timed out waiting to remove $Path");
    expect(script).toContain("New-Item -ItemType Directory -Path $tempDir -Force");
    expect(script.indexOf('Write-UpdateStatus "staged"')).toBeLessThan(script.indexOf("Move-Item -Path $restartSignalTempPath"));
    expect(script).not.toContain('Write-UpdateStatus "stopping"');
    expect(script).not.toContain("Wait-BridgeHealth");
    expect(script).not.toContain("Copy-DirectoryTree $appBackup $appDir");
    expect(script).not.toContain("Backup-ConfiguredDirectories");
    expect(script).not.toContain("Restore-BackupEntry");
    expect(script).not.toContain("Normalize-BackupPath");
    expect(script).not.toContain("Test-SameOrChildPath");
    expect(script).not.toContain("Assert-BackupPathSafe");
    expect(script).not.toContain("Get-BridgePort");
    expect(script).not.toContain("$backupEntries");
    expect(script).not.toContain("$bridgeStopped");
    expect(script).not.toContain("$appBackedUp");
    expect(script).not.toContain("$appExistedBefore");
    expect(script).not.toContain("RollbackAttempted");
    expect(script).not.toContain("rollbackAttempted");
    expect(script).not.toContain("mutableDirectoriesPreservedOnRollback");
    expect(script).not.toContain("backupDir =");
    expect(script).not.toContain("$backupDir");
    expect(script).not.toContain("New-Item -ItemType Directory -Path $backupDir, $tempDir");
  });

  it("uses fast Windows archive and copy tools with PowerShell fallbacks", () => {
    const script = readScript("update-release.ps1");

    expect(script).toContain('Get-Command "tar.exe"');
    expect(script).toContain("Expand-Archive -Path $PackagePath");
    expect(script).toContain('Get-Command "robocopy.exe"');
    expect(script).toContain("$robocopyExitCode -le 7");
    expect(script).toContain("Copy-Item -Path $SourcePath");
    expect(script).toContain("$global:LASTEXITCODE = 0");
  });

  it("keeps source scripts out of packaged app layout while preserving release wrappers", () => {
    const packageScript = readFileSync(join(process.cwd(), "scripts", "package-release.ps1"), "utf-8");
    const smokeScript = readFileSync(join(process.cwd(), "scripts", "test-release-package.ps1"), "utf-8");
    const analysisScript = readFileSync(join(process.cwd(), "scripts", "analyze-release-package.ps1"), "utf-8");

    expect(packageScript).not.toContain('Destination (Join-Path $appDir "scripts")');
    expect(packageScript).toContain('Destination (Join-Path $releaseRoot "start.ps1")');
    expect(packageScript).toContain('Destination (Join-Path $releaseRoot "stop.ps1")');
    expect(packageScript).toContain('Destination (Join-Path $releaseRoot "update.ps1")');
    expect(packageScript).toContain('Destination (Join-Path $releaseRoot "install-startup-task.ps1")');
    expect(packageScript).toContain('Destination (Join-Path $releaseRoot "uninstall-startup-task.ps1")');

    expect(smokeScript).toContain('Assert-PathAbsent "app scripts directory"');
    expect(smokeScript).toContain('Assert-PathExists "install-startup-task.ps1"');
    expect(smokeScript).toContain('Assert-PathExists "uninstall-startup-task.ps1"');
    expect(analysisScript).toContain("Get-AppScriptsFindings");
    expect(analysisScript).toContain("unexpectedRuntimeFiles");
    expect(analysisScript).toContain("installStartupTaskScript");
    expect(analysisScript).toContain("uninstallStartupTaskScript");
  });

  it("bundles every runtime dependency the packaged server imports at startup", () => {
    const packageScript = readFileSync(join(process.cwd(), "scripts", "package-release.ps1"), "utf-8");

    const allowlistMatch = packageScript.match(/\$runtimeDependencyNames\s*=\s*@\(([\s\S]*?)\)/);
    expect(allowlistMatch, "package-release.ps1 must define $runtimeDependencyNames").not.toBeNull();
    const allowlist = [...allowlistMatch![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);

    // The native Bridge-tools MCP server imports @modelcontextprotocol/sdk as a value at
    // startup. It is NOT a transitive dependency of any other allowlisted package, so it must
    // be installed explicitly — otherwise the packaged server crashes on boot with
    // ERR_MODULE_NOT_FOUND and never becomes healthy. Guarding this prevents a silent
    // reintroduction of that release-only crash.
    const mcpServerSource = readFileSync(
      join(process.cwd(), "src", "server", "agent-tools-mcp", "server.ts"),
      "utf-8",
    );
    expect(mcpServerSource).toMatch(/from\s+"@modelcontextprotocol\/sdk\//);
    expect(allowlist).toContain("@modelcontextprotocol/sdk");
  });

  it("forces packaged starts to release mode instead of inheriting dev mode", () => {
    const script = readScript("start-release.ps1");

    expectReleaseCommonDotSource(script);
    expect(script).toContain('Set-Item -Path "Env:BRIDGE_DISTRIBUTION_MODE" -Value "release"');
    expect(script).toContain('Set-Item -Path "Env:BRIDGE_RELEASE_ROOT" -Value $installRoot');
    expect(script).toContain("Get-ActiveReleaseAppRoot $effectiveDataDir");
    expect(script).toContain('Join-Path $activeRoot "release-slot.json"');
    expect(script).not.toContain('Set-DefaultEnv "BRIDGE_DISTRIBUTION_MODE" "release"');
  });

  it("does not fall back to the obsolete app/current release layout", () => {
    const startScript = readFileSync(join(process.cwd(), "scripts", "start-release.ps1"), "utf-8");
    const analyzeScript = readFileSync(join(process.cwd(), "scripts", "analyze-release-package.ps1"), "utf-8");
    const testPackageScript = readFileSync(join(process.cwd(), "scripts", "test-release-package.ps1"), "utf-8");

    for (const script of [startScript, analyzeScript, testPackageScript]) {
      expect(script).not.toMatch(/app[\\/]current/i);
      expect(script).not.toMatch(/\$currentApp\b/);
    }

    const packagedAppRoot = startScript.indexOf('$appRoot = Join-Path $installRoot "app"');
    const activeReleaseRoot = startScript.indexOf("$activeReleaseRoot = Get-ActiveReleaseAppRoot $effectiveDataDir");
    const activeReleaseAssignment = startScript.indexOf("$appRoot = $activeReleaseRoot");
    const launcherCheck = startScript.indexOf('if (-not (Test-Path (Join-Path $appRoot "dist\\launcher.js"))) {');

    expect(packagedAppRoot).toBeGreaterThanOrEqual(0);
    expect(activeReleaseRoot).toBeGreaterThan(packagedAppRoot);
    expect(activeReleaseAssignment).toBeGreaterThan(activeReleaseRoot);
    expect(launcherCheck).toBeGreaterThan(activeReleaseAssignment);
    expect(analyzeScript).toContain('$appRoot = Join-Path $ReleaseRoot "app"');
    expect(analyzeScript).toContain("appRoot = $null -ne $appRoot -and (Test-Path $appRoot)");
    expect(analyzeScript).toContain('launcher = $null -ne $appRoot -and (Test-Path (Join-Path $appRoot "dist\\launcher.js"))');
    expect(testPackageScript).toContain('$appRoot = Join-Path $ReleaseRoot "app"');
    expect(testPackageScript).toContain('throw "Release app root not found under $releaseRoot"');
    expect(testPackageScript).toContain('Assert-PathExists "packaged launcher" (Join-Path $appRoot "dist\\launcher.js")');
  });

  it("rotates release stdout and stderr logs before redirecting to active log paths", () => {
    const script = readScript("start-release.ps1");

    expectBridgeLogRotationBeforeRedirect(script, "logsDir", "logsDir");
    expect(script).not.toMatch(/-RedirectStandardOutput\s+\(Join-Path\s+\$logsDir\s+"bridge\.log"\)/);
    expect(script).not.toMatch(/-RedirectStandardError\s+\(Join-Path\s+\$logsDir\s+"bridge-error\.log"\)/);
  });

  it("surfaces and copies Bridge logs when the start smoke health check fails", () => {
    const script = readScript("test-release-package.ps1");

    expect(script).toContain("function Show-BridgeLogTail");
    expect(script).toContain('$logsDir = Join-Path $StateRoot "logs"');
    expect(script).toContain('Show-BridgeLogTail "launcher.log" (Join-Path $logsDir "launcher.log")');
    expect(script).toContain('Show-BridgeLogTail "bridge.log" (Join-Path $logsDir "bridge.log")');
    expect(script).toContain('Show-BridgeLogTail "bridge-error.log" (Join-Path $logsDir "bridge-error.log")');
    expect(script).toContain('$smokeLogOutDir = Join-Path $smokeRepoRoot "release\\smoke-logs"');

    // The log dump must be wired into the health-check failure path, not the success path.
    const healthCall = script.indexOf('Wait-Health "http://localhost:$Port/api/health" $TimeoutSeconds');
    const logDump = script.indexOf('Show-BridgeLogTail "launcher.log"');
    const reThrow = script.indexOf("throw", logDump);
    expect(healthCall).toBeGreaterThanOrEqual(0);
    expect(logDump).toBeGreaterThan(healthCall);
    expect(reThrow).toBeGreaterThan(logDump);
  });

  it("rotates local stdout and stderr logs before redirecting to active log paths", () => {
    const script = readScript("start-bridge.ps1");

    expectBridgeLogRotationBeforeRedirect(script, "dataDir", "dataDir");
    expect(script).not.toMatch(/-RedirectStandardOutput\s+"\$dataDir\\bridge\.log"/);
    expect(script).not.toMatch(/-RedirectStandardError\s+"\$dataDir\\bridge-error\.log"/);
  });

  it("does not stop the active updater when stopping release processes", () => {
    const script = readScript("stop-release.ps1");

    expectReleaseCommonDotSource(script);
    expect(script).toContain("$updaterProcessPattern");
    expect(script).toContain("function Test-ReleaseUpdaterProcess");
    expect(script).toContain("function Add-ProcessTree($Process, [bool]$RequireReleaseInstallProcess = $true)");
    expect(script).toContain('$releaseSlotsDir = Join-Path $effectiveDataDir "release-slots"');
    // The machine-wide release-slots pattern was a cross-install kill hazard: it would
    // match (and force-kill) an unrelated install's bridge running from its own slot.
    // Matching must stay scoped to this install.
    expect(script).not.toContain("$anyReleaseSlotPattern");
    expect(script).not.toContain('"release-slots[\\\\/][^\\\\/]+[\\\\/]"');
    expect(script).toContain("$releaseRootPatterns = @($installRootPattern, $releaseSlotsPattern)");
    expect(script).toContain('$activeReleasePointerPath = Join-Path $effectiveDataDir "active-release.json"');
    expect(script).toContain("Test-SameOrChildPath $activeReleaseRoot $releaseSlotsDir");
    expect(script).toContain("$releaseRootPatterns");
    expect(script).toContain("Add-ProcessTree $child $false");
    expect(script).toContain("if (Test-ReleaseUpdaterProcess $Process)");
    expect(script).toContain("-not (Test-ReleaseUpdaterProcess $_)");
    expect(script).toContain("$stoppedProcessIds");
    expect(script).toContain("Timed out waiting for stopped Bridge process IDs to exit");
  });

  it("bootstraps preview installs from a signed manifest and verified package", () => {
    const script = readScript("install-preview.ps1");

    expect(script).toContain("latest-preview/preview-win-x64.manifest.json");
    expect(script).toContain("__BRIDGE_UPDATE_MANIFEST_PUBLIC_KEY_PEM__");
    expect(script).toContain("__BRIDGE_RELEASE_COMMON_SCRIPT_BASE64__");
    expect(script).toContain('$embeddedManifestPublicKeyPlaceholder = "__BRIDGE_UPDATE_MANIFEST_" + "PUBLIC_KEY_PEM__"');
    expect(script).toContain(
      '$embeddedReleaseCommonScriptPlaceholder = "__BRIDGE_RELEASE_" + "COMMON_SCRIPT_BASE64__"',
    );
    expect(script).toContain(". $bridgeReleaseCommonScript");
    expect(script).toContain(". ([scriptblock]::Create($embeddedReleaseCommonScript))");
    expect(script).toContain("$embedded = $embeddedManifestPublicKeyPem.Trim()");
    expect(script).toContain("Downloaded package SHA256 mismatch");
    expect(script).toContain('Resolve-CommandPath "tar.exe"');
    expect(script).toContain("Expand-Archive -Path $PackagePath");
    expect(script).toContain('Join-Path $env:LOCALAPPDATA "Programs\\CopilotBridge"');
    expect(script).toContain('Join-Path $env:LOCALAPPDATA "CopilotBridge"');
    expect(script).toContain('Assert-AbsolutePath "InstallRoot" $InstallRoot ""');
    expect(script).toContain("Set-Content -Path (Join-Path $InstallRoot \".bridge-state-root\")");
    expect(script).toContain("& (Join-Path $InstallRoot \"stop.ps1\")");
    expect(script).toContain("& (Join-Path $InstallRoot \"start.ps1\")");
  });

  it("packages and analyzes the shared release helper", () => {
    const packageScript = readScript("package-release.ps1");
    const analyzeScript = readScript("analyze-release-package.ps1");
    const smokeScript = readScript("test-release-package.ps1");

    expect(packageScript).toContain('Copy-Item -Path (Join-Path $repoRoot "scripts\\release-common.ps1")');
    expect(packageScript).toContain("packageLayoutVersion = 3");
    expect(analyzeScript).toContain('$commonScriptPath = Join-Path $releaseRoot "release-common.ps1"');
    expect(analyzeScript).toContain("commonScript = if ($requiresCommonScript) { Test-Path $commonScriptPath } else { $true }");
    expect(smokeScript).toContain('Assert-PathExists "release-common.ps1"');
  });

  it("publishes latest-preview installer and package alias assets", () => {
    const workflow = readFileSync(join(process.cwd(), ".github", "workflows", "preview.yml"), "utf-8");

    expect(workflow).toContain("Prepare latest preview aliases");
    expect(workflow).toContain("release/copilot-bridge-${{ env.PREVIEW_CHANNEL }}-${{ env.PREVIEW_PLATFORM }}.zip");
    expect(workflow).toContain("release/install-preview.ps1");
    expect(workflow).toContain('$installerText = $installerTemplate.Replace("__BRIDGE_UPDATE_MANIFEST_PUBLIC_KEY_PEM__", $publicKeyPem)');
    expect(workflow).toContain('$installerText = $installerText.Replace("__BRIDGE_RELEASE_COMMON_SCRIPT_BASE64__", $releaseCommonScriptBase64)');
    expect(workflow).toContain("function Test-ReleaseAsset");
    expect(workflow).toContain("function Upload-ReleaseAsset");

    const pointerStep = workflow.slice(workflow.indexOf("Publish latest preview pointer"));
    const aliasUpload = pointerStep.indexOf('Upload-ReleaseAsset $tag $aliasZip "package alias"');
    const installerUpload = pointerStep.indexOf('Upload-ReleaseAsset $tag $installer "installer"');
    const signatureUpload = pointerStep.indexOf('Upload-ReleaseAsset $tag $signature "manifest signature"');
    const manifestUpload = pointerStep.indexOf('Upload-ReleaseAsset $tag $manifest "manifest"');
    expect(aliasUpload).toBeGreaterThanOrEqual(0);
    expect(installerUpload).toBeGreaterThan(aliasUpload);
    expect(signatureUpload).toBeGreaterThan(installerUpload);
    expect(manifestUpload).toBeGreaterThan(signatureUpload);
  });

  it("keeps preview publishing guarded to mainline branches", () => {
    const workflow = readFileSync(join(process.cwd(), ".github", "workflows", "preview.yml"), "utf-8");

    const immutablePublishStep = workflow.slice(workflow.indexOf("Publish immutable preview prerelease"));
    expect(workflow).toContain("-SmokeTest");
    expect(immutablePublishStep).toContain("github.ref == 'refs/heads/master'");
    expect(immutablePublishStep).toContain("github.event_name == 'workflow_dispatch'");
    expect(immutablePublishStep).toContain("inputs.publish_prerelease == true");
    expect(workflow).not.toContain("Release-mode install/update E2E");
  });

  it("runs release-mode install/update E2E in a dedicated workflow", () => {
    const workflow = readFileSync(join(process.cwd(), ".github", "workflows", "release-mode-e2e.yml"), "utf-8");
    const script = readScript("test-release-mode-e2e.ps1");

    expect(workflow).toContain("name: Release Mode E2E");
    expect(workflow).toContain(".\\scripts\\test-release-mode-e2e.ps1");
    expect(workflow).toContain('-EvidenceDir "release/release-mode-e2e"');
    expect(workflow).toContain("Upload release-mode E2E evidence");
    expect(workflow).toContain("if: always()");
    expect(workflow).toContain("release/release-mode-e2e/**");
    expect(workflow).toContain("-IncludeNodeModules");
    expect(workflow).toContain("-Analyze");
    expect(workflow).toContain("-SmokeTest");
    expect(workflow).not.toContain("gh release");
    expect(workflow).not.toContain("latest-preview");

    expect(script).toContain("[Parameter(Mandatory = $true)]");
    expect(script).toContain("[string]$PackagePath");
    expect(script).toContain("Wait-UpdateStagedOrSucceeded");
    expect(script).toContain("Wait-UpdateSucceeded");
    expect(script).toContain("-PackagePath $resolvedPackagePath");
    expect(script).toContain('Set-Item -Path "Env:BRIDGE_DISTRIBUTION_MODE" -Value "release"');
    expect(script).toContain("Get-IsolatedProcesses $testRoot");
    expect(script).toContain("Stop-Process -Id $processId");
    expect(script).toContain("Installer still contains the release common helper placeholder.");
    expect(script).toContain('Assert-PathExists "release common helper"');
    expect(script).not.toContain("stop-release.ps1");
    expect(script).not.toContain("stop.ps1");
    expect(script).not.toContain("release-slots[\\\\/]");
  });

  it("writes coverage details into the CI step summary", () => {
    const workflow = readFileSync(join(process.cwd(), ".github", "workflows", "ci.yml"), "utf-8");
    const vitestConfig = readFileSync(join(process.cwd(), "vitest.config.ts"), "utf-8");

    expect(vitestConfig).toContain('"json-summary"');
    expect(vitestConfig).toContain('"html"');
    expect(workflow).toContain("Write coverage summary");
    expect(workflow).toContain(".\\scripts\\write-coverage-summary.mjs coverage\\coverage-summary.json");
    expect(workflow).toContain("Upload coverage report");
  });
});
