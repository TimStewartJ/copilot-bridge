import { replaceEqualDeep, type QueryClient } from "@tanstack/react-query";
import type { ChatEntry, TranscriptAgent } from "./api";
import { queryKeys } from "./queryClient";

const MAX_CACHED_SESSIONS = 5;
/** Revisits open at the newest reply, so keep only the newest; older pages reload on scroll. */
const MAX_CACHED_ENTRIES = 200;
const recentSessionIds: string[] = [];

/** Disk-read entries only (no optimistic/live); the view renders these objects, never mutate. */
export interface ChatHistorySnapshot {
  sessionId: string;
  entries: ChatEntry[];
  firstItemIndex: number;
  fetchedAt: number;
  /** The session's sub-agents from that read, so a cached step still names its agent. */
  agents?: readonly TranscriptAgent[];
}

export function maxActivityTimestamp(left?: string | null, right?: string | null): string | undefined {
  const leftTime = left ? Date.parse(left) : Number.NaN;
  const rightTime = right ? Date.parse(right) : Number.NaN;
  if (!Number.isFinite(leftTime) && !Number.isFinite(rightTime)) return undefined;
  return new Date(Math.max(
    Number.isFinite(leftTime) ? leftTime : Number.NEGATIVE_INFINITY,
    Number.isFinite(rightTime) ? rightTime : Number.NEGATIVE_INFINITY,
  )).toISOString();
}

function getEntryActivityTimestamp(entry: ChatEntry): string | undefined {
  if (entry.type === "tool") return entry.toolCall.completedAt ?? entry.toolCall.startedAt;
  if (entry.type === "visual") return entry.timestamp;
  if (entry.type === "completion") return entry.timestamp;
  if (entry.type === "skill") return entry.timestamp;
  if ("role" in entry && ((entry.content ?? "").trim() || entry.attachments?.length)) return entry.timestamp;
  return undefined;
}

export function getLatestEntryActivityTimestamp(entries: ChatEntry[]): string | undefined {
  let latest: string | undefined;
  for (const entry of entries) latest = maxActivityTimestamp(latest, getEntryActivityTimestamp(entry));
  return latest;
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
  return { ...snapshot, entries: [...snapshot.entries] };
}

export function setCachedChatSnapshot(queryClient: QueryClient, snapshot: ChatHistorySnapshot): void {
  const dropped = Math.max(0, snapshot.entries.length - MAX_CACHED_ENTRIES);
  queryClient.setQueryData<ChatHistorySnapshot>(queryKeys.chatMessages(snapshot.sessionId), {
    ...snapshot,
    entries: snapshot.entries.slice(dropped),
    firstItemIndex: snapshot.firstItemIndex + dropped,
  });
  touchSession(snapshot.sessionId);
  pruneSessions(queryClient);
}

/** Reuse equal loaded objects so unchanged rows skip rendering; match by session index. */
export function keepLoadedEntries(
  loaded: ChatEntry[],
  loadedFirstItemIndex: number,
  next: ChatEntry[],
  nextFirstItemIndex: number,
): ChatEntry[] {
  const offset = nextFirstItemIndex - loadedFirstItemIndex;
  return next.map((entry, index) => {
    const loadedEntry = loaded[index + offset];
    return loadedEntry ? replaceEqualDeep(loadedEntry, entry) : entry;
  });
}

/** A window starting after the loaded one keeps the older prefix (pagination); else replaces it. */
export function replaceHistoryWindow(
  previousEntries: ChatEntry[],
  previousFirstItemIndex: number,
  nextWindow: ChatEntry[],
  total: number,
): { entries: ChatEntry[]; firstItemIndex: number; hasGap: boolean } {
  const nextWindowStart = Math.max(0, total - nextWindow.length);
  if (nextWindowStart <= previousFirstItemIndex) {
    return { entries: nextWindow, firstItemIndex: nextWindowStart, hasGap: false };
  }
  const prefixLength = Math.min(previousEntries.length, nextWindowStart - previousFirstItemIndex);
  return {
    entries: [...previousEntries.slice(0, prefixLength), ...nextWindow],
    firstItemIndex: previousFirstItemIndex,
    hasGap: prefixLength < nextWindowStart - previousFirstItemIndex,
  };
}
