import { useQuery } from "@tanstack/react-query";
import { fetchModelRoles, fetchModels } from "../../api";
import { queryKeys } from "../../queryClient";

export function useModelsQuery(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: queryKeys.models,
    queryFn: fetchModels,
    staleTime: 5 * 60_000, // models change rarely
    enabled: options?.enabled ?? true,
  });
}

/** What each tier and role runs on (Settings › Models). Shares its key with the Models page. */
export function useModelRolesQuery() {
  return useQuery({ queryKey: ["models", "roles"], queryFn: ({ signal }) => fetchModelRoles(signal) });
}
