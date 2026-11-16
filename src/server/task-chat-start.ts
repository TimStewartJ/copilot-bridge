// Starting a chat on a task with a prompt the Bridge writes, such as a tidy-up or a page, from one tap
// in the task panel. The chat is linked to the task and its first message is sent before this returns.
import type { AppContext } from "./app-context.js";
import { resolveSessionCreationOptions } from "./session-creation-options.js";
import type { Task } from "./task-store.js";

export type TaskChatLaunch =
  | { ok: true; sessionId: string }
  /** The chat exists but its first message was not confirmed; open it rather than starting another. */
  | { ok: false; sessionId: string; error: string };

/** Starts a chat on the task with `buildPrompt(task)` as its first message, and waits until it is accepted. */
export async function startTaskChat(
  ctx: Pick<AppContext, "settingsStore" | "sessionManager" | "taskStore">,
  taskId: string,
  buildPrompt: (task: Task) => string,
  onCreated?: () => void,
): Promise<TaskChatLaunch> {
  const task = ctx.taskStore.getTask(taskId);
  if (!task) throw new Error("Task not found");
  const creation = await resolveSessionCreationOptions(ctx, {});
  if (creation.error) throw new Error(creation.error);
  // Created in the foreground, so a chat that failed to start is an error rather than a chat to open.
  const { sessionId } = await ctx.sessionManager.createTaskSession(
    task.id, task.title, task.workItems, task.notes, task.cwd, undefined, creation.options,
  );
  ctx.taskStore.linkSession(task.id, sessionId);
  onCreated?.();
  try {
    await ctx.sessionManager.startWorkAndWaitForDelivery(sessionId, buildPrompt(task));
    return { ok: true, sessionId };
  } catch (error) {
    return { ok: false, sessionId, error: error instanceof Error ? error.message : String(error) };
  }
}

/** The first message of a chat that makes the task's page. It reads as something the user asked. */
export function buildTaskPagePrompt(task: Pick<Task, "id" | "title">): string {
  return [
    `Make a page for the task "${task.title}" (taskId: ${task.id}) and publish it with task_page_publish.`,
    "Read the task first (task_get_info, its checklist and recent history) so the page shows what it holds now.",
    "When it is published, tell me in one line.",
  ].join("\n");
}
