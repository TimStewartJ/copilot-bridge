const INTERACTIVE_HANDOFF_TOOLS = new Set(["ask_user", "browser_session_handoff"]);

/** True when an `assistant.message` came with non-interactive tool calls, not a stop or handoff. */
export function isToolAccompanyingProgress(toolRequests: unknown): boolean {
  if (!Array.isArray(toolRequests) || toolRequests.length === 0) return false;
  return !toolRequests.some((req) => (
    typeof req === "object"
    && req !== null
    && typeof (req as { name?: unknown }).name === "string"
    && INTERACTIVE_HANDOFF_TOOLS.has((req as { name: string }).name)
  ));
}
