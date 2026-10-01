// Shared enrichment cache for work tracking providers.
// Entries stay fresh for a while, then remain servable as stale data so a provider can keep
// showing the last known metadata while an upstream API is failing transiently.

const FRESH_MS = 60_000;
const STALE_MS = 24 * 60 * 60_000;

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
  staleUntil: number;
}

export interface ProviderCache<T> {
  /** Returns fresh data, or stale data when `allowStale` is set and the entry is still within the stale window. */
  read(key: string, now: number, allowStale?: boolean): T | null;
  /** `freshMs` keeps data that rarely changes, such as a completed pull request, fresh for longer. */
  write(key: string, data: T, now: number, freshMs?: number): void;
  /** Makes every entry due for a refresh while keeping it as the fallback for a failed one. */
  expire(): void;
  clear(): void;
}

export function createProviderCache<T>(): ProviderCache<T> {
  const entries = new Map<string, CacheEntry<T>>();

  return {
    read(key, now, allowStale = false) {
      const entry = entries.get(key);
      if (!entry) return null;
      if (now < entry.expiresAt) return entry.data;
      if (allowStale && now < entry.staleUntil) return entry.data;
      return null;
    },
    write(key, data, now, freshMs = FRESH_MS) {
      entries.set(key, {
        data,
        expiresAt: now + freshMs,
        staleUntil: now + Math.max(STALE_MS, freshMs),
      });
    },
    expire() {
      for (const entry of entries.values()) entry.expiresAt = 0;
    },
    clear() {
      entries.clear();
    },
  };
}
