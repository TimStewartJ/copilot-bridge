import { isQuietIntervalDeferEvent } from "./event-transform.js";
import { readSdkSessionEvents } from "./sdk-session-events.js";

export const QUIET_INTERVAL_DEFER_TAIL_TRUNCATION_MODE = "replace-quiet-interval-defer-tail" as const;

export interface QuietIntervalDeferTailTruncationRequest {
  mode: typeof QUIET_INTERVAL_DEFER_TAIL_TRUNCATION_MODE;
  deferId: string;
}

export interface QuietIntervalDeferTailTruncationCandidate {
  eventId: string;
  eventsToRemove: number;
}

export type QuietIntervalDeferTailTruncationResult =
  | { status: "truncated"; eventId: string; eventsRemoved: number; candidateEventsToRemove: number }
  | { status: "skipped"; reason: "no-candidate" | "missing-api" }
  | { status: "failed"; reason: "read-events-failed" | "truncate-failed"; error: unknown };

interface TruncateQuietIntervalDeferTailOptions {
  session: {
    getEvents?: () => Promise<unknown>;
    truncateHistory?: (params: { eventId: string }) => Promise<{ eventsRemoved?: number } | undefined>;
  };
  sessionId: string;
  deferId: string;
  logger?: Pick<Console, "log" | "warn">;
  recordSpan?: (name: string, duration: number, sessionId?: string, metadata?: Record<string, unknown>) => void;
}

const COMPLETION_TERMINAL_EVENT_TYPES = new Set(["assistant.turn_end", "session.idle"]);
const FAILURE_TERMINAL_EVENT_TYPES = new Set(["session.error", "abort", "session.shutdown"]);
const TURN_ACTIVITY_EVENT_TYPES = new Set([
  "user.message",
  "assistant.turn_start",
  "assistant.message",
  "assistant.message_delta",
  "assistant.streaming_delta",
  "assistant.intent",
  "tool.execution_start",
  "tool.execution_progress",
  "tool.execution_partial_result",
  "tool.execution_complete",
  "subagent.started",
  "subagent.completed",
  "subagent.failed",
]);
const TRUNCATION_BLOCKED_TOOL_NAMES = new Set([
  "ask_user",
  "docs_write",
  "docs_edit",
  "docs_delete",
  "docs_db_create",
  "docs_db_add",
  "docs_db_update",
  "docs_db_delete",
  "docs_snapshot_create",
  "docs_snapshot_restore",
  "task_create",
  "task_update",
  "task_update_momentum",
  "task_link_work_item",
  "task_unlink_work_item",
  "task_link_pr",
  "task_unlink_pr",
  "task_group_create",
  "task_group_update",
  "task_group_delete",
  "checklist_add",
  "checklist_update",
  "checklist_remove",
  "tag_create",
  "tag_update",
  "tag_delete",
]);

function getToolName(event: any): string {
  const name = event?.data?.toolName ?? event?.data?.name;
  return typeof name === "string" ? name : "";
}

function blocksQuietDeferTruncation(toolName: string): boolean {
  return !toolName.trim() || TRUNCATION_BLOCKED_TOOL_NAMES.has(toolName);
}

function isCompletionTerminalEvent(event: any): boolean {
  return COMPLETION_TERMINAL_EVENT_TYPES.has(event?.type);
}

function isFailureTerminalEvent(event: any): boolean {
  return FAILURE_TERMINAL_EVENT_TYPES.has(event?.type);
}

