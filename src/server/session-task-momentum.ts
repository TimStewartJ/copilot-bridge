import type { Task } from "./task-store.js";
import { escapePromptLiteral, escapePromptText, normalizeInlineText } from "./session-formatting.js";

function formatTaskMomentumValue(value: string): string {
  return escapePromptText(normalizeInlineText(value));
}

export function formatTaskMomentumContext(task: Task): string | undefined {
  const lines: string[] = [];
  const hasNextAction = !!task.nextAction?.trim();
  const hasWaitingOn = !!task.waitingOn?.trim();
  const hasNextTouchAt = !!task.nextTouchAt?.trim();

  if (task.deferred) {
    lines.push("- Deferred: set aside from Home's Continue working until explicitly resumed. A revisit brings it back for review only. Running sessions, schedules and session defers are not paused.");
  }
  if (task.kind !== "ongoing" && task.doneWhen?.trim()) {
    lines.push(`- Done when: ${formatTaskMomentumValue(task.doneWhen)}`);
  }
  if (hasNextAction) {
    lines.push(`- Next step: ${formatTaskMomentumValue(task.nextAction!)}`);
  }
  if (hasWaitingOn) {
    lines.push(`- Waiting for: ${formatTaskMomentumValue(task.waitingOn!)}`);
  }
  if (hasNextTouchAt) {
    lines.push(`- Revisit on: ${escapePromptLiteral(task.nextTouchAt!)}`);
  }
  if (task.status === "active" && !hasNextAction && !hasWaitingOn && !hasNextTouchAt) {
    lines.push("- No next step, wait or revisit recorded. This context is optional; do not invent work to fill it.");
  }

  return lines.length > 0 ? `Where this task stands:\n${lines.join("\n")}` : undefined;
}
