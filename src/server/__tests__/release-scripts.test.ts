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
});
