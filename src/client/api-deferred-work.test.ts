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
  it("encodes session and defer IDs in every session-scoped endpoint", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchSessionDefers("session/1");
    await fetchSessionDeferRuns("session/1", "interval/1");
    await cancelSessionDefer("session/1", "interval/1");
    await reactivateSessionDefer("session/1", "interval/1");

    expect(fetchMock.mock.calls.map(([url, init]) => [String(url), init?.method ?? "GET"])).toEqual([
      [expect.stringContaining("/api/sessions/session%2F1/defers"), "GET"],
      [expect.stringContaining("/api/sessions/session%2F1/defers/interval%2F1/runs"), "GET"],
      [expect.stringContaining("/api/sessions/session%2F1/defers/interval%2F1/cancel"), "POST"],
      [expect.stringContaining("/api/sessions/session%2F1/defers/interval%2F1/reactivate"), "POST"],
    ]);
  });
});
