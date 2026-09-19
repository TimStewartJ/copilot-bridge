/**
 * Text transforms behind the markdown editor's toolbar and keyboard shortcuts. Each takes the
 * textarea's value plus selection and returns the next value plus selection, so they can be
 * tested without a DOM.
 */

export interface TextEdit {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

export type MarkdownAction =
  | "bold"
  | "italic"
  | "code"
  | "link"
  | "wikilink"
  | "heading2"
  | "heading3"
  | "bulletList"
  | "numberedList"
  | "taskList"
  | "quote"
  | "codeBlock"
  | "table"
  | "divider";

const INLINE_MARKERS: Partial<Record<MarkdownAction, { marker: string; placeholder: string }>> = {
  bold: { marker: "**", placeholder: "bold text" },
  italic: { marker: "_", placeholder: "italic text" },
  code: { marker: "`", placeholder: "code" },
};

const LIST_MARKER = /^(\s*)(?:[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)/;
const HEADING_MARKER = /^(\s{0,3})#{1,6}\s+/;
const QUOTE_MARKER = /^(\s*)>\s?/;

function toggleInline(state: TextEdit, marker: string, placeholder: string): TextEdit {
  const { value, selectionStart: start, selectionEnd: end } = state;
  const selected = value.slice(start, end);
  const size = marker.length;

  // Selection sits between a marker pair: `**|text|**`.
  if (value.slice(start - size, start) === marker && value.slice(end, end + size) === marker) {
    return {
      value: value.slice(0, start - size) + selected + value.slice(end + size),
      selectionStart: start - size,
      selectionEnd: end - size,
    };
  }
  // Selection includes the marker pair: `|**text**|`.
  if (selected.length >= size * 2 && selected.startsWith(marker) && selected.endsWith(marker)) {
    const inner = selected.slice(size, selected.length - size);
    return { value: value.slice(0, start) + inner + value.slice(end), selectionStart: start, selectionEnd: start + inner.length };
  }

  const inner = selected || placeholder;
  return {
    value: value.slice(0, start) + marker + inner + marker + value.slice(end),
    selectionStart: start + size,
    selectionEnd: start + size + inner.length,
  };
}

/** Expands a selection to whole lines and hands each line to `transform`. */
function transformLines(state: TextEdit, transform: (lines: string[]) => string[]): TextEdit {
  const { value, selectionStart, selectionEnd } = state;
  const blockStart = value.lastIndexOf("\n", selectionStart - 1) + 1;
  // A selection that ends right after a newline does not include the following line.
  const effectiveEnd = selectionEnd > selectionStart && value[selectionEnd - 1] === "\n" ? selectionEnd - 1 : selectionEnd;
  const nextBreak = value.indexOf("\n", effectiveEnd);
  const blockEnd = nextBreak === -1 ? value.length : nextBreak;
  const replaced = transform(value.slice(blockStart, blockEnd).split("\n")).join("\n");
  const nextValue = value.slice(0, blockStart) + replaced + value.slice(blockEnd);
  if (selectionStart === selectionEnd) {
    // Keep the caret on the same character of the line it was on.
    const delta = replaced.length - (blockEnd - blockStart);
    const caret = Math.max(blockStart, selectionStart + delta);
    return { value: nextValue, selectionStart: caret, selectionEnd: caret };
  }
  return { value: nextValue, selectionStart: blockStart, selectionEnd: blockStart + replaced.length };
}

function stripBlockMarkers(line: string): { indent: string; text: string } {
  const list = line.match(LIST_MARKER);
  if (list) return { indent: list[1], text: line.slice(list[0].length) };
  const heading = line.match(HEADING_MARKER);
  if (heading) return { indent: "", text: line.slice(heading[0].length) };
  const indent = line.match(/^\s*/)?.[0] ?? "";
  return { indent, text: line.slice(indent.length) };
}

function toggleLinePrefix(
  state: TextEdit,
  isApplied: (line: string) => boolean,
  apply: (indent: string, text: string, index: number) => string,
): TextEdit {
  return transformLines(state, (lines) => {
    const content = lines.filter((line) => line.trim());
    const allApplied = content.length > 0 && content.every(isApplied);
    let counter = 0;
    return lines.map((line) => {
      if (!line.trim() && lines.length > 1) return line;
      const { indent, text } = stripBlockMarkers(line);
      if (allApplied) return indent + text;
      const result = apply(indent, text, counter);
      counter += 1;
      return result;
    });
  });
}

function toggleHeading(state: TextEdit, level: number): TextEdit {
  const marker = `${"#".repeat(level)} `;
  return toggleLinePrefix(
    state,
    (line) => new RegExp(`^\\s{0,3}#{${level}}\\s+`).test(line),
    (_indent, text) => marker + text,
  );
}

function toggleQuote(state: TextEdit): TextEdit {
  return transformLines(state, (lines) => {
    const content = lines.filter((line) => line.trim());
    const allQuoted = content.length > 0 && content.every((line) => QUOTE_MARKER.test(line));
    return lines.map((line) => {
      if (allQuoted) return line.replace(QUOTE_MARKER, "$1");
      return line.trim() || lines.length === 1 ? `> ${line}` : ">";
    });
  });
}

/** Inserts `block` as its own paragraph, padding with blank lines only where they are missing. */
function insertBlock(state: TextEdit, block: string, select?: { from: number; to: number }): TextEdit {
  const { value, selectionStart: start, selectionEnd: end } = state;
  const before = value.slice(0, start);
  const after = value.slice(end);
  const lead = !before || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const trail = !after || after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";
  const offset = before.length + lead.length;
  const caret = offset + block.length;
  return {
    value: before + lead + block + trail + after,
    selectionStart: select ? offset + select.from : caret,
    selectionEnd: select ? offset + select.to : caret,
  };
}

function insertLink(state: TextEdit): TextEdit {
  const { value, selectionStart: start, selectionEnd: end } = state;
  const selected = value.slice(start, end);
  const isUrl = /^(https?:\/\/|mailto:)\S+$/i.test(selected.trim());
  const text = isUrl ? "link text" : selected || "link text";
  const url = isUrl ? selected.trim() : "https://";
  const inserted = `[${text}](${url})`;
  // Select whichever half still needs typing.
  const selectFrom = isUrl || !selected ? start + 1 : start + text.length + 3;
  const selectLength = isUrl || !selected ? text.length : url.length;
  return {
    value: value.slice(0, start) + inserted + value.slice(end),
    selectionStart: selectFrom,
    selectionEnd: selectFrom + selectLength,
  };
}

function insertWikilink(state: TextEdit): TextEdit {
  const { value, selectionStart: start, selectionEnd: end } = state;
  const inner = value.slice(start, end) || "page name";
  return {
    value: `${value.slice(0, start)}[[${inner}]]${value.slice(end)}`,
    selectionStart: start + 2,
    selectionEnd: start + 2 + inner.length,
  };
}

const TABLE_TEMPLATE = "| Column | Column |\n| --- | --- |\n| Value | Value |";

export function applyMarkdownAction(state: TextEdit, action: MarkdownAction): TextEdit {
  const inline = INLINE_MARKERS[action];
  if (inline) return toggleInline(state, inline.marker, inline.placeholder);

  switch (action) {
    case "link":
      return insertLink(state);
    case "wikilink":
      return insertWikilink(state);
    case "heading2":
      return toggleHeading(state, 2);
    case "heading3":
      return toggleHeading(state, 3);
    case "bulletList":
      return toggleLinePrefix(state, (line) => /^\s*[-*+]\s+(?!\[[ xX]\]\s)/.test(line), (indent, text) => `${indent}- ${text}`);
    case "numberedList":
      return toggleLinePrefix(state, (line) => /^\s*\d+[.)]\s+/.test(line), (indent, text, index) => `${indent}${index + 1}. ${text}`);
    case "taskList":
      return toggleLinePrefix(state, (line) => /^\s*[-*+]\s+\[[ xX]\]\s+/.test(line), (indent, text) => `${indent}- [ ] ${text}`);
    case "quote":
      return toggleQuote(state);
    case "codeBlock": {
      const selected = state.value.slice(state.selectionStart, state.selectionEnd) || "code";
      return insertBlock(state, `\`\`\`\n${selected}\n\`\`\``, { from: 4, to: 4 + selected.length });
    }
    case "table":
      return insertBlock(state, TABLE_TEMPLATE, { from: 2, to: 8 });
    case "divider":
      return insertBlock(state, "---");
    default:
      return state;
  }
}

/**
 * Enter inside a list continues it; Enter on an empty item ends the list. Returns null when
 * the caret is not in a list, so the browser handles the key normally.
 */
export function continueListOnEnter(state: TextEdit): TextEdit | null {
  const { value, selectionStart: start, selectionEnd: end } = state;
  if (start !== end) return null;
  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  const line = value.slice(lineStart, start);
  const match = line.match(/^(\s*)([-*+]|\d+[.)])(\s+)(\[[ xX]\]\s+)?/);
  if (!match) return null;

