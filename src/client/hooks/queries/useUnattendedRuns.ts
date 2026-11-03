import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { dismissUnattendedRun, fetchUnattendedRuns, type UnattendedRun } from "../../api";
import { queryKeys } from "../../queryClient";

/** Under ["dashboard"], so the session events that refresh Home refresh this list too. */
export const UNATTENDED_RUNS_KEY = [...queryKeys.dashboard, "unattended-runs"] as const;

type UnattendedRunsData = { runs: UnattendedRun[] };

export function useUnattendedRunsQuery() {
  return useQuery({
    queryKey: UNATTENDED_RUNS_KEY,
    queryFn: ({ signal }) => fetchUnattendedRuns(signal),
    select: (data: UnattendedRunsData) => data.runs,
    refetchOnWindowFocus: true,
  });
}

/** Removes the chat from the list at once and puts it back if the server refuses. */
export function useDismissUnattendedRun() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) => dismissUnattendedRun(sessionId),
    onMutate: async (sessionId) => {
      await client.cancelQueries({ queryKey: UNATTENDED_RUNS_KEY });
      const previous = client.getQueryData<UnattendedRunsData>(UNATTENDED_RUNS_KEY);
      if (previous) {
        client.setQueryData<UnattendedRunsData>(UNATTENDED_RUNS_KEY,
          { runs: previous.runs.filter(run => run.sessionId !== sessionId) });
      }
      return { previous };
    },
    onError: (_error, _sessionId, context) => {
      if (context?.previous) client.setQueryData(UNATTENDED_RUNS_KEY, context.previous);
    },
    onSettled: () => client.invalidateQueries({ queryKey: UNATTENDED_RUNS_KEY }),
  });
}
