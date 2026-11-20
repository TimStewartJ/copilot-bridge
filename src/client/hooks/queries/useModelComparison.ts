import { useQuery } from "@tanstack/react-query";
import { fetchModelComparison } from "../../api";
import { queryClient, queryKeys } from "../../queryClient";
import type { ModelComparisonView } from "../../../shared/model-ab-test.js";

const WORKING = new Set<ModelComparisonView["status"]>(["awaiting_prompt", "starting", "running", "judging"]);

/** The comparison a chat is part of, or null; shared by the chat bar and the header. */
export function useModelComparisonQuery(sessionId: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.modelComparison(sessionId ?? ""),
    queryFn: ({ signal }) => fetchModelComparison(sessionId!, signal),
    enabled: Boolean(sessionId),
    refetchInterval: (current) => (current.state.data && WORKING.has(current.state.data.status) ? 15_000 : false),
  }, queryClient);
}

/** True while the chat's models must stay unnamed: it is in a pair the user has not decided. */
export function isModelHidden(comparison: ModelComparisonView | null | undefined): boolean {
  return !!comparison && !comparison.revealed;
}
