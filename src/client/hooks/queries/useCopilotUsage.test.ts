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

function createUsageTotals(totalTokens: number, requests = 1) {
  return {
    requests,
    inputTokens: totalTokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens,
  };
}

function createZeroCostEstimate() {
  return {
    estimatedCostUsd: 0,
    estimatedAiCredits: 0,
    costBreakdownUsd: {
      input: 0,
      cachedInput: 0,
      cacheWrite: 0,
      output: 0,
      reasoning: 0,
      total: 0,
    },
    billableOutputTokens: 0,
    reasoningPricingAssumption: "reasoning_tokens_priced_at_output_rate" as const,
  };
}

function createUsageSummary(generatedAt: string, totalTokens: number): CopilotUsageSummary {
  const totals = createUsageTotals(totalTokens);
  return {
    generatedAt,
    index: {
      state: "idle",
      startedAt: generatedAt,
      completedAt: generatedAt,
      sessionsTotal: 1,
      sessionsProcessed: 1,
      sessionsUpdated: 1,
      sessionsFailed: 0,
      cachedSessions: 1,
      warning: null,
      error: null,
    },
    totals: {
      ...totals,
      ...createZeroCostEstimate(),
      unpricedModelCount: 0,
      unpricedTokens: createUsageTotals(0, 0),
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
      ...totals,
      ...createZeroCostEstimate(),
      pricingKey: "gpt-5.4",
      pricedAs: "gpt-5.4",
      pricingStatus: "exact",
      pricingSource: "exact",
      normalizedPricingModel: "gpt-5.4",
    }],
    sessions: [],
    unpricedModels: [],
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
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("refreshCopilotUsageQuery", () => {
  it("disables automatic focus refetches for expensive local usage scans", () => {
    const options = getCopilotUsageQueryOptions();

    expect(options.refetchOnWindowFocus).toBe(false);
    expect(options.staleTime).toBe(5 * 60_000);
  });

  it("scopes task usage queries and forwards task filtering to the API", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });
    const summary = createUsageSummary("2026-04-23T12:00:00.000Z", 200);
    vi.mocked(fetchCopilotUsage).mockResolvedValue(summary);

    const options = getCopilotUsageQueryOptions({
      taskId: "task-1",
      sessionIds: ["session-1", "session-2"],
    });
    await queryClient.fetchQuery(options);

    expect(options.queryKey).toEqual([
      "copilot-usage",
      "task-1",
      true,
      "session-1",
      "session-2",
    ]);
    expect(vi.mocked(fetchCopilotUsage)).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "task-1",
      includeSessions: undefined,
    }));
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
