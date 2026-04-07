import { useState, useCallback, useEffect } from "react";
import type { Session } from "./api";
import { fetchReadState, markSessionRead, markSessionUnread } from "./api";

type ReadState = Record<string, string>; // sessionId → ISO lastReadAt

export function useReadState() {
  const [state, setState] = useState<ReadState>({});

  // Apply server state as the single source of truth
  const applyServerState = useCallback((server: ReadState) => {
    setState(server);
  }, []);

  // Hydrate from server on mount
  useEffect(() => {
    let cancelled = false;
    fetchReadState()
      .then((server) => { if (!cancelled) applyServerState(server); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-fetch from server when tab becomes visible (handles cross-device sync)
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        fetchReadState().then(applyServerState).catch(() => {});
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [applyServerState]);

  const markRead = useCallback((sessionId: string) => {
    // Optimistic update — server confirms via SSE
    setState((prev) => ({ ...prev, [sessionId]: new Date().toISOString() }));
    markSessionRead(sessionId).catch(() => {});
  }, []);

  const markUnread = useCallback((sessionId: string) => {
    setState((prev) => {
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
    markSessionUnread(sessionId).catch(() => {});
  }, []);

  const isUnread = useCallback(
    (sessionId: string, modifiedTime?: string): boolean => {
      if (!modifiedTime) return false;
      const lastRead = state[sessionId];
      if (!lastRead) return true;
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

  return { isUnread, markRead, markUnread, unreadCount, applyServerState };
}
