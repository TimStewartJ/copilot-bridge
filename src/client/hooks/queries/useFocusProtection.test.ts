import { createElement } from "react";
import { QueryClient, QueryClientProvider, type QueryKey } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FocusProtectionSnapshot } from "../../api";
import { queryKeys } from "../../queryClient";
import { FOCUS_TEST_NOW, FOCUS_TEST_NOW_MS } from "../../test-focus-fixtures";
import { protectionPreview, protectionRequest, protectionSnapshot, protectionWindow } from "../../test-focus-protection-fixtures";
import { advanceTimersByTimeAct, createReactDomHarness, type ReactDomHarness } from "../../test-react-harness";
import {
  useCancelFocusProtectionMutation, useCreateFocusProtectionMutation, useFocusProtectionCurrentQuery,
  useFocusProtectionPagesQuery, usePreviewFocusProtectionMutation,
} from "./useFocusProtection";

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const { createReactDomHarness } = await import("../../test-react-harness");
  const harness = await createReactDomHarness();
  try { return await importOriginal<typeof import("@tanstack/react-query")>(); }
  finally { await harness.cleanup(); }
});

const api = vi.hoisted(() => ({
  fetchFocusProtectionCurrent: vi.fn<typeof import("../../api").fetchFocusProtectionCurrent>(),
  fetchFocusProtectionPage: vi.fn<typeof import("../../api").fetchFocusProtectionPage>(),
  previewFocusProtection: vi.fn<typeof import("../../api").previewFocusProtection>(),
  createFocusProtection: vi.fn<typeof import("../../api").createFocusProtection>(),
  cancelFocusProtection: vi.fn<typeof import("../../api").cancelFocusProtection>(),
}));
vi.mock("../../api", () => api);

const mounted: Array<{ harness: ReactDomHarness; client: QueryClient }> = [];
async function mountHook<T>(useHook: () => T, suppliedClient?: QueryClient) {
  const harness = await createReactDomHarness();
  const client = suppliedClient ?? new QueryClient({
    defaultOptions: { queries: { retry: 3, staleTime: Infinity, gcTime: Infinity }, mutations: { retry: 3 } },
  });
  mounted.push({ harness, client });
  let value!: T;
  function Probe() { value = useHook(); return null; }
  const rerender = () => harness.render(createElement(QueryClientProvider, { client }, createElement(Probe)));
  await rerender();
  await advanceTimersByTimeAct(harness.act, 10);
  return { harness, client, rerender, current: () => value };
}

beforeEach(() => { vi.resetAllMocks(); vi.useFakeTimers(); vi.setSystemTime(FOCUS_TEST_NOW_MS); });
afterEach(async () => {
  for (const { harness, client } of mounted.splice(0)) { await harness.cleanup(); client.clear(); }
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
});

