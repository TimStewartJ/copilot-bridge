import type { DeferLoopStore } from "./defer-loop-store.js";
import type { DeferredPromptStore } from "./deferred-prompt-store.js";
import type { GlobalBus } from "./global-bus.js";
import type { Schedule } from "./schedule-store.js";
import type { SessionManager } from "./session-manager.js";
import type { SessionMetaStore } from "./session-meta-store.js";

type RetentionSessionManager = Pick<SessionManager, "isSessionBusy" | "listSessionsFromDisk">;

export interface ScheduleSessionRetentionDeps {
  schedule: Schedule;
  sessionMetaStore: SessionMetaStore;
  sessionManager: RetentionSessionManager;
  globalBus: GlobalBus;
  deferredPromptStore?: Pick<DeferredPromptStore, "listForSession">;
  deferLoopStore?: Pick<DeferLoopStore, "listForSession">;
}

export interface ScheduleSessionRetentionResult {
  archivedSessionIds: string[];
  skippedSessionIds: string[];
  /**
   * Candidate sessions that still exist but were not archived this pass because
   * they are busy or have active deferred work. Their run-history rows should be
   * preserved so retention can retry them on a later fire. Excludes sessions
   * that are missing from disk (those should be pruned as orphans).
   */
  retainableSessionIds: string[];
}

function hasActiveDeferredWork(
  sessionId: string,
  deps: Pick<ScheduleSessionRetentionDeps, "deferredPromptStore" | "deferLoopStore">,
): boolean {
  if (!deps.deferredPromptStore || !deps.deferLoopStore) return true;

  const hasPendingPrompt = deps.deferredPromptStore
    ?.listForSession(sessionId)
    .some((prompt) => prompt.status === "pending" || prompt.status === "running") ?? false;
  if (hasPendingPrompt) return true;

  return deps.deferLoopStore
    ?.listForSession(sessionId)
    .some((loop) => loop.status === "active" || loop.status === "running") ?? false;
}

export async function enforceScheduleSessionRetention(
  deps: ScheduleSessionRetentionDeps,
): Promise<ScheduleSessionRetentionResult> {
  const keepCount = deps.schedule.autoArchiveKeep;
  if (typeof keepCount !== "number" || !Number.isInteger(keepCount) || keepCount <= 0) {
    return { archivedSessionIds: [], skippedSessionIds: [], retainableSessionIds: [] };
  }

  const runs = deps.sessionMetaStore.listScheduleRuns(deps.schedule.id);
  const keep = new Set<string>();
  const candidates = new Set<string>();
  for (const run of runs) {
    if (keep.has(run.sessionId) || candidates.has(run.sessionId)) continue;
    if (keep.size < keepCount) {
      keep.add(run.sessionId);
    } else {
      candidates.add(run.sessionId);
    }
  }

  if (candidates.size === 0) {
    return { archivedSessionIds: [], skippedSessionIds: [], retainableSessionIds: [] };
  }

  const sessions = await deps.sessionManager.listSessionsFromDisk({ includeArchived: true });
  const existingSessionIds = new Set(sessions.map((session: { sessionId: string }) => session.sessionId));
  const archivedSessionIds: string[] = [];
  const skippedSessionIds: string[] = [];
  const retainableSessionIds: string[] = [];

  for (const sessionId of candidates) {
    const exists = existingSessionIds.has(sessionId);
    const blocked = exists
      && (deps.sessionManager.isSessionBusy(sessionId) || hasActiveDeferredWork(sessionId, deps));
    if (!exists || blocked) {
      skippedSessionIds.push(sessionId);
      if (blocked) retainableSessionIds.push(sessionId);
      continue;
    }

    if (deps.sessionMetaStore.isArchived(sessionId)) continue;
    deps.sessionMetaStore.setArchived(sessionId, true);
    deps.globalBus.emit({ type: "session:archived", sessionId, archived: true });
    archivedSessionIds.push(sessionId);
  }

  return { archivedSessionIds, skippedSessionIds, retainableSessionIds };
}
