import { useState, useCallback, useEffect } from "react";
import type { Session } from "./api";
import { markSessionRead } from "./api";

const STORAGE_KEY = "copilot-bridge:session-read-state";

type ReadState = Record<string, string>; // sessionId → ISO lastReadAt

function load(): ReadState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function save(state: ReadState): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function useReadState(sessions: Session[]) {
  const [state, setState] = useState<ReadState>(load);

  // GC: prune entries for sessions that no longer exist
  useEffect(() => {
    if (sessions.length === 0) return;
    const validIds = new Set(sessions.map((s) => s.sessionId));
    setState((prev) => {
      const pruned: ReadState = {};
      let changed = false;
      for (const [id, ts] of Object.entries(prev)) {
        if (validIds.has(id)) {
          pruned[id] = ts;
        } else {
          changed = true;
        }
      }
      if (!changed) return prev;
      save(pruned);
      return pruned;
    });
  }, [sessions]);

  const markRead = useCallback((sessionId: string) => {
    setState((prev) => {
      const next = { ...prev, [sessionId]: new Date().toISOString() };
      save(next);
      return next;
    });
    // Fire-and-forget sync to server for dashboard endpoint
    markSessionRead(sessionId).catch(() => {});
  }, []);

  const isUnread = useCallback(
    (sessionId: string, modifiedTime?: string): boolean => {
      if (!modifiedTime) return false;
      const lastRead = state[sessionId];
      if (!lastRead) return true; // never opened = unread if it has content
      return new Date(modifiedTime).getTime() > new Date(lastRead).getTime();
    },
    [state],
  );

  const unreadCount = useCallback(
    (sessionList: Session[], activeSessionId?: string | null): number => {
      return sessionList.filter(
        (s) =>
          s.sessionId !== activeSessionId &&
          isUnread(s.sessionId, s.modifiedTime),
      ).length;
    },
    [isUnread],
  );

  return { isUnread, markRead, unreadCount };
}
