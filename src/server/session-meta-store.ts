import type { DatabaseSync } from "./db.js";
import { createBridgeSessionStateStore } from "./bridge-session-state-store.js";

// ── Types ─────────────────────────────────────────────────────────

export interface SessionMeta {
  archived: boolean;
  archivedAt: string;
  triggeredBy?: "user" | "schedule";
  scheduleId?: string;
  scheduleName?: string;
  lastVisibleActivityAt?: string;
}

export interface ScheduleRunRecord {
  id: number;
  sessionId: string;
  recordedAt: string;
}

type MetaMap = Record<string, SessionMeta>;

// ── Factory ───────────────────────────────────────────────────────

export function createSessionMetaStore(db: DatabaseSync) {
  const bridgeSessionStateStore = createBridgeSessionStateStore(db);

  function hydrate(row: any): SessionMeta {
    return {
      archived: row.archived === 1,
      archivedAt: row.archivedAt ?? "",
      triggeredBy: row.triggeredBy ?? undefined,
      scheduleId: row.scheduleId ?? undefined,
      scheduleName: row.scheduleName ?? undefined,
      lastVisibleActivityAt: row.lastVisibleActivityAt ?? undefined,
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
      bridgeSessionStateStore.setArchived(sessionId, true);
    } else {
      db.prepare("DELETE FROM session_meta WHERE sessionId = ?").run(sessionId);
      bridgeSessionStateStore.setArchived(sessionId, false);
    }
    return getMeta(sessionId) ?? { archived: false, archivedAt: "" };
  }

  function deleteMeta(sessionId: string): void {
    db.prepare("DELETE FROM session_meta WHERE sessionId = ?").run(sessionId);
    bridgeSessionStateStore.deleteState(sessionId);
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
    bridgeSessionStateStore.setScheduleMeta(sessionId, scheduleId, scheduleName);
  }

  function setLastVisibleActivityAt(sessionId: string, lastVisibleActivityAt: string): void {
    db.prepare(`
      INSERT INTO session_meta (sessionId, archived, archivedAt, lastVisibleActivityAt)
      VALUES (?, 0, '', ?)
      ON CONFLICT(sessionId) DO UPDATE SET
        lastVisibleActivityAt = CASE
          WHEN session_meta.lastVisibleActivityAt IS NULL OR session_meta.lastVisibleActivityAt < excluded.lastVisibleActivityAt
          THEN excluded.lastVisibleActivityAt
          ELSE session_meta.lastVisibleActivityAt
        END
    `).run(sessionId, lastVisibleActivityAt);
    bridgeSessionStateStore.setLastVisibleActivityAt(sessionId, lastVisibleActivityAt);
  }

  function recordScheduleRun(scheduleId: string, sessionId: string, recordedAt = new Date().toISOString()): void {
    db.prepare(`
      INSERT INTO schedule_runs (scheduleId, sessionId, recordedAt)
      VALUES (?, ?, ?)
    `).run(scheduleId, sessionId, recordedAt);
  }

  function listMeta(): MetaMap {
    const rows = db.prepare("SELECT * FROM session_meta").all() as any[];
    const result: MetaMap = {};
    for (const row of rows) {
      result[row.sessionId] = hydrate(row);
    }
    return result;
  }

  function listScheduleRuns(scheduleId: string): ScheduleRunRecord[] {
    const rows = db.prepare(
      `SELECT id, sessionId, COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', recordedAt), recordedAt) AS recordedAt
       FROM schedule_runs
       WHERE scheduleId = ?
       ORDER BY datetime(recordedAt) DESC, id DESC`,
    ).all(scheduleId) as any[];
    return rows.map((row) => ({
      id: Number(row.id),
      sessionId: String(row.sessionId),
      recordedAt: String(row.recordedAt),
    }));
  }

  function listSessionIdsBySchedule(scheduleId: string): string[] {
    return listScheduleRuns(scheduleId).map((run) => run.sessionId);
  }

  return {
    getMeta,
    isArchived,
    setArchived,
    deleteMeta,
    setScheduleMeta,
    setLastVisibleActivityAt,
    recordScheduleRun,
    listMeta,
    listScheduleRuns,
    listSessionIdsBySchedule,
  };
}

export type SessionMetaStore = ReturnType<typeof createSessionMetaStore>;
