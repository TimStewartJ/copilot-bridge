import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MutationObserver, QueryClient } from "@tanstack/react-query";
import {
  ApiError,
  deleteChecklistItem,
  deleteSchedule,
  deleteTag,
  deleteTask,
  deleteTaskGroup,
  markSessionUnread,
} from "../api";
import { queryKeys } from "../queryClient";

const originalFetch = globalThis.fetch;

function mockFetchStatus(status: number, body: unknown = { error: "nope" }): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 400 ? "Bad Request" : "Service Unavailable",
    json: async () => body,
  })) as unknown as typeof fetch;
  globalThis.fetch = fetchMock;
  return fetchMock as unknown as ReturnType<typeof vi.fn>;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const DELETE_HELPERS: Array<[string, () => Promise<void>]> = [
  ["deleteTask", () => deleteTask("task-1")],
  ["deleteTaskGroup", () => deleteTaskGroup("group-1")],
  ["deleteTag", () => deleteTag("tag-1")],
  ["markSessionUnread (read-state DELETE)", () => markSessionUnread("session-1")],
  ["deleteSchedule", () => deleteSchedule("schedule-1")],
  ["deleteChecklistItem", () => deleteChecklistItem("item-1")],
];

describe("client delete helpers reject on non-OK responses", () => {
  it("all delete helpers reject with ApiError on 4xx/5xx and resolve on 200", async () => {
    for (const [name, run] of DELETE_HELPERS) {
      // 400 → ApiError with correct status and message
      mockFetchStatus(400, { error: "Cannot delete" });
      const err400 = await run().catch((e: unknown) => e);
      expect(err400, `case: ${name} → 400`).toBeInstanceOf(ApiError);
      expect((err400 as ApiError).status, `case: ${name} → 400 status`).toBe(400);
      expect((err400 as ApiError).message, `case: ${name} → 400 message`).toBe("Cannot delete");

      // 503 → ApiError with correct status
      mockFetchStatus(503, { error: "Unavailable" });
      const err503 = await run().catch((e: unknown) => e);
      expect(err503, `case: ${name} → 503`).toBeInstanceOf(ApiError);
      expect((err503 as ApiError).status, `case: ${name} → 503 status`).toBe(503);

      // 200 → resolves undefined
      mockFetchStatus(200, { ok: true });
      const result = await run();
      expect(result, `case: ${name} → 200`).toBeUndefined();
    }
  });

  it("falls back to the status text when the error body is not JSON", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      json: async () => { throw new Error("not json"); },
    })) as unknown as typeof fetch;

    await expect(deleteTask("task-1")).rejects.toMatchObject({
      status: 503,
      message: "Service Unavailable",
    });
  });
});

describe("delete mutations do not evict cache entries on failure", () => {
  function createClient(): QueryClient {
    return new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    });
  }

  const schedules = [
    { id: "schedule-1", taskId: "task-1", name: "Nightly" },
    { id: "schedule-2", taskId: "task-1", name: "Weekly" },
  ];

  it("keeps the cached schedule list when the server rejects the delete", async () => {
    mockFetchStatus(400, { error: "Cannot delete" });
    const queryClient = createClient();
    queryClient.setQueryData(queryKeys.taskSchedules("task-1"), schedules);

    const observer = new MutationObserver(queryClient, {
      mutationFn: (scheduleId: string) => deleteSchedule(scheduleId),
      onSuccess: (_data: unknown, scheduleId: string) => {
        queryClient.setQueryData(
          queryKeys.taskSchedules("task-1"),
          (old: typeof schedules | undefined) => old?.filter((s) => s.id !== scheduleId),
        );
      },
    });

    await expect(observer.mutate("schedule-1")).rejects.toBeInstanceOf(ApiError);

    expect(queryClient.getQueryData(queryKeys.taskSchedules("task-1"))).toEqual(schedules);
  });

  it("removes the cached schedule only after a successful delete", async () => {
    mockFetchStatus(200, { ok: true });
    const queryClient = createClient();
    queryClient.setQueryData(queryKeys.taskSchedules("task-1"), schedules);

    const observer = new MutationObserver(queryClient, {
      mutationFn: (scheduleId: string) => deleteSchedule(scheduleId),
      onSuccess: (_data: unknown, scheduleId: string) => {
        queryClient.setQueryData(
          queryKeys.taskSchedules("task-1"),
          (old: typeof schedules | undefined) => old?.filter((s) => s.id !== scheduleId),
        );
      },
    });

    await observer.mutate("schedule-1");

    expect(queryClient.getQueryData(queryKeys.taskSchedules("task-1"))).toEqual([schedules[1]]);
  });


});
