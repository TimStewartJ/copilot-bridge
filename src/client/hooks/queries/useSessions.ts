import { useQuery } from "@tanstack/react-query";
import { fetchSessions } from "../../api";
import { queryKeys } from "../../queryClient";

export function useSessionsQuery(includeArchived: boolean) {
  return useQuery({
    queryKey: queryKeys.sessions({ includeArchived }),
    queryFn: () => fetchSessions(includeArchived),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
}
