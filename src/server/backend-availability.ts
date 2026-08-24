// Messages and classifiers for "the agent backend cannot take this request
// right now". Kept separate from session-manager.ts so runners and API
// handlers can classify errors without importing the whole manager.

import { ConnectionError } from "vscode-jsonrpc/node.js";
import { isAgentRpcTimeoutError } from "./agent-backend/rpc-timeouts.js";

/** An in-flight run or request was failed because the backend RPC channel was lost. */
export const BACKEND_DISCONNECTED_MESSAGE =
  "Agent backend disconnected; the Bridge is restarting it. Try again shortly.";
/** The backend is being replaced after a disconnect; new work is refused until it is back. */
export const BACKEND_RECONNECTING_MESSAGE = "Agent backend is reconnecting; try again shortly.";
/** The backend has not finished starting yet. */
export const BACKEND_NOT_READY_MESSAGE = "Agent backend is not ready yet; try again shortly.";
/** Model refresh rotation (pre-existing wording, kept for compatibility). */
export const BACKEND_REFRESH_IN_PROGRESS_MESSAGE = "Copilot SDK client refresh is in progress; try again shortly";
export const BACKEND_NOT_INITIALIZED_MESSAGE = "SessionManager not initialized";

/** Prompt re-sent to interactive sessions whose turn was cut off by a backend disconnect. */
export const BACKEND_RECOVERY_CONTINUE_PROMPT = [
  "<bridge_notice>",
  "The Bridge's agent backend disconnected and was restarted while you were working on the previous request.",
  "Your in-memory tool and sub-agent state was lost; the conversation history on disk is intact.",
  "Continue from where you left off. If the previous request was already complete, briefly confirm that and stop.",
  "</bridge_notice>",
].join("\n");

const BACKEND_UNAVAILABLE_MESSAGES = [
  BACKEND_DISCONNECTED_MESSAGE,
  BACKEND_RECONNECTING_MESSAGE,
  BACKEND_NOT_READY_MESSAGE,
  BACKEND_REFRESH_IN_PROGRESS_MESSAGE,
  BACKEND_NOT_INITIALIZED_MESSAGE,
];

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "";
}

/** The backend is known to be absent, rotating, or freshly lost: safe to retry without consuming an attempt. */
export function isBackendUnavailableError(error: unknown): boolean {
  const message = errorMessage(error);
  if (!message) return false;
  return BACKEND_UNAVAILABLE_MESSAGES.some((candidate) => message.includes(candidate));
}

/**
 * The request failed for a reason that usually clears on its own (a slow or
 * reconnecting backend, a stale cached handle, an RPC timeout) rather than
 * because the request itself is wrong.
 */
export function isTransientBackendError(error: unknown): boolean {
  if (isBackendUnavailableError(error)) return true;
  if (isAgentRpcTimeoutError(error)) return true;
  if (error instanceof ConnectionError) return true;
  const message = errorMessage(error);
  if (!message) return false;
  return (
    /\bSession not found\b/i.test(message)
    || /tool initialization did not complete/i.test(message)
    || /tool initialization timed out/i.test(message)
    || /resumeSession timed out/i.test(message)
    || /\bresume timed out\b/i.test(message)
    || /\btimed out\b/i.test(message)
    || /Client (is )?not connected/i.test(message)
    || /Pending response rejected/i.test(message)
    || /connection (got )?disposed/i.test(message)
    || /Session is still (reconnecting|starting)/i.test(message)
    || /Session is busy but not accepting/i.test(message)
    || /\bECONNRESET\b|\bEPIPE\b|\bECONNREFUSED\b/i.test(message)
  );
}
