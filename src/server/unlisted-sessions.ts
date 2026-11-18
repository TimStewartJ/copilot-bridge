import { randomUUID } from "node:crypto";
import { isComparisonTwinSessionId } from "./comparison-twin.js";
import { isDisposableDeferWorkerSessionId } from "./defer-ids.js";
import { isScratchSessionId } from "./scratch-sessions.js";
import { isDisposableTitleSessionId } from "./session-name-generator.js";

/** Chats no list, search or notification shows, told apart by the reserved prefix of their id. */
export function isUnlistedSessionId(sessionId: string): boolean {
  return isDisposableTitleSessionId(sessionId)
    || isDisposableDeferWorkerSessionId(sessionId)
    || isScratchSessionId(sessionId)
    || isComparisonTwinSessionId(sessionId);
}

/** A new id for an ordinary chat, never one that a reserved prefix would hide or delete. */
export function createListedSessionId(): string {
  for (;;) {
    const sessionId = randomUUID();
    if (!isUnlistedSessionId(sessionId)) return sessionId;
  }
}
