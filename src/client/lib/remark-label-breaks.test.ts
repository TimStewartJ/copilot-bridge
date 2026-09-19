import { describe, expect, it } from "vitest";
import type { Paragraph, PhrasingContent } from "mdast";
import { applyLabelBreaks } from "./remark-label-breaks";

const text = (value: string): PhrasingContent => ({ type: "text", value });
const strong = (value: string): PhrasingContent => ({ type: "strong", children: [{ type: "text", value }] });
const paragraph = (...children: PhrasingContent[]): Paragraph => ({ type: "paragraph", children });

function shape(node: Paragraph): string[] {
  return node.children.map((child) => {
    if (child.type === "text") return `text:${child.value}`;
    if (child.type === "strong") return `strong:${(child.children[0] as { value: string }).value}`;
    return child.type;
  });
}

describe("applyLabelBreaks", () => {
  it("puts each bold label of a metadata block on its own line", () => {
    const node = paragraph(strong("Status:"), text(" shipped\n"), strong("Repo:"), text(" E:\\project\n"), strong("Owner:"), text(" Tim"));
    applyLabelBreaks(node);
    expect(shape(node)).toEqual([
      "strong:Status:", "text: shipped", "break", "strong:Repo:", "text: E:\\project", "break", "strong:Owner:", "text: Tim",
    ]);
  });

  it("accepts the colon written just outside the bold run", () => {
    const node = paragraph(text("intro\n"), strong("Status"), text(": shipped"));
    applyLabelBreaks(node);
    expect(shape(node)).toEqual(["text:intro", "break", "strong:Status", "text:: shipped"]);
  });

  it("keeps hard-wrapped prose flowing, including bold words that start a wrapped line", () => {
    const node = paragraph(text("a sentence that wraps\n"), strong("important"), text(" and continues\non the next line"));
    applyLabelBreaks(node);
    expect(shape(node)).toEqual(["text:a sentence that wraps\n", "strong:important", "text: and continues\non the next line"]);
  });

  it("drops a text node that held nothing but the line break", () => {
    const node = paragraph({ type: "inlineCode", value: "x" }, text("\n"), strong("Next:"), text(" y"));
    applyLabelBreaks(node);
    expect(shape(node)).toEqual(["inlineCode", "break", "strong:Next:", "text: y"]);
  });

  it("handles Windows line endings", () => {
    const node = paragraph(text("first\r\n"), strong("Label:"), text(" value"));
    applyLabelBreaks(node);
    expect(shape(node)).toEqual(["text:first", "break", "strong:Label:", "text: value"]);
  });
});
