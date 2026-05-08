import type { DatabaseSync } from "./db.js";
import { createBridgeSessionStateStore } from "./bridge-session-state-store.js";

export interface SessionWorkspace {
  cwd: string;
  updatedAt: string;
}

type SessionWorkspaceMap = Record<string, SessionWorkspace>;

export function createSessionWorkspaceStore(db: DatabaseSync) {
  const bridgeSessionStateStore = createBridgeSessionStateStore(db);

  function hydrate(state: { pinnedCwd: string; pinnedCwdUpdatedAt?: string; updatedAt: string }): SessionWorkspace {
    return {
      cwd: state.pinnedCwd,
      updatedAt: state.pinnedCwdUpdatedAt ?? state.updatedAt,
    };
  }

  function getWorkspace(sessionId: string): SessionWorkspace | undefined {
    const state = bridgeSessionStateStore.getState(sessionId);
    return state?.pinnedCwd ? hydrate({ ...state, pinnedCwd: state.pinnedCwd }) : undefined;
  }

  function setWorkspace(sessionId: string, cwd: string): SessionWorkspace {
    const state = bridgeSessionStateStore.setPinnedCwd(sessionId, cwd);
    return {
      cwd,
      updatedAt: state.pinnedCwdUpdatedAt ?? state.updatedAt,
    };
  }

  function deleteWorkspace(sessionId: string): void {
    bridgeSessionStateStore.clearPinnedCwd(sessionId);
  }

  function listWorkspaces(): SessionWorkspaceMap {
    const states = bridgeSessionStateStore.listStates();
    const result: SessionWorkspaceMap = {};
    for (const state of Object.values(states)) {
      if (state.pinnedCwd) {
        result[state.sessionId] = hydrate({ ...state, pinnedCwd: state.pinnedCwd });
      }
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
