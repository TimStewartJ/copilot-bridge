import { useState, useEffect } from "react";
import type { EnrichedWorkItem, EnrichedPR } from "../api";
import { fetchEnrichedTask } from "../api";

/** Fetches enriched work items and PRs for a task, re-fetching when the task or link counts change. */
export function useTaskEnrichment(taskId: string | undefined, workItemCount: number, prCount: number) {
  const [enrichedWIs, setEnrichedWIs] = useState<EnrichedWorkItem[]>([]);
  const [enrichedPRs, setEnrichedPRs] = useState<EnrichedPR[]>([]);

  useEffect(() => {
    if (taskId && (workItemCount > 0 || prCount > 0)) {
      fetchEnrichedTask(taskId)
        .then((data) => {
          setEnrichedWIs(data.workItems);
          setEnrichedPRs(data.pullRequests);
        })
        .catch(() => {});
    } else {
      setEnrichedWIs([]);
      setEnrichedPRs([]);
    }
  }, [taskId, workItemCount, prCount]);

  return { enrichedWIs, enrichedPRs };
}
