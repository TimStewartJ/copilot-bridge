import type { DatabaseSync } from "./db.js";
import { createBridgeSessionStateStore, type BridgeSessionState } from "./bridge-session-state-store.js";

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

  function hasMetaFields(state: BridgeSessionState): boolean {
    return state.archived
      || state.archivedAt !== undefined
      || state.triggeredBy !== undefined
      || state.scheduleId !== undefined
      || state.scheduleName !== undefined
      || state.lastVisibleActivityAt !== undefined;
  }

  function hydrate(state: BridgeSessionState): SessionMeta {
    return {
      archived: state.archived,
      archivedAt: state.archivedAt ?? "",
      triggeredBy: state.triggeredBy,
      scheduleId: state.scheduleId,
      scheduleName: state.scheduleName,
      lastVisibleActivityAt: state.lastVisibleActivityAt,
    };
  }

  function getMeta(sessionId: string): SessionMeta | undefined {
    const state = bridgeSessionStateStore.getState(sessionId);
    return state && hasMetaFields(state) ? hydrate(state) : undefined;
  }

  function isArchived(sessionId: string): boolean {
    return bridgeSessionStateStore.getState(sessionId)?.archived === true;
  }

  function setArchived(sessionId: string, archived: boolean): SessionMeta {
    bridgeSessionStateStore.setArchived(sessionId, archived);
    return getMeta(sessionId) ?? { archived: false, archivedAt: "" };
  }

  function deleteMeta(sessionId: string): void {
    bridgeSessionStateStore.deleteState(sessionId);
  }

  function setScheduleMeta(sessionId: string, scheduleId: string, scheduleName: string): void {
    bridgeSessionStateStore.setScheduleMeta(sessionId, scheduleId, scheduleName);
  }

  function setLastVisibleActivityAt(sessionId: string, lastVisibleActivityAt: string): void {
    bridgeSessionStateStore.setLastVisibleActivityAt(sessionId, lastVisibleActivityAt);
  }

  function recordScheduleRun(scheduleId: string, sessionId: string, recordedAt = new Date().toISOString()): void {
    db.prepare(`
      INSERT INTO schedule_runs (scheduleId, sessionId, recordedAt)
      VALUES (?, ?, ?)
    `).run(scheduleId, sessionId, recordedAt);
  }

  function listMeta(): MetaMap {
    const states = bridgeSessionStateStore.listStates();
    const result: MetaMap = {};
    for (const state of Object.values(states)) {
      if (hasMetaFields(state)) {
        result[state.sessionId] = hydrate(state);
      }
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
