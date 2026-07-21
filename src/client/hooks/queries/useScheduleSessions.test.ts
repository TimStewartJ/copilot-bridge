import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduleRun, ScheduleSessionsResponse } from "../../api";
import {
  createReactDomHarness,
  waitUntilAct,
} from "../../test-react-harness";
import { useScheduleSessionsQuery } from "./useScheduleSessions";

const apiMocks = vi.hoisted(() => ({
  fetchScheduleSessions: vi.fn(),
}));

vi.mock("../../api", () => ({
  fetchScheduleSessions: apiMocks.fetchScheduleSessions,
}));

function makeScheduleRun(runId: number): ScheduleRun {
  return {
    runId,
    sessionId: `session-${runId}`,
    summary: `Run ${runId}`,
    recordedAt: new Date(2026, 0, 1, 0, runId).toISOString(),
    recordedAtKnown: true,
    runState: "idle",
    busy: false,
    deferSummary: { count: 0, nextRunAt: null },
  };
}

beforeEach(() => {
  apiMocks.fetchScheduleSessions.mockReset();
});

describe("useScheduleSessionsQuery", () => {
  it("fetches schedule runs in 20-run pages until the total is loaded", async () => {
    const firstPageRuns = Array.from({ length: 20 }, (_, index) => makeScheduleRun(21 - index));
    const secondPageRuns = [makeScheduleRun(1)];
    apiMocks.fetchScheduleSessions.mockImplementation(
      async (_scheduleId: string, opts: { limit?: number; offset?: number } = {}): Promise<ScheduleSessionsResponse> => {
        if (opts.offset === 20) {
          return { sessions: secondPageRuns, total: 21, offset: 20, limit: 20 };
        }
        return { sessions: firstPageRuns, total: 21, offset: 0, limit: 20 };
      },
    );

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const harness = await createReactDomHarness();
    let query: ReturnType<typeof useScheduleSessionsQuery> | undefined;

    function QueryProbe() {
      query = useScheduleSessionsQuery("sched-1");
      return null;
    }

    const getQuery = () => {
      if (!query) throw new Error("Schedule sessions query has not rendered");
      return query;
    };

    try {
      await harness.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(QueryProbe),
        ),
      );
      await waitUntilAct(harness.act, () => getQuery().data?.pages.length === 1);

      expect(apiMocks.fetchScheduleSessions).toHaveBeenNthCalledWith(
        1,
        "sched-1",
        { limit: 20, offset: 0 },
      );
      expect(getQuery().hasNextPage).toBe(true);

      await harness.act(async () => {
        await getQuery().fetchNextPage();
      });
      await waitUntilAct(harness.act, () => getQuery().data?.pages.length === 2);

      expect(apiMocks.fetchScheduleSessions).toHaveBeenNthCalledWith(
        2,
        "sched-1",
        { limit: 20, offset: 20 },
      );
      expect(getQuery().data?.pages.flatMap((page) => page.sessions).map((run) => run.runId))
        .toEqual([...firstPageRuns, ...secondPageRuns].map((run) => run.runId));
      expect(getQuery().hasNextPage).toBe(false);
    } finally {
      queryClient.clear();
      await harness.cleanup();
    }
  });
});
