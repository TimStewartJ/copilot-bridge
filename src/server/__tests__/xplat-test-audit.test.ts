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

  it("reports raw-process-env-mutation for direct assignment and deletion", () => {
    writeFileSync(
      join(srcDir, "env-mutation.test.ts"),
      [
        'process.env.BRIDGE_DATA_DIR = "bad-value";',
        "delete process.env.COPILOT_HOME;",
        'const val = process.env.NODE_ENV; // read-only — ok',
        'if (process.env.NODE_ENV === "test") {} // comparison — ok',
      ].join("\n"),
    );

    const result = auditCrossPlatformTests(rootDir);

    expect(result.scannedFiles).toBe(1);
    expect(result.violations.map((v) => v.ruleId)).toEqual([
      "raw-process-env-mutation",
      "raw-process-env-mutation",
    ]);
    expect(result.violations.every((v) => !v.advisory)).toBe(true);
  });

  it("does not report raw-process-env-mutation when suppressed", () => {
    writeFileSync(
      join(srcDir, "env-suppressed.test.ts"),
      [
        'process.env.BRIDGE_DATA_DIR = "ok"; // xplat-audit-ignore-line',
        "// xplat-audit-ignore-next-line",
        "delete process.env.COPILOT_HOME;",
      ].join("\n"),
    );

    const result = auditCrossPlatformTests(rootDir);

    expect(result.violations).toEqual([]);
  });

  it("reports real-command-in-test for execSync/execFileSync with npm/npx/vite/tsc", () => {
    writeFileSync(
      join(srcDir, "real-exec.test.ts"),
      [
        'execSync("npm install --prefix .");',
        "execFileSync('npx', ['vite', 'build']);",
        "execSync(`vite build`);",
        'execSync("tsc --noEmit");',
        "// mocked usage is fine:",
        "const execSyncMock = vi.fn();",
        "execSyncMock.mockReturnValue('');",
        'execSync("git commit -m msg"); // git is not in the blocked list',
      ].join("\n"),
    );

    const result = auditCrossPlatformTests(rootDir);

    expect(result.scannedFiles).toBe(1);
    const ids = result.violations.map((v) => v.ruleId);
    expect(ids).toEqual([
      "real-command-in-test",
      "real-command-in-test",
      "real-command-in-test",
      "real-command-in-test",
    ]);
    expect(result.violations.every((v) => !v.advisory)).toBe(true);
  });

  it("reports repo-runtime-path as advisory for join(process.cwd(), 'data'|'dist'|'.test-data')", () => {
    writeFileSync(
      join(srcDir, "cwd-path.test.ts"),
      [
        'const bad = join(process.cwd(), "data", "store.db");',
        'const bad2 = join(process.cwd(), "dist", "staging");',
        'const bad3 = join(process.cwd(), ".test-data", "foo");',
        '// read-only reference is fine:',
        'expect(dir.startsWith(process.cwd())).toBe(false);',
      ].join("\n"),
    );

    const result = auditCrossPlatformTests(rootDir);

    expect(result.scannedFiles).toBe(1);
    const advisoryViolations = result.violations.filter((v) => v.advisory);
    expect(advisoryViolations.map((v) => v.ruleId)).toEqual([
      "repo-runtime-path",
      "repo-runtime-path",
      "repo-runtime-path",
    ]);
    expect(result.violations.filter((v) => !v.advisory)).toEqual([]);
  });

  it("reports direct-mkdtemp as advisory", () => {
    writeFileSync(
      join(srcDir, "mkdtemp.test.ts"),
      [
        "const dir = mkdtempSync(join(tmpdir(), 'bridge-test-'));",
        "const dir2 = mkdtempSync(join(tmpdir(), 'bridge-other-'));",
      ].join("\n"),
    );

    const result = auditCrossPlatformTests(rootDir);

    expect(result.scannedFiles).toBe(1);
    const advisoryViolations = result.violations.filter((v) => v.advisory);
    expect(advisoryViolations.map((v) => v.ruleId)).toEqual([
      "direct-mkdtemp",
      "direct-mkdtemp",
    ]);
    expect(result.violations.filter((v) => !v.advisory)).toEqual([]);
  });

  it("formatCrossPlatformAuditResult separates hard and advisory violations", () => {
    writeFileSync(
      join(srcDir, "mixed.test.ts"),
      [
        'process.env.X = "bad"; // hard violation',
        'const dir = mkdtempSync(join(tmpdir(), "x-")); // advisory',
      ].join("\n"),
    );

    const result = auditCrossPlatformTests(rootDir);
    const output = formatCrossPlatformAuditResult(result);

    expect(output).toContain("failed with 1 violation");
    expect(output).toContain("raw-process-env-mutation");
    expect(output).toContain("advisory finding");
    expect(output).toContain("direct-mkdtemp");
  });

  it("formatCrossPlatformAuditResult shows passed with advisory-only findings", () => {
    writeFileSync(
      join(srcDir, "advisory-only.test.ts"),
      [
        'const dir = mkdtempSync(join(tmpdir(), "x-"));',
      ].join("\n"),
    );

    const result = auditCrossPlatformTests(rootDir);
    const output = formatCrossPlatformAuditResult(result);

    expect(output).toContain("passed");
    expect(output).toContain("advisory finding");
    expect(output).not.toContain("failed");
  });
});
