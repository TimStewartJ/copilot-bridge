/** Docs are hard-wrapped, so newlines stay spaces, except before a bold label ending in a colon. */
import type { Paragraph, PhrasingContent, Root, Strong } from "mdast";
import { visit } from "unist-util-visit";

function phrasingText(node: PhrasingContent): string {
  if ("value" in node && typeof node.value === "string") return node.value;
  if ("children" in node) return (node.children as PhrasingContent[]).map(phrasingText).join("");
  return "";
}

function isLabel(node: PhrasingContent, next: PhrasingContent | undefined): node is Strong {
  if (node.type !== "strong") return false;
  if (phrasingText(node).trimEnd().endsWith(":")) return true;
  // Also accept the colon written just outside the bold run: **Status**: shipped
  return next?.type === "text" && next.value.startsWith(":");
}

export function applyLabelBreaks(paragraph: Paragraph): void {
  const children: PhrasingContent[] = [];
  paragraph.children.forEach((child, index) => {
    const previous = children[children.length - 1];
    if (previous?.type === "text" && /\r?\n$/.test(previous.value) && isLabel(child, paragraph.children[index + 1])) {
      previous.value = previous.value.replace(/\r?\n$/, "");
      if (!previous.value) children.pop();
      children.push({ type: "break" });
    }
    children.push(child);
  });
  paragraph.children = children;
}

export default function remarkLabelBreaks() {
  return (tree: Root) => {
    visit(tree, "paragraph", (node: Paragraph) => applyLabelBreaks(node));
  };
}
