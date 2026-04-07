import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchTags, createTag, patchTag, deleteTag as apiDeleteTag, reorderTags as apiReorderTags, type Tag } from "../../api";
import { queryKeys } from "../../queryClient";

export function useTagsQuery() {
  return useQuery({
    queryKey: queryKeys.tags,
    queryFn: fetchTags,
  });
}

export function useCreateTagMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, color }: { name: string; color?: string }) =>
      createTag(name, color),
    onSuccess: (newTag) => {
      queryClient.setQueryData<Tag[]>(queryKeys.tags, (old) =>
        old ? [...old, newTag] : [newTag],
      );
    },
  });
}

export function usePatchTagMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      updates,
    }: {
      id: string;
      updates: Partial<Pick<Tag, "name" | "color" | "instructions">>;
    }) => patchTag(id, updates),
    onSuccess: (updated) => {
      queryClient.setQueryData<Tag[]>(queryKeys.tags, (old) =>
        old?.map((t) => (t.id === updated.id ? updated : t)),
      );
    },
  });
}

export function useDeleteTagMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiDeleteTag(id),
    onSuccess: (_data, id) => {
      queryClient.setQueryData<Tag[]>(queryKeys.tags, (old) =>
        old?.filter((t) => t.id !== id),
      );
    },
  });
}

export function useReorderTagsMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (tagIds: string[]) => apiReorderTags(tagIds),
    onSuccess: (reordered) => {
      queryClient.setQueryData<Tag[]>(queryKeys.tags, reordered);
    },
  });
}
