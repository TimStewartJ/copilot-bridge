// The attention checks on this Bridge's own tasks, read straight from its stores. Used for the
// thinker's packet, the task index a Helm chat starts with, and helm_brief.
import type { AppContext } from "../app-context.js";
import { buildTaskOverview } from "../task-overview.js";
import type { TaskOverviewRow } from "../../shared/task-overview.js";
import type { HelmMemoryEntry } from "../../shared/helm-thinker.js";
import { attentionOfRow, byAttention, taskBasis, upcomingAbsences, type AttentionInputs, type TaskAttention } from "./attention.js";

const LOCAL_THREAD = "local:";

/** Helm's active thread lines for this Bridge's tasks, by task id. */
export function localThreads(ctx: Partial<Pick<AppContext, "helmThinker">>): Map<string, HelmMemoryEntry> {
  const entries = ctx.helmThinker?.listMemory() ?? [];
  return new Map(entries.filter((entry) => entry.kind === "thread" && entry.status === "active" && entry.key?.startsWith(LOCAL_THREAD))
    .map((entry) => [entry.key!.slice(LOCAL_THREAD.length), entry]));
}

/**
 * Helm's line was written before the task's next step, waiting-for or revisit date last changed (or
 * before lines recorded them). A line Tim corrected is his own words and Helm can't rewrite it, so it never is.
 */
export function threadOutOfDate(entry: Pick<HelmMemoryEntry, "basis" | "author">, task: { nextAction?: string | null; waitingOn?: string | null; nextTouchAt?: string | null }): boolean {
  return entry.author !== "user" && entry.basis !== taskBasis(task);
}

type AttentionStores = Pick<AppContext, "taskStore"> & Partial<Pick<AppContext, "checklistStore" | "calendarStore" | "helmThinker">>;

export function localAttentionInputs(ctx: AttentionStores, now: Date, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): AttentionInputs {
  let absences: AttentionInputs["absences"] = [];
  try {
    absences = upcomingAbsences(ctx.calendarStore?.listEvents() ?? [], { now, timeZone });
  } catch {
    // Without the calendar, dates still count; only "before time away" is missed.
  }
  const open = new Map<string, Array<{ text: string; deadline?: string }>>();
  try {
    for (const item of ctx.checklistStore?.listAllOpenChecklistItems() ?? []) {
      if (!item.taskId) continue;
      const list = open.get(item.taskId) ?? [];
      list.push({ text: item.text, ...(item.deadline ? { deadline: item.deadline } : {}) });
      open.set(item.taskId, list);
    }
  } catch {
    // Checklist dates are one signal among several.
  }
  let threads = new Map<string, HelmMemoryEntry>();
  try {
    threads = localThreads(ctx);
  } catch {
    // Helm's own view only adds to what needs Tim; without it the fields still decide.
  }
  return {
    timeZone,
    absences,
    helm: (taskId) => threads.get(taskId),
    local: (taskId) => {
      const task = ctx.taskStore.getTask(taskId);
      return { ...(task?.notes ? { notes: task.notes } : {}), checklist: open.get(taskId) ?? [] };
    },
  };
}

export interface LiveTaskAttention {
  row: TaskOverviewRow;
  attention: TaskAttention;
}

/**
 * Every live local task with its attention, those needing Tim first. Synchronous: a conversation's
 * first message is built without waiting. A task counts as worked on when one of its conversations is busy.
 */
export function liveLocalAttention(ctx: AppContext, now = new Date()): LiveTaskAttention[] {
  const inputs = localAttentionInputs(ctx, now);
  const overview = buildTaskOverview(ctx, null, now.getTime());
  const archived = new Set(ctx.sessionMetaStore?.listArchivedSessionIds() ?? []);
  return overview.tasks.map((row) => {
    const task = ctx.taskStore.getTask(row.id);
    const busyCount = (task?.sessionIds ?? []).filter((id) => !archived.has(id) && ctx.sessionManager.getSessionRunState(id) === "busy").length;
    const live = { ...row, busyCount };
    return { row: live, attention: attentionOfRow(live, inputs, now) };
  }).sort(byAttention);
}
