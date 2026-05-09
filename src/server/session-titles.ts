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
    return bridgeSessionStateStore.getState(sessionId)?.titleOverride;
  }

  function setTitle(sessionId: string, title: string): void {
    bridgeSessionStateStore.setTitleOverride(sessionId, title);
  }

  function hasTitle(sessionId: string): boolean {
    return getTitle(sessionId) !== undefined;
  }

  function deleteTitle(sessionId: string): void {
    bridgeSessionStateStore.clearTitleOverride(sessionId);
  }

  function getAllTitles(): Record<string, string> {
    const states = bridgeSessionStateStore.listStates();
    const result: Record<string, string> = {};
    for (const state of Object.values(states)) {
      if (state.titleOverride !== undefined) {
        result[state.sessionId] = state.titleOverride;
      }
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
