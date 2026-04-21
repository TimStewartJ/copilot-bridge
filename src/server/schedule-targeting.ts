import type { ScheduleSessionMode } from "./schedule-store.js";
import type { TaskStore } from "./task-store.js";
import { err, ok, type Result } from "./tool-results.js";

export const SCHEDULE_SESSION_MODES = ["new", "reuse-last", "reuse-target"] as const;

export interface ScheduleSessionSelection {
  sessionMode: ScheduleSessionMode;
  targetSessionId?: string;
}

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
): Promise<Result<ScheduleSessionSelection>> {
  const sessionModeValue = input.sessionMode ?? opts.defaultSessionMode ?? "new";
  if (!isScheduleSessionMode(sessionModeValue)) {
    return err(`Invalid sessionMode: ${String(sessionModeValue)}`);
  }

  const sessionMode = sessionModeValue;
  const explicitTargetSessionId = normalizeTargetSessionId(input.targetSessionId);
  if (explicitTargetSessionId && sessionMode !== "reuse-target") {
    return err("targetSessionId requires sessionMode 'reuse-target'");
  }

  if (sessionMode !== "reuse-target") {
    return ok({ sessionMode });
  }

  const targetSessionId = explicitTargetSessionId ?? normalizeTargetSessionId(opts.defaultTargetSessionId);
  if (!targetSessionId) {
    return err("targetSessionId is required for reuse-target mode");
  }

  const task = opts.taskStore.getTask(opts.taskId);
  if (!task) {
    return err("Task not found");
  }
  if (!task.sessionIds.includes(targetSessionId)) {
    return err("Target session must already be linked to the same task");
  }

  const sessions = await opts.listSessionsFromDisk();
  if (!sessions.some((session) => session.sessionId === targetSessionId)) {
    return err("Target session not found");
  }

  return ok({ sessionMode, targetSessionId });
}
