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