describe("Focus protection server-state queries", () => {
  it("keeps pending and failed reads unknown, disables retries, and never creates protection", async () => {
    let fail!: (reason: Error) => void;
    api.fetchFocusProtectionCurrent.mockReturnValue(new Promise((_resolve, reject) => { fail = reject; }));
    const result = await mountHook(() => useFocusProtectionCurrentQuery());
    expect(result.current().statusUnknown).toBe(true);
    expect(result.current().isPending).toBe(true);
    expect(result.current().data).toBeUndefined();
    await result.harness.act(async () => { fail(new Error("offline")); });
    await advanceTimersByTimeAct(result.harness.act, 1_000);
    expect(result.current().statusUnknown).toBe(true);
    expect(result.current().error?.message).toBe("offline");
    expect(api.fetchFocusProtectionCurrent).toHaveBeenCalledOnce();
    expect(api.createFocusProtection).not.toHaveBeenCalled();
    expect(api.cancelFocusProtection).not.toHaveBeenCalled();
  });

  it("polls the server and retains last known protection on errors, then recovers", async () => {
    const snapshot = protectionSnapshot({ current: protectionWindow() });
    api.fetchFocusProtectionCurrent.mockResolvedValueOnce(snapshot).mockRejectedValueOnce(new Error("read unavailable")).mockResolvedValue(snapshot);
    const result = await mountHook(() => useFocusProtectionCurrentQuery());
    expect(result.current().protection).toEqual(snapshot.current);
    expect(result.current().statusUnknown).toBe(false);
    await advanceTimersByTimeAct(result.harness.act, 15_000);
    expect(result.current().isError).toBe(true);
    expect(result.current().data).toEqual(snapshot);
    expect(result.current().statusUnknown).toBe(true);
    await advanceTimersByTimeAct(result.harness.act, 15_000);
    expect(result.current().isSuccess).toBe(true);
    expect(result.current().statusUnknown).toBe(false);
    expect(api.fetchFocusProtectionCurrent).toHaveBeenCalledTimes(3);
  });

  it("refetches current and invalidates history at expiry without deriving completion from the clock", async () => {
    const window = protectionWindow({ endsAt: new Date(FOCUS_TEST_NOW_MS + 2_000).toISOString() });
    let release!: (snapshot: FocusProtectionSnapshot) => void;
    api.fetchFocusProtectionCurrent.mockResolvedValueOnce(protectionSnapshot({ current: window }))
      .mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const result = await mountHook(() => useFocusProtectionCurrentQuery());
    result.client.setQueryData(queryKeys.focusProtectionHistory, { pages: [], pageParams: [] });
    await advanceTimersByTimeAct(result.harness.act, 2_010);
    await advanceTimersByTimeAct(result.harness.act, 10);
    expect(api.fetchFocusProtectionCurrent).toHaveBeenCalledTimes(2);
    expect(result.current().boundaryReached).toBe(true);
    expect(result.current().statusUnknown).toBe(true);
    expect(result.current().isFetching).toBe(true);
    expect(result.current().data?.current?.status).toBe("active");
    expect(result.client.getQueryState(queryKeys.focusProtectionHistory)?.isInvalidated).toBe(true);

    await result.harness.act(async () => { release(protectionSnapshot({
      generatedAt: new Date(Date.now()).toISOString(), latest: { ...window, status: "completed" },
    })); });
    await advanceTimersByTimeAct(result.harness.act, 10);
    expect(result.current().protection).toBeNull();
    expect(result.current().boundaryReached).toBe(false);
    expect(result.current().statusUnknown).toBe(false);
    expect(result.current().data?.latest?.status).toBe("completed");
  });

  it("keeps verifying a failed expiry check rather than falsely clearing cached active state", async () => {
    const snapshot = protectionSnapshot({ current: protectionWindow({ endsAt: new Date(FOCUS_TEST_NOW_MS + 1_000).toISOString() }) });
    api.fetchFocusProtectionCurrent.mockResolvedValueOnce(snapshot).mockRejectedValue(new Error("expiry read failed"));
    const result = await mountHook(() => useFocusProtectionCurrentQuery());
    await advanceTimersByTimeAct(result.harness.act, 5_000);
    await advanceTimersByTimeAct(result.harness.act, 10);
    expect(result.current().data).toEqual(snapshot);
    expect(result.current().boundaryReached).toBe(true);
    expect(result.current().isError).toBe(true);
    expect(result.current().statusUnknown).toBe(true);
    expect(api.fetchFocusProtectionCurrent).toHaveBeenCalledTimes(2);
  });

  it("transitions scheduled state only after the start boundary is checked on the server", async () => {
    const window = protectionWindow({ status: "scheduled", startsAt: new Date(FOCUS_TEST_NOW_MS + 1_000).toISOString() });
    api.fetchFocusProtectionCurrent.mockResolvedValueOnce(protectionSnapshot({ upcoming: window }))
      .mockImplementation(async () => protectionSnapshot({
        generatedAt: new Date(Date.now()).toISOString(), current: { ...window, status: "active" },
      }));
    const result = await mountHook(() => useFocusProtectionCurrentQuery());
    expect(result.current().protection?.status).toBe("scheduled");
    await advanceTimersByTimeAct(result.harness.act, 1_020);
    await advanceTimersByTimeAct(result.harness.act, 10);
    expect(api.fetchFocusProtectionCurrent).toHaveBeenCalledTimes(2);
    expect(result.current().protection?.status).toBe("active");
    expect(result.current().statusUnknown).toBe(false);
  });

  it.each(["active", "scheduled"] as const)("checks a %s boundary between display ticks exactly once, retaining server state until verified", async (status) => {
    const boundary = new Date(FOCUS_TEST_NOW_MS + 1_500).toISOString();
    const window = protectionWindow({ status, ...(status === "active" ? { endsAt: boundary } : { startsAt: boundary }) });
    const initial = protectionSnapshot(status === "active" ? { current: window } : { upcoming: window });
    let release!: (snapshot: FocusProtectionSnapshot) => void;
    api.fetchFocusProtectionCurrent.mockResolvedValueOnce(initial)
      .mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const result = await mountHook(() => useFocusProtectionCurrentQuery());
    const localBoundary = result.current().dataUpdatedAt + Date.parse(boundary) - Date.parse(initial.generatedAt);
    await advanceTimersByTimeAct(result.harness.act, localBoundary - Date.now() - 1);
    expect(api.fetchFocusProtectionCurrent).toHaveBeenCalledOnce();
    expect(result.current().boundaryReached).toBe(false);
    await advanceTimersByTimeAct(result.harness.act, 2);
    expect(api.fetchFocusProtectionCurrent).toHaveBeenCalledTimes(2);
    expect(result.current().boundaryReached).toBe(true);
    expect(result.current().statusUnknown).toBe(true);
    expect(result.current().protection?.status).toBe(status);
    await advanceTimersByTimeAct(result.harness.act, 100);
    expect(api.fetchFocusProtectionCurrent).toHaveBeenCalledTimes(2);
    await result.harness.act(async () => {
      release(protectionSnapshot({
        generatedAt: new Date(Date.now()).toISOString(),
        ...(status === "active" ? { latest: { ...window, status: "completed" } } : { current: { ...window, status: "active" } }),
      }));
    });
    await advanceTimersByTimeAct(result.harness.act, 10);
    expect(result.current().statusUnknown).toBe(false);
    expect(result.current().protection?.status ?? null).toBe(status === "active" ? null : "active");
  });

  it("cancels a superseded boundary timer when the server reports a replacement window", async () => {
    const first = protectionWindow({ status: "scheduled", startsAt: new Date(FOCUS_TEST_NOW_MS + 1_500).toISOString() });
    const replacement = { ...first, id: "replacement", startsAt: new Date(FOCUS_TEST_NOW_MS + 2_500).toISOString() };
    api.fetchFocusProtectionCurrent.mockResolvedValueOnce(protectionSnapshot({ upcoming: first }))
      .mockReturnValue(new Promise(() => {}));
    const result = await mountHook(() => useFocusProtectionCurrentQuery());
    await advanceTimersByTimeAct(result.harness.act, 200);
    await result.harness.act(async () => {
      result.client.setQueryData(queryKeys.focusProtectionCurrent, protectionSnapshot({
        generatedAt: new Date(Date.now()).toISOString(), upcoming: replacement,
      }));
    });
    await advanceTimersByTimeAct(result.harness.act, 10);
    await advanceTimersByTimeAct(result.harness.act, FOCUS_TEST_NOW_MS + 1_501 - Date.now());
    expect(api.fetchFocusProtectionCurrent).toHaveBeenCalledOnce();
    expect(result.current().protection?.id).toBe(replacement.id);
    await advanceTimersByTimeAct(result.harness.act, 1_001);
    expect(api.fetchFocusProtectionCurrent).toHaveBeenCalledTimes(2);
    expect(result.current().boundaryReached).toBe(true);
  });

  it("chunks a far-future boundary instead of overflowing the browser timer", async () => {
    const start = FOCUS_TEST_NOW_MS + 60 * 24 * 60 * 60_000;
    const window = protectionWindow({
      status: "scheduled", startsAt: new Date(start).toISOString(), endsAt: new Date(start + 60 * 60_000).toISOString(),
    });
    api.fetchFocusProtectionCurrent.mockResolvedValue(protectionSnapshot({ upcoming: window }));
    const timer = vi.spyOn(globalThis, "setTimeout");
    const result = await mountHook(() => useFocusProtectionCurrentQuery());
    expect(timer.mock.calls.some(([, delay]) => delay === 24 * 60 * 60_000)).toBe(true);
    expect(timer.mock.calls.every(([, delay]) => delay === undefined || delay <= 2_147_483_647)).toBe(true);
    expect(result.current().boundaryReached).toBe(false);
    expect(api.fetchFocusProtectionCurrent).toHaveBeenCalledOnce();
  });

  it("keeps malformed server boundaries unknown instead of arming an immediate retry loop", async () => {
    api.fetchFocusProtectionCurrent.mockResolvedValue(protectionSnapshot({ current: protectionWindow({ endsAt: "invalid" }) }));
    const result = await mountHook(() => useFocusProtectionCurrentQuery());
    await advanceTimersByTimeAct(result.harness.act, 100);
    expect(result.current().boundaryReached).toBe(false);
    expect(result.current().statusUnknown).toBe(true);
    expect(api.fetchFocusProtectionCurrent).toHaveBeenCalledOnce();
  });

  it("anchors countdowns to the server clock, including after remount with a cached inactive read", async () => {
    vi.setSystemTime(FOCUS_TEST_NOW_MS + 3_600_000);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
    client.setQueryData(queryKeys.focusProtectionCurrent, protectionSnapshot());
    api.fetchFocusProtectionCurrent.mockResolvedValue(protectionSnapshot({ current: protectionWindow() }));
    const result = await mountHook(() => useFocusProtectionCurrentQuery(), client);
    expect(api.fetchFocusProtectionCurrent).toHaveBeenCalledOnce();
    expect(result.current().protection?.status).toBe("active");
    expect(result.current().nowMs).toBeLessThan(FOCUS_TEST_NOW_MS + 1_000);
    expect(result.current().boundaryReached).toBe(false);
    await result.harness.render(null);
    await result.rerender();
    await advanceTimersByTimeAct(result.harness.act, 10);
    expect(api.fetchFocusProtectionCurrent).toHaveBeenCalledTimes(2);
  });

  it("does not fetch or poll disabled queries, and honors the server history nextOffset", async () => {
    let enabled = false;
    const first = { generatedAt: FOCUS_TEST_NOW, windows: [protectionWindow()], nextOffset: 7 };
    const last = { generatedAt: FOCUS_TEST_NOW, windows: [protectionWindow({ id: "older", status: "completed" })], nextOffset: null };
    api.fetchFocusProtectionCurrent.mockResolvedValue(protectionSnapshot());
    api.fetchFocusProtectionPage.mockResolvedValueOnce(first).mockResolvedValueOnce(last);
    const result = await mountHook(() => ({
      current: useFocusProtectionCurrentQuery(enabled), history: useFocusProtectionPagesQuery(enabled),
    }));
    await result.harness.act(async () => { await result.client.invalidateQueries({ queryKey: queryKeys.focusProtectionRoot }); });
    await advanceTimersByTimeAct(result.harness.act, 30_000);
    expect(api.fetchFocusProtectionCurrent).not.toHaveBeenCalled();
    expect(api.fetchFocusProtectionPage).not.toHaveBeenCalled();
    enabled = true;
    await result.rerender();
    await advanceTimersByTimeAct(result.harness.act, 10);
    expect(api.fetchFocusProtectionPage).toHaveBeenCalledExactlyOnceWith(0, 50);
    expect(result.current().history.hasNextPage).toBe(true);
    await result.harness.act(async () => { await result.current().history.fetchNextPage(); });
    await advanceTimersByTimeAct(result.harness.act, 10);
    expect(api.fetchFocusProtectionPage).toHaveBeenLastCalledWith(7, 50);
    expect(result.current().history.data?.pages).toEqual([first, last]);
    expect(result.current().history.hasNextPage).toBe(false);
  });
});

