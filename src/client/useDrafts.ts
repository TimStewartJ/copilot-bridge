import { useState, useCallback, useEffect, useRef } from "react";
import type { Session, BlobAttachment } from "./api";

const STORAGE_KEY = "copilot-bridge:session-drafts";
const DEBOUNCE_MS = 500;

export interface Draft {
  text: string;
  attachments?: BlobAttachment[];
}

type DraftState = Record<string, Draft>; // sessionId → Draft

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
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // GC: prune drafts for sessions that no longer exist
  useEffect(() => {
    if (sessions.length === 0) return;
    const validIds = new Set(sessions.map((s) => s.sessionId));
    setState((prev) => {
      let changed = false;
      const pruned: DraftState = {};
      for (const [id, draft] of Object.entries(prev)) {
        if (validIds.has(id)) {
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

  const flushNow = useCallback((next: DraftState) => {
    save(next);
  }, []);

  const setDraft = useCallback(
    (sessionId: string, text: string, attachments?: BlobAttachment[]) => {
      setState((prev) => {
        const trimmed = text.trim();
        const hasContent = trimmed.length > 0 || (attachments && attachments.length > 0);

        let next: DraftState;
        if (!hasContent) {
          if (!(sessionId in prev)) return prev; // no-op
          next = { ...prev };
          delete next[sessionId];
        } else {
          next = {
            ...prev,
            [sessionId]: attachments?.length
              ? { text, attachments }
              : { text },
          };
        }

        // Debounced save
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => flushNow(next), DEBOUNCE_MS);

        return next;
      });
    },
    [flushNow],
  );

  const clearDraft = useCallback((sessionId: string) => {
    // Cancel any pending debounced save to prevent it from re-persisting the draft
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setState((prev) => {
      if (!(sessionId in prev)) return prev;
      const next = { ...prev };
      delete next[sessionId];
      save(next);
      return next;
    });
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

  return { getDraft, setDraft, clearDraft, hasDraft };
}
