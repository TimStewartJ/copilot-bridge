// Suggested chats on a task: a few ready prompts Helm leaves on the task panel. Tapping one opens a
// new chat on the task with the prompt in the composer. Helm's looks write them for the tasks they
// look at, and the panel's refresh asks Helm for just that task. Shared by the server and the client.
import { isPlaybookName } from "./workflow-vocabulary.js";

export const TASK_STARTERS_MAX = 3;
export const TASK_STARTER_LABEL_MAX = 60;
export const TASK_STARTER_PROMPT_MAX = 2000;

/** helm: a scheduled look; refresh: the panel's refresh button; auto: after a chat on the task went quiet. */
export type TaskStarterSource = "helm" | "refresh" | "auto";
export type TaskStarterRefreshTrigger = "manual" | "auto";

export interface TaskStarter {
  id: string;
  taskId: string;
  label: string;
  prompt: string;
  /** A playbook for the chat, or "none" for the direct path; unset lets the chat choose. */
  playbook?: string;
  source: TaskStarterSource;
  createdAt: string;
}

export interface TaskStartersResponse {
  starters: TaskStarter[];
  refreshing: boolean;
  /** Why the last refresh of this task failed, until the next one starts. */
  error?: string;
}

export type TaskStarterDraft = Pick<TaskStarter, "label" | "prompt" | "playbook">;

export type TaskStarterValidation =
  | { ok: true; starters: TaskStarterDraft[] }
  | { ok: false; errors: string[] };

/** Checks a writer's list of suggested chats. `where` prefixes each error so a model can fix it. */
export function validateTaskStarters(raw: unknown, where = "chats"): TaskStarterValidation {
  if (!Array.isArray(raw) || raw.length > TASK_STARTERS_MAX) {
    return { ok: false, errors: [`${where} must be a list of at most ${TASK_STARTERS_MAX}`] };
  }
  const errors: string[] = [];
  const starters: TaskStarterDraft[] = [];
  const labels = new Set<string>();
  raw.forEach((entry, index) => {
    const at = `${where} ${index + 1}`;
    const value = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    const label = typeof value.label === "string" ? value.label.trim() : "";
    const prompt = typeof value.prompt === "string" ? value.prompt.trim() : "";
    if (!label || label.length > TASK_STARTER_LABEL_MAX) errors.push(`${at}: label is required (at most ${TASK_STARTER_LABEL_MAX} characters)`);
    if (!prompt || prompt.length > TASK_STARTER_PROMPT_MAX) errors.push(`${at}: prompt is required (at most ${TASK_STARTER_PROMPT_MAX} characters)`);
    if (value.playbook !== undefined && value.playbook !== null && !isPlaybookName(value.playbook)) errors.push(`${at}: playbook must be a playbook name or "none"`);
    if (label && labels.has(label.toLowerCase())) errors.push(`${at}: another chat already has the label "${label}"`);
    labels.add(label.toLowerCase());
    if (!label || !prompt) return;
    starters.push({ label, prompt, ...(typeof value.playbook === "string" ? { playbook: value.playbook } : {}) });
  });
  return errors.length ? { ok: false, errors } : { ok: true, starters };
}
