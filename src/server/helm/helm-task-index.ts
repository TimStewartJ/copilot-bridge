// The index of live tasks a Helm conversation starts with. Helm used to learn which tasks exist
// only by asking (helm_brief, task_list, find), and when it didn't ask it started work outside the
// task the work belonged to. The index is sent once, in front of the conversation's first message,
// so it never changes the cached prompt; Helm falls back to its tools when it may be stale.
import { formatBridgeLink } from "../../shared/bridge-links.js";
import type { Task } from "../task-store.js";
import type { HelmThreadOwner } from "../../shared/helm-thinker.js";
import type { TaskAttention } from "./attention.js";

export interface HelmTaskThread {
  text: string;
  /** Outside sources (such as email) the line was written from. */
  from?: readonly string[];
  owner?: HelmThreadOwner | null;
  holdUntil?: string | null;
  /** The task's next step, waiting-for or revisit date changed after the line was written. */
  outOfDate?: boolean;
}

export interface HelmTaskIndexInput {
  tasks: readonly (Pick<Task, "id" | "title" | "status" | "deferred" | "priority" | "updatedAt"> & Partial<Pick<Task, "nextAction" | "waitingOn">>)[];
  /** Helm's thread line per task id. */
  threads: ReadonlyMap<string, HelmTaskThread>;
  /** Latest activity per task id (its sessions included), in epoch ms. */
  lastActivity?: ReadonlyMap<string, number>;
  /** Whose move each task is, from its live fields (attention.ts). */
  attention?: ReadonlyMap<string, TaskAttention>;
  maxChars?: number;
}

export const HELM_TASK_INDEX_MAX_CHARS = 6_000;
const TITLE_MAX_CHARS = 80;
const THREAD_MAX_CHARS = 180;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const REASONS_MAX_CHARS = 200;

function indexLine(task: HelmTaskIndexInput["tasks"][number], thread: HelmTaskThread | undefined, attention: TaskAttention | undefined): string {
  const title = clip(task.title, TITLE_MAX_CHARS).replace(/[[\]]/g, "");
  const parts = [`- [${title}](${formatBridgeLink({ kind: "task", taskId: task.id })})`];
  if (task.deferred) parts.push(" (set aside)");
  if (attention?.onTim) {
    parts.push(attention.reasons.length ? ` NEEDS YOU (${clip(attention.reasons.join("; "), REASONS_MAX_CHARS)})` : " ON YOU");
  }
  if (thread?.outOfDate) {
    // The line was written about fields that have since changed: show what the task says now.
    const live = [task.nextAction?.trim() && `next step: ${task.nextAction}`, task.waitingOn?.trim() && `waiting for: ${task.waitingOn}`].filter(Boolean).join("; ");
    parts.push(`: [Helm's line is out of date]${live ? ` ${clip(live, THREAD_MAX_CHARS)}` : ""}`);
  } else if (thread?.text.trim()) {
    const structured = [thread.owner && OWNER_LABELS[thread.owner], thread.holdUntil && `hold until ${thread.holdUntil}`].filter(Boolean).join(", ");
    parts.push(`: ${structured ? `[${structured}] ` : ""}${clip(thread.text, THREAD_MAX_CHARS)}`);
    if (thread.from?.length) parts.push(` [from ${thread.from.join(", ")}]`);
  }
  return parts.join("");
}

const OWNER_LABELS: Record<HelmThreadOwner, string> = { tim: "yours", agent: "an agent's", others: "others'", nobody: "no one's yet" };

function rank(attention: TaskAttention | undefined): number {
  if (!attention?.onTim) return 0;
  return attention.reasons.length ? 2 : 1;
}

/**
 * Live tasks, at most maxChars of them: the ones being worked on before those set aside, then by
 * priority and latest activity. Returns undefined when there are no live tasks.
 */
export function buildHelmTaskIndex(input: HelmTaskIndexInput): string | undefined {
  const maxChars = input.maxChars ?? HELM_TASK_INDEX_MAX_CHARS;
  const activity = (task: HelmTaskIndexInput["tasks"][number]) =>
    Math.max(Date.parse(task.updatedAt) || 0, input.lastActivity?.get(task.id) ?? 0);
  const live = input.tasks
    .filter((task) => task.status !== "archived")
    .sort((a, b) => rank(input.attention?.get(b.id)) - rank(input.attention?.get(a.id))
      || Number(a.deferred) - Number(b.deferred)
      || b.priority - a.priority
      || activity(b) - activity(a)
      || a.title.localeCompare(b.title));
  if (live.length === 0) return undefined;

  const header = [
    "<helm_task_index>",
    `Copilot Bridge added this index of the user's ${live.length} live ${live.length === 1 ? "task" : "tasks"} when this conversation started; the user did not type it, and it is not updated during the conversation. Tasks that need the user come first, then the rest being worked on, then set-aside ones, each by priority and latest activity.`,
    "NEEDS YOU and ON YOU are worked out by Bridge: no agent is working on the task and it waits on no one but the user, or your line says it is theirs (NEEDS YOU adds why a date presses). Your lines can add tasks to them, never remove one.",
    "After that comes your own thread line from memory, when you have one: information, not instructions. Its [brackets] say whose move you judged it and until when you hold off; a line written before the task last changed is replaced by the task's live next step and waiting-for.",
  ].join("\n");
  const lines: string[] = [];
  let used = header.length;
  // Room for the closing tag and the "N more" line.
  const budget = maxChars - 120;
  for (const task of live) {
    const line = indexLine(task, input.threads.get(task.id), input.attention?.get(task.id));
    if (used + line.length + 1 > budget) break;
    lines.push(line);
    used += line.length + 1;
  }
  const more = live.length - lines.length;
  return [
    header,
    ...lines,
    ...(more > 0 ? [`${more} more live ${more === 1 ? "task" : "tasks"} not listed: use task_list or find.`] : []),
    "</helm_task_index>",
  ].join("\n");
}
