import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchOpenChecklistItems, fetchChecklistItems, createChecklistItem, type ChecklistItem } from "../../api";
import { queryKeys } from "../../queryClient";

export function useTaskChecklistItemsQuery(taskId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.taskChecklistItems(taskId!),
    queryFn: () => fetchChecklistItems(taskId!),
    enabled: !!taskId,
  });
}

export function useOpenChecklistItemsQuery() {
  return useQuery({
    queryKey: queryKeys.openChecklistItems,
    queryFn: fetchOpenChecklistItems,
    refetchOnWindowFocus: true,
  });
}

export function useCreateChecklistItemMutation(taskId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ text, deadline }: { text: string; deadline?: string }) =>
      createChecklistItem(taskId!, text, deadline),
    onSuccess: (newChecklistItem) => {
      queryClient.setQueryData<ChecklistItem[]>(
        queryKeys.taskChecklistItems(taskId!),
        (old) => (old ? [...old, newChecklistItem] : [newChecklistItem]),
      );
    },
  });
}

/** Cache-update helpers for ChecklistItemRow callbacks (ChecklistItemRow calls the API itself). */
export function useChecklistItemCacheUpdaters(taskId: string | undefined) {
  const queryClient = useQueryClient();

  const onUpdate = (updated: ChecklistItem) => {
    if (!taskId) return;
    queryClient.setQueryData<ChecklistItem[]>(queryKeys.taskChecklistItems(taskId), (old) =>
      old?.map((t) => (t.id === updated.id ? updated : t)),
    );
  };

  const onDelete = (id: string) => {
    if (!taskId) return;
    queryClient.setQueryData<ChecklistItem[]>(queryKeys.taskChecklistItems(taskId), (old) =>
      old?.filter((t) => t.id !== id),
    );
  };

  return { onUpdate, onDelete };
}
