import type { DatabaseSync } from "./db.js";
import { createBridgeSessionStateStore } from "./bridge-session-state-store.js";
import {
  NO_PLAYBOOK,
  type PlaybookSource,
  type SessionPlaybookView,
} from "../shared/workflow-vocabulary.js";

/** A chat's stored playbook choice: the user's or agent's pick, or what its schedule pinned. */
export function createSessionPlaybookStore(db: DatabaseSync) {
  const bridgeSessionStateStore = createBridgeSessionStateStore(db);

  return {
    get(sessionId: string): { playbook: string; source: PlaybookSource } | undefined {
      const state = bridgeSessionStateStore.getState(sessionId);
      return state?.playbook && state.playbookSource ? { playbook: state.playbook, source: state.playbookSource } : undefined;
    },
    set(sessionId: string, playbook: string, source: PlaybookSource): void {
      bridgeSessionStateStore.setPlaybook(sessionId, playbook, source);
    },
    clear(sessionId: string): void {
      bridgeSessionStateStore.clearPlaybook(sessionId);
    },
  };
}

export type SessionPlaybookStore = ReturnType<typeof createSessionPlaybookStore>;

/**
 * The playbook a chat follows. A pick by the user or the agent wins; otherwise the task's pin;
 * otherwise what the chat's schedule pinned when it started it.
 */
export function resolveSessionPlaybook(
  stored: { playbook: string; source: PlaybookSource } | undefined,
  taskPin: string | undefined,
): { playbook: string; source: PlaybookSource } | undefined {
  if (stored && (stored.source === "user" || stored.source === "agent")) return stored;
  if (taskPin) return { playbook: taskPin, source: "task" };
  return stored;
}

export function toSessionPlaybookView(
  resolved: { playbook: string; source: PlaybookSource } | undefined,
  labelFor: (playbook: string) => string | undefined,
): SessionPlaybookView {
  if (!resolved) return {};
  return {
    playbook: resolved.playbook,
    source: resolved.source,
    label: resolved.playbook === NO_PLAYBOOK ? "Direct" : labelFor(resolved.playbook) ?? resolved.playbook,
  };
}
