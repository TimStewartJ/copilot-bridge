// Guard for "Comments" in AGENTS.md: one line each, at most 100 columns, with code between two.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const MAX_COMMENT_LINE_COLUMNS = 100;
const SOURCE_FILE = /\.(?:tsx?|[cm]?js)$/;
const SKIPPED_DIRS = new Set(["node_modules", "dist", "coverage", ".git"]);
const SCANNED_ROOTS = ["src", "scripts", "public"];
// Tool directives: they count toward line length, but may sit next to other comments.
const DIRECTIVE = /^(?:@ts-|agent-text-audit|xplat-audit-ignore|design-audit-ignore|@vitest-environment|<reference |[#@]__PURE__|@vite-ignore|c8 |istanbul |eslint|prettier-ignore)/;

export interface CommentProblem {
  line: number;
  problem: "too-long" | "multi-line" | "stacked";
}

interface CommentRange {
  pos: number;
  end: number;
  directive: boolean;
}

function scriptKind(fileName: string): ts.ScriptKind {
  if (fileName.endsWith(".tsx")) return ts.ScriptKind.TSX;
  return fileName.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS;
}

function collectComments(sourceFile: ts.SourceFile): CommentRange[] {
  const text = sourceFile.text;
  const byPos = new Map<number, ts.CommentRange>();
  const jsxText: Array<[number, number]> = [];
  const add = (ranges: ts.CommentRange[] | undefined) => ranges?.forEach((range) => byPos.set(range.pos, range));
  const visit = (node: ts.Node) => {
    if (node.kind === ts.SyntaxKind.JsxText) jsxText.push([node.pos, node.end]);
    add(ts.getLeadingCommentRanges(text, node.getFullStart()));
    add(ts.getTrailingCommentRanges(text, node.getEnd()));
    node.getChildren(sourceFile).forEach(visit);
  };
  visit(sourceFile);
  // Comment-like prose inside JSX text is text, not a comment.
  const inJsxText = (pos: number) => jsxText.some(([start, end]) => pos >= start && pos < end);
  return [...byPos.values()]
    .filter((range) => !inJsxText(range.pos))
    .sort((a, b) => a.pos - b.pos)
    .map((range) => {
      const body = text.slice(range.pos + 2, range.end).replace(/^\*+|\*\/$/g, "").trim();
      return { pos: range.pos, end: range.end, directive: DIRECTIVE.test(body) };
    });
}

/** Finds the comments in one file that break the one-line comment rule. */
export function findCommentProblems(fileName: string, text: string): CommentProblem[] {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKind(fileName));
  const lines = text.split(/\r?\n/);
  const lineOf = (pos: number) => sourceFile.getLineAndCharacterOfPosition(pos).line;
  const problems: CommentProblem[] = [];
  const commentLines = new Map<number, CommentRange[]>();
  for (const comment of collectComments(sourceFile)) {
    const first = lineOf(comment.pos);
    const last = lineOf(comment.end);
    if (last > first) problems.push({ line: first + 1, problem: "multi-line" });
    for (let line = first; line <= last; line++) commentLines.set(line, [...(commentLines.get(line) ?? []), comment]);
  }
  let previousComment: number | undefined;
  let endsInComment: number | undefined;
  for (let line = 0; line < lines.length; line++) {
    const comments = commentLines.get(line);
    const lineText = lines[line]!;
    if (comments && [...lineText].length > MAX_COMMENT_LINE_COLUMNS) problems.push({ line: line + 1, problem: "too-long" });
    if (!lineText.trim()) continue;
    const start = sourceFile.getLineStarts()[line]!;
    let rest = lineText;
    for (const comment of [...(comments ?? [])].reverse()) {
      rest = rest.slice(0, Math.max(0, comment.pos - start)) + rest.slice(Math.max(0, comment.end - start));
    }
    const commentOnly = comments !== undefined && /^\s*(?:\{\s*\})?\s*$/.test(rest);
    const prose = (comments ?? []).filter((comment) => !comment.directive && lineOf(comment.pos) === line);
    if (prose.length > 1) problems.push({ line: line + 1, problem: "stacked" });
    if (!commentOnly) {
      const last = prose.at(-1);
      endsInComment = last !== undefined && !text.slice(last.end, start + lineText.length).trim() ? line : undefined;
      previousComment = undefined;
      continue;
    }
    if (comments.every((comment) => comment.directive)) continue;
    const underComment = previousComment !== undefined || endsInComment === line - 1;
    if (underComment && prose.length > 0) {
      problems.push({ line: line + 1, problem: "stacked" });
    }
    previousComment = line;
  }
  return problems.sort((a, b) => a.line - b.line);
}

function collectFiles(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(path, files);
    else if (SOURCE_FILE.test(entry.name)) files.push(path);
  }
  return files;
}

const PROBLEM_TEXT: Record<CommentProblem["problem"], string> = {
  "too-long": `comment line over ${MAX_COMMENT_LINE_COLUMNS} columns`,
  "multi-line": "comment spans several lines",
  stacked: "comment follows another comment with no code between",
};

export function auditComments(rootDir = REPO_ROOT): { scannedFiles: number; failures: string[] } {
  const files = SCANNED_ROOTS.flatMap((root) => collectFiles(join(rootDir, root)));
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    if (entry.isFile() && SOURCE_FILE.test(entry.name)) files.push(join(rootDir, entry.name));
  }
  const failures: string[] = [];
  for (const file of files) {
    const path = relative(rootDir, file).split("\\").join("/");
    for (const { line, problem } of findCommentProblems(file, readFileSync(file, "utf8"))) {
      failures.push(`${path}:${line}  ${PROBLEM_TEXT[problem]}`);
    }
  }
  return { scannedFiles: files.length, failures };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { scannedFiles, failures } = auditComments();
  if (failures.length > 0) {
    console.error(`Comment audit: ${failures.length} problems (see "Comments" in AGENTS.md).\n`);
    console.error(failures.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`Comment audit passed (${scannedFiles} files).`);
  }
}
