import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("release scripts", () => {
  it("preserves mutable directories and health-checks rollback after failed updates", () => {
    const script = readFileSync(join(process.cwd(), "scripts", "update-release.ps1"), "utf-8");

    expect(script).toContain("mutableDirectoriesPreservedOnRollback");
    expect(script).toContain("Preserving mutable data/config directories after failed update");
    expect(script).toContain("Wait-BridgeHealth -TimeoutSeconds 60");
    expect(script).toContain("function Remove-PathWithRetry");
    expect(script).toContain("Timed out waiting to remove $Path");
    expect(script).toContain("Copy-DirectoryTree $appBackup $appDir");
    expect(script).toContain('Write-UpdateStatus "rollback_failed" $rollbackMessage $true');
    expect(script).not.toMatch(/foreach\s*\(\$entry\s+in\s+\$backupEntries\)\s*\{\s*Restore-BackupEntry\s+\$entry\s*\}/s);
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

  it("does not stop the active updater when stopping release processes", () => {
    const script = readFileSync(join(process.cwd(), "scripts", "stop-release.ps1"), "utf-8");

    expect(script).toContain("$updaterProcessPattern");
    expect(script).toContain("function Test-ReleaseUpdaterProcess");
    expect(script).toContain("function Add-ProcessTree($Process, [bool]$RequireReleaseInstallProcess = $true)");
    expect(script).toContain("Add-ProcessTree $child $false");
    expect(script).toContain("if (Test-ReleaseUpdaterProcess $Process)");
    expect(script).toContain("-not (Test-ReleaseUpdaterProcess $_)");
    expect(script).toContain("$stoppedProcessIds");
    expect(script).toContain("Timed out waiting for stopped Bridge process IDs to exit");
  });
});
