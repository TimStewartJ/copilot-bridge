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

  if (task.kind !== "ongoing" && task.doneWhen?.trim()) {
    lines.push(`- Done when: ${formatTaskMomentumValue(task.doneWhen)}`);
  }
  if (hasNextAction) {
    lines.push(`- Next action: ${formatTaskMomentumValue(task.nextAction!)}`);
  }
  if (hasWaitingOn) {
    lines.push(`- Waiting on: ${formatTaskMomentumValue(task.waitingOn!)}`);
  }
  if (hasNextTouchAt) {
    lines.push(`- Follow up: ${escapePromptLiteral(task.nextTouchAt!)}`);
  }
  if (task.status === "active" && !hasNextAction && !hasWaitingOn && !hasNextTouchAt) {
    lines.push("- Next action / waiting on / follow up: none set.");
  }

  return lines.length > 0 ? `Task momentum:\n${lines.join("\n")}` : undefined;
}
