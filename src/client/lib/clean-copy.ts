type CopyEventLike = Pick<ClipboardEvent, "clipboardData" | "defaultPrevented" | "preventDefault" | "target">;
type SelectionLike = Pick<Selection, "toString" | "rangeCount" | "getRangeAt">;
type EditableLike = { tagName?: string; isContentEditable?: boolean };

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
// Past this many elements the copy keeps only plain text, so a huge selection does not stall the page.
const MAX_COPIED_ELEMENTS = 5_000;
const TEXT_FIELD_TAGS = new Set(["INPUT", "TEXTAREA"]);
const DROPPED_TAGS = new Set([
  "AUDIO", "CANVAS", "EMBED", "IFRAME", "INPUT", "NOSCRIPT", "OBJECT", "SCRIPT", "SELECT", "STYLE", "SVG", "TEMPLATE",
  "TEXTAREA", "VIDEO",
]);
const INLINE_FORMAT_TAGS = new Set([
  "A", "ABBR", "B", "CODE", "DEL", "EM", "I", "INS", "KBD", "MARK", "S", "SMALL", "STRONG", "SUB", "SUP", "U",
]);
// A selection across the parts of one of these loses its meaning without the element around it.
const CONTAINER_TAGS = new Set(["OL", "PRE", "TABLE", "TBODY", "TFOOT", "THEAD", "TR", "UL"]);
const STRUCTURE_TAGS = new Set([...CONTAINER_TAGS, "BLOCKQUOTE", "LI", "TD", "TH"]);
const KEPT_ATTRIBUTES: Record<string, string[]> = {
  A: ["href"],
  IMG: ["src", "alt"],
  TD: ["colspan", "rowspan"],
  TH: ["colspan", "rowspan"],
};
const SAFE_URL = /^(https?:|mailto:)/i;

class TooLargeError extends Error {}

function isBlockDisplay(display: string): boolean {
  return display !== "" && !display.startsWith("inline") && display !== "contents";
}

function isTextField(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  const element = node as EditableLike;
  return element.isContentEditable === true || TEXT_FIELD_TAGS.has(element.tagName ?? "");
}

class RangeSerializer {
  private elements = 0;
  private readonly doc: Document;

  constructor(private readonly range: Range) {
    this.doc = range.commonAncestorContainer.ownerDocument as Document;
  }

  html(): string {
    const root = this.range.commonAncestorContainer;
    let content: Node = this.doc.createDocumentFragment();
    if (root.nodeType === TEXT_NODE) this.appendText(root as Text, content);
    else for (const child of Array.from(root.childNodes)) this.append(child, content, false);

    let ancestor = root.nodeType === ELEMENT_NODE ? root as Element : root.parentElement;
    // Keep the bold, italic, link or code the selection sits in.
    while (ancestor && !this.isBlock(ancestor)) {
      if (INLINE_FORMAT_TAGS.has(ancestor.tagName.toUpperCase())) content = this.wrap(ancestor, content);
      ancestor = ancestor.parentElement;
    }
    // Keep the list, table or code block the selected items, rows or lines belong to.
    if (ancestor && CONTAINER_TAGS.has(ancestor.tagName.toUpperCase())) {
      while (ancestor && STRUCTURE_TAGS.has(ancestor.tagName.toUpperCase())) {
        content = this.wrap(ancestor, content);
        ancestor = ancestor.parentElement;
      }
    }
    const container = this.doc.createElement("div");
    container.appendChild(content);
    return container.innerHTML;
  }

  private style(element: Element) {
    return this.doc.defaultView?.getComputedStyle(element);
  }

  private isBlock(element: Element): boolean {
    return isBlockDisplay(this.style(element)?.display ?? "");
  }

  private wrap(element: Element, content: Node): Element {
    const shell = this.shell(element, this.style(element)?.display ?? "");
    shell.appendChild(content);
    return shell;
  }

