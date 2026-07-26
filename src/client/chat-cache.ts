import type { QueryClient } from "@tanstack/react-query";
import type { Attachment, ChatEntry, ToolCall } from "./api";
import { queryKeys } from "./queryClient";

const MAX_CACHED_SESSIONS = 5;
const recentSessionIds: string[] = [];

/**
 * A window of committed transcript entries read straight from `events.jsonl`. Cached windows are
 * always disk-derived, so they can be rendered immediately on revisit and simply replaced by the
 * next disk read. Optimistic and live content is never stored here.
 */
export interface ChatHistorySnapshot {
  sessionId: string;
  entries: ChatEntry[];
  firstItemIndex: number;
  total: number;
  hasMore: boolean;
  fetchedAt: number;
}

function cloneAttachment(attachment: Attachment): Attachment {
  return { ...attachment };
}

function cloneToolCall(toolCall: ToolCall): ToolCall {
  return {
    ...toolCall,
    childToolCalls: toolCall.childToolCalls?.map((child) => cloneToolCall(child)),
  };
}

function cloneChatEntry(entry: ChatEntry): ChatEntry {
  if (entry.type === "tool") {
    return {
      ...entry,
      toolCall: entry.toolCall ? cloneToolCall(entry.toolCall) : entry.toolCall,
    };
  }

  if (entry.type === "visual") {
    return { ...entry };
  }

  if (entry.type === "completion") {
    return {
      ...entry,
      completion: { ...entry.completion },
    };
  }

  if (entry.type === "skill") {
    return { ...entry, skill: { ...entry.skill } };
  }

  return {
    ...entry,
    attachments: entry.attachments?.map((attachment) => cloneAttachment(attachment)),
    toolCalls: entry.toolCalls?.map((toolCall) => cloneToolCall(toolCall)),
    delivery: entry.delivery ? { ...entry.delivery } : undefined,
  };
}

function cloneSnapshot(snapshot: ChatHistorySnapshot): ChatHistorySnapshot {
  return {
    ...snapshot,
    entries: snapshot.entries.map((entry) => cloneChatEntry(entry)),
  };
}

function forgetSession(sessionId: string): void {
  const index = recentSessionIds.indexOf(sessionId);
  if (index >= 0) recentSessionIds.splice(index, 1);
}

function touchSession(sessionId: string): void {
  forgetSession(sessionId);
  recentSessionIds.push(sessionId);
}

function pruneSessions(queryClient: QueryClient): void {
  while (recentSessionIds.length > MAX_CACHED_SESSIONS) {
    const evictedSessionId = recentSessionIds.shift();
    if (!evictedSessionId) break;
    queryClient.removeQueries({ queryKey: queryKeys.chatMessages(evictedSessionId), exact: true });
  }
}

export function resetCachedChatSnapshotState(): void {
  recentSessionIds.splice(0, recentSessionIds.length);
}

export function getCachedChatSnapshot(queryClient: QueryClient, sessionId: string): ChatHistorySnapshot | undefined {
  const snapshot = queryClient.getQueryData<ChatHistorySnapshot>(queryKeys.chatMessages(sessionId));
  if (!snapshot) {
    forgetSession(sessionId);
    return undefined;
  }
  touchSession(sessionId);
  return cloneSnapshot(snapshot);
}

export function setCachedChatSnapshot(queryClient: QueryClient, snapshot: ChatHistorySnapshot): void {
  queryClient.setQueryData(queryKeys.chatMessages(snapshot.sessionId), cloneSnapshot(snapshot));
  touchSession(snapshot.sessionId);
  pruneSessions(queryClient);
}

/**
 * Replace the loaded window with a freshly read disk window.
 *
 * Committed entries only ever come from one atomic `transformEventsToMessages` pass, so a refresh
 * replaces the overlapping range wholesale. When the reader returns a window that starts after the
 * currently loaded window, the older prefix is kept so pagination is preserved; when it starts at
 * or before the loaded window, the fetched window fully supersedes it.
 */
export function replaceHistoryWindow(
  previousEntries: ChatEntry[],
  previousFirstItemIndex: number,
  nextWindow: ChatEntry[],
  total: number,
): { entries: ChatEntry[]; firstItemIndex: number; total: number; hasGap: boolean } {
  const nextWindowStart = Math.max(0, total - nextWindow.length);
  if (nextWindowStart <= previousFirstItemIndex) {
    return {
      entries: nextWindow,
      firstItemIndex: nextWindowStart,
      total: Math.max(total, nextWindowStart + nextWindow.length),
      hasGap: false,
    };
  }
  const prefixLength = Math.min(previousEntries.length, nextWindowStart - previousFirstItemIndex);
  const entries = [...previousEntries.slice(0, prefixLength), ...nextWindow];
  return {
    entries,
    firstItemIndex: previousFirstItemIndex,
    total: Math.max(total, previousFirstItemIndex + entries.length),
    hasGap: prefixLength < nextWindowStart - previousFirstItemIndex,
  };
}
