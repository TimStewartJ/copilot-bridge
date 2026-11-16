// Keeps the newest chats a trigger started and archives older ones, for triggers that set keepChats.

import type { DeferredPromptStore } from "../deferred-prompt-store.js";
import type { GlobalBus } from "../global-bus.js";
import { setSessionsArchived } from "../session-archive.js";
import type { SessionManager } from "../session-manager.js";
import type { SessionMetaStore } from "../session-meta-store.js";
import type { TriggerStore } from "./store.js";

/** Run rows kept per trigger beyond keepChats, so retention always has the full window to look at. */
export const TRIGGER_RUNS_KEEP_MIN = 200;
const TRIGGER_RUNS_KEEP_HEADROOM = 50;

export function resolveTriggerRunsKeep(keepChats?: number): number {
  return Math.max(TRIGGER_RUNS_KEEP_MIN, (keepChats ?? 0) + TRIGGER_RUNS_KEEP_HEADROOM);
}

/**
 * Whether a chat has automation that archiving would cancel: an active trigger, or a restart notice
 * waiting to be sent. Without the stores to ask, assume it has.
 */
export function hasPendingChatAutomation(
  sessionId: string,
  deps: { triggerStore?: Pick<TriggerStore, "hasActiveForSession">; deferredPromptStore?: Pick<DeferredPromptStore, "listForSession"> },
): boolean {
  if (!deps.triggerStore || !deps.deferredPromptStore) return true;
  return deps.triggerStore.hasActiveForSession(sessionId)
    || deps.deferredPromptStore.listForSession(sessionId).some((prompt) => prompt.status === "pending" || prompt.status === "running");
}

export interface TriggerRetentionDeps {
  triggerId: string;
  keepChats?: number;
  triggerStore: Pick<TriggerStore, "listRuns" | "hasActiveForSession">;
  sessionMetaStore: Pick<SessionMetaStore, "isArchived" | "setArchived">;
  sessionManager: Pick<SessionManager, "isSessionBusy" | "readSessionsFromDisk">;
  globalBus: GlobalBus;
}

export interface TriggerRetentionResult {
  archivedSessionIds: string[];
  /** Chats that still exist but were left alone (busy or with triggers of their own); their run rows are kept. */
  retainableSessionIds: string[];
}

export async function enforceTriggerChatRetention(deps: TriggerRetentionDeps): Promise<TriggerRetentionResult> {
  const keepCount = deps.keepChats;
  if (typeof keepCount !== "number" || !Number.isInteger(keepCount) || keepCount <= 0) {
    return { archivedSessionIds: [], retainableSessionIds: [] };
  }
  const keep = new Set<string>();
  const candidates = new Set<string>();
  for (const run of deps.triggerStore.listRuns(deps.triggerId).runs) {
    if (keep.has(run.sessionId) || candidates.has(run.sessionId)) continue;
    if (keep.size < keepCount) keep.add(run.sessionId);
    else candidates.add(run.sessionId);
  }
  if (candidates.size === 0) return { archivedSessionIds: [], retainableSessionIds: [] };

  // A folder that could not be read throws: this pass then archives and prunes nothing, and the next one retries.
  const sessions = await deps.sessionManager.readSessionsFromDisk([...candidates], { failOnReadError: true });
  const existing = new Set(sessions.map((session: { sessionId: string }) => session.sessionId));
  const toArchive: string[] = [];
  const retainableSessionIds: string[] = [];
  for (const sessionId of candidates) {
    if (!existing.has(sessionId)) continue;
    // Archiving cancels a chat's triggers, so a chat with any is left alone.
    if (deps.sessionManager.isSessionBusy(sessionId) || deps.triggerStore.hasActiveForSession(sessionId)) {
      retainableSessionIds.push(sessionId);
      continue;
    }
    if (deps.sessionMetaStore.isArchived(sessionId)) continue;
    toArchive.push(sessionId);
  }
  // No await between the checks above and these writes, so a chat cannot turn busy in between.
  const { sessionIds: archivedSessionIds, errors } = setSessionsArchived(deps, toArchive, true);
  for (const sessionId of Object.keys(errors)) {
    console.warn(`[trigger-retention] Could not archive session ${sessionId}: ${errors[sessionId]}`);
    retainableSessionIds.push(sessionId);
  }
  return { archivedSessionIds, retainableSessionIds };
}
