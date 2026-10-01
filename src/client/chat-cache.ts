import { replaceEqualDeep, type QueryClient } from "@tanstack/react-query";
import type { ChatEntry } from "./api";
import { queryKeys } from "./queryClient";

const MAX_CACHED_SESSIONS = 5;
/**
 * A revisit lands on the newest reply and re-reads everything it paints from the cache, so the
 * cache keeps only this many of the newest entries. Older pages load again on scroll.
 */
const MAX_CACHED_ENTRIES = 200;
const recentSessionIds: string[] = [];

/**
 * A window of committed transcript entries read straight from `events.jsonl`. Cached windows are
 * always disk-derived, so they can be rendered immediately on revisit and simply replaced by the
 * next disk read. Optimistic and live content is never stored here.
 *
 * The cache holds the very entry objects the view renders, so entries are never changed in place.
 */
export interface ChatHistorySnapshot {
  sessionId: string;
  entries: ChatEntry[];
  firstItemIndex: number;
  fetchedAt: number;
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

/**
 * A fresh read returns equal copies of the entries that are already loaded. Keeping the loaded
 * object wherever the two are equal lets that entry's row skip rendering, so a refresh costs what
 * changed and not the size of the window. Entries are matched by their index in the session.
 */
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
