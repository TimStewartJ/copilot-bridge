import { useQuery } from "@tanstack/react-query";
import { fetchModels } from "../../api";
import { queryKeys } from "../../queryClient";

export function useModelsQuery() {
  return useQuery({
    queryKey: queryKeys.models,
    queryFn: fetchModels,
    staleTime: 5 * 60_000, // models change rarely
  });
}
