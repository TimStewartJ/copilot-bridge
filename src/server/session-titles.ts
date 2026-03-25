// Session title overrides — stores LLM-generated concise titles
// The SDK CLI uses the full first user message as the session summary.
// We generate better titles and store them here.

import type { DatabaseSync } from "./db.js";

// ── Factory ───────────────────────────────────────────────────────

export function createSessionTitlesStore(db: DatabaseSync) {
  function loadTitles(): void {
    // Purge any titles that are actually echoed prompt text from a bug
    const leaked = db.prepare(
      "SELECT sessionId FROM session_titles WHERE title LIKE '%generate a concise%' OR title LIKE '%3-6 word title%'",
    ).all() as any[];
    if (leaked.length > 0) {
      db.prepare(
        "DELETE FROM session_titles WHERE title LIKE '%generate a concise%' OR title LIKE '%3-6 word title%'",
      ).run();
      console.log(`[titles] Purged ${leaked.length} leaked prompt-text titles`);
    }
  }

  function getTitle(sessionId: string): string | undefined {
    const row = db.prepare("SELECT title FROM session_titles WHERE sessionId = ?").get(sessionId) as any;
    return row?.title;
  }

  function setTitle(sessionId: string, title: string): void {
    db.prepare(
      "INSERT INTO session_titles (sessionId, title) VALUES (?, ?) ON CONFLICT(sessionId) DO UPDATE SET title = ?",
    ).run(sessionId, title, title);
  }

  function hasTitle(sessionId: string): boolean {
    return !!db.prepare("SELECT 1 FROM session_titles WHERE sessionId = ?").get(sessionId);
  }

  function deleteTitle(sessionId: string): void {
    db.prepare("DELETE FROM session_titles WHERE sessionId = ?").run(sessionId);
  }

  function getAllTitles(): Record<string, string> {
    const rows = db.prepare("SELECT sessionId, title FROM session_titles").all() as any[];
    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.sessionId] = row.title;
    }
    return result;
  }

  return { loadTitles, getTitle, setTitle, hasTitle, deleteTitle, getAllTitles };
}

export type SessionTitlesStore = ReturnType<typeof createSessionTitlesStore>;
