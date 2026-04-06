import { useState, useCallback, useEffect } from "react";
import type { Session } from "./api";
import { fetchReadState, markSessionRead, markSessionUnread } from "./api";

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

export function useReadState(sessions: Session[], allLoaded = false) {
  const [state, setState] = useState<ReadState>(load);

  // Hydrate from server so read state syncs across devices
  useEffect(() => {
    let cancelled = false;
    fetchReadState()
      .then((server) => {
        if (cancelled) return;
        setState((local) => {
          const merged = { ...local };
          let changed = false;
          for (const [id, serverTs] of Object.entries(server)) {
            const localTs = local[id];
            if (!localTs || new Date(serverTs) > new Date(localTs)) {
              merged[id] = serverTs;
              changed = true;
            }
          }
          // Push locally-newer entries back to server (self-heal missed writes)
          for (const [id, localTs] of Object.entries(local)) {
            const serverTs = server[id];
            if (!serverTs || new Date(localTs) > new Date(serverTs)) {
              markSessionRead(id).catch(() => {});
            }
          }
          if (!changed) return local;
          save(merged);
          return merged;
        });
      })
      .catch(() => {}); // offline — fall back to localStorage
    return () => {
      cancelled = true;
    };
  }, []); // once on mount

  // GC: prune entries for sessions that no longer exist.
  // Skip when archived sessions haven't been loaded yet — we'd incorrectly
  // prune their read-state, causing them to appear unread when expanded.
  useEffect(() => {
    if (!allLoaded || sessions.length === 0) return;
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
  }, [sessions, allLoaded]);

  const markRead = useCallback((sessionId: string) => {
    setState((prev) => {
      const next = { ...prev, [sessionId]: new Date().toISOString() };
      save(next);
      return next;
    });
    // Fire-and-forget sync to server for dashboard endpoint
    markSessionRead(sessionId).catch(() => {});
  }, []);

  const markUnread = useCallback((sessionId: string) => {
    setState((prev) => {
      const next = { ...prev };
      delete next[sessionId];
      save(next);
      return next;
    });
    markSessionUnread(sessionId).catch(() => {});
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

  return { isUnread, markRead, markUnread, unreadCount };
}
