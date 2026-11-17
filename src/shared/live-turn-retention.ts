/** At a turn boundary keep the ended turn's disk-backed items: its history read may be pending. */
export function keepEndingTurnItems<T extends { turnInstanceId?: string }>(
  items: T[],
  endingTurnInstanceId: string | undefined,
  isDiskBacked: (item: T) => boolean = () => true,
): T[] {
  if (!endingTurnInstanceId) return [];
  return items.filter((item) => item.turnInstanceId === endingTurnInstanceId && isDiskBacked(item));
}

/** Per owner: a boundary only affects calls of whoever crossed it (agent calls have a parent). */
interface OwnedLiveTool {
  turnInstanceId?: string;
  parentToolCallId?: string;
  completedAt?: string;
}

/** Main-agent turn began: keep its calls from the ended turn and every sub-agent's calls. */
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

/** A sub-agent's turn began: keep its in-flight calls and ended-turn calls; others untouched. */
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
