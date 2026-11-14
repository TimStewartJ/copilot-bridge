// Guard for the "Agent output" rule in AGENTS.md: the Bridge never decides anything from the words
// a model wrote. It flags, in production code, regex literals that match natural-language words and
// multi-word string literals used in includes/startsWith/endsWith/indexOf or ===/!==. Each match
// must say where the text it reads comes from, in a comment on its line or the line above:
//
//   // agent-text-audit: error (SQLite's corruption message)
//
// or, for a file whose only job is reading one kind of non-agent text, once near the top:
//
//   // agent-text-audit-file: tool-output (agent-browser CLI output)
//
// "agent" is never a valid source. The audit is partial on purpose: it cannot see needles held in
// variables, word sets, regexes built at run time, or single-word checks, so it backs up the rule
// and review rather than replacing them.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const TEXT_SOURCES = {
  "tool-output": "output of another program, a web page or an HTTP API",
  error: "an error message from the Bridge, the agent runtime, Node or the OS",
  "user-input": "what the user typed or said",
  "bridge-text": "text the Bridge itself wrote",
  format: "a defined format: URLs, ids, dates, file names, flags, markup",
  code: "source code or a script, matched for identifiers",
  search: "agent text used only as a search query, never to judge what it means",
} as const;

export type TextSource = keyof typeof TEXT_SOURCES;

export interface PhraseCheck {
  line: number;
  literal: string;
  /** The source named by an exemption, when there is a valid one. */
  source?: TextSource;
  /** Why the exemption is not accepted, when there is one. */
  invalid?: string;
}

const LINE_DIRECTIVE = "agent-text-audit:";
const FILE_DIRECTIVE = "agent-text-audit-file:";
const LINE_DIRECTIVE_COMMENT = /(?:\/\/|\/\*)\s*agent-text-audit:/;
const SKIPPED_PATH = /(?:^|[\\/])(?:__tests__|test-support|node_modules)[\\/]|\.(?:test|spec)\.tsx?$|\.d\.ts$/;
const COMPARISON_TOKENS = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);
const SEARCH_METHODS = new Set(["includes", "startsWith", "endsWith", "indexOf", "lastIndexOf"]);

/** Whether a regex's source matches words of a natural language rather than a format. */
export function regexMatchesWords(source: string, flags: string): boolean {
  const plain = source.replace(/\[[^\]]*\]/g, "#");
  // Two words with a space between them: a phrase.
  if (/[A-Za-z]{2,}(?: |\\s[+*?]?)+[A-Za-z]{2,}/.test(plain)) return true;
  const words = plain
    .replace(/\\[pPu]\{[^}]*\}/g, "#")
    .replace(/\\[bBsSdDwWnrt]/g, " ")
    .replace(/\\./g, "#")
    .replace(/\(\?(?:[:=!]|<[=!])/g, "(");
  // Alternatives that are each a plain word, such as (done|finished): a word list.
  const alternatives = words.split(/[()|]/).map((part) => part.replace(/[?*+^$]/g, "").trim()).filter(Boolean);
  // Words as people write them; ALL-CAPS codes and snake_case names are identifiers.
  const wordAlternatives = /_/.test(source) ? [] : alternatives.filter((part) => /^[A-Za-z][a-z]{2,}$/.test(part));
  // Paths, URLs, extensions and prefixes such as type: are formats, whatever words they list.
  const format = /\\\/|\\\.|:/.test(source.replace(/\(\?(?:[:=!]|<[=!])/g, "("));
  if (!format && /\|/.test(words) && wordAlternatives.length >= 2) return true;
  // A case-insensitive whole word, such as /\bwaiting\b/i.
  return flags.includes("i") && /\\b[A-Za-z]{3,}/.test(source) && !/[\\/:.]/.test(source.replace(/\\[bsdw]/g, ""));
}

function isPhrase(text: string): boolean {
  return /[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(text);
}

function parseSource(comment: string, directive: string): { source?: TextSource; invalid?: string } {
  const rest = comment.slice(comment.indexOf(directive) + directive.length).trim();
  const name = /^[a-z]+(?:-[a-z]+)*/.exec(rest)?.[0] ?? "";
  if (!name) return { invalid: `${directive} needs a source: ${Object.keys(TEXT_SOURCES).join(", ")}` };
  if (name === "agent") return { invalid: "text a model wrote must not be matched against words; use a structured signal" };
  if (!Object.hasOwn(TEXT_SOURCES, name)) return { invalid: `unknown source "${name}"; use one of ${Object.keys(TEXT_SOURCES).join(", ")}` };
  return { source: name as TextSource };
}

/** Finds the word and phrase checks in one file, with the exemption each one carries. */
export function findPhraseChecks(fileName: string, text: string): PhraseCheck[] {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lines = text.split(/\r?\n/);
  const fileDirective = lines.slice(0, 40).find((line) => line.trimStart().startsWith(`// ${FILE_DIRECTIVE}`));
  const fileExemption = fileDirective ? parseSource(fileDirective, FILE_DIRECTIVE) : undefined;
  const checks: PhraseCheck[] = [];
  const record = (node: ts.Node, literal: string) => {
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line;
    const comment = [lines[line], lines[line - 1]].find((candidate) => candidate !== undefined && LINE_DIRECTIVE_COMMENT.test(candidate));
    const exemption = comment ? parseSource(comment, LINE_DIRECTIVE) : fileExemption;
    checks.push({ line: line + 1, literal: literal.slice(0, 120), ...exemption });
  };
  const visit = (node: ts.Node) => {
    if (ts.isRegularExpressionLiteral(node)) {
      const match = /^\/(.*)\/([a-z]*)$/s.exec(node.text);
      if (match && regexMatchesWords(match[1]!, match[2]!)) record(node, node.text);
    } else if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && isPhrase(node.text)) {
      const parent = node.parent;
      const searched = ts.isCallExpression(parent) && parent.arguments[0] === node
        && ts.isPropertyAccessExpression(parent.expression) && SEARCH_METHODS.has(parent.expression.name.text);
      const compared = ts.isBinaryExpression(parent) && COMPARISON_TOKENS.has(parent.operatorToken.kind);
      if (searched || compared) record(node, node.getText(sourceFile));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return checks;
}

function collectFiles(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (SKIPPED_PATH.test(path + (entry.isDirectory() ? "/" : ""))) continue;
    if (entry.isDirectory()) collectFiles(path, files);
    else if (/\.tsx?$/.test(entry.name)) files.push(path);
  }
  return files;
}

export function auditAgentText(rootDir = REPO_ROOT): { scannedFiles: number; failures: string[] } {
  const files = collectFiles(join(rootDir, "src"));
  const failures: string[] = [];
  for (const file of files) {
    const path = relative(rootDir, file).split("\\").join("/");
    for (const check of findPhraseChecks(file, readFileSync(file, "utf8"))) {
      if (check.source) continue;
      failures.push(`${path}:${check.line}  ${check.literal}\n    ${check.invalid ?? "say where this text comes from with an agent-text-audit comment, or decide from a structured signal"}`);
    }
  }
  return { scannedFiles: files.length, failures };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { scannedFiles, failures } = auditAgentText();
  if (failures.length > 0) {
    console.error(`Agent text audit: ${failures.length} unexplained word or phrase checks (see "Agent output" in AGENTS.md).\n`);
    console.error(failures.join("\n"));
    process.exit(1);
  }
  console.log(`Agent text audit passed (${scannedFiles} files).`);
}
