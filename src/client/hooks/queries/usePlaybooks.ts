import { useQuery } from "@tanstack/react-query";
import { fetchPlaybooks } from "../../api";
import { queryClient, queryKeys } from "../../queryClient";

/** The installed playbooks. A skill scan (`skills:changed`) refreshes them. */
export function usePlaybooksQuery(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: queryKeys.playbooks,
    queryFn: fetchPlaybooks,
    staleTime: 5 * 60_000,
    enabled: options?.enabled ?? true,
  }, queryClient);
}
