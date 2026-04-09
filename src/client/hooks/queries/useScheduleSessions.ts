import { useQuery } from "@tanstack/react-query";
import { fetchScheduleSessions } from "../../api";
import { queryKeys } from "../../queryClient";

export function useScheduleSessionsQuery(scheduleId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.scheduleSessions(scheduleId!),
    queryFn: () => fetchScheduleSessions(scheduleId!, { limit: 20 }),
    enabled: !!scheduleId,
  });
}
