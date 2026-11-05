import { createHash } from "node:crypto";

export type TaskNotesSource = "task" | "group";
/** Notes up to this length travel whole with a chat's messages; longer ones travel as their start. */
export const TASK_NOTES_BRIEF_LENGTH = 8000;
/** Keeps a page under the 20 KB at which the CLI moves a tool's result to a file. */
const PAGE_LENGTH = 16_000;

function notesHash(prefix: string, notes: string): string {
  return createHash("sha256").update(prefix).update(notes).digest("hex").slice(0, 16);
}

/** Identifies the full source, not just the part shown in a brief or page. */
export function taskNotesRevision(notes: string): string {
  return notesHash("", notes);
}

/** Handed out only to a reader of the whole notes, so the revision in a brief can't stand in for it. */
export function notesWriteTokenField(notes: string): { notesWriteToken?: string } {
  return notes.length > TASK_NOTES_BRIEF_LENGTH ? { notesWriteToken: notesHash("write:", notes) } : {};
}

/** Why these notes can't be replaced yet. An agent only has the start of long notes until it reads them. */
export function notesWriteRefusal(current: string, token: unknown): string | undefined {
  const { notesWriteToken } = notesWriteTokenField(current);
  if (!notesWriteToken || token === notesWriteToken) return undefined;
  return token === undefined
    ? "These notes are longer than the excerpt in your context. To change part of task notes use notesEdit; to replace them, read them to the end with task_get_info (task_group_list for group notes) and pass its notesWriteToken."
    : "These notes changed since you read them. Read them again and pass the new notesWriteToken.";
}

/** Changes one exact passage, so nothing else has to be read or sent back. */
export function applyNotesEdit(notes: string, oldStr: string, newStr: string): { notes: string } | { error: string } {
  if (!oldStr) return { error: "old_str must not be empty." };
  const first = notes.indexOf(oldStr);
  if (first < 0) return { error: "old_str is not in the notes. Copy it exactly from the notes." };
  if (notes.includes(oldStr, first + 1)) return { error: "old_str appears more than once. Include more text around it." };
  return { notes: notes.slice(0, first) + newStr + notes.slice(first + oldStr.length) };
}

export function sliceTaskNotes(notes: string, offset: number, length: number): string {
  let end = Math.min(offset + length, notes.length);
  // Returned offsets are UTF-16 positions, but a page must not split a character in two.
  if (end < notes.length && (notes.codePointAt(end - 1) ?? 0) > 0xffff) end--;
  return notes.slice(offset, end);
}

/** A continued read must name what it has read so far, so two versions can't be stitched into one. */
export function notesContinuationRefusal(notes: string, offset: number, revision: unknown): string | undefined {
  return offset === 0 || (revision === taskNotesRevision(notes) && offset <= notes.length)
    ? undefined
    : "These notes changed since that read. Read them again from the start, without offset.";
}

export function readTaskNotesPage(notes: string, offset: number) {
  const text = sliceTaskNotes(notes, offset, PAGE_LENGTH);
  const end = offset + text.length;
  return {
    text,
    revision: taskNotesRevision(notes),
    nextOffset: end < notes.length ? end : null,
    ...(end < notes.length ? {} : notesWriteTokenField(notes)),
  };
}
