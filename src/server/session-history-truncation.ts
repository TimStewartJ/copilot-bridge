import { isQuietIntervalDeferEvent } from "./event-transform.js";

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
  | { status: "failed"; reason: "get-messages-failed" | "truncate-failed"; error: unknown };

interface TruncateQuietIntervalDeferTailOptions {
  session: {
    getMessages?: () => Promise<unknown>;
    rpc?: {
      history?: {
        truncate?: (params: { eventId: string }) => Promise<{ eventsRemoved?: number }>;
      };
    };
  };
  sessionId: string;
  deferId: string;
  logger?: Pick<Console, "log" | "warn">;
  recordSpan?: (name: string, duration: number, sessionId?: string, metadata?: Record<string, unknown>) => void;
}

const TERMINAL_EVENT_TYPES = new Set(["session.idle", "session.error", "abort", "session.shutdown"]);
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
const TRUNCATABLE_TOOL_NAMES = new Set([
  "browser_fetch",
  "browser_session_get_state",
  "computer_clipboard_read",
  "computer_cursor_position",
  "computer_display_info",
  "computer_screenshot",
  "defer_list",
  "docs_db_query",
  "docs_db_schema",
  "docs_list",
  "docs_read",
  "docs_search",
  "github-get_commit",
  "github-get_file_contents",
  "github-get_latest_release",
  "github-get_release_by_tag",
  "github-get_tag",
  "github-list_branches",
  "github-list_commits",
  "github-list_pull_requests",
  "github-list_releases",
  "github-list_tags",
  "github-pull_request_read",
  "github-search_code",
  "github-search_pull_requests",
  "github-search_repositories",
  "glob",
  "linear-extract_images",
  "linear-get_attachment",
  "linear-get_diff",
  "linear-get_diff_threads",
  "linear-get_document",
  "linear-get_issue",
  "linear-get_issue_status",
  "linear-get_milestone",
  "linear-get_project",
  "linear-get_team",
  "linear-get_user",
  "linear-list_comments",
  "linear-list_cycles",
  "linear-list_diffs",
  "linear-list_documents",
  "linear-list_issue_labels",
  "linear-list_issue_statuses",
  "linear-list_issues",
  "linear-list_milestones",
  "linear-list_project_labels",
  "linear-list_projects",
  "linear-list_teams",
  "linear-list_users",
  "linear-search_documentation",
  "list_agents",
  "read_agent",
  "read_bash",
  "report_intent",
  "rg",
  "schedule_list",
  "view",
  "web_fetch",
  "web_search",
]);

function getToolName(event: any): string {
  const name = event?.data?.toolName ?? event?.data?.name;
  return typeof name === "string" ? name : "";
}

function isTruncatableToolName(toolName: string): boolean {
  return TRUNCATABLE_TOOL_NAMES.has(toolName);
}

function isTerminalEvent(event: any): boolean {
  return TERMINAL_EVENT_TYPES.has(event?.type);
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

  let idleTerminalCount = 0;
  let terminalSeen = false;
  for (let index = candidateIndex + 1; index < events.length; index += 1) {
    const event = events[index] as any;

    if (terminalSeen && isTurnActivityEvent(event)) return undefined;
    if (event?.type === "user.message") return undefined;

    if (event?.type === "tool.execution_start") {
      const toolName = getToolName(event);
      if (!isTruncatableToolName(toolName)) return undefined;
    }
    if (event?.type === "tool.execution_complete" && event?.data?.success !== true) {
      return undefined;
    }
    if (event?.type === "subagent.started" || event?.type === "subagent.completed" || event?.type === "subagent.failed") {
      return undefined;
    }

    if (!isTerminalEvent(event)) continue;
    if (event.type !== "session.idle") return undefined;
    terminalSeen = true;
    idleTerminalCount += 1;
    if (idleTerminalCount > 1) return undefined;
  }

  if (idleTerminalCount !== 1) return undefined;
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
  const truncate = session.rpc?.history?.truncate;
  if (typeof session.getMessages !== "function" || typeof truncate !== "function") {
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
    rawEvents = await session.getMessages();
  } catch (error) {
    logger.warn(`[sdk] [${sessionId.slice(0, 8)}] Failed to inspect quiet defer history: ${getErrorMessage(error)}`);
    recordSpan?.("session.history.truncate", Date.now() - start, sessionId, {
      outcome: "failed",
      reason: "get-messages-failed",
      deferId,
    });
    return { status: "failed", reason: "get-messages-failed", error };
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
