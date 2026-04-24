import { useMutation, useQuery, useQueryClient, queryOptions, type QueryClient } from "@tanstack/react-query";
import {
  fetchSessionWorkspace,
  resetSessionWorkspace,
  selectSessionWorkspace,
  setSessionWorkspacePath,
} from "../../api";
import type { SessionWorkspaceDetails } from "../../api";
import { queryKeys } from "../../queryClient";

export function invalidateSessionWorkspaceQueries(
  queryClient: Pick<QueryClient, "invalidateQueries">,
  sessionId: string,
) {
  void queryClient.invalidateQueries({ queryKey: ["sessions"] });
  void queryClient.invalidateQueries({ queryKey: ["session-workspace", sessionId] });
}

export function getSessionWorkspaceQueryOptions(sessionId: string, taskId?: string) {
  return queryOptions({
    queryKey: queryKeys.sessionWorkspace(sessionId, taskId),
    queryFn: ({ signal }) => fetchSessionWorkspace(sessionId, { taskId, signal }),
    enabled: !!sessionId,
  });
}

export function applyWorkspaceMutationResult(
  queryClient: Pick<QueryClient, "setQueryData" | "invalidateQueries">,
  sessionId: string,
  workspace: SessionWorkspaceDetails,
  taskId?: string,
) {
  queryClient.setQueryData(queryKeys.sessionWorkspace(sessionId, taskId), workspace);
  invalidateSessionWorkspaceQueries(queryClient, sessionId);
}

export function useSessionWorkspaceQuery(sessionId: string | undefined, taskId?: string) {
  return useQuery({
    ...getSessionWorkspaceQueryOptions(sessionId!, taskId),
    enabled: !!sessionId,
  });
}

export function useSetSessionWorkspacePathMutation(sessionId: string | undefined, taskId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (cwd: string) => setSessionWorkspacePath(sessionId!, cwd, { taskId }),
    onSuccess: (workspace) => {
      if (!sessionId) return;
      applyWorkspaceMutationResult(queryClient, sessionId, workspace, taskId);
    },
  });
}

export function useSelectSessionWorkspaceMutation(sessionId: string | undefined, taskId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (cwd: string) => selectSessionWorkspace(sessionId!, cwd, { taskId }),
    onSuccess: (workspace) => {
      if (!sessionId) return;
      applyWorkspaceMutationResult(queryClient, sessionId, workspace, taskId);
    },
  });
}

export function useResetSessionWorkspaceMutation(sessionId: string | undefined, taskId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => resetSessionWorkspace(sessionId!, { taskId }),
    onSuccess: (workspace) => {
      if (!sessionId) return;
      applyWorkspaceMutationResult(queryClient, sessionId, workspace, taskId);
    },
  });
}
