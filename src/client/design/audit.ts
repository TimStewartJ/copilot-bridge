import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { DESIGN_AUDIT_PENDING } from "./audit-pending";

/**
 * Keeps screens on the design system. README.md in this folder holds the rules; this file turns the
 * ones a machine can check into a gate that runs in `check:fast` and `check:pr`.
 *
 * Every client source file is checked unless it is listed in audit-pending.ts, which names the
 * screens that have not been migrated yet. That list only shrinks: a new file is never added to it,
 * and a file that comes out clean has to be taken off it.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const CLIENT_ROOT = join("src", "client");
/** The system itself spells the recipes out, so the rules do not apply inside it. */
const DESIGN_DIR = join("src", "client", "design");
const SOURCE_FILE_RE = /\.(ts|tsx)$/;
const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx)$/;
const IGNORE_NEXT_LINE_RE = /design-audit-ignore-next-line:\s*\S/;

const TONES = "(?:accent|info|success|warning|error)";

export interface DesignRule {
  id: string;
  /** What the rule protects, and what to use instead. Shown with every violation. */
  message: string;
  matches: (line: string) => boolean;
}

export const DESIGN_RULES: ReadonlyArray<DesignRule> = [
  {
    id: "legacy-tokens",
    message: "Import class recipes from src/client/design, not the legacy shared/design-system tokens.",
    matches: (line) => /from\s+["'](?:[^"']*\/)?design-system(?:\.js)?["']/.test(line),
  },
  {
    id: "accent-fill",
    message: "Accent is never a fill. Use <Button variant=\"primary\"> for the one primary action, a neutral fill for selection, DS.badge for a state.",
    matches: (line) => /(?<![\w-])bg-accent(?!-surface)/.test(line),
  },
  {
    id: "white-on-fill",
    message: "White text belongs to a coloured fill, and the system has none. Use the Button variants or DS.badge.",
    matches: (line) => /(?<![\w-])text-white(?![\w-])/.test(line),
  },
  {
    id: "accent-outline",
    message: "Selection is a neutral fill (DS.row.selected, DS.segmented.selected, DS.choice.selected) and focus is DS.focus, not an accent border or ring.",
    matches: (line) => /(?<![\w-])(?:border|ring)-accent(?![\w])/.test(line) || /(?<![\w-])(?:border|ring)-accent-border/.test(line),
  },
  {
    id: "tinted-box",
    message: "A tinted box turns a whole section the colour of its state. Use <Notice>, which keeps the surface neutral and colours only the icon and title.",
    matches: (line) => new RegExp(`(?<![\\w-])border-${TONES}[-/]`).test(line) && new RegExp(`(?<![\\w-])bg-${TONES}[-/]`).test(line),
  },
  {
    id: "state-pill",
    message: "A state is a <Badge> (DS.badge), not a rounded-full pill. Dots and round icon buttons, which have no horizontal padding, are fine.",
    matches: (line) => /(?<![\w-])rounded-full(?![\w-])/.test(line) && /(?<![\w-])px-\d/.test(line),
  },
  {
    id: "dashed-empty",
    message: "Say an absent state once and quietly with <EmptyHint>, not with a dashed empty box.",
    matches: (line) => /(?<![\w-])border-dashed(?![\w-])/.test(line),
  },
  {
    id: "in-page-shadow",
    message: "In-page surfaces have no shadow. Something that floats uses DS.surface.floating or DS.surface.dialog.",
    matches: (line) => /(?<![\w-])shadow(?:-(?:xs|sm|md|lg|xl|2xl))?(?![\w-])/.test(line) && /className|["'`]/.test(line),
  },
  {
    id: "uppercase-label",
    message: "Capitals are kept for the label inside a detail panel. Use DS.text.eyebrow there and DS.text.sectionLabel everywhere else.",
    matches: (line) => /(?<![\w-])uppercase(?![\w-])/.test(line) && /className|["'`]/.test(line),
  },
];

export interface DesignViolation {
  ruleId: string;
  file: string;
  lineNumber: number;
  message: string;
  snippet: string;
}

export interface DesignAuditResult {
  rootDir: string;
  scannedFiles: number;
  /** Violations in files that are held to the system. Any of these fails the audit. */
  violations: DesignViolation[];
  /** Pending files that no longer exist or no longer break a rule, and so must leave the list. */
  stalePending: string[];
  pendingFiles: number;
}

function toPosix(path: string): string {
  return path.replaceAll("\\", "/");
}

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(fullPath, out);
    } else if (SOURCE_FILE_RE.test(entry.name) && !TEST_FILE_RE.test(entry.name)) {
      out.push(fullPath);
    }
  }
  return out;
}

