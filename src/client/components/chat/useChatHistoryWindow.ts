import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { replaceEqualDeep, useQueryClient } from "@tanstack/react-query";
import type { ChatEntry, TranscriptAgent } from "../../api";
import { getLatestEntryActivityTimestamp, maxActivityTimestamp, setCachedChatSnapshot } from "../../chat-cache";

export const NO_AGENT_RECORDS: readonly TranscriptAgent[] = Object.freeze([]);
export const NO_HISTORY = { ownerSessionId: null, firstItemIndex: 0 } as const;

export interface ApplyHistoryOptions {
  ownerSessionId?: string | null;
  firstItemIndex?: number;
  lastVisibleActivityAt?: string | null;
  fetchedAt?: number;
  persistSnapshot?: boolean;
  reportReadThrough?: boolean;
  keepViewport?: boolean;
}

interface ChatHistoryWindowOptions {
  sessionId: string | null;
  keepViewportRef: RefObject<boolean>;
  onRenderedReadThrough?: (sessionId: string, readThroughActivityAt: string) => void;
}

/** Owns the disk-derived window and its cached snapshot, never optimistic or streaming content. */
export function useChatHistoryWindow({
  sessionId, keepViewportRef, onRenderedReadThrough,
}: ChatHistoryWindowOptions) {
  const queryClient = useQueryClient();
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const entriesRef = useRef<ChatEntry[]>([]);
  const [agentRecords, setAgentRecords] = useState<readonly TranscriptAgent[]>(NO_AGENT_RECORDS);
  const agentRecordsRef = useRef<readonly TranscriptAgent[]>(NO_AGENT_RECORDS);
  const [hasMore, setHasMore] = useState(false);
  const firstItemIndex = useRef(0);
  const lastVisibleActivityAtRef = useRef<string | undefined>(undefined);
  const historyFetchedAtRef = useRef<number | null>(null);
  const sessionIdRef = useRef(sessionId);
  const pendingReadThrough = useRef<{ sessionId: string; readThroughActivityAt: string } | null>(null);

  useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);

  const applyAgentRecords = useCallback((next: readonly TranscriptAgent[] | undefined) => {
    if (!next) return;
    const kept = next.length === 0 ? NO_AGENT_RECORDS : replaceEqualDeep(agentRecordsRef.current, next);
    if (kept === agentRecordsRef.current) return;
    agentRecordsRef.current = kept;
    setAgentRecords(kept);
  }, []);

  const applyHistory = useCallback((nextEntries: ChatEntry[], opts: ApplyHistoryOptions = {}) => {
    const ownerSessionId = opts.ownerSessionId === undefined ? sessionIdRef.current : opts.ownerSessionId;
    const nextFirstItemIndex = opts.firstItemIndex ?? firstItemIndex.current;
    keepViewportRef.current = Boolean(opts.keepViewport);
    firstItemIndex.current = nextFirstItemIndex;
    const lastActivityAt = opts.lastVisibleActivityAt === null
      ? undefined
      : opts.lastVisibleActivityAt ?? lastVisibleActivityAtRef.current;
    lastVisibleActivityAtRef.current = ownerSessionId ? lastActivityAt : undefined;
    entriesRef.current = nextEntries;
    setEntries(nextEntries);
    setHasMore(nextFirstItemIndex > 0);
    const readThrough = maxActivityTimestamp(lastActivityAt, getLatestEntryActivityTimestamp(nextEntries));
    pendingReadThrough.current = ownerSessionId && opts.reportReadThrough !== false && readThrough
      ? { sessionId: ownerSessionId, readThroughActivityAt: readThrough }
      : null;
    if (!ownerSessionId) {
      historyFetchedAtRef.current = null;
      return;
    }
    const fetchedAt = opts.fetchedAt ?? Date.now();
    historyFetchedAtRef.current = fetchedAt;
    if (opts.persistSnapshot === false) return;
    setCachedChatSnapshot(queryClient, {
      sessionId: ownerSessionId, entries: nextEntries, firstItemIndex: nextFirstItemIndex,
      fetchedAt, agents: agentRecordsRef.current,
    });
  }, [keepViewportRef, queryClient]);

  useLayoutEffect(() => {
    const pending = pendingReadThrough.current;
    if (!pending || pending.sessionId !== sessionId) return;
    pendingReadThrough.current = null;
    onRenderedReadThrough?.(pending.sessionId, pending.readThroughActivityAt);
  }, [entries, onRenderedReadThrough, sessionId]);

  return {
    entries, entriesRef, agentRecords, applyAgentRecords, hasMore, firstItemIndex,
    historyFetchedAtRef, sessionIdRef, applyHistory,
  };
}
