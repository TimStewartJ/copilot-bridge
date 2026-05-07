import type { DatabaseSync } from "./db.js";
import { createBridgeSessionStateStore } from "./bridge-session-state-store.js";

export interface SessionWorkspace {
  cwd: string;
  updatedAt: string;
}

type SessionWorkspaceMap = Record<string, SessionWorkspace>;

export function createSessionWorkspaceStore(db: DatabaseSync) {
  const bridgeSessionStateStore = createBridgeSessionStateStore(db);

  function hydrate(row: any): SessionWorkspace {
    return {
      cwd: row.cwd,
      updatedAt: row.updatedAt,
    };
  }

  function getWorkspace(sessionId: string): SessionWorkspace | undefined {
    const row = db.prepare("SELECT cwd, updatedAt FROM session_workspace WHERE sessionId = ?").get(sessionId) as any;
    return row ? hydrate(row) : undefined;
  }

  function setWorkspace(sessionId: string, cwd: string): SessionWorkspace {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO session_workspace (sessionId, cwd, updatedAt)
      VALUES (?, ?, ?)
      ON CONFLICT(sessionId) DO UPDATE SET cwd = excluded.cwd, updatedAt = excluded.updatedAt
    `).run(sessionId, cwd, now);
    bridgeSessionStateStore.setPinnedCwd(sessionId, cwd);
    return { cwd, updatedAt: now };
  }

  function deleteWorkspace(sessionId: string): void {
    db.prepare("DELETE FROM session_workspace WHERE sessionId = ?").run(sessionId);
    bridgeSessionStateStore.clearPinnedCwd(sessionId);
  }

  function listWorkspaces(): SessionWorkspaceMap {
    const rows = db.prepare("SELECT sessionId, cwd, updatedAt FROM session_workspace").all() as any[];
    const result: SessionWorkspaceMap = {};
    for (const row of rows) {
      result[row.sessionId] = hydrate(row);
    }
    return result;
  }

  return {
    getWorkspace,
    setWorkspace,
    deleteWorkspace,
    listWorkspaces,
  };
}

export type SessionWorkspaceStore = ReturnType<typeof createSessionWorkspaceStore>;
