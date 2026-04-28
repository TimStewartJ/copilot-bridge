import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type { CopilotUsageSummary } from "../../api";
import { fetchCopilotUsage } from "../../api";
import {
  getCopilotUsageQueryOptions,
  refreshCopilotUsageQuery,
} from "./useCopilotUsage";

vi.mock("../../api", async () => {
  const actual = await vi.importActual<typeof import("../../api")>("../../api");
  return {
    ...actual,
    fetchCopilotUsage: vi.fn(),
  };
});

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

function createUsageSummary(generatedAt: string, totalTokens: number): CopilotUsageSummary {
  return {
    generatedAt,
    totals: {
      requests: 1,
      inputTokens: totalTokens,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens,
    },
    coverage: {
      sessionsSeen: 1,
      sessionsWithEvents: 1,
      sessionsIncluded: 1,
      sessionsSkipped: 0,
      skippedByReason: {
        no_events: 0,
        no_shutdown: 0,
        empty_model_metrics: 0,
        parse_error: 0,
      },
      earliestIncludedAt: generatedAt,
      latestIncludedAt: generatedAt,
      earliestSkippedAt: null,
      latestSkippedAt: null,
    },
    models: [{
      model: "gpt-5.4",
      sessions: 1,
      requests: 1,
      inputTokens: totalTokens,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens,
    }],
    sessions: [],
  };
}

function createAbortablePromise<T>(deferred: ReturnType<typeof createDeferred<T>>, signal?: AbortSignal) {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const abort = () => reject(signal?.reason ?? new Error("aborted"));
    signal?.addEventListener("abort", abort, { once: true });
    deferred.promise.then(resolve, reject).finally(() => signal?.removeEventListener("abort", abort));
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("refreshCopilotUsageQuery", () => {
  it("disables automatic focus refetches for expensive local usage scans", () => {
    const options = getCopilotUsageQueryOptions();

    expect(options.refetchOnWindowFocus).toBe(false);
    expect(options.staleTime).toBe(5 * 60_000);
  });

  it("cancels an in-flight stale fetch before applying the manual refresh result", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });
    const observer = new QueryObserver(queryClient, getCopilotUsageQueryOptions());
    const staleFetch = createDeferred<CopilotUsageSummary>();
    const refreshed = createUsageSummary("2026-04-23T12:00:00.000Z", 200);
    let staleSignal: AbortSignal | undefined;

    vi.mocked(fetchCopilotUsage).mockImplementation((options) => {
      if (options?.refresh) {
        return Promise.resolve(refreshed);
      }
      staleSignal = options?.signal;
      return createAbortablePromise(staleFetch, options?.signal);
    });

    const unsubscribe = observer.subscribe(() => {});
    const initialFetch = observer.refetch().catch(() => undefined);

    await Promise.resolve();
    await refreshCopilotUsageQuery(queryClient);

    staleFetch.resolve(createUsageSummary("2026-04-23T11:00:00.000Z", 100));
    await initialFetch;

    expect(vi.mocked(fetchCopilotUsage)).toHaveBeenNthCalledWith(1, expect.objectContaining({ refresh: undefined }));
    expect(vi.mocked(fetchCopilotUsage)).toHaveBeenNthCalledWith(2, expect.objectContaining({ refresh: true }));
    expect(staleSignal?.aborted).toBe(true);
    expect(queryClient.getQueryData(getCopilotUsageQueryOptions().queryKey)).toEqual(refreshed);

    unsubscribe();
  });

  it("keeps stale data while exposing a manual refresh failure through query state", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });
    const observer = new QueryObserver(queryClient, getCopilotUsageQueryOptions());
    const cached = createUsageSummary("2026-04-23T10:00:00.000Z", 100);

    vi.mocked(fetchCopilotUsage).mockImplementation((options) => {
      if (options?.refresh) {
        return Promise.reject(new Error("refresh failed"));
      }
      return Promise.resolve(cached);
    });

    const unsubscribe = observer.subscribe(() => {});
    await observer.refetch();

    await expect(refreshCopilotUsageQuery(queryClient)).rejects.toThrow("refresh failed");

    const result = observer.getCurrentResult();
    expect(result.data).toEqual(cached);
    expect(result.error).toEqual(expect.objectContaining({ message: "refresh failed" }));

    unsubscribe();
  });
});
