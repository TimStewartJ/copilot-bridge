// Chat messages the Bridge accepted that the agent never received. Each is recorded when its turn
// starts and removed once the runtime has saved it, so a Stop, a failed start or a restart before
// that leaves it in the chat, marked not sent, instead of losing it with the in-memory overlay.

import type { DatabaseSync } from "./db.js";
import { isSendMode, type SendMode } from "../shared/send-mode.js";
import {
  isUnsentMessageState,
  type UnsentMessageAttachment,
  type UnsentMessageState,
  type UnsentMessageView,
} from "../shared/unsent-message.js";

/**
 * Row states beyond the shown ones: waiting to be sent, handed to the runtime, delivered, being
 * resent, or dismissed. Delivered and dismissed rows stay a while so a repeat of the same browser
 * message is recognised and not run again.
 */
type StoredState = UnsentMessageState | "pending" | "sending" | "delivered" | "resending" | "discarded";

const RESOLVED_RETENTION_MS = 14 * 24 * 60 * 60_000;

interface Row {
  sessionId: string;
  id: string;
  content: string;
  attachmentsJson: string | null;
  mode: string | null;
  state: string;
  error: string | null;
  createdAt: string;
}

export interface RecordPendingMessage {
  sessionId: string;
  id: string;
  content: string;
  attachments?: UnsentMessageAttachment[];
  mode?: SendMode;
  at?: Date;
}

