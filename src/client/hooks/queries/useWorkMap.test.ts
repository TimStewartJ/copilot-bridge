import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkMapData } from "../../api";
import { queryKeys } from "../../queryClient";
import { advanceTimersByTimeAct, createReactDomHarness, flushAct, type ReactDomHarness } from "../../test-react-harness";
import { useWorkMapQuery, type WorkMapQuery } from "./useWorkMap";

const api = vi.hoisted(() => ({ fetchWorkMap: vi.fn(), fetchWorkMapProgress: vi.fn() }));

vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  fetchWorkMap: (...args: unknown[]) => api.fetchWorkMap(...args),
  fetchWorkMapProgress: (...args: unknown[]) => api.fetchWorkMapProgress(...args),
}));

const DATA: WorkMapData = {
  enabled: true,
  currentUser: null,
  org: "msazure",
  project: "One",
  tasks: [],
  workItems: [],
  contextWorkItems: [],
  pullRequests: [],
  warnings: [],
};

describe("useWorkMapQuery", () => {
  let harness: ReactDomHarness;
  let queryClient: QueryClient;
  let map: WorkMapQuery;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    harness = await createReactDomHarness();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(async () => {
    queryClient.clear();
    await harness.cleanup();
  });

  async function render(enabled: boolean, includeArchived = false, assignedToMe = false) {
    function Probe() {
      map = useWorkMapQuery(enabled, includeArchived, assignedToMe);
      return null;
    }
    await harness.render(createElement(QueryClientProvider, { client: queryClient }, createElement(Probe)));
    await flushAct(harness.act, 3);
  }

  it("reports the server's progress while nothing is loaded, and stops asking once the map arrives", async () => {
    let deliver: (data: WorkMapData) => void = () => {};
    api.fetchWorkMap.mockReturnValue(new Promise<WorkMapData>((resolve) => { deliver = resolve; }));
    api.fetchWorkMapProgress
      .mockResolvedValueOnce({ label: "Reading work items and their links", step: 2, steps: 4, done: 100, total: 400 })
      .mockResolvedValueOnce({ label: "Reading work items and their links", step: 2, steps: 4, done: 300, total: 400 })
      // The build can finish just before its answer arrives; the last step stays on screen.
      .mockResolvedValue(null);

    await render(true, false, true);

    expect(api.fetchWorkMap).toHaveBeenCalledExactlyOnceWith({
      includeArchived: false,
      assignedToMe: true,
      forceRefresh: false,
      signal: expect.any(AbortSignal),
    });
    expect(api.fetchWorkMapProgress).toHaveBeenCalledWith({
      includeArchived: false,
      assignedToMe: true,
      signal: expect.any(AbortSignal),
    });
    expect(map.progress?.done).toBe(100);
    expect(map.isFetching).toBe(true);

    await advanceTimersByTimeAct(harness.act, 500);
    expect(map.progress?.done).toBe(300);
    await advanceTimersByTimeAct(harness.act, 500);
    expect(map.progress?.done).toBe(300);

    await harness.act(async () => {
      deliver(DATA);
    });
    await flushAct(harness.act, 3);
    expect(map.data).toBe(DATA);
    expect(map.progress).toBeNull();

    const asked = api.fetchWorkMapProgress.mock.calls.length;
    await advanceTimersByTimeAct(harness.act, 5_000);
    expect(api.fetchWorkMapProgress).toHaveBeenCalledTimes(asked);
  });

  it("asks ADO again once on refresh, and not on the refetches that follow", async () => {
    api.fetchWorkMap.mockResolvedValue(DATA);
    api.fetchWorkMapProgress.mockResolvedValue(null);
    await render(true);
    expect(map.data).toBe(DATA);
    const asked = api.fetchWorkMapProgress.mock.calls.length;

    await harness.act(async () => {
      map.refresh();
    });
    await flushAct(harness.act, 3);
    expect(api.fetchWorkMap).toHaveBeenLastCalledWith(expect.objectContaining({ forceRefresh: true }));

    await harness.act(async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.workMapRoot });
    });
    await flushAct(harness.act, 3);
    expect(api.fetchWorkMap).toHaveBeenCalledTimes(3);
    expect(api.fetchWorkMap).toHaveBeenLastCalledWith(expect.objectContaining({ forceRefresh: false }));
    // With a map on screen there is nothing to stand in for, so progress is not asked for.
    expect(api.fetchWorkMapProgress).toHaveBeenCalledTimes(asked);
  });

  it("does not load or ask for progress until it is enabled", async () => {
    await render(false);

    expect(api.fetchWorkMap).not.toHaveBeenCalled();
    expect(api.fetchWorkMapProgress).not.toHaveBeenCalled();
    expect(map.isFetching).toBe(false);
  });
});
