import { useEffect } from "react";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { fetchRestartStatus, type RestartStatus } from "../../api";
import { queryKeys } from "../../queryClient";

export const UNREACHABLE_RESTART_REFETCH_MS = 2_000;
export const PENDING_RESTART_REFETCH_MS = 5_000;
export const IDLE_RESTART_REFETCH_MS = 30_000;

export function getRestartStatusQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.restartStatus,
    queryFn: fetchRestartStatus,
    // A failed read is itself the news that the server is away, so it shows at once and is asked again soon.
    retry: false,
    refetchInterval: (currentQuery) =>
      currentQuery.state.status === "error"
        ? UNREACHABLE_RESTART_REFETCH_MS
        : currentQuery.state.data?.pending ? PENDING_RESTART_REFETCH_MS : IDLE_RESTART_REFETCH_MS,
    refetchIntervalInBackground: false,
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
  });
}

export function useRestartStatusQuery() {
  const query = useQuery(getRestartStatusQueryOptions());

  useEffect(() => {
    if (typeof document === "undefined" || typeof window === "undefined") return;

    const refetchWhenVisible = () => {
      if (document.visibilityState === "visible") void query.refetch();
    };

    document.addEventListener("visibilitychange", refetchWhenVisible);
    window.addEventListener("online", refetchWhenVisible);
    return () => {
      document.removeEventListener("visibilitychange", refetchWhenVisible);
      window.removeEventListener("online", refetchWhenVisible);
    };
  }, [query.refetch]);

  return query;
}

export type RestartNotice =
  | { kind: "waiting"; sessions: number; jobs: number; operations?: number; sessionIds: string[] }
  | { kind: "restarting" }
  /** A different server process answered: the page reloads to run the client that came with it. */
  | { kind: "restarted" };

/**
 * What the restart notice shows, or null for nothing. `pageInstanceId` is the server this page was
 * loaded from; `unreachable` is a status read that just failed.
 */
export function describeRestartNotice(
  status: RestartStatus | undefined,
  pageInstanceId: string | undefined,
  unreachable: boolean,
): RestartNotice | null {
  if (!status) return null;
  if (pageInstanceId !== undefined && status.serverInstanceId !== pageInstanceId) return { kind: "restarted" };
  if (!status.pending) return null;
  if (status.phase === "restarting" || unreachable) return { kind: "restarting" };
  return { kind: "waiting", ...status.waitingOn };
}