  const [prefix, indent, bullet, gap, task] = match;
  if (line.length === prefix.length) {
    // Empty item: drop the marker and leave a plain line.
    return { value: value.slice(0, lineStart) + value.slice(start), selectionStart: lineStart, selectionEnd: lineStart };
  }
  const numbered = bullet.match(/^(\d+)([.)])$/);
  const nextBullet = numbered ? `${Number(numbered[1]) + 1}${numbered[2]}` : bullet;
  const inserted = `\n${indent}${nextBullet}${gap}${task ? "[ ] " : ""}`;
  const caret = start + inserted.length;
  return { value: value.slice(0, start) + inserted + value.slice(end), selectionStart: caret, selectionEnd: caret };
}

/**
 * Tab and Shift+Tab nest list items. Returns null outside a list so Tab keeps moving focus,
 * which keyboard users rely on to leave the editor.
 */
export function indentListOnTab(state: TextEdit, outdent: boolean): TextEdit | null {
  const { value, selectionStart } = state;
  const lineStart = value.lastIndexOf("\n", selectionStart - 1) + 1;
  const lineEnd = value.indexOf("\n", selectionStart);
  const firstLine = value.slice(lineStart, lineEnd === -1 ? value.length : lineEnd);
  if (!LIST_MARKER.test(firstLine)) return null;
  return transformLines(state, (lines) => lines.map((line) => {
    if (!outdent) return line.trim() ? `  ${line}` : line;
    return line.replace(/^( {1,2}|\t)/, "");
  }));
}

export interface TextChange {
  start: number;
  end: number;
  insert: string;
}

/** The smallest replacement that turns `before` into `after`, so undo history stays granular. */
export function computeTextChange(before: string, after: string): TextChange {
  let prefix = 0;
  const maxPrefix = Math.min(before.length, after.length);
  while (prefix < maxPrefix && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  const maxSuffix = Math.min(before.length, after.length) - prefix;
  while (suffix < maxSuffix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;
  return { start: prefix, end: before.length - suffix, insert: after.slice(prefix, after.length - suffix) };
}
