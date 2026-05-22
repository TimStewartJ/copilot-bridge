import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("release scripts", () => {
  function expectBridgeLogRotationBeforeRedirect(script: string, stdoutRoot: string, stderrRoot: string) {
    expect(script).toContain("function Remove-OldBridgeLogArchives($Path, $MaxArchives)");
    expect(script).toContain("function Move-ExistingBridgeLog($Path, $MaxArchives)");
    expect(script).toContain(`$bridgeStdoutLog = Join-Path $${stdoutRoot} "bridge.log"`);
    expect(script).toContain(`$bridgeStderrLog = Join-Path $${stderrRoot} "bridge-error.log"`);
    expect(script).toContain("$bridgeLogArchiveRetention = 20");
    expect(script).toContain("Test-Path -LiteralPath $logDirectory -PathType Container");
    expect(script).toContain("Where-Object { $_.Name -match $archivePattern }");
    expect(script).toContain("Select-Object -Skip $MaxArchives");
    expect(script).toContain("Move-Item -LiteralPath $Path -Destination $archivePath -ErrorAction Stop");
    expect(script).toContain("Remove-OldBridgeLogArchives $Path $MaxArchives");
    expect(script).toContain("Remove-Item -LiteralPath $archive.FullName -Force -ErrorAction Stop");
    expect(script).toContain('Write-Warning "Could not remove old Bridge log archive $($archive.FullName): $($_.Exception.Message)"');
    expect(script).toContain('throw "Could not rotate existing Bridge log $Path to $archivePath after $attempt attempts: $($_.Exception.Message)"');

    const moveExistingLog = script.indexOf("Move-Item -LiteralPath $Path -Destination $archivePath -ErrorAction Stop");
    const pruneArchives = script.indexOf("Remove-OldBridgeLogArchives $Path $MaxArchives");
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

  it("stages release updates as inactive slots and queues launcher activation", () => {
    const script = readFileSync(join(process.cwd(), "scripts", "update-release.ps1"), "utf-8");

    expect(script).toContain('$releaseSlotsDir = Join-Path $effectiveDataDir "release-slots"');
    expect(script).toContain('Write-JsonFile (Join-Path $tempSlotRoot "release-slot.json") $releaseSlotManifest');
    expect(script).toContain('$restartSignalPath = Join-Path $effectiveDataDir "restart.signal"');
    expect(script).toContain('Write-UpdateStatus "staged"');
    expect(script).toContain("Copy-ReleaseWrappersWithBackup");
    expect(script).toContain("function Remove-PathWithRetry");
    expect(script).toContain("Timed out waiting to remove $Path");
    expect(script.indexOf('Write-UpdateStatus "staged"')).toBeLessThan(script.indexOf("Move-Item -Path $restartSignalTempPath"));
    expect(script).not.toContain('Write-UpdateStatus "stopping"');
    expect(script).not.toContain("Wait-BridgeHealth -TimeoutSeconds 60");
    expect(script).not.toContain("Copy-DirectoryTree $appBackup $appDir");
  });

  it("uses fast Windows archive and copy tools with PowerShell fallbacks", () => {
    const script = readFileSync(join(process.cwd(), "scripts", "update-release.ps1"), "utf-8");

    expect(script).toContain('Get-Command "tar.exe"');
    expect(script).toContain("Expand-Archive -Path $PackagePath");
    expect(script).toContain('Get-Command "robocopy.exe"');
    expect(script).toContain("$robocopyExitCode -le 7");
    expect(script).toContain("Copy-Item -Path $SourcePath");
    expect(script).toContain("$global:LASTEXITCODE = 0");
  });

  it("forces packaged starts to release mode instead of inheriting dev mode", () => {
    const script = readFileSync(join(process.cwd(), "scripts", "start-release.ps1"), "utf-8");

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
    const script = readFileSync(join(process.cwd(), "scripts", "start-release.ps1"), "utf-8");

    expectBridgeLogRotationBeforeRedirect(script, "logsDir", "logsDir");
    expect(script).not.toMatch(/-RedirectStandardOutput\s+\(Join-Path\s+\$logsDir\s+"bridge\.log"\)/);
    expect(script).not.toMatch(/-RedirectStandardError\s+\(Join-Path\s+\$logsDir\s+"bridge-error\.log"\)/);
  });

  it("rotates local stdout and stderr logs before redirecting to active log paths", () => {
    const script = readFileSync(join(process.cwd(), "scripts", "start-bridge.ps1"), "utf-8");

    expectBridgeLogRotationBeforeRedirect(script, "dataDir", "dataDir");
    expect(script).not.toMatch(/-RedirectStandardOutput\s+"\$dataDir\\bridge\.log"/);
    expect(script).not.toMatch(/-RedirectStandardError\s+"\$dataDir\\bridge-error\.log"/);
  });

  it("does not stop the active updater when stopping release processes", () => {
    const script = readFileSync(join(process.cwd(), "scripts", "stop-release.ps1"), "utf-8");

    expect(script).toContain("$updaterProcessPattern");
    expect(script).toContain("function Test-ReleaseUpdaterProcess");
    expect(script).toContain("function Add-ProcessTree($Process, [bool]$RequireReleaseInstallProcess = $true)");
    expect(script).toContain('$releaseSlotsDir = Join-Path $effectiveDataDir "release-slots"');
    expect(script).toContain("$anyReleaseSlotPattern");
    expect(script).toContain("$releaseRootPatterns");
    expect(script).toContain("Add-ProcessTree $child $false");
    expect(script).toContain("if (Test-ReleaseUpdaterProcess $Process)");
    expect(script).toContain("-not (Test-ReleaseUpdaterProcess $_)");
    expect(script).toContain("$stoppedProcessIds");
    expect(script).toContain("Timed out waiting for stopped Bridge process IDs to exit");
  });

  it("bootstraps preview installs from a signed manifest and verified package", () => {
    const script = readFileSync(join(process.cwd(), "scripts", "install-preview.ps1"), "utf-8");

    expect(script).toContain("latest-preview/preview-win-x64.manifest.json");
    expect(script).toContain("__BRIDGE_UPDATE_MANIFEST_PUBLIC_KEY_PEM__");
    expect(script).toContain("createPublicKey");
    expect(script).toContain("verify(null, manifest, publicKey, signature)");
    expect(script).toContain('$embeddedManifestPublicKeyPlaceholder = "__BRIDGE_UPDATE_MANIFEST_" + "PUBLIC_KEY_PEM__"');
    expect(script).toContain("$embedded = $embeddedManifestPublicKeyPem.Trim()");
    expect(script).toContain("Downloaded package SHA256 mismatch");
    expect(script).toContain('Resolve-CommandPath "tar.exe"');
    expect(script).toContain("Expand-Archive -Path $PackagePath");
    expect(script).toContain('Join-Path $env:LOCALAPPDATA "Programs\\CopilotBridge"');
    expect(script).toContain('Join-Path $env:LOCALAPPDATA "CopilotBridge"');
    expect(script).toContain("Set-Content -Path (Join-Path $InstallRoot \".bridge-state-root\")");
    expect(script).toContain("& (Join-Path $InstallRoot \"stop.ps1\")");
    expect(script).toContain("& (Join-Path $InstallRoot \"start.ps1\")");
  });

  it("publishes latest-preview installer and package alias assets", () => {
    const workflow = readFileSync(join(process.cwd(), ".github", "workflows", "preview.yml"), "utf-8");

    expect(workflow).toContain("Prepare latest preview aliases");
    expect(workflow).toContain("release/copilot-bridge-${{ env.PREVIEW_CHANNEL }}-${{ env.PREVIEW_PLATFORM }}.zip");
    expect(workflow).toContain("release/install-preview.ps1");
    expect(workflow).toContain('$installerTemplate.Replace("__BRIDGE_UPDATE_MANIFEST_PUBLIC_KEY_PEM__", $publicKeyPem)');
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
    const script = readFileSync(join(process.cwd(), "scripts", "test-release-mode-e2e.ps1"), "utf-8");

    expect(workflow).toContain("name: Release Mode E2E");
    expect(workflow).toContain(".\\scripts\\test-release-mode-e2e.ps1");
    expect(workflow).toContain("-EvidenceDir \"release/release-mode-e2e\"");
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
