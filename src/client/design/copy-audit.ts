import ts from "typescript";
import type { DesignViolation } from "./audit";

/**
 * The "long-copy" rule: user-visible text stays short (README.md, "Copy"). A label, a state and a
 * control explain themselves; a sentence is for a consequence the reader would otherwise get wrong,
 * an error, or an interaction that cannot work without it, and even then it is short.
 *
 * Word count is a tripwire, not the whole rule: it catches the intros, help lines and footnotes
 * that pile up, and leaves short tutorial lines to review against the README. Prose is measured as
 * the reader sees it, so text split around inline markup (`<code>`, links) or joined with `+` counts
 * as one piece. Text built at run time from data cannot be checked here.
 */

export const LONG_COPY_MAX_WORDS = 12;

export const LONG_COPY_MESSAGE = `Text over ${LONG_COPY_MAX_WORDS} words. Let the label, state and control speak; drop intros, help lines, footnotes and tutorial text (src/client/design/README.md, "Copy"). If the reader would be wrong about a consequence without it, keep it to one short sentence and put \`// copy-ok: <why>\` (or {/* copy-ok: <why> */}) on the line above.`;

const COPY_OK_RE = /copy-ok:\s*\S/;

/** Attributes that are never shown as body text. `title` is handled apart: it is a tooltip except on VISIBLE_TITLE_COMPONENTS. */
const EXEMPT_ATTRIBUTES = new Set([
  "className", "class", "style", "key", "id", "htmlFor", "href", "src", "alt", "role", "type", "name", "value",
  "placeholder", "autoComplete", "inputMode", "d", "viewBox", "to", "rel", "target", "lang", "accept",
]);

/** Components that show their `title` prop as a heading rather than as a tooltip. */
const VISIBLE_TITLE_COMPONENTS = new Set(["Notice", "Dialog", "DocsDialog", "SettingsSection"]);

/** Elements that sit inside a line of prose rather than breaking it. */
const INLINE_TAGS = new Set(["a", "abbr", "b", "br", "code", "em", "i", "kbd", "Kbd", "Link", "mark", "small", "span", "strong", "sub", "sup"]);

function countWords(text: string): number {
  return text.split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
}

function tagName(node: ts.JsxElement | ts.JsxSelfClosingElement, source: ts.SourceFile): string {
  return (ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName).getText(source);
}

/** A class recipe, markup or code rather than words for a reader. */
function isNotProse(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.startsWith("<") || (/[{}]/.test(trimmed) && /;/.test(trimmed))) return true;
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const utilities = tokens.filter((token) => /^[!-]?[a-z0-9@[]/.test(token) && /[-:[\]/]/.test(token) || /^(?:flex|grid|block|inline|relative|absolute|fixed|sticky|hidden|truncate|border|rounded|shadow|italic|underline|grow|shrink|transition)$/.test(token));
  return tokens.length > 0 && utilities.length / tokens.length >= 0.6;
}

function literalText(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(" ");
  }
  if (ts.isParenthesizedExpression(node)) return literalText(node.expression);
  return undefined;
}

/** The pieces of a `+` chain of literals, or undefined when any operand is not text. */
function concatenatedText(node: ts.Expression): string | undefined {
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = concatenatedText(node.left);
    const right = concatenatedText(node.right);
    if (left === undefined && right === undefined) return undefined;
    return `${left ?? ""} ${right ?? ""}`;
  }
  return literalText(node);
}

function isPlusChain(node: ts.Node): boolean {
  return ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken;
}

function isNotCopyContext(node: ts.Node, source: ts.SourceFile): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return true;
    if (ts.isJsxAttribute(parent)) {
      const name = parent.name.getText(source);
      if (EXEMPT_ATTRIBUTES.has(name) || name.startsWith("aria-") || name.startsWith("data-")) return true;
      if (name === "title") {
        const element = parent.parent.parent;
        return !((ts.isJsxOpeningElement(element) || ts.isJsxSelfClosingElement(element)) && VISIBLE_TITLE_COMPONENTS.has(element.tagName.getText(source)));
      }
      return false;
    }
    if (ts.isPropertyAssignment(parent) && /^(?:className|class|style)$/.test(parent.name.getText(source))) return true;
    if ((ts.isVariableDeclaration(parent) || ts.isFunctionDeclaration(parent)) && parent.name && /class|style|tooltip|[a-z]Title$/i.test(parent.name.getText(source))) return true;
    if (ts.isPropertyAssignment(parent) && /^(?:title|tooltip)$/.test(parent.name.getText(source))) return true;
    if (ts.isCallExpression(parent)) {
      const callee = parent.expression.getText(source);
      if (/^(?:cx|clsx|cn)$/.test(callee) || /^console\./.test(callee)) return true;
    }
    if (ts.isNewExpression(parent) && /Error$/.test(parent.expression.getText(source))) return true;
    if (ts.isThrowStatement(parent)) return true;
    if (ts.isJsxElement(parent) || ts.isJsxSelfClosingElement(parent) || ts.isBlock(parent) || ts.isSourceFile(parent)) return false;
  }
  return false;
}

