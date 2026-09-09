import {
  getSdkEventId,
  isSdkUserAuthoredMessage,
} from "./sdk-event-identity.js";

export interface SearchableMessage {
  sourceEventId: string;
  role: "user" | "assistant";
  timestamp?: string;
  content: string;
}

export function projectSearchableMessage(event: unknown): SearchableMessage | null {
  if (!event || typeof event !== "object") return null;
  const record = event as Record<string, unknown>;
  const data = record.data && typeof record.data === "object" && !Array.isArray(record.data)
    ? record.data as Record<string, unknown>
    : undefined;
  const sourceEventId = getSdkEventId(event);
  if (!sourceEventId || !data) return null;

  if (record.type === "user.message" && isSdkUserAuthoredMessage(event)) {
    const content = typeof data.content === "string"
      ? data.content
      : typeof data.prompt === "string"
        ? data.prompt
        : "";
    if (!content.trim()) return null;
    const timestamp = typeof data.timestamp === "string"
      ? data.timestamp
      : typeof record.timestamp === "string"
        ? record.timestamp
        : undefined;
    return { sourceEventId, role: "user", ...(timestamp ? { timestamp } : {}), content };
  }

  if (
    record.type === "assistant.message"
    && !data.parentToolCallId
    && typeof data.content === "string"
    && data.content.trim()
  ) {
    const timestamp = typeof data.timestamp === "string"
      ? data.timestamp
      : typeof record.timestamp === "string"
        ? record.timestamp
        : undefined;
    return {
      sourceEventId,
      role: "assistant",
      ...(timestamp ? { timestamp } : {}),
      content: data.content,
    };
  }
  return null;
}
