// xplat-audit-ignore-file: this suite embeds intentionally bad fixture strings.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  auditCrossPlatformTests,
  formatCrossPlatformAuditResult,
  type CrossPlatformAuditResult,
} from "../xplat-test-audit.js";

describe("cross-platform test audit", () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "bridge-xplat-audit-"));
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  /** Writes each fixture under src/ (relative paths may include subfolders) and audits the tree. */
  function audit(files: Record<string, string[]>): CrossPlatformAuditResult {
    for (const [file, lines] of Object.entries(files)) {
      const path = join(rootDir, "src", ...file.split("/"));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, lines.join("\n"));
    }
    return auditCrossPlatformTests(rootDir);
  }

  const ruleIds = (result: CrossPlatformAuditResult, advisory?: boolean) => result.violations
    .filter((v) => advisory === undefined || Boolean(v.advisory) === advisory)
    .map((v) => v.ruleId);

  it("reports known Unix-only bridge test patterns and formats results with file paths", () => {
    const result1 = audit({
      "bad.test.ts": [
        'const tempPath = "/tmp/bridge";',
        'const cliPath = "/usr/bin/devtunnel";',
        'it.skipIf(isWindows)("portable", () => {});',
        'chmodSync(tempPath, 0o000);',
      ],
    });

    expect(result1.scannedFiles).toBe(1);
    expect(ruleIds(result1)).toEqual(["unix-temp-path", "unix-bin-path", "windows-skip", "unix-chmod"]);
    expect(formatCrossPlatformAuditResult(result1)).toContain("bad.test.ts:3");

    // Helper modules under __tests__ are scanned; comment-only matches are ignored
    rmSync(join(rootDir, "src", "bad.test.ts"));
    const result2 = audit({
      "server/__tests__/helper.ts": [
        '// fixture text can mention "/tmp/ignored" without triggering the audit',
        'export const tempPath = "/tmp/helper";',
      ],
    });

    expect(result2.scannedFiles).toBe(1);
    expect(ruleIds(result2)).toEqual(["unix-temp-path"]);
    expect(formatCrossPlatformAuditResult(result2)).toContain("server/__tests__/helper.ts:2");
  });

  it("ignores non-test files, portable helper usage, and suppressed fixture lines", () => {
    const result = audit({
      "good.test.ts": [
        'const cliPath = testExecutablePath("devtunnel");',
        'const home = testPath("a", "b");',
        'expect(stderr).toContain("/tmp/example"); // xplat-audit-ignore-line',
        '// xplat-audit-ignore-next-line',
        'expect(cliPath).toContain("/usr/bin/devtunnel");',
      ],
      "ignored.ts": ['const tempPath = "/tmp/not-a-test";', ""],
    });

    expect(result.scannedFiles).toBe(1);
    expect(result.violations).toEqual([]);
    expect(formatCrossPlatformAuditResult(result)).toContain("passed");
  });

  it("only honors suppression directives when they appear in comments", () => {
    const result = audit({
      "directive-string.test.ts": [
        'expect(message).toContain("xplat-audit-ignore-file");',
        'expect(message).toContain("xplat-audit-ignore-next-line");',
        "const fixture = `",
        "// xplat-audit-ignore-file",
        "`;",
        'const tempPath = "/tmp/bridge";',
      ],
    });

    expect(result.scannedFiles).toBe(1);
    expect(ruleIds(result)).toEqual(["unix-temp-path"]);
  });

  it("honors block-comment suppression directives", () => {
    const result = audit({
      "block-directives.test.ts": ["/*", " * xplat-audit-ignore-next-line", " */", 'const cliPath = "/usr/bin/devtunnel";'],
      "block-file-ignore.test.ts": ["/*", " * xplat-audit-ignore-file", " */", 'const tempPath = "/tmp/bridge";'],
    });

    expect(result.scannedFiles).toBe(2);
    expect(result.violations).toEqual([]);
  });

  it("reports raw-process-env-mutation for direct assignment and deletion", () => {
    const result = audit({
      "env-mutation.test.ts": [
        'process.env.BRIDGE_DATA_DIR = "bad-value";',
        "delete process.env.COPILOT_HOME;",
        'const val = process.env.NODE_ENV; // read-only — ok',
        'if (process.env.NODE_ENV === "test") {} // comparison — ok',
      ],
    });

    expect(result.scannedFiles).toBe(1);
    expect(ruleIds(result, false)).toEqual(["raw-process-env-mutation", "raw-process-env-mutation"]);
    expect(ruleIds(result, true)).toEqual([]);
  });

  it("does not report raw-process-env-mutation when suppressed", () => {
    const result = audit({
      "env-suppressed.test.ts": [
        'process.env.BRIDGE_DATA_DIR = "ok"; // xplat-audit-ignore-line',
        "// xplat-audit-ignore-next-line",
        "delete process.env.COPILOT_HOME;",
      ],
    });

    expect(result.violations).toEqual([]);
  });

  it("reports real-command-in-test for execSync/execFileSync with npm/npx/vite/tsc", () => {
    const result = audit({
      "real-exec.test.ts": [
        'execSync("npm install --prefix .");',
        "execFileSync('npx', ['vite', 'build']);",
        "execSync(`vite build`);",
        'execSync("tsc --noEmit");',
        "// mocked usage is fine:",
        "const execSyncMock = vi.fn();",
        "execSyncMock.mockReturnValue('');",
        'execSync("git commit -m msg"); // git is not in the blocked list',
      ],
    });

    expect(result.scannedFiles).toBe(1);
    expect(ruleIds(result, false)).toEqual(Array(4).fill("real-command-in-test"));
    expect(ruleIds(result, true)).toEqual([]);
  });

  it("reports repo-runtime-path as advisory for join(process.cwd(), 'data'|'dist'|'.test-data')", () => {
    const result = audit({
      "cwd-path.test.ts": [
        'const bad = join(process.cwd(), "data", "store.db");',
        'const bad2 = join(process.cwd(), "dist", "staging");',
        'const bad3 = join(process.cwd(), ".test-data", "foo");',
        '// read-only reference is fine:',
        'expect(dir.startsWith(process.cwd())).toBe(false);',
      ],
    });

    expect(result.scannedFiles).toBe(1);
    expect(ruleIds(result, true)).toEqual(Array(3).fill("repo-runtime-path"));
    expect(ruleIds(result, false)).toEqual([]);
  });

  it("reports destructive repo-runtime-path cleanup as a hard failure", () => {
    const result = audit({
      "destructive-cwd-path.test.ts": [
        'rmSync(join(process.cwd(), "dist", "staging"), { recursive: true, force: true });',
        'rmdirSync(join(process.cwd(), "data"), { recursive: true });',
      ],
    });

    expect(result.scannedFiles).toBe(1);
    expect(ruleIds(result, false)).toEqual(Array(2).fill("destructive-repo-runtime-path"));
    expect(ruleIds(result, true)).toEqual(Array(2).fill("repo-runtime-path"));
  });

  it("reports direct-mkdtemp as advisory", () => {
    const result = audit({
      "mkdtemp.test.ts": [
        "const dir = mkdtempSync(join(tmpdir(), 'bridge-test-'));",
        "const dir2 = mkdtempSync(join(tmpdir(), 'bridge-other-'));",
      ],
    });

    expect(result.scannedFiles).toBe(1);
    expect(ruleIds(result, true)).toEqual(Array(2).fill("direct-mkdtemp"));
    expect(ruleIds(result, false)).toEqual([]);
  });

  it("formatCrossPlatformAuditResult separates hard and advisory violations", () => {
    const output = formatCrossPlatformAuditResult(audit({
      "mixed.test.ts": [
        'process.env.X = "bad"; // hard violation',
        'const dir = mkdtempSync(join(tmpdir(), "x-")); // advisory',
      ],
    }));

    expect(output).toContain("failed with 1 violation");
    expect(output).toContain("raw-process-env-mutation");
    expect(output).toContain("advisory finding");
    expect(output).toContain("direct-mkdtemp");
  });

  it("formatCrossPlatformAuditResult shows passed with advisory-only findings", () => {
    const output = formatCrossPlatformAuditResult(audit({
      "advisory-only.test.ts": ['const dir = mkdtempSync(join(tmpdir(), "x-"));'],
    }));

    expect(output).toContain("passed");
    expect(output).toContain("advisory finding");
    expect(output).not.toContain("failed");
  });
});
