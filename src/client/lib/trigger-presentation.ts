import type { DsStatusKind } from "../design/tokens";
import type { TriggerCheckOutcome, TriggerStatus, TriggerThen, TriggerView, TriggerWhen } from "../api";

const PROMPT_EXCERPT_CHARS = 60;

/** A trigger's name, or the start of its prompt when it has none. */
export function triggerLabel(trigger: Pick<TriggerView, "name" | "prompt">): string {
  if (trigger.name?.trim()) return trigger.name.trim();
  const firstLine = trigger.prompt.trim().split(/\r?\n/)[0] ?? "";
  return firstLine.length > PROMPT_EXCERPT_CHARS ? `${firstLine.slice(0, PROMPT_EXCERPT_CHARS - 1)}…` : firstLine || "Trigger";
}

export const TRIGGER_THEN_LABEL: Record<TriggerThen, string> = {
  worker: "Runs a worker",
  message: "Sends the prompt",
  new_chat: "Start a chat in this task",
  new_task: "Create a task",
};

/** Paused, finished and failed triggers can no longer fire on their own. */
export function isTriggerLive(status: TriggerStatus): boolean {
  return status === "active" || status === "running" || status === "paused";
}

/** "active" → "Active"; also used for delivery statuses. */
export function triggerStatusLabel(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export function triggerStatusKind(status: TriggerStatus): DsStatusKind {
  switch (status) {
    case "active": return "on";
    case "running": return "working";
    case "paused": return "paused";
    case "completed": return "done";
    case "failed": return "danger";
    case "cancelled":
    case "expired": return "closed";
  }
}

/** When it runs, for people: a one-time trigger shows its local time instead of the server's ISO string. */
export function formatTriggerWhen(when: TriggerWhen, whenLabel: string): string {
  if (when.kind === "at") return `Once, ${new Date(when.at).toLocaleString()}`;
  return whenLabel.charAt(0).toUpperCase() + whenLabel.slice(1);
}

export const TRIGGER_CHECK_OUTCOME_LABEL: Record<TriggerCheckOutcome, string> = {
  baseline: "Baseline",
  unchanged: "Unchanged",
  changed: "Changed",
  quiet: "Nothing to do",
  fired: "Fired",
};

export function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
