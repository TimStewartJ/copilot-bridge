// Fails on every `any` type in production code: each one switches off type checking for a value.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TEST_PATH =
  /(?:^|\/)(?:__tests__|test-support|node_modules|test)\/|^src\/integration\/|(?:^|\/)test-[^/]*\.tsx?$|\.(?:test|spec)\.tsx?$|\.d\.ts$/;

export interface AnyUse {
  line: number;
  text: string;
}

export interface AnyUsage {
  uses: AnyUse[];
  doubleCasts: number;
}

/** Whether a repository path (forward slashes, from the root) is production source. */
export function isProductionSource(path: string): boolean {
  return path.startsWith("src/") && /\.tsx?$/.test(path) && !TEST_PATH.test(path);
}

function unwrapType(type: ts.TypeNode): ts.TypeNode {
  return ts.isParenthesizedTypeNode(type) ? unwrapType(type.type) : type;
}

function unwrapExpression(node: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(node) ? unwrapExpression(node.expression) : node;
}

function isAssertion(node: ts.Node): node is ts.AsExpression | ts.TypeAssertion {
  return ts.isAsExpression(node) || ts.isTypeAssertionExpression(node);
}

/** The node an `any` belongs to, for the report: its declaration, cast or signature. */
function owner(node: ts.Node): ts.Node {
  let current = node;
  while (current.parent && (ts.isTypeNode(current.parent) || ts.isTypeParameterDeclaration(current.parent))) {
    current = current.parent;
  }
  return current.parent ?? current;
}

export function findAnyUsage(fileName: string, text: string): AnyUsage {
  const kind = fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const usage: AnyUsage = { uses: [], doubleCasts: 0 };
  const visit = (node: ts.Node) => {
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      const context = owner(node).getText(source).replace(/\s+/g, " ").slice(0, 100);
      usage.uses.push({ line, text: context });
    } else if (isAssertion(node)) {
      const inner = unwrapExpression(node.expression);
      if (isAssertion(inner) && unwrapType(inner.type).kind === ts.SyntaxKind.UnknownKeyword) usage.doubleCasts += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return usage;
}

function collectFiles(rootDir: string, dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") collectFiles(rootDir, path, files);
    } else if (isProductionSource(relative(rootDir, path).split("\\").join("/"))) {
      files.push(path);
    }
  }
  return files;
}

export function auditAny(rootDir = REPO_ROOT) {
  const files = collectFiles(rootDir, join(rootDir, "src"));
  const failures: string[] = [];
  let doubleCasts = 0;
  for (const file of files) {
    const path = relative(rootDir, file).split("\\").join("/");
    const usage = findAnyUsage(file, readFileSync(file, "utf8"));
    doubleCasts += usage.doubleCasts;
    for (const use of usage.uses) failures.push(`${path}:${use.line}  ${use.text}`);
  }
  return { scannedFiles: files.length, failures, doubleCasts };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { scannedFiles, failures, doubleCasts } = auditAny();
  const report = `${doubleCasts} \`as unknown as\` casts (reported, not failed)`;
  if (failures.length > 0) {
    console.error(`Any audit: ${failures.length} uses of \`any\` in production code. Use a real type or \`unknown\`.\n`);
    console.error(failures.join("\n"));
    console.error(`\n${report}.`);
    process.exit(1);
  }
  console.log(`Any audit passed (${scannedFiles} files; ${report}).`);
}