export function findDesignViolations(file: string, content: string): DesignViolation[] {
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
  const rawLines = content.split(/\r?\n/);
  const violations = new Map<string, DesignViolation>();
  const panelNames = new Set(["Panel"]);

  const report = (ruleId: string, message: string, start: number, snippet: string) => {
    const line = source.getLineAndCharacterOfPosition(start).line;
    const preceding = rawLines[line - 1]?.trim() ?? "";
    if (/^(?:\/\/|\/\*|\{\/\*)/.test(preceding) && IGNORE_NEXT_LINE_RE.test(preceding)) return;
    violations.set(`${ruleId}:${line}`, {
      ruleId,
      file,
      lineNumber: line + 1,
      message,
      snippet: snippet.replace(/\s+/g, " ").trim().slice(0, 160),
    });
  };
  const isClassContext = (node: ts.Node): boolean => {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if ((ts.isJsxAttribute(parent) || ts.isPropertyAssignment(parent))
        && parent.name.getText(source) === "className") return true;
      if ((ts.isVariableDeclaration(parent) || ts.isFunctionDeclaration(parent))
        && parent.name && /class|style/i.test(parent.name.getText(source))) return true;
    }
    return false;
  };
  const checkText = (text: string, start: number, classContext = false) => {
    const flattened = text.replace(/\r?\n/g, " ");
    const hasRecipeTokens = /\b(?:text|font|tracking|rounded|border|bg|shadow|p[xy]?|m[xy]?|z)-(?:\w|\[)/.test(flattened);
    for (const rule of DESIGN_RULES) {
      // "A shadow" and "an uppercase letter" are also English. These two rules need a class
      // context or another utility, rather than banning ordinary prose in a screen's labels.
      if ((rule.id === "in-page-shadow" || rule.id === "uppercase-label") && !classContext && !hasRecipeTokens) continue;
      if (rule.matches(flattened)) report(rule.id, rule.message, start, text);
    }
  };

  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (/\/design(?:\/(?:primitives|index))?(?:\.js)?$/.test(statement.moduleSpecifier.text)
      && bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        if ((binding.propertyName ?? binding.name).text === "Panel") panelNames.add(binding.name.text);
      }
    }
  }

  const visit = (node: ts.Node, panelDepth = 0) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) checkText(`from ${node.moduleSpecifier.getText(source)}`, node.getStart(source));
    }

    // Parse literals, not lines: comments and slashes inside strings are unambiguous, and a
    // multiline recipe cannot hide a tinted box by splitting its border and fill across lines.
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      checkText(node.getText(source), node.getStart(source), isClassContext(node));
      return;
    }
    if (ts.isTemplateExpression(node)) {
      checkText(`"${[node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(" ")}"`, node.getStart(source), isClassContext(node));
      for (const span of node.templateSpans) visit(span.expression, panelDepth);
      return;
    }

    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName;
      const isPanel = ts.isIdentifier(tag) ? panelNames.has(tag.text)
        : ts.isPropertyAccessExpression(tag) && tag.name.text === "Panel";
      if (isPanel && panelDepth > 0) {
        report("nested-panel", "Never put a Panel inside another Panel. Group its content with Section, FieldList, hairlines or a rail.", node.getStart(source), node.getText(source));
      }
      if (isPanel) panelDepth += 1;
    }
    ts.forEachChild(node, (child) => visit(child, panelDepth));
  };
  visit(source);
  return [...violations.values()].sort((a, b) => a.lineNumber - b.lineNumber || a.ruleId.localeCompare(b.ruleId));
}

