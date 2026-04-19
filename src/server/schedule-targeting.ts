import type { ScheduleSessionMode } from "./schedule-store.js";
import type { TaskStore } from "./task-store.js";

export const SCHEDULE_SESSION_MODES = ["new", "reuse-last", "reuse-target"] as const;

function normalizeTargetSessionId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function isScheduleSessionMode(value: unknown): value is ScheduleSessionMode {
  return typeof value === "string" && (SCHEDULE_SESSION_MODES as readonly string[]).includes(value);
}

export async function resolveScheduleSessionSelection(
  input: { sessionMode?: unknown; targetSessionId?: unknown },
  opts: {
    taskId: string;
    taskStore: Pick<TaskStore, "getTask">;
    listSessionsFromDisk: () => Promise<Array<{ sessionId: string }>> | Array<{ sessionId: string }>;
    defaultSessionMode?: ScheduleSessionMode;
    defaultTargetSessionId?: string;
  },
): Promise<{ sessionMode: ScheduleSessionMode; targetSessionId?: string } | { error: string }> {
  const sessionModeValue = input.sessionMode ?? opts.defaultSessionMode ?? "new";
  if (!isScheduleSessionMode(sessionModeValue)) {
    return { error: `Invalid sessionMode: ${String(sessionModeValue)}` };
  }

  const sessionMode = sessionModeValue;
  const explicitTargetSessionId = normalizeTargetSessionId(input.targetSessionId);
  if (explicitTargetSessionId && sessionMode !== "reuse-target") {
    return { error: "targetSessionId requires sessionMode 'reuse-target'" };
  }

  if (sessionMode !== "reuse-target") {
    return { sessionMode };
  }

  const targetSessionId = explicitTargetSessionId ?? normalizeTargetSessionId(opts.defaultTargetSessionId);
  if (!targetSessionId) {
    return { error: "targetSessionId is required for reuse-target mode" };
  }

  const task = opts.taskStore.getTask(opts.taskId);
  if (!task) {
    return { error: "Task not found" };
  }
  if (!task.sessionIds.includes(targetSessionId)) {
    return { error: "Target session must already be linked to the same task" };
  }

  const sessions = await opts.listSessionsFromDisk();
  if (!sessions.some((session) => session.sessionId === targetSessionId)) {
    return { error: "Target session not found" };
  }

  return { sessionMode, targetSessionId };
}