export function findLongCopy(file: string, content: string): DesignViolation[] {
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const rawLines = content.split(/\r?\n/);
  const violations = new Map<number, DesignViolation>();
  const inlineConsumed = new Set<ts.Node>();

  const markedAbove = (start: number) => {
    const line = source.getLineAndCharacterOfPosition(start).line;
    return COPY_OK_RE.test(rawLines[line - 1] ?? "") || COPY_OK_RE.test(rawLines[line] ?? "");
  };
  const report = (start: number, text: string, element?: ts.Node) => {
    if (markedAbove(start)) return;
    if (element && markedAbove(element.getStart(source))) return;
    const line = source.getLineAndCharacterOfPosition(start).line;
    violations.set(line, {
      ruleId: "long-copy",
      file,
      lineNumber: line + 1,
      message: LONG_COPY_MESSAGE,
      snippet: text.replace(/\s+/g, " ").trim().slice(0, 160),
    });
  };

  /** Contiguous prose among JSX children: text, literal expressions and inline elements, broken by block elements. */
  const checkJsxChildren = (element: ts.JsxElement | ts.JsxFragment) => {
    // A {/* copy-ok: … */} anywhere among the element's own children marks all of its prose.
    if (element.children.some((child) => ts.isJsxExpression(child) && !child.expression && COPY_OK_RE.test(child.getText(source)))) return;
    let run = "";
    let runStart = -1;
    const flush = () => {
      if (runStart >= 0 && countWords(run) > LONG_COPY_MAX_WORDS) report(runStart, run, element);
      run = "";
      runStart = -1;
    };
    const add = (text: string, start: number) => {
      if (!text.trim()) {
        run += " ";
        return;
      }
      if (runStart < 0) runStart = start + (text.length - text.trimStart().length);
      run += text;
    };
    const walk = (nodes: ts.NodeArray<ts.JsxChild>) => {
      for (const child of nodes) {
        if (ts.isJsxText(child)) {
          add(child.text, child.getStart(source));
        } else if (ts.isJsxExpression(child)) {
          if (!child.expression) continue;
          // A value in the middle of prose ({name}) reads as part of it but is not counted.
          const text = concatenatedText(child.expression);
          if (text !== undefined) add(text, child.getStart(source));
        } else if ((ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) && INLINE_TAGS.has(tagName(child, source))) {
          inlineConsumed.add(child);
          if (ts.isJsxElement(child)) walk(child.children);
          else run += " ";
        } else {
          flush();
        }
      }
    };
    walk(element.children);
    flush();
  };

  const visit = (node: ts.Node) => {
    if ((ts.isJsxElement(node) || ts.isJsxFragment(node)) && !inlineConsumed.has(node)) {
      checkJsxChildren(node);
    }

    const parent = node.parent;
    const isJsxChildExpression = parent && ts.isJsxExpression(parent) && parent.parent && (ts.isJsxElement(parent.parent) || ts.isJsxFragment(parent.parent));
    if (isPlusChain(node) && !(parent && isPlusChain(parent))) {
      const text = concatenatedText(node as ts.Expression);
      if (text !== undefined && !isJsxChildExpression && !isNotProse(text) && !isNotCopyContext(node, source) && countWords(text) > LONG_COPY_MAX_WORDS) {
        report(node.getStart(source), text);
      }
      if (text !== undefined) return;
    }
    const text = literalText(node);
    if (text !== undefined && !ts.isParenthesizedExpression(node)) {
      if (!isJsxChildExpression && !isNotProse(text) && !isNotCopyContext(node, source) && countWords(text) > LONG_COPY_MAX_WORDS) {
        report(node.getStart(source), text);
      }
      if (!ts.isTemplateExpression(node)) return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...violations.values()].sort((a, b) => a.lineNumber - b.lineNumber);
}
