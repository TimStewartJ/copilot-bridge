/**
 * Work Bridge does on a session outside any agent run (a "hold"). While one is in progress the
 * session is busy, but it has no run to stream or steer.
 */
export type SessionHoldReason = "model-switching" | "history-undo" | "image-compaction";

/** What a session's live view shows while it is held. */
export const SESSION_HOLD_INTENT: Record<SessionHoldReason, string> = {
  "image-compaction": "Summarizing the images in this chat",
  "model-switching": "Switching model",
  "history-undo": "Undoing chat history",
};

/** Tracks which sessions are held and who is watching for a hold to start or end. */
export class SessionHolds {
  private readonly reasons = new Map<string, SessionHoldReason>();
  private readonly listeners = new Map<string, Set<() => void>>();

  has(sessionId: string): boolean {
    return this.reasons.has(sessionId);
  }

  get(sessionId: string): SessionHoldReason | undefined {
    return this.reasons.get(sessionId);
  }

  sessionIds(): IterableIterator<string> {
    return this.reasons.keys();
  }

  start(sessionId: string, reason: SessionHoldReason): void {
    this.reasons.set(sessionId, reason);
    this.notify(sessionId);
  }

  /** Ends the hold; false when the session was not held. Callers notify once follow-up work has started. */
  end(sessionId: string): boolean {
    return this.reasons.delete(sessionId);
  }

  subscribe(sessionId: string, listener: () => void): () => void {
    let set = this.listeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(listener);
    return () => {
      const current = this.listeners.get(sessionId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(sessionId);
    };
  }

  notify(sessionId: string): void {
    const set = this.listeners.get(sessionId);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        listener();
      } catch (error) {
        console.warn(`[sdk] [${sessionId.slice(0, 8)}] Session hold listener failed:`, error instanceof Error ? error.message : error);
      }
    }
  }
}
