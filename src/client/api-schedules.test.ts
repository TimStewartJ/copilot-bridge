import { afterEach, describe, expect, it, vi } from "vitest";

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
