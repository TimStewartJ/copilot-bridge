import type { DatabaseSync } from "./db.js";

export interface UnattendedRun {
  sessionId: string;
  /** Turns defers or schedules started since the user last wrote in the chat. */
  turnCount: number;
  firstAt: string;
  lastAt: string;
  origins: Array<"defer" | "schedule">;
}

/**
 * Chats where automated turns ran while nobody was watching. A chat leaves the list when the user
 * writes in it (which includes asking for a review) or dismisses it.
 */
export function createUnattendedRunStore(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS unattended_runs (
      sessionId TEXT PRIMARY KEY,
      turnCount INTEGER NOT NULL DEFAULT 0,
      firstAt TEXT NOT NULL,
      lastAt TEXT NOT NULL,
      origins TEXT NOT NULL DEFAULT ''
    );
  `);

  return {
    noteTurn(sessionId: string, origin: "defer" | "schedule", at = new Date().toISOString()): void {
      db.prepare(`
        INSERT INTO unattended_runs (sessionId, turnCount, firstAt, lastAt, origins)
        VALUES (?, 1, ?, ?, ?)
        ON CONFLICT(sessionId) DO UPDATE SET
          turnCount = unattended_runs.turnCount + 1,
          lastAt = excluded.lastAt,
          origins = CASE
            WHEN instr(',' || unattended_runs.origins || ',', ',' || excluded.origins || ',') > 0 THEN unattended_runs.origins
            WHEN unattended_runs.origins = '' THEN excluded.origins
            ELSE unattended_runs.origins || ',' || excluded.origins
          END
      `).run(sessionId, at, at, origin);
    },
    clear(sessionId: string): void {
      db.prepare("DELETE FROM unattended_runs WHERE sessionId = ?").run(sessionId);
    },
    list(): UnattendedRun[] {
      const rows = db.prepare("SELECT sessionId, turnCount, firstAt, lastAt, origins FROM unattended_runs ORDER BY lastAt DESC").all() as Array<{
        sessionId: string; turnCount: number; firstAt: string; lastAt: string; origins: string;
      }>;
      return rows.map((row) => ({
        sessionId: row.sessionId,
        turnCount: row.turnCount,
        firstAt: row.firstAt,
        lastAt: row.lastAt,
        origins: row.origins.split(",").filter((origin): origin is "defer" | "schedule" => origin === "defer" || origin === "schedule"),
      }));
    },
  };
}

export type UnattendedRunStore = ReturnType<typeof createUnattendedRunStore>;
