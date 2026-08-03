import { isTerminalCompletionToolName } from "./terminal-completion.js";
import { normalizeSessionTitle } from "./session-title-utils.js";

// Single source of truth for "which tool calls are Bridge control-flow plumbing rather than
// transcript content". Both the disk replay fold (server) and the live stream fold (client)
// must agree, or a tool renders live and then disappears on reload.

function getRenameTargetSessionId(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const value = (args as Record<string, unknown>).sessionId;
  if (typeof value !== "string") return undefined;
  // Normalized exactly as the session_rename handler does, so visibility matches the session the
  // tool would actually rename.
  return normalizeSessionTitle(value) || undefined;
}

/**
 * Tools the Bridge injects for control flow, which must never appear as chat entries.
 *
 * `session_rename` is hidden only when it targets the session being viewed: renaming the current
 * session is bookkeeping, while renaming a different session is a real user-visible action. The
 * target id is trimmed and an absent/blank id means "the invoking session", matching the
 * `session_rename` handler in `src/server/tools/session-tools.ts`.
 */
export function isHiddenTool(toolName: string, args: unknown, sessionId?: string): boolean {
  if (isTerminalCompletionToolName(toolName)) return true;
  if (toolName === "report_intent") return true;
  if (toolName !== "session_rename") return false;
  const targetSessionId = getRenameTargetSessionId(args);
  return targetSessionId === undefined || (sessionId !== undefined && targetSessionId === sessionId);
}
