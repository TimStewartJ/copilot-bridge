import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx)$/;
const TEST_SUPPORT_FILE_RE = /\.(ts|tsx)$/;
const FILE_IGNORE_DIRECTIVE = "xplat-audit-ignore-file";
const NEXT_LINE_IGNORE_DIRECTIVE = "xplat-audit-ignore-next-line";
const LINE_IGNORE_DIRECTIVE = "xplat-audit-ignore-line";

interface CommentSpan {
  start: number;
  end: number;
  text: string;
  startLine: number;
  endLine: number;
}

export interface CrossPlatformTestRule {
  id: string;
  pattern: RegExp;
  message: string;
  /** When true, violations are reported as warnings but do not fail the audit. */
  advisory?: boolean;
}

export interface CrossPlatformTestViolation {
  ruleId: string;
  filePath: string;
  lineNumber: number;
  message: string;
  snippet: string;
  advisory?: boolean;
}

export interface CrossPlatformAuditResult {
  rootDir: string;
  scannedFiles: number;
  violations: CrossPlatformTestViolation[];
}

export const CROSS_PLATFORM_TEST_RULES: ReadonlyArray<CrossPlatformTestRule> = [
  {
    id: "unix-temp-path",
    pattern: /["'`]\/tmp\//,
    message: "Use mkdtempSync(tmpdir()) or shared test-path helpers instead of hardcoded /tmp paths.",
  },
  {
    id: "unix-bin-path",
    pattern: /["'`](?:\/usr\/bin\/|\/bin\/)/,
    message: "Use testExecutablePath() or behavior-level assertions instead of hardcoded Unix binary paths.",
  },
  {
    id: "windows-skip",
    pattern: /\bskipIf\(isWindows\)/,
    message: "Fix the portability issue instead of skipping Windows in bridge tests.",
  },
  {
    id: "unix-chmod",
    pattern: /\bchmodSync\(/,
    message: "Mock read/stat failures instead of relying on Unix-only chmod semantics.",
  },
  {
    id: "raw-process-env-mutation",
    pattern: /(?:process\.env\.[A-Z_][A-Z0-9_]*\s*=(?!=)|delete\s+process\.env\.)/,
    message:
      "Use vi.stubEnv() or withTestEnv() for scoped env mutations instead of direct process.env assignment or deletion.",
  },
  {
    id: "real-command-in-test",
    pattern: /\b(?:execSync|execFileSync)\s*\(\s*["'`](?:npm|npx|vite|tsc)["'`\s]/,
    message:
      "Tests must not shell out to npm, npx, vite, or tsc. Mock the exec call or test behavior through the module API.",
  },
  {
    id: "repo-runtime-path",
    // Catches join(process.cwd(), "data"|".test-data"|"dist") — writing to repo-local runtime dirs in tests.
    pattern: /join\s*\(\s*process\.cwd\s*\(\s*\)\s*,\s*["'`](?:data|\.test-data|dist)["'`]/,
    message:
      "Use makeTestDir() or makeTestRuntimePaths() instead of repo-local runtime paths derived from process.cwd().",
    advisory: true,
  },
  {
    id: "direct-mkdtemp",
    // Advisory until all suites have been migrated to the shared makeTestDir() helper.
    pattern: /\bmkdtempSync\s*\(/,
    message:
      "Prefer makeTestDir() from the shared test helpers over raw mkdtempSync() so cleanup is automatic.",
    advisory: true,
  },
];

function isAuditedTestFile(filePath: string): boolean {
  if (TEST_FILE_RE.test(filePath)) return true;
  return TEST_SUPPORT_FILE_RE.test(filePath) && filePath.split(/[/\\]/).includes("__tests__");
}

function collectTestFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTestFiles(fullPath));
      continue;
    }
    if (isAuditedTestFile(fullPath)) {
      files.push(fullPath);
    }
  }
  return files;
}

function getScanRoot(rootDir: string): string {
  const srcDir = join(rootDir, "src");
  return existsSync(srcDir) ? srcDir : rootDir;
}

function collectCommentSpans(filePath: string, content: string): CommentSpan[] {
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, false);
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, content);
  const spans: CommentSpan[] = [];

  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token !== ts.SyntaxKind.SingleLineCommentTrivia && token !== ts.SyntaxKind.MultiLineCommentTrivia) {
      continue;
    }
    const start = scanner.getTokenPos();
    const end = scanner.getTextPos();
    spans.push({
      start,
      end,
      text: content.slice(start, end),
      startLine: sourceFile.getLineAndCharacterOfPosition(start).line,
      endLine: sourceFile.getLineAndCharacterOfPosition(end).line,
    });
  }

  return spans;
}

