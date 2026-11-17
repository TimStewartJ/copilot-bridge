import type { InvalidateQueryFilters, QueryClient } from "@tanstack/react-query";

/** Events burst faster than a quick server answers, so answers alone would not space refetches. */
export const EVENT_REFETCH_GAP_MS = 1_000;
/** A request that never answers must not hold back later refetches for good. */
export const EVENT_REFETCH_MAX_WAIT_MS = 15_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Coalesces event-driven refetches; doesn't await follow-ups, so mutations use queryClient. */
export function createCoalescedInvalidator(queryClient: QueryClient): Pick<QueryClient, "invalidateQueries"> {
  /** Queries invalidated too recently to go again; `owed` are those that owe a follow-up. */
  const recent = new Set<string>();
  const owed = new Set<string>();

  const invalidateQueries = (filters?: InvalidateQueryFilters): Promise<void> =>
    Promise.all(queryClient.getQueryCache().findAll(filters).map(({ queryKey, queryHash }) => {
      if (recent.has(queryHash)) return void owed.add(queryHash);
      recent.add(queryHash);
      const only = { queryKey, exact: true };
      const refetched = queryClient.invalidateQueries(only);
      void Promise.all([
        sleep(EVENT_REFETCH_GAP_MS),
        Promise.race([refetched, sleep(EVENT_REFETCH_MAX_WAIT_MS)]),
      ]).then(() => {
        recent.delete(queryHash);
        if (owed.delete(queryHash)) void invalidateQueries(only);
      });
      return refetched;
    })).then(() => undefined);

  return { invalidateQueries };
}
