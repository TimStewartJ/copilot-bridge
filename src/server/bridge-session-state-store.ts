import type { DatabaseSync } from "./db.js";

export interface BridgeSessionState {
  sessionId: string;
  archived: boolean;
  archivedAt?: string;
  titleOverride?: string;
  titleOverrideUpdatedAt?: string;
  pinnedCwd?: string;
  pinnedCwdUpdatedAt?: string;
  triggeredBy?: "user" | "schedule";
  scheduleId?: string;
  scheduleName?: string;
  lastVisibleActivityAt?: string;
  hiddenReason?: string;
  hiddenAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type BridgeSessionStateMap = Record<string, BridgeSessionState>;

function nowIso(): string {
  return new Date().toISOString();
}

export function createBridgeSessionStateStore(db: DatabaseSync) {
  function hydrate(row: any): BridgeSessionState {
    return {
      sessionId: row.sessionId,
      archived: row.archived === 1,
      archivedAt: row.archivedAt ?? undefined,
      titleOverride: row.titleOverride ?? undefined,
      titleOverrideUpdatedAt: row.titleOverrideUpdatedAt ?? undefined,
      pinnedCwd: row.pinnedCwd ?? undefined,
      pinnedCwdUpdatedAt: row.pinnedCwdUpdatedAt ?? undefined,
      triggeredBy: row.triggeredBy ?? undefined,
      scheduleId: row.scheduleId ?? undefined,
      scheduleName: row.scheduleName ?? undefined,
      lastVisibleActivityAt: row.lastVisibleActivityAt ?? undefined,
      hiddenReason: row.hiddenReason ?? undefined,
      hiddenAt: row.hiddenAt ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  function getState(sessionId: string): BridgeSessionState | undefined {
    const row = db.prepare("SELECT * FROM bridge_session_state WHERE sessionId = ?").get(sessionId) as any;
    return row ? hydrate(row) : undefined;
  }

  function listStates(): BridgeSessionStateMap {
    const rows = db.prepare("SELECT * FROM bridge_session_state").all() as any[];
    const states: BridgeSessionStateMap = {};
    for (const row of rows) states[row.sessionId] = hydrate(row);
    return states;
  }

  function pruneIfDefault(sessionId: string): void {
    db.prepare(`
      DELETE FROM bridge_session_state
      WHERE sessionId = ?
        AND archived = 0
        AND archivedAt IS NULL
        AND titleOverride IS NULL
        AND titleOverrideUpdatedAt IS NULL
        AND pinnedCwd IS NULL
        AND pinnedCwdUpdatedAt IS NULL
        AND triggeredBy IS NULL
        AND scheduleId IS NULL
        AND scheduleName IS NULL
        AND lastVisibleActivityAt IS NULL
        AND hiddenReason IS NULL
        AND hiddenAt IS NULL
    `).run(sessionId);
  }

  function setArchived(sessionId: string, archived: boolean): BridgeSessionState | undefined {
    const now = nowIso();
    if (archived) {
      db.prepare(`
        INSERT INTO bridge_session_state (sessionId, archived, archivedAt, createdAt, updatedAt)
        VALUES (?, 1, ?, ?, ?)
        ON CONFLICT(sessionId) DO UPDATE SET
          archived = 1,
          archivedAt = excluded.archivedAt,
          updatedAt = excluded.updatedAt
      `).run(sessionId, now, now, now);
    } else {
      db.prepare(`
        UPDATE bridge_session_state
        SET archived = 0,
            archivedAt = NULL,
            updatedAt = ?
        WHERE sessionId = ?
      `).run(now, sessionId);
      pruneIfDefault(sessionId);
    }
    return getState(sessionId);
  }

  function setTitleOverride(sessionId: string, title: string): BridgeSessionState {
    const now = nowIso();
    db.prepare(`
      INSERT INTO bridge_session_state (sessionId, titleOverride, titleOverrideUpdatedAt, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(sessionId) DO UPDATE SET
        titleOverride = excluded.titleOverride,
        titleOverrideUpdatedAt = excluded.titleOverrideUpdatedAt,
        updatedAt = excluded.updatedAt
    `).run(sessionId, title, now, now, now);
    return getState(sessionId)!;
  }

  function clearTitleOverride(sessionId: string): void {
    const now = nowIso();
    db.prepare(`
      UPDATE bridge_session_state
      SET titleOverride = NULL,
          titleOverrideUpdatedAt = NULL,
          updatedAt = ?
      WHERE sessionId = ?
    `).run(now, sessionId);
    pruneIfDefault(sessionId);
  }

  function clearAllTitleOverrides(): void {
    const now = nowIso();
    db.prepare(`
      UPDATE bridge_session_state
      SET titleOverride = NULL,
          titleOverrideUpdatedAt = NULL,
          updatedAt = ?
      WHERE titleOverride IS NOT NULL
         OR titleOverrideUpdatedAt IS NOT NULL
    `).run(now);
    db.prepare(`
      DELETE FROM bridge_session_state
      WHERE archived = 0
        AND archivedAt IS NULL
        AND titleOverride IS NULL
        AND titleOverrideUpdatedAt IS NULL
        AND pinnedCwd IS NULL
        AND pinnedCwdUpdatedAt IS NULL
        AND triggeredBy IS NULL
        AND scheduleId IS NULL
        AND scheduleName IS NULL
        AND lastVisibleActivityAt IS NULL
        AND hiddenReason IS NULL
        AND hiddenAt IS NULL
    `).run();
  }

  function setPinnedCwd(sessionId: string, cwd: string): BridgeSessionState {
    const now = nowIso();
    db.prepare(`
      INSERT INTO bridge_session_state (sessionId, pinnedCwd, pinnedCwdUpdatedAt, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(sessionId) DO UPDATE SET
        pinnedCwd = excluded.pinnedCwd,
        pinnedCwdUpdatedAt = excluded.pinnedCwdUpdatedAt,
        updatedAt = excluded.updatedAt
    `).run(sessionId, cwd, now, now, now);
    return getState(sessionId)!;
  }

  function clearPinnedCwd(sessionId: string): void {
    const now = nowIso();
    db.prepare(`
      UPDATE bridge_session_state
      SET pinnedCwd = NULL,
          pinnedCwdUpdatedAt = NULL,
          updatedAt = ?
      WHERE sessionId = ?
    `).run(now, sessionId);
    pruneIfDefault(sessionId);
  }

  function setScheduleMeta(sessionId: string, scheduleId: string, scheduleName: string): BridgeSessionState {
    const now = nowIso();
    db.prepare(`
      INSERT INTO bridge_session_state (sessionId, triggeredBy, scheduleId, scheduleName, createdAt, updatedAt)
      VALUES (?, 'schedule', ?, ?, ?, ?)
      ON CONFLICT(sessionId) DO UPDATE SET
        triggeredBy = 'schedule',
        scheduleId = excluded.scheduleId,
        scheduleName = excluded.scheduleName,
        updatedAt = excluded.updatedAt
    `).run(sessionId, scheduleId, scheduleName, now, now);
    return getState(sessionId)!;
  }

  function setLastVisibleActivityAt(sessionId: string, lastVisibleActivityAt: string): BridgeSessionState {
    const now = nowIso();
    db.prepare(`
      INSERT INTO bridge_session_state (sessionId, lastVisibleActivityAt, createdAt, updatedAt)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(sessionId) DO UPDATE SET
        lastVisibleActivityAt = CASE
          WHEN bridge_session_state.lastVisibleActivityAt IS NULL
            OR bridge_session_state.lastVisibleActivityAt < excluded.lastVisibleActivityAt
          THEN excluded.lastVisibleActivityAt
          ELSE bridge_session_state.lastVisibleActivityAt
        END,
        updatedAt = CASE
          WHEN bridge_session_state.lastVisibleActivityAt IS NULL
            OR bridge_session_state.lastVisibleActivityAt < excluded.lastVisibleActivityAt
          THEN excluded.updatedAt
          ELSE bridge_session_state.updatedAt
        END
    `).run(sessionId, lastVisibleActivityAt, now, now);
    return getState(sessionId)!;
  }

  function setHidden(sessionId: string, hiddenReason: string): BridgeSessionState {
    const now = nowIso();
    db.prepare(`
      INSERT INTO bridge_session_state (sessionId, hiddenReason, hiddenAt, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(sessionId) DO UPDATE SET
        hiddenReason = excluded.hiddenReason,
        hiddenAt = excluded.hiddenAt,
        updatedAt = excluded.updatedAt
    `).run(sessionId, hiddenReason, now, now, now);
    return getState(sessionId)!;
  }

  function clearHidden(sessionId: string): void {
    const now = nowIso();
    db.prepare(`
      UPDATE bridge_session_state
      SET hiddenReason = NULL,
          hiddenAt = NULL,
          updatedAt = ?
      WHERE sessionId = ?
    `).run(now, sessionId);
    pruneIfDefault(sessionId);
  }

  function deleteState(sessionId: string): void {
    db.prepare("DELETE FROM bridge_session_state WHERE sessionId = ?").run(sessionId);
  }

  return {
    getState,
    listStates,
    setArchived,
    setTitleOverride,
    clearTitleOverride,
    clearAllTitleOverrides,
    setPinnedCwd,
    clearPinnedCwd,
    setScheduleMeta,
    setLastVisibleActivityAt,
    setHidden,
    clearHidden,
    deleteState,
    pruneIfDefault,
  };
}

export type BridgeSessionStateStore = ReturnType<typeof createBridgeSessionStateStore>;
