/**
 * The sessions a `session:archived` event is about. One session is named by `sessionId`; a bulk
 * change names all of them in `sessionIds`, in a single event.
 */
export function archivedEventSessionIds(event: { sessionId?: unknown; sessionIds?: unknown }): string[] {
  if (Array.isArray(event.sessionIds)) {
    return event.sessionIds.filter((sessionId): sessionId is string => typeof sessionId === "string" && sessionId !== "");
  }
  return typeof event.sessionId === "string" && event.sessionId ? [event.sessionId] : [];
}
