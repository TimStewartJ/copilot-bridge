import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchWorkMap, fetchWorkMapProgress, type WorkMapProgress } from "../../api";
import { queryKeys } from "../../queryClient";

const PROGRESS_POLL_MS = 500;

/** While the map is loading with nothing to show, asks the server how far its build is. */
function useWorkMapProgress(waiting: boolean, includeArchived: boolean, assignedToMe: boolean): WorkMapProgress | null {
  const [progress, setProgress] = useState<WorkMapProgress | null>(null);
  useEffect(() => {
    if (!waiting) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await fetchWorkMapProgress({ includeArchived, assignedToMe, signal: controller.signal });
        // The build can finish a moment before its answer arrives; keep its last step until then.
        if (next && !controller.signal.aborted) setProgress(next);
      } catch {
        // Progress is a courtesy. The map request itself reports a failure.
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, PROGRESS_POLL_MS);
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
      setProgress(null);
    };
  }, [waiting, includeArchived, assignedToMe]);
  return progress;
}

export function useWorkMapQuery(enabled: boolean, includeArchived: boolean, assignedToMe: boolean) {
  const forceRefresh = useRef(false);
  const { data, error, isFetching, dataUpdatedAt, refetch } = useQuery({
    queryKey: queryKeys.workMap(includeArchived, assignedToMe),
    queryFn: ({ signal }) => {
      const force = forceRefresh.current;
      forceRefresh.current = false;
      return fetchWorkMap({ includeArchived, assignedToMe, forceRefresh: force, signal });
    },
    enabled,
    staleTime: 60_000,
  });
  const progress = useWorkMapProgress(isFetching && !data, includeArchived, assignedToMe);
  /** Reads ADO again instead of taking what the server remembers. */
  const refresh = useCallback(() => {
    forceRefresh.current = true;
    void refetch();
  }, [refetch]);
  return { data, error, isFetching, progress, refreshedAt: dataUpdatedAt, refresh };
}

export type WorkMapQuery = ReturnType<typeof useWorkMapQuery>;
