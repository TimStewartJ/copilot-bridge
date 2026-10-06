import type { InvalidateQueryFilters, QueryClient } from "@tanstack/react-query";

/** A burst of events arrives faster than a quick server answers, so answers alone would not space the refetches. */
export const EVENT_REFETCH_GAP_MS = 1_000;
/** A request that never answers must not hold back later refetches for good. */
export const EVENT_REFETCH_MAX_WAIT_MS = 15_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * `invalidateQueries` for refetches that server events start and nobody awaits. The first
 * invalidation of a query goes to the query client at once. Further ones, until that refetch has
 * settled and the gap has passed, become a single follow-up: a burst of events costs two requests
 * per query instead of one each. The promise settles with the refetches this call started and
 * does not wait for a follow-up, so a caller that needs data fetched after its own change uses
 * the query client itself.
 */
export function createCoalescedInvalidator(queryClient: QueryClient): Pick<QueryClient, "invalidateQueries"> {
  /** Queries invalidated too recently to go again yet, and those among them that owe a follow-up. */
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
