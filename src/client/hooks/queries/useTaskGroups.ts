import { useQuery } from "@tanstack/react-query";
import { fetchTaskGroups } from "../../api";
import { queryKeys } from "../../queryClient";

export function useTaskGroupsQuery() {
  return useQuery({
    queryKey: queryKeys.taskGroups,
    queryFn: fetchTaskGroups,
  });
}