function isTurnActivityEvent(event: any): boolean {
  return TURN_ACTIVITY_EVENT_TYPES.has(event?.type);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function findQuietIntervalDeferTailTruncationCandidate(
  events: unknown[],
  expectedDeferId: string,
): QuietIntervalDeferTailTruncationCandidate | undefined {
  const deferId = expectedDeferId.trim();
  if (!deferId) return undefined;

  let candidateIndex = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as any;
    if (event?.type !== "user.message") continue;
    if (!isQuietIntervalDeferEvent(event, deferId)) return undefined;
    candidateIndex = index;
    break;
  }

  if (candidateIndex < 0) return undefined;
  const candidate = events[candidateIndex] as any;
  if (typeof candidate?.id !== "string" || !candidate.id.trim()) return undefined;

  let completionTerminalIndex = -1;
  for (let index = candidateIndex + 1; index < events.length; index += 1) {
    const event = events[index] as any;

    if (event?.type === "user.message") return undefined;

    if (event?.type === "tool.execution_start") {
      const toolName = getToolName(event);
      if (blocksQuietDeferTruncation(toolName)) return undefined;
    }
    if (event?.type === "tool.execution_complete" && event?.data?.success !== true) {
      return undefined;
    }
    if (event?.type === "subagent.started" || event?.type === "subagent.completed" || event?.type === "subagent.failed") {
      return undefined;
    }
    if (isFailureTerminalEvent(event)) return undefined;

    if (isCompletionTerminalEvent(event)) {
      completionTerminalIndex = index;
    }
  }

  if (completionTerminalIndex < 0) return undefined;
  for (let index = completionTerminalIndex + 1; index < events.length; index += 1) {
    if (isTurnActivityEvent(events[index])) return undefined;
  }

  return {
    eventId: candidate.id,
    eventsToRemove: events.length - candidateIndex,
  };
}

export async function truncateQuietIntervalDeferTail({
  session,
  sessionId,
  deferId,
  logger = console,
  recordSpan,
}: TruncateQuietIntervalDeferTailOptions): Promise<QuietIntervalDeferTailTruncationResult> {
  const start = Date.now();
  const truncate = session.truncateHistory;
  if (typeof session.getEvents !== "function" || typeof truncate !== "function") {
    logger.warn(`[sdk] [${sessionId.slice(0, 8)}] Quiet defer history truncation unavailable`);
    recordSpan?.("session.history.truncate", Date.now() - start, sessionId, {
      outcome: "skipped",
      reason: "missing-api",
      deferId,
    });
    return { status: "skipped", reason: "missing-api" };
  }

  let rawEvents: unknown;
  try {
    rawEvents = await readSdkSessionEvents(session);
  } catch (error) {
    logger.warn(`[sdk] [${sessionId.slice(0, 8)}] Failed to inspect quiet defer history: ${getErrorMessage(error)}`);
    recordSpan?.("session.history.truncate", Date.now() - start, sessionId, {
      outcome: "failed",
      reason: "read-events-failed",
      deferId,
    });
    return { status: "failed", reason: "read-events-failed", error };
  }

  const events = Array.isArray(rawEvents) ? rawEvents : [];
  const candidate = findQuietIntervalDeferTailTruncationCandidate(events, deferId);
  if (!candidate) {
    recordSpan?.("session.history.truncate", Date.now() - start, sessionId, {
      outcome: "skipped",
      reason: "no-candidate",
      deferId,
      eventCount: events.length,
    });
    return { status: "skipped", reason: "no-candidate" };
  }

  try {
    const result = await truncate({ eventId: candidate.eventId });
    const eventsRemoved = typeof result?.eventsRemoved === "number" ? result.eventsRemoved : 0;
    if (eventsRemoved !== candidate.eventsToRemove) {
      logger.warn(
        `[sdk] [${sessionId.slice(0, 8)}] Quiet defer truncation removed ${eventsRemoved} event(s), expected ${candidate.eventsToRemove}`,
      );
    }
    logger.log(
      `[sdk] [${sessionId.slice(0, 8)}] Truncated previous quiet defer tail ${deferId} (${eventsRemoved} event(s))`,
    );
    recordSpan?.("session.history.truncate", Date.now() - start, sessionId, {
      outcome: "truncated",
      deferId,
      eventId: candidate.eventId,
      eventsRemoved,
      candidateEventsToRemove: candidate.eventsToRemove,
    });
    return {
      status: "truncated",
      eventId: candidate.eventId,
      eventsRemoved,
      candidateEventsToRemove: candidate.eventsToRemove,
    };
  } catch (error) {
    logger.warn(`[sdk] [${sessionId.slice(0, 8)}] Failed to truncate quiet defer history: ${getErrorMessage(error)}`);
    recordSpan?.("session.history.truncate", Date.now() - start, sessionId, {
      outcome: "failed",
      reason: "truncate-failed",
      deferId,
      eventId: candidate.eventId,
    });
    return { status: "failed", reason: "truncate-failed", error };
  }
}
