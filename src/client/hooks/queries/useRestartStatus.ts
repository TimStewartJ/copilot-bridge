import { useEffect } from "react";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { fetchRestartStatus, type RestartStatus } from "../../api";
import { queryKeys } from "../../queryClient";

export const PENDING_RESTART_REFETCH_MS = 5_000;
export const IDLE_RESTART_REFETCH_MS = 30_000;

export function getRestartStatusQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.restartStatus,
    queryFn: fetchRestartStatus,
    refetchInterval: (currentQuery) =>
      currentQuery.state.data?.pending ? PENDING_RESTART_REFETCH_MS : IDLE_RESTART_REFETCH_MS,
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
