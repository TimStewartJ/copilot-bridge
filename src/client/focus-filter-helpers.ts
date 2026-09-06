import type { ChecklistItem, FocusHistoryFilter, FocusObject, FocusReadFilters, Task } from "./api";
import { FOCUS_LIFECYCLE_LABELS } from "./focus-view-model";

export interface FocusTaskContext {
  taskId?: string | null;
  taskTitle?: string | null;
  taskState?: string;
  originalTaskId?: string | null;
  originalTaskTitle?: string | null;
  orphanedAt?: string | null;
}

export interface FocusTaskChoice {
  id: string;
  title: string;
  hint?: string;
}

export function focusTaskContext(object: FocusObject | ChecklistItem): FocusTaskContext {
  if ("details" in object) return {
    taskId: object.taskId, taskTitle: object.taskTitle, taskState: object.taskState,
    originalTaskId: object.details.originalTaskId, originalTaskTitle: object.details.originalTaskTitle,
    orphanedAt: object.details.orphanedAt,
  };
  return {
    taskId: object.taskId, originalTaskId: object.originalTaskId,
    originalTaskTitle: object.originalTaskTitle, orphanedAt: object.orphanedAt,
  };
}

export function focusTaskChoices(tasks: Task[], contexts: FocusTaskContext[], original = false): FocusTaskChoice[] {
  const choices = new Map<string, FocusTaskChoice>();
  for (const task of tasks) choices.set(task.id, {
    id: task.id, title: task.title, hint: task.status === "archived" ? "archived" : task.muted ? "muted" : undefined,
  });
  for (const context of contexts) {
    const id = original ? context.originalTaskId : context.taskId;
    const sameIdentity = context.taskId === context.originalTaskId;
    const title = original
      ? context.originalTaskTitle ?? (sameIdentity ? context.taskTitle : null)
      : context.taskTitle ?? (sameIdentity ? context.originalTaskTitle : null);
    if (!id || !title || choices.has(id)) continue;
    choices.set(id, {
      id, title,
      hint: original ? context.orphanedAt ? "removed" : "retained label"
        : context.taskState && context.taskState !== "global" ? context.taskState : "retained label",
    });
  }
  return [...choices.values()].sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
}

export function focusTaskChoiceLabel(id: string, choices: FocusTaskChoice[]): string {
  const choice = choices.find((entry) => entry.id === id);
  if (!choice) return `Unlisted task (${id})`;
  const duplicate = choices.some((entry) => entry.id !== id && entry.title === choice.title);
  return `${choice.title}${choice.hint ? ` (${choice.hint})` : ""}${duplicate ? ` [${id}]` : ""}`;
}

export function normalizeFocusReadFilter(input: FocusReadFilters): FocusReadFilters {
  const result: FocusReadFilters = {};
  for (const key of ["query", "taskId", "originalTaskId", "sourceFamily", "activationId"] as const) {
    const value = input[key]?.trim();
    if (value) result[key] = value;
  }
  if (input.lifecycle) result.lifecycle = input.lifecycle;
  return result;
}

export function describeFocusFilters(filter: FocusHistoryFilter, tasks: FocusTaskChoice[], originals: FocusTaskChoice[]): string {
  const labels: string[] = [];
  if (filter.query) labels.push(`Search: ${filter.query}`);
  if (filter.taskId) labels.push(`Task: ${focusTaskChoiceLabel(filter.taskId, tasks)}`);
  if (filter.originalTaskId) labels.push(`Original task: ${focusTaskChoiceLabel(filter.originalTaskId, originals)}`);
  if (filter.sourceFamily) labels.push(`Source family: ${filter.sourceFamily}`);
  if (filter.lifecycle) labels.push(`Lifecycle: ${FOCUS_LIFECYCLE_LABELS[filter.lifecycle]}`);
  if (filter.objectType) labels.push(`Record type: ${filter.objectType === "decision" ? "Decisions" : filter.objectType === "alert" ? "Alerts" : filter.objectType === "event" ? "Events" : "Actions"}`);
  if (filter.objectId) labels.push(`Object or Action ID: ${filter.objectId}`);
  if (filter.activationId) labels.push(`Episode ID: ${filter.activationId}`);
  return labels.join(" · ");
}
