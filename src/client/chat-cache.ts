import type { QueryClient } from "@tanstack/react-query";
import type { Attachment, ChatEntry, ToolCall } from "./api";
import { queryKeys } from "./queryClient";

const MAX_CACHED_SESSIONS = 5;
const recentSessionIds: string[] = [];
const CLIENT_GENERATED_ID_PREFIXES = ["stream-", "local-", "err-", "draft-"] as const;

export interface ChatHistorySnapshot {
  sessionId: string;
  entries: ChatEntry[];
  firstItemIndex: number;
  total: number;
  hasMore: boolean;
  fetchedAt: number;
  isCanonical: boolean;
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

  return {
    ...entry,
    attachments: entry.attachments?.map((attachment) => cloneAttachment(attachment)),
    toolCalls: entry.toolCalls?.map((toolCall) => cloneToolCall(toolCall)),
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
  if (!snapshot.isCanonical) return;
  queryClient.setQueryData(queryKeys.chatMessages(snapshot.sessionId), cloneSnapshot(snapshot));
  touchSession(snapshot.sessionId);
  pruneSessions(queryClient);
}

export function hasOptimisticTail(currentFirstItemIndex: number, entryCount: number, total: number): boolean {
  return currentFirstItemIndex + entryCount > total;
}

export function isClientGeneratedEntry(entry: ChatEntry): boolean {
  const { id } = entry;
  return typeof id === "string" && CLIENT_GENERATED_ID_PREFIXES.some((prefix) => id.startsWith(prefix));
}

export function hasClientGeneratedEntries(entries: ChatEntry[]): boolean {
  return entries.some((entry) => isClientGeneratedEntry(entry));
}

function isUnsafeCommittedClientEntry(entry: ChatEntry): boolean {
  if (!isClientGeneratedEntry(entry)) return false;
  if (entry.type === "tool") return false;
  if (entry.role === "user") return false;
  return entry.content.startsWith("⚠️ Error:") || entry.content.includes("*(stopped)*");
}

export function normalizeCommittedClientEntries(
  entries: ChatEntry[],
  firstItemIndex: number,
  total: number,
): ChatEntry[] {
  return entries.map((entry, index) => {
    if (firstItemIndex + index >= total) return entry;
    if (!isClientGeneratedEntry(entry) || isUnsafeCommittedClientEntry(entry)) return entry;
    return { ...entry, id: undefined };
  });
}

export function mergeTailMessages(
  previousEntries: ChatEntry[],
  currentFirstItemIndex: number,
  total: number,
  nextWindow: ChatEntry[],
): { entries: ChatEntry[]; firstItemIndex: number; total: number; hasOptimisticTail: boolean; hasClientGeneratedEntries: boolean } {
  const latestWindowStart = Math.max(0, total - nextWindow.length);
  const currentLoadedEnd = currentFirstItemIndex + previousEntries.length;
  const preserveCount = latestWindowStart <= currentLoadedEnd
    ? Math.max(0, Math.min(previousEntries.length, latestWindowStart - currentFirstItemIndex))
    : 0;
  const optimisticTailCount = hasOptimisticTail(currentFirstItemIndex, previousEntries.length, total)
    ? currentLoadedEnd - total
    : 0;
  const optimisticTail = optimisticTailCount > 0
    ? previousEntries.slice(previousEntries.length - optimisticTailCount)
    : [];
  const firstItemIndex = preserveCount > 0 ? currentFirstItemIndex : latestWindowStart;
  const entries = preserveCount > 0
    ? [...previousEntries.slice(0, preserveCount), ...nextWindow, ...optimisticTail]
    : [...nextWindow, ...optimisticTail];
  const normalizedEntries = normalizeCommittedClientEntries(entries, firstItemIndex, total);

  return {
    firstItemIndex,
    entries: normalizedEntries,
    total: Math.max(total, firstItemIndex + normalizedEntries.length),
    hasOptimisticTail: optimisticTailCount > 0,
    hasClientGeneratedEntries: hasClientGeneratedEntries(normalizedEntries),
  };
}
