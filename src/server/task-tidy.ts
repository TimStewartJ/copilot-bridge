// Tidying a task's standing instructions and notes. Instructions are read by every session of a
// task, and notes travel with its messages, so dated stories, ids of past items and reference
// material in them cost every later session and can mislead it. A tidy-up runs in a chat of its
// own: it proposes moves, the user picks which to apply, and only then does it change anything.
// Helm's weekly look offers one for tasks that show the signs below; a task's menu starts one too.
import type { AppContext } from "./app-context.js";
import { resolveSessionCreationOptions } from "./session-creation-options.js";
import type { Task } from "./task-store.js";

const MONTH = "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)(?![a-z])\\.?";
const DATED_REFERENCE = new RegExp(
  `\\b${MONTH}\\s?\\d{1,2}(?:st|nd|rd|th)?\\b|\\b\\d{1,2}\\s?${MONTH}|\\b\\d{4}-\\d{2}-\\d{2}\\b`,
  "gi",
);
const ID = /(?<![0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f])/gi;
/** A rule may cite when it was verified; this many dated mentions usually means stories. */
const DATED_REFERENCES_FLAGGED = 3;
const LONG_INSTRUCTIONS = 6_000;
const LONG_NOTES = 12_000;

/** Signs, in plain words, that a task's instructions or notes need tidying. Empty when they look fine. */
export function taskTidyHints(task: Pick<Task, "instructions" | "notes">): string[] {
  const hints: string[] = [];
  const instructions = task.instructions ?? "";
  const dates = (instructions.match(DATED_REFERENCE) ?? []).length;
  if (dates >= DATED_REFERENCES_FLAGGED) hints.push(`instructions mention specific dates ${dates} times`);
  const ids = new Set(instructions.match(ID) ?? []).size;
  if (ids > 0) hints.push(`instructions hold ${ids} ${ids === 1 ? "id" : "ids"} of specific items`);
  if (instructions.length > LONG_INSTRUCTIONS) hints.push(`instructions are ${instructions.length.toLocaleString("en-US")} characters`);
  if (task.notes.length > LONG_NOTES) hints.push(`notes are ${task.notes.length.toLocaleString("en-US")} characters`);
  return hints;
}

export function buildTaskTidyPrompt(task: Pick<Task, "id" | "title" | "kind" | "doneWhen">): string {
  return [
    `Tidy the standing instructions and notes of the task "${task.title}" (taskId: ${task.id}). Read them first with task_get_info.`,
    "",
    "Where each kind of information belongs:",
    "- Instructions: lasting rules for every session, written as general principles that make sense to someone who was not there. Not stories of what went wrong, one-off exceptions, dated events or the ids of past items.",
    "- Notes: the current state of the work and what to do next, kept short.",
    "- Task history (task_history_add): what happened and when, including one-off exceptions and dated decisions.",
    "- A docs page linked from the notes: reference material such as measured facts, how-tos and long background.",
    "- Facts that change, such as balances, prices, statuses or someone else's deadlines: where to check them, or the value with the date it was true.",
    ...(task.kind !== "ongoing" && !task.doneWhen?.trim()
      ? ["- This task has no \"done when\". Suggest one: what must be true, checkable by someone else, for it to be finished."]
      : []),
    "",
    "How to do it:",
    "1. Propose before changing anything: each move (what, from where, to where), anything you would drop and why, the full new instructions text, and what stays in the notes.",
    "2. Keep every rule the user wrote that may still apply. When you are not sure whether one still applies, keep it and ask.",
    "3. Ask the user with ask_user which changes to apply.",
    "4. Before applying, read the task again. If its instructions or notes changed since your proposal, propose again from the new text.",
    "5. Apply docs pages first, then history entries, then task_update, so nothing is lost if a step fails. Nothing you remove may disappear: it moves to history or a docs page, or the user agreed to drop it.",
    "6. Report what moved where.",
  ].join("\n");
}

export type TaskTidyLaunch =
  | { ok: true; sessionId: string }
  /** The chat exists but its first message was not confirmed; open it rather than starting another. */
  | { ok: false; sessionId: string; error: string };

/** Starts a chat on the task that tidies it, and waits until its first message is accepted. */
export async function startTaskTidyChat(
  ctx: Pick<AppContext, "settingsStore" | "sessionManager" | "taskAgentDefinitionStore" | "taskStore">,
  taskId: string,
  onCreated?: () => void,
): Promise<TaskTidyLaunch> {
  const task = ctx.taskStore.getTask(taskId);
  if (!task) throw new Error("Task not found");
  const creation = await resolveSessionCreationOptions(ctx, {}, { taskId });
  if (creation.error) throw new Error(creation.error);
  // Created in the foreground, so a chat that failed to start is an error rather than a chat to open.
  const { sessionId } = await ctx.sessionManager.createTaskSession(
    task.id, task.title, task.workItems, task.notes, task.cwd, undefined, creation.options,
  );
  ctx.taskStore.linkSession(task.id, sessionId);
  onCreated?.();
  try {
    await ctx.sessionManager.startWorkAndWaitForDelivery(sessionId, buildTaskTidyPrompt(task));
    return { ok: true, sessionId };
  } catch (error) {
    return { ok: false, sessionId, error: error instanceof Error ? error.message : String(error) };
  }
}
