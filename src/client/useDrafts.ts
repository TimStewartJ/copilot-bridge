import { useState, useCallback, useEffect, useRef } from "react";
import type { Session, Attachment } from "./api";

const STORAGE_KEY = "copilot-bridge:session-drafts";
const DEBOUNCE_MS = 500;

export interface Draft {
  text: string;
  attachments?: Attachment[];
}

type DraftState = Record<string, Draft>; // composerKey → Draft

function isRouteDraftKey(key: string): boolean {
  return key.startsWith("draft:");
}

function buildNextDraftState(
  prev: DraftState,
  sessionId: string,
  text: string,
  attachments?: Attachment[],
): DraftState {
  const trimmed = text.trim();
  const hasContent = trimmed.length > 0 || (attachments && attachments.length > 0);

  if (!hasContent) {
    if (!(sessionId in prev)) return prev;
    const next = { ...prev };
    delete next[sessionId];
    return next;
  }

  return {
    ...prev,
    [sessionId]: attachments?.length
      ? { text, attachments }
      : { text },
  };
}

function load(): DraftState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function save(state: DraftState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage quota exceeded — try without attachments
    const slim: DraftState = {};
    for (const [id, draft] of Object.entries(state)) {
      slim[id] = { text: draft.text };
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(slim));
    } catch {
      // give up silently
    }
  }
}

export function useDrafts(sessions: Session[]) {
  const [state, setState] = useState<DraftState>(load);
  const stateRef = useRef(state);
  const timersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // GC: prune drafts for sessions that no longer exist
  useEffect(() => {
    if (sessions.length === 0) return;
    const validIds = new Set(sessions.map((s) => s.sessionId));
    setState((prev) => {
      let changed = false;
      const pruned: DraftState = {};
      for (const [id, draft] of Object.entries(prev)) {
        if (validIds.has(id) || isRouteDraftKey(id)) {
          pruned[id] = draft;
        } else {
          changed = true;
        }
      }
      if (!changed) return prev;
      save(pruned);
      return pruned;
    });
  }, [sessions]);

  const scheduleSave = useCallback((composerKey: string) => {
    const existingTimer = timersRef.current[composerKey];
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    timersRef.current[composerKey] = setTimeout(() => {
      delete timersRef.current[composerKey];
      save(stateRef.current);
    }, DEBOUNCE_MS);
  }, []);

  const clearDraftTimer = useCallback((composerKey: string) => {
    const existingTimer = timersRef.current[composerKey];
    if (!existingTimer) return;
    clearTimeout(existingTimer);
    delete timersRef.current[composerKey];
  }, []);

  const setDraft = useCallback(
    (sessionId: string, text: string, attachments?: Attachment[]) => {
      setState((prev) => {
        const next = buildNextDraftState(prev, sessionId, text, attachments);
        if (next === prev) {
          clearDraftTimer(sessionId);
          return prev;
        }

        stateRef.current = next;
        scheduleSave(sessionId);

        return next;
      });
    },
    [clearDraftTimer, scheduleSave],
  );

  const setDraftImmediate = useCallback((sessionId: string, text: string, attachments?: Attachment[]) => {
    clearDraftTimer(sessionId);
    const next = buildNextDraftState(stateRef.current, sessionId, text, attachments);
    if (next === stateRef.current) return;
    stateRef.current = next;
    setState(next);
    save(next);
  }, [clearDraftTimer]);

  const clearDraft = useCallback((sessionId: string) => {
    clearDraftTimer(sessionId);
    setState((prev) => {
      if (!(sessionId in prev)) return prev;
      const next = { ...prev };
      delete next[sessionId];
      stateRef.current = next;
      save(next);
      return next;
    });
  }, [clearDraftTimer]);

  useEffect(() => {
    return () => {
      Object.values(timersRef.current).forEach((timer) => clearTimeout(timer));
      timersRef.current = {};
    };
  }, []);

  const getDraft = useCallback(
    (sessionId: string): Draft | null => {
      return state[sessionId] ?? null;
    },
    [state],
  );

  const hasDraft = useCallback(
    (sessionId: string): boolean => {
      return sessionId in state;
    },
    [state],
  );

  return { getDraft, setDraft, setDraftImmediate, clearDraft, hasDraft };
}
