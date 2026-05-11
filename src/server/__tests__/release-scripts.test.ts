import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("release scripts", () => {
  it("preserves mutable directories and health-checks rollback after failed updates", () => {
    const script = readFileSync(join(process.cwd(), "scripts", "update-release.ps1"), "utf-8");

    expect(script).toContain("mutableDirectoriesPreservedOnRollback");
    expect(script).toContain("Preserving mutable data/config directories after failed update");
    expect(script).toContain("Wait-BridgeHealth -TimeoutSeconds 60");
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
});
