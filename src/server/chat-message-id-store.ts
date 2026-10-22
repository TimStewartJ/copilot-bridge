// Which browser message id each saved user message was sent as, so history can name the
// optimistic chat message a saved one replaces. The runtime's message id is the join key: it is
// returned by `session.send` and saved on the `user.message` event.

import type { DatabaseSync } from "./db.js";

export interface ClientMessageIdAnnotatable {
  type?: string;
  role?: string;
  messageId?: string;
  clientMessageId?: string;
}

export function createChatMessageIdStore(db: DatabaseSync) {
  const insert = db.prepare(`
    INSERT INTO chat_message_client_ids (sessionId, messageId, clientMessageId, createdAt)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(sessionId, messageId) DO UPDATE SET clientMessageId = excluded.clientMessageId
  `);
  const selectForMessages = db.prepare(`
    SELECT messageId, clientMessageId FROM chat_message_client_ids
    WHERE sessionId = ? AND messageId IN (SELECT value FROM json_each(?))
  `);
  const removeSession = db.prepare("DELETE FROM chat_message_client_ids WHERE sessionId = ?");

  return {
    record(sessionId: string, messageId: string, clientMessageId: string, at: Date = new Date()): void {
      insert.run(sessionId, messageId, clientMessageId, at.toISOString());
    },
    /** Client message ids by runtime message id, for those of `messageIds` that have one. */
    getClientMessageIds(sessionId: string, messageIds: readonly string[]): Map<string, string> {
      const result = new Map<string, string>();
      if (messageIds.length === 0) return result;
      const rows = selectForMessages.all(sessionId, JSON.stringify([...new Set(messageIds)])) as Array<{
        messageId: string;
        clientMessageId: string;
      }>;
      for (const row of rows) result.set(row.messageId, row.clientMessageId);
      return result;
    },
    forgetSession(sessionId: string): void {
      removeSession.run(sessionId);
    },
  };
}

export type ChatMessageIdStore = ReturnType<typeof createChatMessageIdStore>;

/**
 * Adds `clientMessageId` to the user messages in a history page whose runtime message id has one,
 * with a single lookup for the page. Annotated entries are copies; the rest are returned as is.
 * A failed lookup leaves the page unannotated rather than failing the read.
 */
export function annotateClientMessageIds<T extends ClientMessageIdAnnotatable>(
  store: Pick<ChatMessageIdStore, "getClientMessageIds"> | undefined,
  sessionId: string,
  entries: T[],
): T[] {
  if (!store) return entries;
  const messageIds = entries.flatMap((entry) => (
    isUserMessageEntry(entry) && entry.messageId ? [entry.messageId] : []
  ));
  if (messageIds.length === 0) return entries;
  let clientMessageIds: Map<string, string>;
  try {
    clientMessageIds = store.getClientMessageIds(sessionId, messageIds);
  } catch (error) {
    console.warn(`[chat] [${sessionId.slice(0, 8)}] Could not read client message ids:`, error);
    return entries;
  }
  if (clientMessageIds.size === 0) return entries;
  return entries.map((entry) => {
    const clientMessageId = isUserMessageEntry(entry) && entry.messageId
      ? clientMessageIds.get(entry.messageId)
      : undefined;
    return clientMessageId ? { ...entry, clientMessageId } : entry;
  });
}

function isUserMessageEntry(entry: ClientMessageIdAnnotatable): boolean {
  return (entry.type === undefined || entry.type === "message") && entry.role === "user";
}
