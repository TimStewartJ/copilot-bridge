import { afterEach, describe, expect, it, vi } from "vitest";
import { ConditionalGetCache, readEtagHeader } from "./conditional-get-cache";

describe("ConditionalGetCache", () => {
  it("sends If-None-Match only once it holds a validator and reuses the body on 304", () => {
    const cache = new ConditionalGetCache();
    expect(cache.requestHeaders("/api/sessions")).toEqual({});

    const body = { sessions: [{ sessionId: "a" }] };
    cache.remember("/api/sessions", 'W/"abc"', body);
    expect(cache.requestHeaders("/api/sessions")).toEqual({ "If-None-Match": 'W/"abc"' });
    expect(cache.reuseIfNotModified("/api/sessions", 304)).toEqual({ result: body });
    expect(cache.reuseIfNotModified("/api/sessions", 304)?.result).toBe(body);
  });

  it("does not reuse anything for 200s or for unknown keys", () => {
    const cache = new ConditionalGetCache();
    cache.remember("/api/sessions", 'W/"abc"', { sessions: [] });
    expect(cache.reuseIfNotModified("/api/sessions", 200)).toBeUndefined();
    expect(cache.reuseIfNotModified("/api/tasks", 304)).toBeUndefined();
    expect(cache.reuseIfNotModified("/api/sessions", undefined)).toBeUndefined();
  });

  it("forgets a key when the latest response carried no ETag", () => {
    const cache = new ConditionalGetCache();
    cache.remember("/api/sessions", 'W/"abc"', { sessions: [] });
    cache.remember("/api/sessions", null, { sessions: [] });
    expect(cache.requestHeaders("/api/sessions")).toEqual({});
  });

  it("evicts the least recently used entry beyond the limit", () => {
    const cache = new ConditionalGetCache(2);
    cache.remember("/a", "1", "a");
    cache.remember("/b", "2", "b");
    cache.reuseIfNotModified("/a", 304);
    cache.remember("/c", "3", "c");
    expect(cache.size).toBe(2);
    expect(cache.requestHeaders("/b")).toEqual({});
    expect(cache.requestHeaders("/a")).toEqual({ "If-None-Match": "1" });
    expect(cache.requestHeaders("/c")).toEqual({ "If-None-Match": "3" });
  });

  it("reads ETags defensively from minimal response shapes", () => {
    expect(readEtagHeader(undefined)).toBeNull();
    expect(readEtagHeader({})).toBeNull();
    expect(readEtagHeader({ headers: new Headers({ etag: 'W/"x"' }) })).toBe('W/"x"');
  });
});

describe("apiFetch conditional GET", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("revalidates with the remembered ETag and serves the cached body on 304", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const sessions = [{ sessionId: "a", summary: "A" }];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/telemetry/batch") {
        return { ok: true, status: 200, json: async () => ({}) };
      }
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url, headers });
      if (headers["If-None-Match"] === 'W/"v1"') {
        return { ok: false, status: 304, statusText: "Not Modified", headers: new Headers(), json: async () => { throw new Error("no body"); } };
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers({ etag: 'W/"v1"' }),
        json: async () => ({ sessions }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const { fetchSessions, resetConditionalGetCacheForTests } = await import("./api.js");
    resetConditionalGetCacheForTests();

    const first = await fetchSessions();
    expect(first).toEqual(sessions);
    expect(calls[0].headers["If-None-Match"]).toBeUndefined();

    const second = await fetchSessions();
    expect(calls[1].headers["If-None-Match"]).toBe('W/"v1"');
    expect(second).toBe(first);
  });

  it("still surfaces real errors when no cached body exists", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/telemetry/batch") {
        return { ok: true, status: 200, json: async () => ({}) };
      }
      return { ok: false, status: 500, statusText: "Boom", headers: new Headers(), json: async () => ({ error: "server down" }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    const { fetchSessions, resetConditionalGetCacheForTests } = await import("./api.js");
    resetConditionalGetCacheForTests();
    await expect(fetchSessions()).rejects.toThrow("server down");
  });
});
