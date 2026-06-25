export type TranscriptCompletionStatus = "success" | "error";

export interface TerminalCompletion {
  content: string;
  title: string;
  status: TranscriptCompletionStatus;
  sourceEventType: string;
}

// Canonical terminal-completion contract
// --------------------------------------
// A "terminal completion" is the agent's explicit end-of-turn summary, produced either by a
// `session.task_complete` event (extractTerminalCompletion) or a `task_complete` tool call captured
// as a *pending* completion (extractTerminalCompletionFromToolCall).
//
// Contract: a pending terminal completion is surfaced exactly once, as a `completion` entry, on the
// FIRST turn-terminal event that closes the run — whether that terminal is normal
// (session.task_complete / session.idle / assistant.turn_end) or abnormal (abort / session.shutdown
// / session.error). It is scoped to the turn it closes and carries that turn's id when available.
//
// The disk reference implementations (event-transform.transformEventsToMessages and the
// session-disk-reader pagination scanner) flush a pending completion on any of these terminal
// events. The live SSE producer (event-bus) and the reconnect snapshot normalizer (api-router) must
// therefore carry pending completions through abort/shutdown/error too, so live streaming, reconnect
// replay, event replay, and disk pagination all agree on the same completion entry.
const TERMINAL_COMPLETION_EVENT_TYPES = new Set([
  "session.task_complete",
]);

const TERMINAL_COMPLETION_TOOL_NAMES = new Set([
  "task_complete",
]);

/**
 * Turn-terminal event types that close a run and flush a pending terminal completion.
 * Shared so disk replay (event-transform) and disk pagination (session-disk-reader) stay in sync.
 */
export const TERMINAL_TURN_EVENT_TYPES = new Set([
  "assistant.turn_end",
  "session.shutdown",
  "abort",
  "session.idle",
  "session.error",
  "session.task_complete",
]);

export function isTerminalTurnEventType(eventType: unknown): eventType is string {
  return typeof eventType === "string" && TERMINAL_TURN_EVENT_TYPES.has(eventType);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function firstTrimmedString(record: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return value;
  }
  return undefined;
}

export function isTerminalCompletionEventType(eventType: unknown): eventType is string {
  return typeof eventType === "string" && TERMINAL_COMPLETION_EVENT_TYPES.has(eventType);
}

export function isTerminalCompletionToolName(toolName: unknown): toolName is string {
  return typeof toolName === "string" && TERMINAL_COMPLETION_TOOL_NAMES.has(toolName);
}

export function extractTerminalCompletion(event: unknown): TerminalCompletion | undefined {
  const record = asRecord(event);
  const eventType = record?.type;
  if (!isTerminalCompletionEventType(eventType)) return undefined;
  if (!record) return undefined;

  const data = asRecord(record.data);
  const content = firstTrimmedString(data, ["summary", "content", "message"]);
  if (!content) return undefined;

  return {
    content,
    title: firstTrimmedString(data, ["title"]) ?? "Task complete",
    status: data?.success === false ? "error" : "success",
    sourceEventType: eventType,
  };
}

export function extractTerminalCompletionFromToolCall(
  toolName: unknown,
  args: unknown,
  sourceEventType = "tool.execution_complete",
): TerminalCompletion | undefined {
  if (!isTerminalCompletionToolName(toolName)) return undefined;
  const argRecord = asRecord(args);
  const content = firstTrimmedString(argRecord, ["summary", "content", "message"]);
  if (!content) return undefined;
  return {
    content,
    title: firstTrimmedString(argRecord, ["title"]) ?? "Task complete",
    status: "success",
    sourceEventType,
  };
}