function maskCommentContent(content: string, comments: CommentSpan[]): string {
  let masked = "";
  let cursor = 0;
  for (const comment of comments) {
    masked += content.slice(cursor, comment.start);
    masked += content.slice(comment.start, comment.end).replace(/[^\r\n]/g, " ");
    cursor = comment.end;
  }
  masked += content.slice(cursor);
  return masked;
}

function normalizeCommentDirectiveLine(line: string): string {
  return line.trim()
    .replace(/^\/\//, "")
    .replace(/^\/\*+/, "")
    .replace(/^\*+/, "")
    .replace(/\*\/$/, "")
    .trim();
}

function commentHasDirective(commentText: string, directive: string): boolean {
  return commentText
    .split(/\r?\n/)
    .some((line) => normalizeCommentDirectiveLine(line).startsWith(directive));
}

export function auditCrossPlatformTests(rootDir = REPO_ROOT): CrossPlatformAuditResult {
  const resolvedRoot = resolve(rootDir);
  const scanRoot = getScanRoot(resolvedRoot);
  const testFiles = existsSync(scanRoot) ? collectTestFiles(scanRoot) : [];
  const violations: CrossPlatformTestViolation[] = [];

  for (const filePath of testFiles) {
    const content = readFileSync(filePath, "utf-8");
    const comments = collectCommentSpans(filePath, content);
    if (comments.some((comment) => commentHasDirective(comment.text, FILE_IGNORE_DIRECTIVE))) continue;

    const lineIgnore = new Set<number>();
    const nextLineIgnore = new Set<number>();
    for (const comment of comments) {
      if (commentHasDirective(comment.text, LINE_IGNORE_DIRECTIVE)) lineIgnore.add(comment.startLine);
      if (commentHasDirective(comment.text, NEXT_LINE_IGNORE_DIRECTIVE)) nextLineIgnore.add(comment.endLine + 1);
    }

    const lines = maskCommentContent(content, comments).split(/\r?\n/);
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (!trimmed || lineIgnore.has(index) || nextLineIgnore.has(index)) {
        return;
      }
      for (const rule of CROSS_PLATFORM_TEST_RULES) {
        if (rule.pattern.test(line)) {
          violations.push({
            ruleId: rule.id,
            filePath,
            lineNumber: index + 1,
            message: rule.message,
            snippet: line.trim(),
            advisory: rule.advisory,
          });
        }
      }
    });
  }

  return {
    rootDir: resolvedRoot,
    scannedFiles: testFiles.length,
    violations,
  };
}

export function formatCrossPlatformAuditResult(result: CrossPlatformAuditResult): string {
  const hard = result.violations.filter((v) => !v.advisory);
  const advisory = result.violations.filter((v) => v.advisory);

  const lines: string[] = [];

  if (hard.length === 0) {
    lines.push(`Cross-platform test audit passed (${result.scannedFiles} test file(s) scanned).`);
  } else {
    lines.push(
      `Cross-platform test audit failed with ${hard.length} violation(s) across ${result.scannedFiles} test file(s):`,
      "",
    );
    for (const v of hard) {
      const displayPath = (relative(result.rootDir, v.filePath) || v.filePath).replaceAll("\\", "/");
      lines.push(`- [${v.ruleId}] ${displayPath}:${v.lineNumber} — ${v.message}`);
      lines.push(`  ${v.snippet || "<blank line>"}`);
    }
    lines.push("", "Fix the violations above or rewrite the test to use the shared x-plat helpers.");
  }

  if (advisory.length > 0) {
    lines.push(
      "",
      `${advisory.length} advisory finding(s) — will not fail the audit, but should be addressed:`,
      "",
    );
    for (const v of advisory) {
      const displayPath = (relative(result.rootDir, v.filePath) || v.filePath).replaceAll("\\", "/");
      lines.push(`- [${v.ruleId}] ${displayPath}:${v.lineNumber} — ${v.message}`);
      lines.push(`  ${v.snippet || "<blank line>"}`);
    }
  }

  return lines.join("\n");
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  return Boolean(entry) && resolve(entry) === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) {
  const rootArg = process.argv[2];
  const result = auditCrossPlatformTests(rootArg ? resolve(rootArg) : REPO_ROOT);
  const output = formatCrossPlatformAuditResult(result);
  const hardViolations = result.violations.filter((v) => !v.advisory);
  const stream = hardViolations.length === 0 ? process.stdout : process.stderr;
  stream.write(`${output}\n`);
  if (hardViolations.length > 0) process.exitCode = 1;
}
