import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchSessionTriggers,
  fetchTaskTriggers,
  fetchTriggerChats,
  reactivateTrigger,
  updateTrigger,
} from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("trigger client API", () => {
  it("builds owner queries and encodes trigger ids", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchSessionTriggers("session/1");
    await fetchTaskTriggers("task 1");
    await fetchTriggerChats("trigger/1", { limit: 20, offset: 40 });
    await updateTrigger("trigger/1", { active: false });
    await reactivateTrigger("trigger/1");

    expect(fetchMock.mock.calls.map(([url, init]) => [String(url), init?.method ?? "GET"])).toEqual([
      [expect.stringContaining("/api/triggers?sessionId=session%2F1"), "GET"],
      [expect.stringContaining("/api/triggers?taskId=task+1"), "GET"],
      [expect.stringContaining("/api/triggers/trigger%2F1/chats?limit=20&offset=40"), "GET"],
      [expect.stringContaining("/api/triggers/trigger%2F1"), "PATCH"],
      [expect.stringContaining("/api/triggers/trigger%2F1/reactivate"), "POST"],
    ]);
  });
});
