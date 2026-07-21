import { useInfiniteQuery } from "@tanstack/react-query";
import { fetchScheduleSessions } from "../../api";
import { queryKeys } from "../../queryClient";

const SCHEDULE_RUN_PAGE_SIZE = 20;

export function useScheduleSessionsQuery(scheduleId: string | undefined) {
  return useInfiniteQuery({
    queryKey: queryKeys.scheduleSessions(scheduleId!),
    queryFn: ({ pageParam }) => fetchScheduleSessions(scheduleId!, {
      limit: SCHEDULE_RUN_PAGE_SIZE,
      offset: pageParam,
    }),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => {
      if (lastPage.sessions.length === 0) return undefined;
      const nextOffset = lastPage.offset + lastPage.sessions.length;
      return nextOffset < lastPage.total ? nextOffset : undefined;
    },
    enabled: !!scheduleId,
  });
}
