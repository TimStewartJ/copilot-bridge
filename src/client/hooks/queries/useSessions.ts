import { useQuery } from "@tanstack/react-query";
import { useRef } from "react";
import { fetchSessions } from "../../api";
import { queryKeys } from "../../queryClient";

export function useSessionsQuery(includeArchived: boolean) {
  const hasFetchedOnce = useRef(false);
  return useQuery({
    queryKey: queryKeys.sessions({ includeArchived }),
    queryFn: () => {
      // Skip expensive disk size calculation on polling refetches
      const skip = hasFetchedOnce.current;
      hasFetchedOnce.current = true;
      return fetchSessions(includeArchived, skip);
    },
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
}
