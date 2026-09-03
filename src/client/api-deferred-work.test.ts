import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cancelSessionDefer,
  fetchSessionDeferRuns,
  fetchSessionDefers,
  reactivateSessionDefer,
} from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("deferred work client API", () => {
  it("uses session-scoped detail and run endpoints", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ runs: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchSessionDefers("session/1");
    await fetchSessionDeferRuns("session/1", "interval/1");

    expect(fetchMock.mock.calls[0]?.[0]).toContain("/api/sessions/session%2F1/defers");
    expect(fetchMock.mock.calls[1]?.[0]).toContain(
      "/api/sessions/session%2F1/defers/interval%2F1/runs",
    );
  });

  it("posts cancel and reactivate mutations", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await cancelSessionDefer("session-1", "interval_1");
    await reactivateSessionDefer("session-1", "interval_1");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("/api/sessions/session-1/defers/interval_1/cancel"),
      { method: "POST" },
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("/api/sessions/session-1/defers/interval_1/reactivate"),
      { method: "POST" },
    );
  });
});