export function auditDesignSystem(
  rootDir = REPO_ROOT,
  pending: ReadonlyArray<string> = DESIGN_AUDIT_PENDING,
): DesignAuditResult {
  const resolvedRoot = resolve(rootDir);
  const clientRoot = join(resolvedRoot, CLIENT_ROOT);
  const designDir = join(resolvedRoot, DESIGN_DIR);
  const files = existsSync(clientRoot) ? collectSourceFiles(clientRoot) : [];
  const pendingSet = new Set(pending);
  const violations: DesignViolation[] = [];
  const pendingWithViolations = new Set<string>();
  let scannedFiles = 0;

  for (const filePath of files) {
    if (filePath.startsWith(`${designDir}${sep}`)) continue;
    scannedFiles += 1;
    const file = toPosix(relative(resolvedRoot, filePath));
    const found = findDesignViolations(file, readFileSync(filePath, "utf-8"));
    if (found.length === 0) continue;
    if (pendingSet.has(file)) {
      pendingWithViolations.add(file);
    } else {
      violations.push(...found);
    }
  }

  return {
    rootDir: resolvedRoot,
    scannedFiles,
    violations,
    stalePending: pending.filter((file) => !pendingWithViolations.has(file)),
    pendingFiles: pending.length,
  };
}

export function formatDesignAuditResult(result: DesignAuditResult): string {
  const lines: string[] = [];
  if (result.violations.length === 0 && result.stalePending.length === 0) {
    lines.push(
      `Design system audit passed (${result.scannedFiles} file(s) scanned, ${result.pendingFiles} not yet migrated).`,
    );
    return lines.join("\n");
  }

  if (result.violations.length > 0) {
    lines.push(`Design system audit failed with ${result.violations.length} violation(s):`, "");
    for (const violation of result.violations) {
      lines.push(`- [${violation.ruleId}] ${violation.file}:${violation.lineNumber} — ${violation.message}`);
      lines.push(`  ${violation.snippet}`);
    }
    lines.push(
      "",
      "Build the screen from src/client/design (read its README.md first). Do not add the file to audit-pending.ts:",
      "that list names screens written before the system existed, and it only shrinks.",
    );
  }

  if (result.stalePending.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(
      `${result.stalePending.length} file(s) in src/client/design/audit-pending.ts no longer break a rule. Remove them from the list so they stay clean:`,
      "",
      ...result.stalePending.map((file) => `- ${file}`),
    );
  }
  return lines.join("\n");
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  return Boolean(entry) && resolve(entry) === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) {
  const explainIndex = process.argv.indexOf("--explain");
  if (explainIndex >= 0) {
    // What one file still breaks, whether or not it is pending: the to-do list for migrating it.
    const targetArg = process.argv[explainIndex + 1];
    if (!targetArg || targetArg.startsWith("--")) throw new Error("Expected a source file after --explain.");
    const target = toPosix(relative(REPO_ROOT, resolve(REPO_ROOT, targetArg)));
    const found = findDesignViolations(target, readFileSync(join(REPO_ROOT, target), "utf-8"));
    process.stdout.write(found.length === 0
      ? `${target} follows the design system.\n`
      : `${found.map((violation) => `${target}:${violation.lineNumber} [${violation.ruleId}] ${violation.message}\n  ${violation.snippet}`).join("\n")}\n`);
  } else if (process.argv.includes("--list")) {
    // Every file that breaks a rule, pending or not.
    const result = auditDesignSystem(REPO_ROOT, []);
    const files = [...new Set(result.violations.map((violation) => violation.file))].sort();
    process.stdout.write(`${files.join("\n")}\n`);
  } else {
    const result = auditDesignSystem();
    const failed = result.violations.length > 0 || result.stalePending.length > 0;
    (failed ? process.stderr : process.stdout).write(`${formatDesignAuditResult(result)}\n`);
    if (failed) process.exitCode = 1;
  }
}
