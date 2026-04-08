import { useCallback, useEffect, useRef } from "react";
import type { EnrichedWorkItem, EnrichedPR } from "../api";
import { useQueryClient } from "@tanstack/react-query";
import { useTaskEnrichmentQuery } from "./queries/useEnrichment";
import { queryKeys } from "../queryClient";

/** Fetches enriched work items and PRs for a task, re-fetching when the task or link counts change. */
export function useTaskEnrichment(taskId: string | undefined, workItemCount: number, prCount: number) {
  const enabled = (workItemCount > 0 || prCount > 0);
  const { data } = useTaskEnrichmentQuery(taskId, enabled);
  const queryClient = useQueryClient();

  // Invalidate enrichment when link counts change (e.g. after link/unlink)
  const prevCounts = useRef({ workItemCount, prCount });
  useEffect(() => {
    const prev = prevCounts.current;
    if (taskId && (prev.workItemCount !== workItemCount || prev.prCount !== prCount)) {
      queryClient.invalidateQueries({ queryKey: queryKeys.taskEnriched(taskId) });
    }
    prevCounts.current = { workItemCount, prCount };
  }, [taskId, workItemCount, prCount, queryClient]);

  const enrichedWIs: EnrichedWorkItem[] = enabled ? (data?.workItems ?? []) : [];
  const enrichedPRs: EnrichedPR[] = enabled ? (data?.pullRequests ?? []) : [];

  const reload = useCallback(() => {
    if (taskId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.taskEnriched(taskId) });
    }
  }, [taskId, queryClient]);

  return { enrichedWIs, enrichedPRs, reload };
}