  private appendText(text: Text, parent: Node) {
    const start = text === this.range.startContainer ? this.range.startOffset : 0;
    const end = text === this.range.endContainer ? this.range.endOffset : text.data.length;
    if (end > start) parent.appendChild(this.doc.createTextNode(text.data.slice(start, end)));
  }

  private append(node: Node, parent: Node, contained: boolean) {
    if (!contained) {
      if (!this.range.intersectsNode(node)) return;
      contained = !node.contains(this.range.startContainer) && !node.contains(this.range.endContainer);
    }
    if (node.nodeType === TEXT_NODE) {
      this.appendText(node as Text, parent);
      return;
    }
    if (node.nodeType !== ELEMENT_NODE) return;
    const element = node as Element;
    if (DROPPED_TAGS.has(element.tagName.toUpperCase())) return;
    if (++this.elements > MAX_COPIED_ELEMENTS) throw new TooLargeError();
    const style = this.style(element);
    if (style?.display === "none" || style?.visibility === "hidden" || style?.visibility === "collapse") return;
    const shell = this.shell(element, style?.display ?? "");
    for (const child of Array.from(element.childNodes)) this.append(child, shell, contained);
    parent.appendChild(shell);
  }

  private shell(element: Element, display: string): Element {
    const tag = element.tagName.toUpperCase();
    // File links and chat images render inside buttons; diff lines are spans styled as blocks.
    const name = tag === "BUTTON" || tag === "SPAN" ? (isBlockDisplay(display) ? "div" : "span") : tag.toLowerCase();
    const shell = this.doc.createElement(name);
    for (const attribute of KEPT_ATTRIBUTES[tag] ?? []) {
      const isUrl = attribute === "href" || attribute === "src";
      // Resolved properties give absolute URLs, so links and images still work once pasted elsewhere.
      const value = isUrl ? (element as unknown as Record<string, unknown>)[attribute] : element.getAttribute(attribute);
      if (typeof value !== "string" || !value || (isUrl && !SAFE_URL.test(value))) continue;
      shell.setAttribute(attribute, value);
    }
    if (tag === "OL") this.setListStart(element as HTMLOListElement, shell);
    return shell;
  }

  private setListStart(list: HTMLOListElement, shell: Element) {
    const items = Array.from(list.children).filter((child) => child.tagName.toUpperCase() === "LI");
    const first = Math.max(0, items.findIndex((item) => this.range.intersectsNode(item)));
    const start = list.start + first;
    if (start !== 1) shell.setAttribute("start", String(start));
  }
}

/**
 * The selection as HTML that keeps its structure (headings, lists, tables, emphasis, links, code)
 * but none of the Bridge's styling. Empty when the selection is too large to rebuild quickly.
 */
export function cleanSelectionHtml(selection: SelectionLike): string {
  try {
    let html = "";
    for (let index = 0; index < selection.rangeCount; index += 1) {
      html += new RangeSerializer(selection.getRangeAt(index)).html();
    }
    return html;
  } catch (error) {
    if (error instanceof TooLargeError) return "";
    throw error;
  }
}

/**
 * Copies a selection without the Bridge's fonts, colors and backgrounds, so it
 * pastes into a mail or document in that document's own style.
 * Text fields already copy plain text, and a handler that set its own data first wins.
 */
export function handleCleanCopy(
  event: CopyEventLike,
  getSelection: () => SelectionLike | null = () => window.getSelection(),
): void {
  if (event.defaultPrevented || !event.clipboardData || isTextField(event.target)) return;
  const selection = getSelection();
  const text = selection?.toString() ?? "";
  if (!selection || !text) return;
  event.clipboardData.setData("text/plain", text);
  const html = cleanSelectionHtml(selection);
  if (html) event.clipboardData.setData("text/html", html);
  event.preventDefault();
}

export function installCleanCopy(target: Pick<Document, "addEventListener" | "removeEventListener"> = document): () => void {
  const listener = (event: ClipboardEvent) => handleCleanCopy(event);
  target.addEventListener("copy", listener);
  return () => target.removeEventListener("copy", listener);
}
