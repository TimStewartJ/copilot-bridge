import { useCallback } from "react";
import {
  replaceEqualDeep,
  useMutationState,
  useQuery,
  type InfiniteData,
  type Query,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { fetchSessions, getSessionRunState, type Session, type TaskArchivedSessionsResponse } from "../../api";
import { queryKeys } from "../../queryClient";

const inFlightSessionPatches = new WeakMap<Query, {
  promise: Promise<unknown> | undefined;
  patches: Map<string, Partial<Session>>;
}>();

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

/**
 * Session polls return a fresh array every time even when nothing changed. Keep the
 * cached references for unchanged sessions so the list (and every consumer keyed on
 * it) only re-renders for real changes.
 */
export function shareSessionsStructurally(
  oldData: Session[] | undefined,
  newData: Session[],
  now = Date.now(),
): Session[] {
  return replaceEqualDeep(oldData, mergeOptimisticSessions(newData, oldData, now));
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

function applySessionQueryPatches(
  queryClient: QueryClient,
  queryKey: QueryKey,
  patches: ReadonlyMap<string, Partial<Session>>,
): void {
  const apply = (session: Session): Session => {
    const patch = patches.get(session.sessionId);
    return patch ? { ...session, ...patch } : session;
  };
  if (queryKey[0] !== queryKeys.taskArchivedSessionsRoot[0]) {
    queryClient.setQueryData<Session[]>(queryKey, (prev) => prev?.map(apply));
    return;
  }
  // A task's archived pages hold their own copies of the same sessions.
  queryClient.setQueryData<InfiniteData<TaskArchivedSessionsResponse>>(
    queryKey,
    (prev) => {
      if (!prev?.pages.some((page) => page.sessions.some((session) => patches.has(session.sessionId)))) return prev;
      return {
        ...prev,
        pages: prev.pages.map((page) => ({
          ...page,
          sessions: page.sessions.map(apply),
        })),
      };
    },
  );
}

export function patchSessionQueryData(
  queryClient: QueryClient,
  sessionIds: readonly string[],
  patch: Partial<Session>,
): void {
  if (sessionIds.length === 0) return;
  const patches = new Map(sessionIds.map((sessionId) => [sessionId, patch]));
  const cache = queryClient.getQueryCache();
  for (const query of [
    ...cache.findAll({ queryKey: ["sessions"] }),
    ...cache.findAll({ queryKey: queryKeys.taskArchivedSessionsRoot }),
  ]) {
    let pending = inFlightSessionPatches.get(query);
    if (query.state.fetchStatus !== "idle" && !pending) {
      // Keep live updates that arrive during a fetch, including a multi-page archive refetch,
      // without canceling the fetch or losing its other fresh fields.
      const updates = {
        promise: query.promise,
        patches: new Map<string, Partial<Session>>(),
      };
      pending = updates;
      inFlightSessionPatches.set(query, updates);
      const unsubscribe = cache.subscribe((event) => {
        if (event.query !== query) return;
        if (event.type !== "removed" && (event.type !== "updated" || query.state.fetchStatus !== "idle")) return;
        unsubscribe();
        const current = inFlightSessionPatches.get(query);
        inFlightSessionPatches.delete(query);
        if (current && current.promise === query.promise && event.type === "updated"
          && event.action.type === "success" && !event.action.manual) {
          applySessionQueryPatches(queryClient, query.queryKey, current.patches);
        }
      });
    }
    if (pending && pending.promise !== query.promise) {
      pending.promise = query.promise;
      pending.patches.clear();
    }
    for (const sessionId of sessionIds) {
      pending?.patches.set(sessionId, { ...pending.patches.get(sessionId), ...patch });
    }
    applySessionQueryPatches(queryClient, query.queryKey, patches);
  }
}

export function useSessionsQuery(includeArchived: boolean, options: UseSessionsQueryOptions = {}) {
  const sendingSessionIds = useMutationState({
    filters: { mutationKey: queryKeys.sessionSends, status: "pending" },
    select: (mutation) => mutation.options.mutationKey?.[1],
  });
  return useQuery<Session[]>({
    queryKey: queryKeys.sessions({ includeArchived }),
    enabled: options.enabled ?? true,
    queryFn: () => fetchSessions(includeArchived),
    select: useCallback((sessions: Session[]): Session[] => {
      if (sendingSessionIds.length === 0) return sessions;
      return sessions.map((session) =>
        sendingSessionIds.includes(session.sessionId) && getSessionRunState(session) === "idle"
          ? { ...session, runState: "busy" }
          : session);
    }, [sendingSessionIds]),
    structuralSharing: (oldData, newData) =>
      shareSessionsStructurally(oldData as Session[] | undefined, newData as Session[]),
    refetchInterval: options.refetchInterval ?? 30_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: options.refetchOnWindowFocus ?? true,
  });
}
