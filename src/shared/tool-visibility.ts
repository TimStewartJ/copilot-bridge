import { isTerminalCompletionToolName } from "./terminal-completion.js";
import { normalizeSessionTitle } from "./session-title-utils.js";

// Server replay and client live fold share this; if they disagree a tool vanishes on reload.

function getRenameTargetSessionId(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const value = (args as Record<string, unknown>).sessionId;
  if (typeof value !== "string") return undefined;
  // Normalized as the session_rename handler does, so visibility matches what it would rename.
  return normalizeSessionTitle(value) || undefined;
}

/** session_rename hides only for the viewed session (blank id = invoker, as its handler does). */
export function isHiddenTool(toolName: string, args: unknown, sessionId?: string): boolean {
  if (isTerminalCompletionToolName(toolName)) return true;
  if (toolName === "report_intent") return true;
  if (toolName !== "session_rename") return false;
  const targetSessionId = getRenameTargetSessionId(args);
  return targetSessionId === undefined || (sessionId !== undefined && targetSessionId === sessionId);
}
