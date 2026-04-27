import { useQuery } from "@tanstack/react-query";
import { useRef } from "react";
import { fetchSessions, type Session } from "../../api";
import { queryKeys } from "../../queryClient";

interface UseSessionsQueryOptions {
  enabled?: boolean;
  refetchInterval?: number | false;
  refetchOnWindowFocus?: boolean;
}

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

export function mergeActiveAndArchivedSessions(
  activeSessions: Session[],
  archivedQuerySessions: Session[],
  includeArchived: boolean,
  restoringSessionIds: ReadonlySet<string> = new Set(),
): Session[] {
  if (!includeArchived) return activeSessions;

  const activeSessionIds = new Set(activeSessions.map((session) => session.sessionId));
  const archivedSessions = archivedQuerySessions.filter((session) =>
    !activeSessionIds.has(session.sessionId)
      && (session.archived || restoringSessionIds.has(session.sessionId)));
  return archivedSessions.length > 0
    ? [...activeSessions, ...archivedSessions]
    : activeSessions;
}

export function useSessionsQuery(includeArchived: boolean, options: UseSessionsQueryOptions = {}) {
  const hasFetchedOnce = useRef(false);
  return useQuery<Session[]>({
    queryKey: queryKeys.sessions({ includeArchived }),
    enabled: options.enabled ?? true,
    queryFn: () => {
      // Skip expensive disk size calculation on polling refetches
      const skip = hasFetchedOnce.current;
      hasFetchedOnce.current = true;
      return fetchSessions(includeArchived, skip);
    },
    structuralSharing: (oldData, newData) =>
      mergeOptimisticSessions(newData, oldData),
    refetchInterval: options.refetchInterval ?? 30_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: options.refetchOnWindowFocus ?? true,
  });
}
