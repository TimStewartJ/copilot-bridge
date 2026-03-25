import type { DatabaseSync } from "./db.js";

// ── Types ─────────────────────────────────────────────────────────

export interface SessionMeta {
  archived: boolean;
  archivedAt: string;
  triggeredBy?: "user" | "schedule";
  scheduleId?: string;
  scheduleName?: string;
}

type MetaMap = Record<string, SessionMeta>;

// ── Factory ───────────────────────────────────────────────────────

export function createSessionMetaStore(db: DatabaseSync) {
  function hydrate(row: any): SessionMeta {
    return {
      archived: row.archived === 1,
      archivedAt: row.archivedAt ?? "",
      triggeredBy: row.triggeredBy ?? undefined,
      scheduleId: row.scheduleId ?? undefined,
      scheduleName: row.scheduleName ?? undefined,
    };
  }

  function getMeta(sessionId: string): SessionMeta | undefined {
    const row = db.prepare("SELECT * FROM session_meta WHERE sessionId = ?").get(sessionId) as any;
    return row ? hydrate(row) : undefined;
  }

  function isArchived(sessionId: string): boolean {
    const row = db.prepare("SELECT archived FROM session_meta WHERE sessionId = ?").get(sessionId) as any;
    return row?.archived === 1;
  }

  function setArchived(sessionId: string, archived: boolean): SessionMeta {
    if (archived) {
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO session_meta (sessionId, archived, archivedAt)
        VALUES (?, 1, ?)
        ON CONFLICT(sessionId) DO UPDATE SET archived = 1, archivedAt = ?
      `).run(sessionId, now, now);
    } else {
      db.prepare("DELETE FROM session_meta WHERE sessionId = ?").run(sessionId);
    }
    return getMeta(sessionId) ?? { archived: false, archivedAt: "" };
  }

  function deleteMeta(sessionId: string): void {
    db.prepare("DELETE FROM session_meta WHERE sessionId = ?").run(sessionId);
  }

  function setScheduleMeta(sessionId: string, scheduleId: string, scheduleName: string): void {
    const existing = getMeta(sessionId);
    if (existing) {
      db.prepare(`
        UPDATE session_meta SET triggeredBy = 'schedule', scheduleId = ?, scheduleName = ?
        WHERE sessionId = ?
      `).run(scheduleId, scheduleName, sessionId);
    } else {
      db.prepare(`
        INSERT INTO session_meta (sessionId, archived, archivedAt, triggeredBy, scheduleId, scheduleName)
        VALUES (?, 0, '', 'schedule', ?, ?)
      `).run(sessionId, scheduleId, scheduleName);
    }
  }

  function listMeta(): MetaMap {
    const rows = db.prepare("SELECT * FROM session_meta").all() as any[];
    const result: MetaMap = {};
    for (const row of rows) {
      result[row.sessionId] = hydrate(row);
    }
    return result;
  }

  return { getMeta, isArchived, setArchived, deleteMeta, setScheduleMeta, listMeta };
}

export type SessionMetaStore = ReturnType<typeof createSessionMetaStore>;
