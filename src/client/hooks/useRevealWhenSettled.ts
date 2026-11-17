import { useEffect, useState } from "react";

/** The longest a region waits for its data before it shows anyway. */
export const REVEAL_CAP_MS = 600;

/** True once settled or capMs after key first appears; stays true for that key while refreshing. */
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
