import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { fetchTaskArchivedSessions, type Session, type TaskArchivedSessionsResponse } from "../../api";
import { queryKeys } from "../../queryClient";

export const TASK_ARCHIVED_SESSION_PAGE_SIZE = 25;

/** One task's archived sessions, newest first, fetched a page at a time once `enabled`. */
export function useTaskArchivedSessionsQuery(taskId: string | undefined, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: queryKeys.taskArchivedSessions(taskId ?? ""),
    queryFn: ({ pageParam, signal }) => fetchTaskArchivedSessions(taskId!, {
      limit: TASK_ARCHIVED_SESSION_PAGE_SIZE,
      offset: pageParam,
      signal,
    }),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => {
      if (lastPage.sessions.length === 0) return undefined;
      const nextOffset = lastPage.offset + lastPage.sessions.length;
      return nextOffset < lastPage.total ? nextOffset : undefined;
    },
    enabled: !!taskId && enabled,
    refetchOnWindowFocus: false,
    // App reads these pages so an archived chat opened from them keeps its title and details.
    gcTime: 30 * 60_000,
  });
}

/**
 * Every archived session any task has loaded so far, so a chat opened from a task's archived list
 * finds its summary and details without the global archived list.
 */
export function useCachedTaskArchivedSessions(): Session[] {
  const queryClient = useQueryClient();
  const [version, setVersion] = useState(0);
  useEffect(() => queryClient.getQueryCache().subscribe((event) => {
    if (event.query.queryKey[0] !== queryKeys.taskArchivedSessionsRoot[0]) return;
    if (event.type === "updated" || event.type === "removed") setVersion((current) => current + 1);
  }), [queryClient]);
  return useMemo(() => {
    const seen = new Set<string>();
    const sessions: Session[] = [];
    for (const [, data] of queryClient.getQueriesData<InfiniteData<TaskArchivedSessionsResponse>>({
      queryKey: queryKeys.taskArchivedSessionsRoot,
    })) {
      for (const page of data?.pages ?? []) {
        for (const session of page.sessions) {
          if (seen.has(session.sessionId)) continue;
          seen.add(session.sessionId);
          sessions.push(session);
        }
      }
    }
    return sessions;
    // version tracks cache changes that getQueriesData cannot subscribe to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryClient, version]);
}
