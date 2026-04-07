import { useQuery } from "@tanstack/react-query";
import { fetchDashboard } from "../../api";
import { queryKeys } from "../../queryClient";

export function useDashboardQuery() {
  return useQuery({
    queryKey: queryKeys.dashboard,
    queryFn: fetchDashboard,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
}
