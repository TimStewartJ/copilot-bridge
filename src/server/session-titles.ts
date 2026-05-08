// Session title overrides — stores explicit Bridge display title overrides.

import type { DatabaseSync } from "./db.js";
import { createBridgeSessionStateStore } from "./bridge-session-state-store.js";

// ── Factory ───────────────────────────────────────────────────────

export function createSessionTitlesStore(db: DatabaseSync) {
  const bridgeSessionStateStore = createBridgeSessionStateStore(db);

  function tableExists(): boolean {
    const row = db.prepare(
      "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'session_titles'",
    ).get() as { found?: number } | undefined;
    return row?.found === 1;
  }

  function getTitle(sessionId: string): string | undefined {
    if (!tableExists()) return undefined;
    const row = db.prepare("SELECT title FROM session_titles WHERE sessionId = ?").get(sessionId) as any;
    return row?.title;
  }

  function setTitle(sessionId: string, title: string): void {
    if (!tableExists()) return;
    db.prepare(
      "INSERT INTO session_titles (sessionId, title) VALUES (?, ?) ON CONFLICT(sessionId) DO UPDATE SET title = ?",
    ).run(sessionId, title, title);
    bridgeSessionStateStore.setTitleOverride(sessionId, title);
  }

  function hasTitle(sessionId: string): boolean {
    if (!tableExists()) return false;
    return !!db.prepare("SELECT 1 FROM session_titles WHERE sessionId = ?").get(sessionId);
  }

  function deleteTitle(sessionId: string): void {
    if (tableExists()) {
      db.prepare("DELETE FROM session_titles WHERE sessionId = ?").run(sessionId);
    }
    bridgeSessionStateStore.clearTitleOverride(sessionId);
  }

  function getAllTitles(): Record<string, string> {
    if (!tableExists()) return {};
    const rows = db.prepare("SELECT sessionId, title FROM session_titles").all() as any[];
    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.sessionId] = row.title;
    }
    return result;
  }

  function clearAllTitles(): void {
    if (tableExists()) {
      db.prepare("DELETE FROM session_titles").run();
    }
    bridgeSessionStateStore.clearAllTitleOverrides();
  }

  function dropLegacyTable(): void {
    if (tableExists()) {
      db.prepare("DROP TABLE session_titles").run();
    }
    bridgeSessionStateStore.clearAllTitleOverrides();
  }

  return { getTitle, setTitle, hasTitle, deleteTitle, getAllTitles, clearAllTitles, dropLegacyTable };
}

export type SessionTitlesStore = ReturnType<typeof createSessionTitlesStore>;
