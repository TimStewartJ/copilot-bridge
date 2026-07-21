import type { DatabaseSync } from "./db.js";
import { createBridgeSessionStateStore, type BridgeSessionState } from "./bridge-session-state-store.js";
import type { SyntheticTerminalOverlay } from "../shared/session-stream.js";

// ── Schedule run retention ────────────────────────────────────────

/** Default number of schedule_runs rows retained per schedule. */
export const DEFAULT_SCHEDULE_RUNS_KEEP = 500;
/** Extra rows kept above a schedule's autoArchiveKeep so retention has headroom. */
export const SCHEDULE_RUNS_KEEP_HEADROOM = 50;

function readScheduleRunsKeepEnv(): number {
  const raw = process.env.BRIDGE_SCHEDULE_RUNS_KEEP;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (/^\d+$/.test(trimmed)) {
      const parsed = Number(trimmed);
      if (Number.isInteger(parsed) && parsed >= 1) return parsed;
    }
  }
  return DEFAULT_SCHEDULE_RUNS_KEEP;
}

/**
 * Resolve how many schedule_runs rows to retain for a schedule. Defaults to
 * BRIDGE_SCHEDULE_RUNS_KEEP (or {@link DEFAULT_SCHEDULE_RUNS_KEEP}). When a
 * schedule configures autoArchiveKeep, keep at least that many rows plus
 * {@link SCHEDULE_RUNS_KEEP_HEADROOM} so session retention still sees the full
 * keep window plus a buffer of candidates.
 */
export function resolveScheduleRunsKeep(autoArchiveKeep?: number | null): number {
  const base = readScheduleRunsKeepEnv();
  if (typeof autoArchiveKeep === "number" && Number.isInteger(autoArchiveKeep) && autoArchiveKeep > 0) {
    return Math.max(base, autoArchiveKeep + SCHEDULE_RUNS_KEEP_HEADROOM);
  }
  return base;
}

// ── Types ─────────────────────────────────────────────────────────

export interface SessionMeta {
  archived: boolean;
  archivedAt: string;
  triggeredBy?: "user" | "schedule";
  scheduleId?: string;
  scheduleName?: string;
  lastVisibleActivityAt?: string;
  lastAttentionAt?: string;
  terminalOverlay?: SyntheticTerminalOverlay;
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
      || state.lastVisibleActivityAt !== undefined
      || state.lastAttentionAt !== undefined
      || state.terminalOverlay !== undefined;
  }

  function hydrate(state: BridgeSessionState): SessionMeta {
    return {
      archived: state.archived,
      archivedAt: state.archivedAt ?? "",
      triggeredBy: state.triggeredBy,
      scheduleId: state.scheduleId,
      scheduleName: state.scheduleName,
      lastVisibleActivityAt: state.lastVisibleActivityAt,
      lastAttentionAt: state.lastAttentionAt,
      terminalOverlay: state.terminalOverlay,
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

  function replaceLastVisibleActivityAt(sessionId: string, lastVisibleActivityAt?: string): void {
    bridgeSessionStateStore.replaceLastVisibleActivityAt(sessionId, lastVisibleActivityAt);
  }

  function setLastAttentionAt(sessionId: string, lastAttentionAt: string): void {
    bridgeSessionStateStore.setLastAttentionAt(sessionId, lastAttentionAt);
  }

  function replaceLastAttentionAt(sessionId: string, lastAttentionAt?: string): void {
    bridgeSessionStateStore.replaceLastAttentionAt(sessionId, lastAttentionAt);
  }

  function getTerminalOverlay(sessionId: string): SyntheticTerminalOverlay | undefined {
    return bridgeSessionStateStore.getState(sessionId)?.terminalOverlay;
  }

  function setTerminalOverlay(sessionId: string, overlay: SyntheticTerminalOverlay): void {
    bridgeSessionStateStore.setTerminalOverlay(sessionId, overlay);
  }

  function clearTerminalOverlay(sessionId: string): void {
    bridgeSessionStateStore.clearTerminalOverlay(sessionId);
  }

  function recordScheduleRun(scheduleId: string, sessionId: string, recordedAt = new Date().toISOString()): void {
    db.prepare(`
      INSERT INTO schedule_runs (scheduleId, sessionId, recordedAt)
      VALUES (?, ?, ?)
    `).run(scheduleId, sessionId, recordedAt);
  }

  /**
   * Bound per-schedule run history to the newest `keep` rows. Idempotent: a
   * no-op when at or below the bound. `retainSessionIds` rows are never pruned
   * (used to preserve sessions retention still wants to retry, e.g. busy or
   * sessions with active deferred work). Ordering matches listScheduleRuns; the
   * idx_schedule_runs_schedule index serves the scheduleId filter.
   */
  function pruneScheduleRuns(scheduleId: string, keep: number, retainSessionIds: string[] = []): number {
    if (!Number.isInteger(keep) || keep <= 0) return 0;
    const retained = [...new Set(retainSessionIds)];
    const exclusion = retained.length > 0
      ? `AND sessionId NOT IN (${retained.map(() => "?").join(", ")})`
      : "";
    const result = db.prepare(`
      DELETE FROM schedule_runs
      WHERE id IN (
        SELECT id FROM schedule_runs
        WHERE scheduleId = ?
        ORDER BY datetime(recordedAt) DESC, id DESC
        LIMIT -1 OFFSET ?
      )
      ${exclusion}
    `).run(scheduleId, keep, ...retained) as { changes?: number };
    return result.changes ?? 0;
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
    replaceLastVisibleActivityAt,
    setLastAttentionAt,
    replaceLastAttentionAt,
    getTerminalOverlay,
    setTerminalOverlay,
    clearTerminalOverlay,
    recordScheduleRun,
    pruneScheduleRuns,
    listMeta,
    listScheduleRuns,
    listSessionIdsBySchedule,
  };
}

export type SessionMetaStore = ReturnType<typeof createSessionMetaStore>;
