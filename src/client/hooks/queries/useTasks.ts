import { useQuery } from "@tanstack/react-query";
import { fetchTasks } from "../../api";
import { queryKeys } from "../../queryClient";

export function useTasksQuery() {
  return useQuery({
    queryKey: queryKeys.tasks,
    queryFn: fetchTasks,
  });
}
