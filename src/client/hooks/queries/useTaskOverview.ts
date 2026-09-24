import { useQuery } from "@tanstack/react-query";
import { fetchTaskOverview } from "../../api";

/** Under the dashboard prefix, so every task change that refreshes Home refreshes task states too. */
export const TASK_OVERVIEW_KEY = ["dashboard", "task-overview"] as const;

export function useTaskOverviewQuery(enabled = true) {
  return useQuery({
    queryKey: TASK_OVERVIEW_KEY,
    queryFn: ({ signal }) => fetchTaskOverview(signal),
    enabled,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    staleTime: 10_000,
  });
}
