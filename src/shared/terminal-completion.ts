export type TranscriptCompletionStatus = "success" | "error";

export interface TerminalCompletion {
  content: string;
  title: string;
  status: TranscriptCompletionStatus;
  sourceEventType: string;
}

const TERMINAL_COMPLETION_EVENT_TYPES = new Set([
  "session.task_complete",
]);

const TERMINAL_COMPLETION_TOOL_NAMES = new Set([
  "task_complete",
]);

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
