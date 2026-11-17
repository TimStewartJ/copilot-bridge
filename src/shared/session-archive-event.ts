/** Sessions a `session:archived` event names: `sessionId` for one, `sessionIds` in bulk. */
export function archivedEventSessionIds(event: { sessionId?: unknown; sessionIds?: unknown }): string[] {
  if (Array.isArray(event.sessionIds)) {
    return event.sessionIds.filter((sessionId): sessionId is string => typeof sessionId === "string" && sessionId !== "");
  }
  return typeof event.sessionId === "string" && event.sessionId ? [event.sessionId] : [];
}
