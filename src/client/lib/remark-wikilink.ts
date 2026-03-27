/**
 * Remark plugin that transforms [[wikilink]] syntax into mdast link nodes.
 *
 * Supported forms:
 *   [[page-name]]           → link to "page-name", display text "page-name"
 *   [[path/to/page]]        → link to "path/to/page", display text "page"
 *   [[target|Custom Label]] → link to "target", display text "Custom Label"
 *
 * Links are emitted with a `wiki:` URL scheme so the custom anchor renderer
 * can distinguish them from regular markdown links.
 */
import type { Root, Text, PhrasingContent } from "mdast";
import { visit } from "unist-util-visit";

const WIKILINK_RE = /\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g;

export default function remarkWikilink() {
  return (tree: Root) => {
    visit(tree, "text", (node: Text, index, parent) => {
      if (!parent || index == null) return;

      const value = node.value;
      WIKILINK_RE.lastIndex = 0;
      if (!WIKILINK_RE.test(value)) return;

      // Split the text node around wikilink matches
      WIKILINK_RE.lastIndex = 0;
      const children: PhrasingContent[] = [];
      let lastIndex = 0;
      let match: RegExpExecArray | null;

      while ((match = WIKILINK_RE.exec(value)) !== null) {
        // Text before the match
        if (match.index > lastIndex) {
          children.push({ type: "text", value: value.slice(lastIndex, match.index) });
        }

        const target = match[1].trim();
        const label = match[2]?.trim() || target.split("/").pop() || target;

        children.push({
          type: "link",
          url: `wiki:${target}`,
          children: [{ type: "text", value: label }],
        });

        lastIndex = match.index + match[0].length;
      }

      // Remaining text after last match
      if (lastIndex < value.length) {
        children.push({ type: "text", value: value.slice(lastIndex) });
      }

      // Replace the original text node with the split children
      if (children.length > 0) {
        parent.children.splice(index, 1, ...children);
      }
    });
  };
}
