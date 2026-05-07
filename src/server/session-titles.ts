// Session title overrides — stores explicit Bridge display title overrides.

import type { DatabaseSync } from "./db.js";
import { createBridgeSessionStateStore } from "./bridge-session-state-store.js";

// ── Factory ───────────────────────────────────────────────────────

export function createSessionTitlesStore(db: DatabaseSync) {
  const bridgeSessionStateStore = createBridgeSessionStateStore(db);

  function getTitle(sessionId: string): string | undefined {
    const row = db.prepare("SELECT title FROM session_titles WHERE sessionId = ?").get(sessionId) as any;
    return row?.title;
  }

  function setTitle(sessionId: string, title: string): void {
    db.prepare(
      "INSERT INTO session_titles (sessionId, title) VALUES (?, ?) ON CONFLICT(sessionId) DO UPDATE SET title = ?",
    ).run(sessionId, title, title);
    bridgeSessionStateStore.setTitleOverride(sessionId, title);
  }

  function hasTitle(sessionId: string): boolean {
    return !!db.prepare("SELECT 1 FROM session_titles WHERE sessionId = ?").get(sessionId);
  }

  function deleteTitle(sessionId: string): void {
    db.prepare("DELETE FROM session_titles WHERE sessionId = ?").run(sessionId);
    bridgeSessionStateStore.clearTitleOverride(sessionId);
  }

  function getAllTitles(): Record<string, string> {
    const rows = db.prepare("SELECT sessionId, title FROM session_titles").all() as any[];
    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.sessionId] = row.title;
    }
    return result;
  }

  return { getTitle, setTitle, hasTitle, deleteTitle, getAllTitles };
}

export type SessionTitlesStore = ReturnType<typeof createSessionTitlesStore>;
