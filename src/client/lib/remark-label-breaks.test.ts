import { describe, expect, it } from "vitest";
import type { Paragraph, PhrasingContent } from "mdast";
import { applyLabelBreaks } from "./remark-label-breaks";

const text = (value: string): PhrasingContent => ({ type: "text", value });
const strong = (value: string): PhrasingContent => ({ type: "strong", children: [{ type: "text", value }] });
const paragraph = (...children: PhrasingContent[]): Paragraph => ({ type: "paragraph", children });

function shape(node: Paragraph): string[] {
  return node.children.map((child) => {
    if (child.type === "text" || child.type === "inlineCode") return `${child.type}:${child.value}`;
    if (child.type === "strong") return `strong:${(child.children[0] as { value: string }).value}`;
    return child.type;
  });
}

describe("applyLabelBreaks", () => {
  it("puts each bold label of a metadata block on its own line", () => {
    const node = paragraph(
      strong("Status:"), text(" shipped\r\n"), strong("Repo:"), { type: "inlineCode", value: "E:\\project" },
      text("\n"), strong("Owner:"), text(" Tim"),
    );
    applyLabelBreaks(node);
    expect(shape(node).filter((word) => word !== "text:")).toEqual([
      "strong:Status:", "text: shipped", "break", "strong:Repo:", "inlineCode:E:\\project", "break", "strong:Owner:", "text: Tim",
    ]);
  });

  it("keeps hard-wrapped prose flowing, including bold words that start a wrapped line", () => {
    const node = paragraph(text("a sentence that wraps\n"), strong("important"), text(" and continues\non the next line"));
    applyLabelBreaks(node);
    expect(shape(node)).toEqual(["text:a sentence that wraps\n", "strong:important", "text: and continues\non the next line"]);
  });
});
