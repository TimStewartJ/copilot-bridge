import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchTodos, createTodo, type Todo } from "../../api";
import { queryKeys } from "../../queryClient";

export function useTaskTodosQuery(taskId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.taskTodos(taskId!),
    queryFn: () => fetchTodos(taskId!),
    enabled: !!taskId,
  });
}

export function useCreateTodoMutation(taskId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ text, deadline }: { text: string; deadline?: string }) =>
      createTodo(taskId!, text, deadline),
    onSuccess: (newTodo) => {
      queryClient.setQueryData<Todo[]>(
        queryKeys.taskTodos(taskId!),
        (old) => (old ? [...old, newTodo] : [newTodo]),
      );
    },
  });
}

/** Cache-update helpers for TodoRow callbacks (TodoRow calls the API itself). */
export function useTodoCacheUpdaters(taskId: string | undefined) {
  const queryClient = useQueryClient();

  const onUpdate = (updated: Todo) => {
    if (!taskId) return;
    queryClient.setQueryData<Todo[]>(queryKeys.taskTodos(taskId), (old) =>
      old?.map((t) => (t.id === updated.id ? updated : t)),
    );
  };

  const onDelete = (id: string) => {
    if (!taskId) return;
    queryClient.setQueryData<Todo[]>(queryKeys.taskTodos(taskId), (old) =>
      old?.filter((t) => t.id !== id),
    );
  };

  return { onUpdate, onDelete };
}
