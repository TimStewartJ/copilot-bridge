import type { DatabaseSync } from "./db.js";
import { createBridgeSessionStateStore } from "./bridge-session-state-store.js";
import type { PromptProfileId } from "../shared/prompt-profiles.js";

/** Explicit per-chat profile choices. A chat without one follows the settings default. */
export function createSessionPromptProfileStore(db: DatabaseSync) {
  const bridgeSessionStateStore = createBridgeSessionStateStore(db);

  return {
    getPromptProfile(sessionId: string): PromptProfileId | undefined {
      return bridgeSessionStateStore.getState(sessionId)?.promptProfile;
    },
    setPromptProfile(sessionId: string, promptProfile: PromptProfileId): void {
      bridgeSessionStateStore.setPromptProfile(sessionId, promptProfile);
    },
    clearPromptProfile(sessionId: string): void {
      bridgeSessionStateStore.clearPromptProfile(sessionId);
    },
  };
}

export type SessionPromptProfileStore = ReturnType<typeof createSessionPromptProfileStore>;
