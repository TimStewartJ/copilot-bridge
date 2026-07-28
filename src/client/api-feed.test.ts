import { afterEach, describe, expect, it, vi } from "vitest";

describe("fetchFeedPage query building", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.resetModules();
  });

  it("serializes kind and keyPrefix filters into the URL, omits keyPrefix when not provided", async () => {
    vi.useFakeTimers();
    let requestedUrl = "";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/feed")) {
        requestedUrl = url;
        return { ok: true, json: async () => ({ cards: [], nextCursor: null }) };
      }
      if (url === "/api/telemetry/batch") {
        return { ok: true, json: async () => ({}) };
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { fetchFeedPage } = await import("./api.js");

    await expect(
      fetchFeedPage({ kind: "note", keyPrefix: "docs-maintenance:", limit: 50 }),
    ).resolves.toEqual({ cards: [], nextCursor: null });

    expect(requestedUrl).toContain("kind=note");
    expect(requestedUrl).toContain("keyPrefix=docs-maintenance%3A");
    expect(requestedUrl).toContain("limit=50");

    await vi.runOnlyPendingTimersAsync();

    requestedUrl = "";
    await fetchFeedPage({ status: "active" });

    expect(requestedUrl).not.toContain("keyPrefix");

    await vi.runOnlyPendingTimersAsync();
  });
});

describe("fetchSchedules", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.resetModules();
  });

  it("requests schedules for an explicit task scope", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/schedules?taskId=task+1") {
        return { ok: true, json: async () => [] };
      }
      if (url === "/api/telemetry/batch") {
        return { ok: true, json: async () => ({}) };
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { fetchSchedules } = await import("./api.js");

    await expect(fetchSchedules("task 1")).resolves.toEqual([]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/schedules?taskId=task+1");

    await vi.runOnlyPendingTimersAsync();
  });
});
