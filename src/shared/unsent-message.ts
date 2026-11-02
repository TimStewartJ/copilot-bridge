import type { SendMode } from "./send-mode.js";

/**
 * Why a chat message the Bridge accepted never reached the agent:
 * - stopped: the user pressed Stop before the agent had it.
 * - failed: starting the turn failed before the agent had it.
 * - interrupted: the Bridge stopped or restarted before the agent had it.
 */
export type UnsentMessageState = "stopped" | "failed" | "interrupted";

/** A file the message carried, as saved in the session's files/ folder. */
export interface UnsentMessageAttachment {
  type: "uploaded";
  displayName: string;
  mimeType: string;
  size?: number;
}

/** A user message that stays in the chat, marked not sent, until it is resent or discarded. */
export interface UnsentMessageView {
  /** The id the browser sent the message with. */
  id: string;
  content: string;
  attachments?: UnsentMessageAttachment[];
  mode?: SendMode;
  state: UnsentMessageState;
  error?: string;
  /** When the Bridge accepted it, which is where it sits in the chat. */
  createdAt: string;
}

export function isUnsentMessageState(value: unknown): value is UnsentMessageState {
  return value === "stopped" || value === "failed" || value === "interrupted";
}
