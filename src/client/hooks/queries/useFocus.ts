import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  fetchFocusAttentionEvents,
  fetchFocusAttentionMetrics,
  fetchFocusAuditPage,
  fetchFocusAuthorityPage,
  fetchFocusCoveragePage,
  fetchFocusHistoryPage,
  fetchFocusEpisodePage,
  fetchFocusLaunchReceipt,
  fetchFocusLaunchReceipts,
  fetchFocusNotificationDeliveries,
  fetchFocusObject,
  fetchFocusQuietConcernPage,
  fetchFocusTransitionPage,
  markFocusDigestViewed,
  type FocusHistoryFilter,
  type FocusLaunchIdentity,
  type FocusObject,
  type FocusObjectType,
  type FocusQuietConcernFilter,
  type FocusSessionLaunch,
} from "../../api";
import { invalidateFocusMutationQueries } from "../../lib/focus-query-invalidation";
import { queryKeys } from "../../queryClient";

export function useFocusObjectQuery(type: FocusObjectType, id: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.focusObject(type, id),
    queryFn: () => fetchFocusObject(type, id),
    enabled,
  });
}

export function useFocusHistoryPagesQuery(filter: FocusHistoryFilter, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: queryKeys.focusHistory(filter),
    queryFn: ({ pageParam }) => fetchFocusHistoryPage(pageParam, 20, filter),
    initialPageParam: 0,
    getNextPageParam: (page) => page.nextOffset ?? undefined,
    enabled,
  });
}

export function useFocusTransitionPagesQuery(id: string, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: queryKeys.focusTransitions(id),
    queryFn: ({ pageParam }) => fetchFocusTransitionPage(id, pageParam, 100),
    initialPageParam: 0,
    getNextPageParam: (page, pages) => page.length === 100 ? pages.flat().length : undefined,
    enabled,
  });
}

export function useFocusAuthorityPagesQuery(enabled: boolean) {
  return useInfiniteQuery({
    queryKey: queryKeys.focusAuthority,
    queryFn: ({ pageParam }) => fetchFocusAuthorityPage(pageParam, 50),
    initialPageParam: 0,
    getNextPageParam: (page, pages) => page.length === 50 ? pages.flat().length : undefined,
    enabled,
    refetchInterval: enabled ? 15_000 : false,
  });
}

export function useFocusCoveragePagesQuery(enabled: boolean) {
  return useInfiniteQuery({
    queryKey: queryKeys.focusCoverage,
    queryFn: ({ pageParam }) => fetchFocusCoveragePage(pageParam, 50),
    initialPageParam: 0,
    getNextPageParam: (page, pages) => {
      const loaded = pages.reduce((count, current) => count + current.assertions.length, 0);
      return page.assertions.length > 0 && loaded < page.summary.total ? loaded : undefined;
    },
    enabled,
    refetchInterval: enabled ? 15_000 : false,
  });
}

export function useFocusAuditPagesQuery(enabled: boolean) {
  return useInfiniteQuery({
    queryKey: queryKeys.focusAudits,
    queryFn: ({ pageParam }) => fetchFocusAuditPage(pageParam, 50, "open"),
    initialPageParam: 0,
    getNextPageParam: (page, pages) => page.length === 50 ? pages.flat().length : undefined,
    enabled,
  });
}

export function useFocusAttentionMetricsQuery(days = 7, enabled = true) {
  return useQuery({ queryKey: queryKeys.focusMetrics(days), queryFn: () => fetchFocusAttentionMetrics(days), enabled });
}

export function useFocusAttentionEventsQuery(objectId?: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.focusAttentionEvents(objectId),
    queryFn: () => fetchFocusAttentionEvents(objectId),
    enabled,
  });
}

export function useFocusNotificationDeliveriesQuery(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.focusDeliveries,
    queryFn: () => fetchFocusNotificationDeliveries(100),
    enabled,
  });
}

export function useFocusMutation<T, V>(objectId: string, mutationFn: (input: V) => Promise<T>, actions = false) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: queryKeys.focusMutation(objectId),
    mutationFn,
    retry: false,
    onSettled: () => invalidateFocusMutationQueries(queryClient, actions),
  });
}

export function useMarkFocusDigestViewedMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ digestId, viewedAt }: { digestId: string; viewedAt: string }) => markFocusDigestViewed(digestId, viewedAt),
    retry: false,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.focusSnapshot }),
        queryClient.invalidateQueries({ queryKey: ["dashboard", "focus", "metrics"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard", "focus", "attention-events"] }),
      ]);
    },
  });
}

export function useFocusEpisodePagesQuery(objectId: string, activationId: string, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: queryKeys.focusEpisode(objectId, activationId),
    queryFn: ({ pageParam }) => fetchFocusEpisodePage(objectId, activationId, pageParam),
    initialPageParam: 0,
    getNextPageParam: (page) => page.nextOffset ?? undefined,
    enabled,
  });
}

export function useFocusQuietConcernPagesQuery(filter: FocusQuietConcernFilter, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: queryKeys.focusQuietConcerns(filter),
    queryFn: ({ pageParam }) => fetchFocusQuietConcernPage(pageParam, 20, filter),
    initialPageParam: 0,
    getNextPageParam: (page) => page.nextOffset ?? undefined,
    enabled,
  });
}

function launchInProgress(receipt: FocusSessionLaunch | null | undefined): boolean {
  return receipt?.status === "creating" || receipt?.status === "created";
}

export function useFocusLaunchReceiptQuery(identity: FocusLaunchIdentity, enabled = true) {
  return useQuery({
    queryKey: queryKeys.focusLaunchReceipt(identity),
    queryFn: () => fetchFocusLaunchReceipt(identity),
    enabled,
    staleTime: 0,
    retry: false,
    refetchOnMount: "always",
    refetchInterval: (query) => launchInProgress(query.state.data) ? 2_000 : false,
  });
}

export function useFocusLaunchReceiptsQuery(object: Pick<FocusObject, "id" | "activationId">, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.focusLaunchReceipts(object.id, object.activationId),
    queryFn: () => fetchFocusLaunchReceipts(object.id, object.activationId),
    enabled,
    staleTime: 0,
    retry: false,
    refetchOnMount: "always",
    refetchInterval: (query) => query.state.data?.some(launchInProgress) ? 2_000 : false,
  });
}

export function rememberFocusLaunchReceipt(queryClient: QueryClient, receipt: FocusSessionLaunch) {
  queryClient.setQueryData<FocusSessionLaunch | null>(queryKeys.focusLaunchReceipt(receipt),
    (current) => current && current.version > receipt.version ? current : receipt);
  queryClient.setQueryData<FocusSessionLaunch>(queryKeys.focusLaunchReceiptById(receipt.id),
    (current) => current && current.version > receipt.version ? current : receipt);
  queryClient.setQueryData<FocusSessionLaunch[]>(queryKeys.focusLaunchReceipts(receipt.objectId, receipt.activationId), (current) => {
    if (!current) return current;
    const existing = current.find((entry) => entry.id === receipt.id);
    if (existing && existing.version > receipt.version) return current;
    return [...current.filter((entry) => entry.id !== receipt.id), receipt];
  });
}
