import { randomUUID } from "node:crypto";
import { CHAT_MESSAGE_DELIVERY_ID_PREFIX, type DeferredPromptStore } from "./deferred-prompt-store.js";

/**
 * Keeps a chat message the session cannot take right now (Bridge is holding it, it is resuming or
 * starting a turn, the backend is recovering, the server is restarting) as a deferred delivery. The
 * deferred-prompt runner sends it as a new turn once the session is free, and it survives restarts.
 */
export function queueChatMessageDelivery(
  store: Pick<DeferredPromptStore, "get" | "enqueueDelivery">,
  sessionId: string,
  prompt: string,
  clientMessageId?: string,
): string {
  const id = `${CHAT_MESSAGE_DELIVERY_ID_PREFIX}${clientMessageId ?? randomUUID()}`;
  // A client retrying the same message finds the row it already queued.
  if (!store.get(id)) store.enqueueDelivery({ id, sessionId, sourceId: id, prompt });
  return id;
}

export function isChatMessageDeliveryId(id: string): boolean {
  return id.startsWith(CHAT_MESSAGE_DELIVERY_ID_PREFIX);
}

/** The id the sending page gave the message, so the page recognizes it once its turn starts. */
export function chatMessageDeliveryClientId(id: string): string | undefined {
  return isChatMessageDeliveryId(id) ? id.slice(CHAT_MESSAGE_DELIVERY_ID_PREFIX.length) : undefined;
}
