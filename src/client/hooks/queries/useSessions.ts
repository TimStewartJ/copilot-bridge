import { useQuery } from "@tanstack/react-query";
import { useRef } from "react";
import { fetchSessions, type Session } from "../../api";
import { queryKeys } from "../../queryClient";

export function mergeOptimisticSessions(
  serverSessions: Session[],
  cachedSessions: Session[] | undefined,
  now = Date.now(),
): Session[] {
  if (!cachedSessions?.length) return serverSessions;

  const serverSessionIds = new Set(serverSessions.map((session) => session.sessionId));
  const optimisticSessions = cachedSessions.filter((session) =>
    session.isOptimistic
      && !serverSessionIds.has(session.sessionId)
      && (session.optimisticUntil === undefined || session.optimisticUntil > now),
  );

  return optimisticSessions.length > 0
    ? [...optimisticSessions, ...serverSessions]
    : serverSessions;
}

export function useSessionsQuery(includeArchived: boolean) {
  const hasFetchedOnce = useRef(false);
  return useQuery<Session[]>({
    queryKey: queryKeys.sessions({ includeArchived }),
    queryFn: () => {
      // Skip expensive disk size calculation on polling refetches
      const skip = hasFetchedOnce.current;
      hasFetchedOnce.current = true;
      return fetchSessions(includeArchived, skip);
    },
    structuralSharing: (oldData, newData) =>
      mergeOptimisticSessions(newData, oldData),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
}
