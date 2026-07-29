// Shared enrichment cache for work tracking providers.
// Entries stay fresh briefly, then remain servable as stale data so a provider can keep
// showing the last known metadata while an upstream API is failing transiently.

const CACHE_TTL = 60_000;
const STALE_CACHE_TTL = 24 * 60 * 60_000;

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
  staleUntil: number;
}

export interface ProviderCache<T> {
  /** Returns fresh data, or stale data when `allowStale` is set and the entry is still within the stale window. */
  read(key: string, now: number, allowStale?: boolean): T | null;
  write(key: string, data: T, now: number): void;
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
    write(key, data, now) {
      entries.set(key, {
        data,
        expiresAt: now + CACHE_TTL,
        staleUntil: now + STALE_CACHE_TTL,
      });
    },
    clear() {
      entries.clear();
    },
  };
}
