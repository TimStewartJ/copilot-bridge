/**
 * Client-side conditional GET support.
 *
 * The dev tunnel relay stamps `Cache-Control: no-cache,no-store` onto every response,
 * so the browser's own HTTP cache never revalidates API polls. Remembering the last
 * ETag + parsed body per GET URL lets us send `If-None-Match` ourselves and turn an
 * unchanged poll into a bodyless 304 regardless of what the relay adds. Setting a
 * conditional header also makes fetch() bypass the HTTP cache, so behavior is the
 * same on localhost and through the tunnel.
 */

export const CONDITIONAL_GET_CACHE_LIMIT = 64;

interface ConditionalGetEntry {
  etag: string;
  result: unknown;
}

export class ConditionalGetCache {
  private readonly entries = new Map<string, ConditionalGetEntry>();

  constructor(private readonly limit = CONDITIONAL_GET_CACHE_LIMIT) {}

  /** Header to attach to a GET for `key`, if we hold a validator for it. */
  requestHeaders(key: string): Record<string, string> {
    const entry = this.entries.get(key);
    return entry ? { "If-None-Match": entry.etag } : {};
  }

  /**
   * Resolve a response for `key`. Returns the cached body on a 304 we can honor;
   * otherwise `undefined` so the caller parses the fresh response body.
   */
  reuseIfNotModified(key: string, status: number | undefined): { result: unknown } | undefined {
    if (status !== 304) return undefined;
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    // Refresh recency so hot polls survive eviction.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return { result: entry.result };
  }

  remember(key: string, etag: string | null | undefined, result: unknown): void {
    if (!etag) {
      this.entries.delete(key);
      return;
    }
    this.entries.delete(key);
    this.entries.set(key, { etag, result });
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  forget(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

export function readEtagHeader(res: { headers?: { get?(name: string): string | null } } | undefined): string | null {
  try {
    return res?.headers?.get?.("etag") ?? null;
  } catch {
    return null;
  }
}
