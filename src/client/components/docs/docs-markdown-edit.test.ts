import { describe, expect, it } from "vitest";
import {
  applyMarkdownAction,
  computeTextChange,
  continueListOnEnter,
  indentListOnTab,
  type MarkdownAction,
  type TextEdit,
} from "./docs-markdown-edit";

/** Writes an edit state with `[` and `]` marking the selection (or `|` for a caret). */
function parse(marked: string): TextEdit {
  const caret = marked.indexOf("|");
  if (caret >= 0) {
    const value = marked.replace("|", "");
    return { value, selectionStart: caret, selectionEnd: caret };
  }
  const start = marked.indexOf("[");
  const end = marked.indexOf("]") - 1;
  return { value: marked.replace("[", "").replace("]", ""), selectionStart: start, selectionEnd: end };
}

function show(state: TextEdit): string {
  const { value, selectionStart: start, selectionEnd: end } = state;
  if (start === end) return `${value.slice(0, start)}|${value.slice(start)}`;
  return `${value.slice(0, start)}[${value.slice(start, end)}]${value.slice(end)}`;
}

const run = (marked: string, action: MarkdownAction) => show(applyMarkdownAction(parse(marked), action));

describe("inline formatting", () => {
  it("wraps the selection and keeps it selected, so a second press undoes it", () => {
    expect(run("make [this] bold", "bold")).toBe("make **[this]** bold");
    expect(run("make **[this]** bold", "bold")).toBe("make [this] bold");
    expect(run("make [**this**] bold", "bold")).toBe("make [this] bold");
  });

  it("inserts a selected placeholder when nothing is selected", () => {
    expect(run("say |", "italic")).toBe("say _[italic text]_");
    expect(run("call |", "code")).toBe("call `[code]`");
  });

  // Links use raw states: the bracket notation above would be unreadable next to link syntax.
  it("builds links around text or around a pasted URL, selecting the half still to type", () => {
    expect(applyMarkdownAction({ value: "see the guide", selectionStart: 4, selectionEnd: 13 }, "link"))
      .toEqual({ value: "see [the guide](https://)", selectionStart: 16, selectionEnd: 24 });
    expect(applyMarkdownAction({ value: "see https://example.com/a", selectionStart: 4, selectionEnd: 25 }, "link"))
      .toEqual({ value: "see [link text](https://example.com/a)", selectionStart: 5, selectionEnd: 14 });
    expect(applyMarkdownAction({ value: "see ", selectionStart: 4, selectionEnd: 4 }, "link"))
      .toEqual({ value: "see [link text](https://)", selectionStart: 5, selectionEnd: 14 });
    expect(applyMarkdownAction({ value: "see deploy guide", selectionStart: 4, selectionEnd: 16 }, "wikilink"))
      .toEqual({ value: "see [[deploy guide]]", selectionStart: 6, selectionEnd: 18 });
  });
});

describe("block formatting", () => {
  it("turns whole lines into list items and back", () => {
    expect(run("[one\ntwo]", "bulletList")).toBe("[- one\n- two]");
    expect(run("[- one\n- two]", "bulletList")).toBe("[one\ntwo]");
    expect(run("[one\ntwo\nthree]", "numberedList")).toBe("[1. one\n2. two\n3. three]");
    expect(run("[- one\n- two]", "taskList")).toBe("[- [ ] one\n- [ ] two]");
  });

  it("swaps one kind of block marker for another instead of stacking them", () => {
    expect(run("[1. one\n2. two]", "bulletList")).toBe("[- one\n- two]");
    expect(run("## Tit|le", "heading3")).toBe("### Tit|le");
    expect(run("- it|em", "heading2")).toBe("## it|em");
  });

  it("toggles headings on the caret's line without moving the caret off its character", () => {
    expect(run("Tit|le", "heading2")).toBe("## Tit|le");
    expect(run("## Tit|le", "heading2")).toBe("Tit|le");
  });

  it("skips blank lines inside a multi-line selection and keeps indentation", () => {
    expect(run("[one\n\n  two]", "bulletList")).toBe("[- one\n\n  - two]");
  });

  it("quotes and unquotes every selected line", () => {
    expect(run("[one\ntwo]", "quote")).toBe("[> one\n> two]");
    expect(run("[> one\n> two]", "quote")).toBe("[one\ntwo]");
  });

  it("does not swallow the line after a selection that ends at a line break", () => {
    expect(show(applyMarkdownAction({ value: "one\ntwo", selectionStart: 0, selectionEnd: 4 }, "bulletList"))).toBe("[- one]\ntwo");
  });

  it("inserts blocks as their own paragraph with exactly the padding that is missing", () => {
    expect(run("before|", "divider")).toBe("before\n\n---|");
    expect(run("before\n\n|\n\nafter", "divider")).toBe("before\n\n---|\n\nafter");
    expect(run("|after", "divider")).toBe("---|\n\nafter");
    expect(run("wrap [x = 1] here", "codeBlock")).toBe("wrap \n\n```\n[x = 1]\n```\n\n here");
    expect(applyMarkdownAction(parse("|"), "table").value).toBe("| Column | Column |\n| --- | --- |\n| Value | Value |");
  });
});

describe("list keys", () => {
  const enter = (marked: string) => {
    const next = continueListOnEnter(parse(marked));
    return next ? show(next) : null;
  };
  const tab = (marked: string, outdent = false) => {
    const next = indentListOnTab(parse(marked), outdent);
    return next ? show(next) : null;
  };

  it("continues bullets, numbers and tasks", () => {
    expect(enter("- one|")).toBe("- one\n- |");
    expect(enter("  * nested|")).toBe("  * nested\n  * |");
    expect(enter("9. nine|")).toBe("9. nine\n10. |");
    expect(enter("- [x] done|")).toBe("- [x] done\n- [ ] |");
    expect(enter("- split| here")).toBe("- split\n- | here");
  });

  it("ends the list when Enter is pressed on an empty item", () => {
    expect(enter("- one\n- |")).toBe("- one\n|");
  });

  it("leaves Enter alone outside a list or with a selection", () => {
    expect(enter("plain text|")).toBeNull();
    expect(enter("- [one]")).toBeNull();
  });

  it("nests and un-nests list items, and leaves Tab alone elsewhere so focus can move", () => {
    expect(tab("- one|")).toBe("  - one|");
    expect(tab("  - one|", true)).toBe("- one|");
    expect(tab("[- one\n- two]")).toBe("[  - one\n  - two]");
    expect(tab("plain|")).toBeNull();
  });
});

describe("computeTextChange", () => {
  it("finds the smallest replacement so undo history stays granular", () => {
    expect(computeTextChange("make this bold", "make **this** bold")).toEqual({ start: 5, end: 9, insert: "**this**" });
    expect(computeTextChange("**this**", "this")).toEqual({ start: 0, end: 8, insert: "this" });
    expect(computeTextChange("same", "same")).toEqual({ start: 4, end: 4, insert: "" });
    expect(computeTextChange("aaa", "aaaa")).toEqual({ start: 3, end: 3, insert: "a" });
    expect(computeTextChange("abc", "")).toEqual({ start: 0, end: 3, insert: "" });
  });
});