describe("explicit Focus protection mutations", () => {
  const affected: QueryKey[] = [
    queryKeys.focusProtectionCurrent, queryKeys.focusProtectionHistory, queryKeys.focusSnapshot,
    queryKeys.focusDeliveries, queryKeys.focusAttentionEvents(), queryKeys.focusMetrics(),
    queryKeys.dashboard, queryKeys.sessions(), queryKeys.tasks, queryKeys.task("task-1"),
    queryKeys.taskSchedules("task-1"), queryKeys.scheduleSessions("schedule-1"),
  ];

  it("preview is non-mutating, preserves exact input and never invalidates status", async () => {
    const preview = protectionPreview();
    api.previewFocusProtection.mockResolvedValue(preview);
    const result = await mountHook(() => usePreviewFocusProtectionMutation());
    result.client.setQueryData(queryKeys.focusProtectionCurrent, protectionSnapshot());
    await result.harness.act(async () => { await expect(result.current().mutateAsync(preview.request)).resolves.toEqual(preview); });
    expect(api.previewFocusProtection).toHaveBeenCalledExactlyOnceWith(preview.request, expect.anything());
    expect(result.client.getQueryState(queryKeys.focusProtectionCurrent)?.isInvalidated).toBe(false);
    expect(api.createFocusProtection).not.toHaveBeenCalled();
  });

  it.each(["create", "cancel"] as const)("invalidates status, history, impacts and admitted work after %s", async (kind) => {
    const window = protectionWindow({ status: kind === "cancel" ? "cancelled" : "active" });
    api.createFocusProtection.mockResolvedValue(window);
    api.cancelFocusProtection.mockResolvedValue(window);
    const result = await mountHook(() => ({ create: useCreateFocusProtectionMutation(), cancel: useCancelFocusProtectionMutation() }));
    for (const key of affected) result.client.setQueryData(key, "retained");
    result.client.setQueryData(queryKeys.settings, "settings");
    await result.harness.act(async () => {
      if (kind === "create") await expect(result.current().create.mutateAsync({
        ...protectionRequest(), confirmationToken: "confirmed", confirmInterventionConflicts: false,
      })).resolves.toEqual(window);
      else await expect(result.current().cancel.mutateAsync(window.id)).resolves.toEqual(window);
    });
    for (const key of affected) {
      expect(result.client.getQueryState(key)?.isInvalidated, JSON.stringify(key)).toBe(true);
      expect(result.client.getQueryData(key)).toBe("retained");
    }
    expect(result.client.getQueryState(queryKeys.settings)?.isInvalidated).toBe(false);
  });

  it.each(["create", "cancel"] as const)("does not retry uncertain %s writes, but invalidates reads for recovery", async (kind) => {
    api.createFocusProtection.mockRejectedValue(new Error("response lost"));
    api.cancelFocusProtection.mockRejectedValue(new Error("response lost"));
    const result = await mountHook(() => ({ create: useCreateFocusProtectionMutation(), cancel: useCancelFocusProtectionMutation() }));
    result.client.setQueryData(queryKeys.focusProtectionCurrent, protectionSnapshot({ current: protectionWindow() }));
    await result.harness.act(async () => {
      const operation = kind === "create" ? result.current().create.mutateAsync({
        ...protectionRequest(), confirmationToken: "confirmed", confirmInterventionConflicts: false,
      }) : result.current().cancel.mutateAsync("protection-1");
      await expect(operation).rejects.toThrow("response lost");
    });
    await advanceTimersByTimeAct(result.harness.act, 10_000);
    expect(kind === "create" ? api.createFocusProtection : api.cancelFocusProtection).toHaveBeenCalledOnce();
    expect(result.client.getQueryState(queryKeys.focusProtectionCurrent)?.isInvalidated).toBe(true);
    expect(result.client.getQueryData<FocusProtectionSnapshot>(queryKeys.focusProtectionCurrent)?.current?.id).toBe("protection-1");
  });
});
