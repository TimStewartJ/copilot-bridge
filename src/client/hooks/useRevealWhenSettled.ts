import { useEffect, useState } from "react";

/** The longest a region waits for its data before it shows anyway. */
export const REVEAL_CAP_MS = 600;

/**
 * Whether a region whose parts load separately may be shown, so its rows appear together instead of
 * pushing each other down one by one. True once everything has settled or `capMs` has passed since
 * `key` first appeared, and it stays true for that key while its data refreshes. Cached data settles
 * on the first render, so a warm region never waits.
 */
export function useRevealWhenSettled(key: string, settled: boolean, capMs = REVEAL_CAP_MS): boolean {
  const [revealedKey, setRevealedKey] = useState<string | null>(settled ? key : null);
  const revealed = settled || revealedKey === key;

  useEffect(() => {
    if (revealed) {
      if (revealedKey !== key) setRevealedKey(key);
      return;
    }
    const timer = setTimeout(() => setRevealedKey(key), capMs);
    return () => clearTimeout(timer);
  }, [capMs, key, revealed, revealedKey]);

  return revealed;
}
