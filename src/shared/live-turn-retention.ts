/**
 * What the live overlay keeps when a new model turn starts.
 *
 * Everything in the overlay is handed off to disk history by exact identity, so keeping an item a
 * little too long is invisible: it disappears the moment its disk entry is loaded. Dropping one too
 * early is not. The read that carries a turn's last events is usually still in flight when the
 * next turn starts, and it can even have raced the runtime's own flush of those events, so clearing
 * the overlay at the boundary made a finished tool flip back to "running" (and its thinking or
 * text blink out) until some later event happened to trigger another read.
 *
 * The rule, applied identically by the server's event bus and the browser's stream hook: at a turn
 * boundary keep the disk-backed items of the turn that just ended, and let go of anything older.
 * Every turn triggers at least one history read of its own, so by the time a turn is two
 * boundaries old the browser has certainly read it back.
 */
export function keepEndingTurnItems<T extends { turnInstanceId?: string }>(
  items: T[],
  endingTurnInstanceId: string | undefined,
  isDiskBacked: (item: T) => boolean = () => true,
): T[] {
  if (!endingTurnInstanceId) return [];
  return items.filter((item) => item.turnInstanceId === endingTurnInstanceId && isDiskBacked(item));
}

/**
 * Tool calls follow the same rule, per owner. A sub-agent works through turns of its own while the
 * main agent goes through its turns, so a boundary only speaks for the calls of whoever crossed it:
 * a call an agent made names the call that launched the agent as its parent, and the main agent's
 * calls have no parent.
 */
interface OwnedLiveTool {
  turnInstanceId?: string;
  parentToolCallId?: string;
  completedAt?: string;
}

/** A main-agent turn began: its finished calls from the turn that just ended stay, as does every agent's call. */
export function keepToolsAtMainTurnBoundary<T extends OwnedLiveTool>(
  tools: T[],
  endingTurnInstanceId: string | undefined,
): T[] {
  return tools.filter((tool) => (
    tool.parentToolCallId !== undefined
    || (endingTurnInstanceId !== undefined
      && tool.turnInstanceId === endingTurnInstanceId
      && Boolean(tool.completedAt))
  ));
}

/**
 * A sub-agent's turn began: of that agent's calls, the ones still in flight and the finished ones
 * from the turn that just ended stay. Nobody else's calls are touched.
 */
export function keepToolsAtAgentTurnBoundary<T extends OwnedLiveTool>(
  tools: T[],
  agentToolCallId: string,
  endingTurnInstanceId: string | undefined,
): T[] {
  return tools.filter((tool) => (
    tool.parentToolCallId !== agentToolCallId
    || !tool.completedAt
    || (endingTurnInstanceId !== undefined && tool.turnInstanceId === endingTurnInstanceId)
  ));
}
