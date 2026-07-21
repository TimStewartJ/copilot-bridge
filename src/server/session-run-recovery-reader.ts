import { open, stat } from "node:fs/promises";

const MAX_RECOVERY_TAIL_BYTES = 8 * 1024 * 1024;

const RELEVANT_EVENT_TYPES = new Set([
  "user.message",
  "assistant.turn_start",
  "assistant.message",
  "assistant.message_delta",
  "assistant.streaming_delta",
  "assistant.intent",
  "assistant.turn_end",
  "session.task_complete",
  "tool.execution_start",
  "tool.execution_progress",
  "tool.execution_partial_result",
  "tool.execution_complete",
  "external_tool.requested",
  "external_tool.completed",
  "subagent.started",
  "subagent.completed",
  "subagent.failed",
  "session.idle",
  "session.error",
  "abort",
  "session.shutdown",
]);

const DIAGNOSTIC_TERMINAL_EVENT_TYPES = new Set([
  "assistant.turn_end",
  "session.task_complete",
  "session.idle",
  "session.error",
  "abort",
  "session.shutdown",
]);

const ACTIVE_FOLLOWUP_EVENT_TYPES = new Set([
  "user.message",
  "assistant.turn_start",
  "assistant.message",
  "tool.execution_start",
  "tool.execution_complete",
  "external_tool.requested",
  "external_tool.completed",
  "subagent.started",
  "subagent.completed",
  "subagent.failed",
]);

export interface PersistedRunEventInfo {
  latestPersistedEventType?: string;
  latestPersistedEventAgeMs?: number;
  latestPersistedTerminalEventType?: string;
  latestPersistedTerminalEventAgeMs?: number;
}

export interface PersistedRunTerminal {
  event: any;
  assistantContent?: string;
}

export interface PersistedRunRecoveryInspection {
  info: PersistedRunEventInfo;
  terminal: PersistedRunTerminal | null;
}

function getEventTimestampMs(event: any): number | undefined {
  const rawTimestamp = event?.data?.timestamp ?? event?.timestamp;
  if (typeof rawTimestamp !== "string") return undefined;
  const eventTime = Date.parse(rawTimestamp);
  return Number.isFinite(eventTime) ? eventTime : undefined;
}

async function readBoundedTail(eventsPath: string): Promise<string> {
  const fileStat = await stat(eventsPath);
  if (fileStat.size === 0) return "";
  const bytesToRead = Math.min(fileStat.size, MAX_RECOVERY_TAIL_BYTES);
  const position = fileStat.size - bytesToRead;
  const buffer = Buffer.alloc(bytesToRead);
  const file = await open(eventsPath, "r");
  try {
    const { bytesRead } = await file.read(buffer, 0, bytesToRead, position);
    let content = buffer.subarray(0, bytesRead).toString("utf-8");
    if (position > 0) {
      const firstNewline = content.indexOf("\n");
      content = firstNewline >= 0 ? content.slice(firstNewline + 1) : "";
    }
    return content;
  } finally {
    await file.close();
  }
}

export async function inspectPersistedRunRecovery(
  eventsPath: string,
  sendStart: number,
  options: {
    now?: number;
    lastAssistantContent?: string;
    treatSessionShutdownAsTerminal?: boolean;
  } = {},
): Promise<PersistedRunRecoveryInspection> {
  let raw: string;
  try {
    raw = await readBoundedTail(eventsPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { info: {}, terminal: null };
    }
    throw error;
  }

  const now = options.now ?? Date.now();
  let latestEventType: string | undefined;
  let latestEventAt: number | undefined;
  let latestTerminalEventType: string | undefined;
  let latestTerminalEventAt: number | undefined;
  let assistantContent = options.lastAssistantContent;
  let latestRelevantState: "active" | "terminal" | undefined;
  let terminalEvent: any | null = null;
  let hasTurnEnd = false;
  let activeEventsAfterTurnEnd = 0;

  const markActive = (eventType: string) => {
    if (hasTurnEnd && ACTIVE_FOLLOWUP_EVENT_TYPES.has(eventType)) {
      activeEventsAfterTurnEnd += 1;
    }
    latestRelevantState = "active";
    terminalEvent = null;
  };
  const markTerminal = (event: any) => {
    latestRelevantState = "terminal";
    terminalEvent = event;
  };

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const eventType = event?.type;
    if (typeof eventType !== "string" || !RELEVANT_EVENT_TYPES.has(eventType)) continue;
    const eventTime = getEventTimestampMs(event);
    if (eventTime === undefined || eventTime < sendStart) continue;

    latestEventType = eventType;
    latestEventAt = eventTime;
    if (DIAGNOSTIC_TERMINAL_EVENT_TYPES.has(eventType)) {
      latestTerminalEventType = eventType;
      latestTerminalEventAt = eventTime;
    }

    const data = event?.data;
    switch (eventType) {
      case "assistant.message":
        if (data?.parentToolCallId) break;
        if (typeof data?.content === "string") assistantContent = data.content;
        markActive(eventType);
        break;
      case "user.message":
      case "assistant.turn_start":
      case "assistant.message_delta":
      case "assistant.streaming_delta":
      case "assistant.intent":
      case "tool.execution_start":
      case "tool.execution_progress":
      case "tool.execution_partial_result":
      case "tool.execution_complete":
      case "external_tool.requested":
      case "external_tool.completed":
      case "subagent.started":
      case "subagent.completed":
      case "subagent.failed":
        markActive(eventType);
        break;
      case "session.idle":
      case "session.task_complete":
        if (hasTurnEnd && activeEventsAfterTurnEnd > 0) markActive(eventType);
        else markTerminal(event);
        break;
      case "assistant.turn_end":
        hasTurnEnd = true;
        activeEventsAfterTurnEnd = 0;
        markTerminal(event);
        break;
      case "session.error":
      case "abort":
        markTerminal(event);
        break;
      case "session.shutdown":
        if (options.treatSessionShutdownAsTerminal !== false) markTerminal(event);
        break;
    }
  }

  return {
    info: {
      latestPersistedEventType: latestEventType,
      latestPersistedEventAgeMs: latestEventAt === undefined ? undefined : Math.max(0, now - latestEventAt),
      latestPersistedTerminalEventType: latestTerminalEventType,
      latestPersistedTerminalEventAgeMs: latestTerminalEventAt === undefined
        ? undefined
        : Math.max(0, now - latestTerminalEventAt),
    },
    terminal: latestRelevantState === "terminal" && terminalEvent
      ? { event: terminalEvent, assistantContent }
      : null,
  };
}