export function initializeUnsentMessageSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS unsent_chat_messages (
      sessionId TEXT NOT NULL,
      id TEXT NOT NULL,
      content TEXT NOT NULL,
      attachmentsJson TEXT,
      mode TEXT,
      state TEXT NOT NULL,
      error TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      PRIMARY KEY (sessionId, id)
    );
  `);
}

function parseAttachments(json: string | null): UnsentMessageAttachment[] | undefined {
  if (!json) return undefined;
  try {
    const value: unknown = JSON.parse(json);
    if (!Array.isArray(value)) return undefined;
    const attachments = value.flatMap((item): UnsentMessageAttachment[] => (
      item && typeof item === "object"
        && typeof item.displayName === "string" && typeof item.mimeType === "string"
        ? [{
          type: "uploaded",
          displayName: item.displayName,
          mimeType: item.mimeType,
          ...(typeof item.size === "number" ? { size: item.size } : {}),
        }]
        : []
    ));
    return attachments.length > 0 ? attachments : undefined;
  } catch {
    return undefined;
  }
}

function toView(row: Row): UnsentMessageView | undefined {
  if (!isUnsentMessageState(row.state)) return undefined;
  const attachments = parseAttachments(row.attachmentsJson);
  return {
    id: row.id,
    content: row.content,
    ...(attachments ? { attachments } : {}),
    ...(row.mode && isSendMode(row.mode) ? { mode: row.mode } : {}),
    state: row.state,
    ...(row.error ? { error: row.error } : {}),
    createdAt: row.createdAt,
  };
}

const SHOWN = "('stopped', 'failed', 'interrupted')";

export function createUnsentMessageStore(db: DatabaseSync) {
  initializeUnsentMessageSchema(db);
  const insert = db.prepare(`
    INSERT INTO unsent_chat_messages (sessionId, id, content, attachmentsJson, mode, state, error, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, ?)
    ON CONFLICT(sessionId, id) DO NOTHING
  `);
  const select = db.prepare("SELECT * FROM unsent_chat_messages WHERE sessionId = ? AND id = ?");
  const selectShown = db.prepare(`
    SELECT * FROM unsent_chat_messages WHERE sessionId = ? AND state IN ${SHOWN} ORDER BY createdAt, id
  `);
  const setState = db.prepare(`
    UPDATE unsent_chat_messages SET state = ?, error = ?, updatedAt = ?
    WHERE sessionId = ? AND id = ? AND state = ?
  `);
  const markDelivered = db.prepare(`
    UPDATE unsent_chat_messages SET state = 'delivered', error = NULL, updatedAt = ?
    WHERE sessionId = ? AND id = ? AND state <> 'delivered'
  `);
  const removeSession = db.prepare("DELETE FROM unsent_chat_messages WHERE sessionId = ?");
  // Never handed to the runtime: it cannot have it. Handed over: the runtime saves a message before
  // it answers, so it has it.
  const interruptUnsent = db.prepare(`
    UPDATE unsent_chat_messages SET state = 'interrupted', error = NULL, updatedAt = ?
    WHERE state IN ('pending', 'resending')
  `);
  const settleSending = db.prepare(`
    UPDATE unsent_chat_messages SET state = 'delivered', updatedAt = ? WHERE state = 'sending'
  `);
  const pruneResolved = db.prepare(`
    DELETE FROM unsent_chat_messages WHERE state IN ('delivered', 'discarded') AND updatedAt < ?
  `);

  const read = (sessionId: string, id: string): Row | undefined => select.get(sessionId, id) as Row | undefined;
  const transition = (sessionId: string, id: string, from: StoredState, to: StoredState, error?: string): boolean => (
    Number(setState.run(to, error ?? null, new Date().toISOString(), sessionId, id, from).changes) > 0
  );

  return {
    /** Records a message whose turn is starting. A message already known under this id is left as it is. */
    recordPending(message: RecordPendingMessage): boolean {
      const at = (message.at ?? new Date()).toISOString();
      const result = insert.run(
        message.sessionId,
        message.id,
        message.content,
        message.attachments?.length ? JSON.stringify(message.attachments) : null,
        message.mode ?? null,
        at,
        at,
      );
      return Number(result.changes) > 0;
    },
    /** The agent never got a message that was waiting to be sent. */
    markUndelivered(sessionId: string, id: string, state: UnsentMessageState, error?: string): boolean {
      return transition(sessionId, id, "pending", state, error);
    },
    /** The message is being handed to the runtime; from here only the runtime's answer settles it. */
    markSending(sessionId: string, id: string): boolean {
      return transition(sessionId, id, "pending", "sending");
    },
    /** Handing it over failed, so it is waiting again (for a retry, or to be marked undelivered). */
    markSendFailed(sessionId: string, id: string): boolean {
      return transition(sessionId, id, "sending", "pending");
    },
    /** The runtime has the message, so the chat's history shows it from now on. */
    retire(sessionId: string, id: string): void {
      markDelivered.run(new Date().toISOString(), sessionId, id);
    },
    /** Whether a message under this id was ever recorded here, in any state. */
    has(sessionId: string, id: string): boolean {
      return read(sessionId, id) !== undefined;
    },
    get(sessionId: string, id: string): (UnsentMessageView & { storedState: StoredState }) | undefined {
      const row = read(sessionId, id);
      if (!row) return undefined;
      const view = toView({ ...row, state: isUnsentMessageState(row.state) ? row.state : "interrupted" })!;
      return { ...view, storedState: row.state as StoredState };
    },
    /** The messages the chat shows as not sent, oldest first. */
    list(sessionId: string): UnsentMessageView[] {
      return (selectShown.all(sessionId) as unknown as Row[]).flatMap((row) => {
        const view = toView(row);
        return view ? [view] : [];
      });
    },
    /** Hides a not-sent message for good. False when it is not shown (already resent, discarded or saved). */
    discard(sessionId: string, id: string): boolean {
      const row = read(sessionId, id);
      if (!row || !isUnsentMessageState(row.state)) return false;
      return transition(sessionId, id, row.state, "discarded");
    },
    /**
     * Claims a not-sent message for one resend. Only one caller wins; it must call `finishResend`.
     * Undefined when the message is not shown (another device resent or discarded it).
     */
    claimResend(sessionId: string, id: string): UnsentMessageView | undefined {
      const row = read(sessionId, id);
      if (!row || !isUnsentMessageState(row.state)) return undefined;
      if (!transition(sessionId, id, row.state, "resending")) return undefined;
      return toView(row);
    },
    /** Ends a claimed resend: the copy was accepted (the original goes), or it was not (it is shown again). */
    finishResend(sessionId: string, claimed: UnsentMessageView, accepted: boolean): void {
      transition(sessionId, claimed.id, "resending", accepted ? "discarded" : claimed.state, claimed.error);
    },
    /**
     * At startup: what was waiting to be sent or resent when the Bridge last stopped never reached
     * the agent. Old delivered and dismissed records are dropped.
     */
    recoverAfterRestart(now: Date = new Date()): number {
      pruneResolved.run(new Date(now.getTime() - RESOLVED_RETENTION_MS).toISOString());
      settleSending.run(now.toISOString());
      return Number(interruptUnsent.run(now.toISOString()).changes);
    },
    forgetSession(sessionId: string): void {
      removeSession.run(sessionId);
    },
  };
}

export type UnsentMessageStore = ReturnType<typeof createUnsentMessageStore>;
