// xplat-audit-ignore-file: this suite embeds intentionally bad fixture strings.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { auditCrossPlatformTests, formatCrossPlatformAuditResult } from "../xplat-test-audit.js";

describe("cross-platform test audit", () => {
  let rootDir: string;
  let srcDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "bridge-xplat-audit-"));
    srcDir = join(rootDir, "src");
    mkdirSync(srcDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("reports known Unix-only bridge test patterns", () => {
    writeFileSync(
      join(srcDir, "bad.test.ts"),
      [
        'const tempPath = "/tmp/bridge";',
        'const cliPath = "/usr/bin/devtunnel";',
        'it.skipIf(isWindows)("portable", () => {});',
        'chmodSync(tempPath, 0o000);',
      ].join("\n"),
    );

    const result = auditCrossPlatformTests(rootDir);

    expect(result.scannedFiles).toBe(1);
    expect(result.violations.map((violation) => violation.ruleId)).toEqual([
      "unix-temp-path",
      "unix-bin-path",
      "windows-skip",
      "unix-chmod",
    ]);
    expect(formatCrossPlatformAuditResult(result)).toContain("bad.test.ts:3");
  });

  it("scans helper modules under __tests__ and ignores comment-only matches", () => {
    const helperDir = join(srcDir, "server", "__tests__");
    mkdirSync(helperDir, { recursive: true });
    writeFileSync(
      join(helperDir, "helper.ts"),
      [
        '// fixture text can mention "/tmp/ignored" without triggering the audit',
        'export const tempPath = "/tmp/helper";',
      ].join("\n"),
    );

    const result = auditCrossPlatformTests(rootDir);

    expect(result.scannedFiles).toBe(1);
    expect(result.violations.map((violation) => violation.ruleId)).toEqual(["unix-temp-path"]);
    expect(formatCrossPlatformAuditResult(result)).toContain("server/__tests__/helper.ts:2");
  });

  it("ignores non-test files, portable helper usage, and suppressed fixture lines", () => {
    writeFileSync(
      join(srcDir, "good.test.ts"),
      [
        'const cliPath = testExecutablePath("devtunnel");',
        'const home = testPath("a", "b");',
        'expect(stderr).toContain("/tmp/example"); // xplat-audit-ignore-line',
        '// xplat-audit-ignore-next-line',
        'expect(cliPath).toContain("/usr/bin/devtunnel");',
      ].join("\n"),
    );
    writeFileSync(join(srcDir, "ignored.ts"), 'const tempPath = "/tmp/not-a-test";\n');

    const result = auditCrossPlatformTests(rootDir);

    expect(result.scannedFiles).toBe(1);
    expect(result.violations).toEqual([]);
    expect(formatCrossPlatformAuditResult(result)).toContain("passed");
  });

  it("only honors suppression directives when they appear in comments", () => {
    writeFileSync(
      join(srcDir, "directive-string.test.ts"),
      [
        'expect(message).toContain("xplat-audit-ignore-file");',
        'expect(message).toContain("xplat-audit-ignore-next-line");',
        "const fixture = `",
        "// xplat-audit-ignore-file",
        "`;",
        'const tempPath = "/tmp/bridge";',
      ].join("\n"),
    );

    const result = auditCrossPlatformTests(rootDir);

    expect(result.scannedFiles).toBe(1);
    expect(result.violations.map((violation) => violation.ruleId)).toEqual(["unix-temp-path"]);
  });

  it("honors block-comment suppression directives", () => {
    writeFileSync(
      join(srcDir, "block-directives.test.ts"),
      [
        "/*",
        " * xplat-audit-ignore-next-line",
        " */",
        'const cliPath = "/usr/bin/devtunnel";',
      ].join("\n"),
    );
    writeFileSync(
      join(srcDir, "block-file-ignore.test.ts"),
      [
        "/*",
        " * xplat-audit-ignore-file",
        " */",
        'const tempPath = "/tmp/bridge";',
      ].join("\n"),
    );

    const result = auditCrossPlatformTests(rootDir);

    expect(result.scannedFiles).toBe(2);
    expect(result.violations).toEqual([]);
  });
});
