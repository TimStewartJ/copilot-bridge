import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  fetchDashboard,
  fetchFocusAlertPage,
  fetchFocusClearedPage,
  fetchFocusDecisionPage,
  fetchFocusEventDigestPage,
  fetchFocusSnapshot,
  type FocusDigest,
} from "../../api";
import { queryKeys } from "../../queryClient";

export function useDashboardQuery() {
  return useQuery({
    queryKey: queryKeys.dashboard,
    queryFn: fetchDashboard,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
}

export function useFocusSnapshotQuery(enabled = true) {
  return useQuery({
    queryKey: queryKeys.focusSnapshot,
    queryFn: fetchFocusSnapshot,
    enabled,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
}

export function useFocusDecisionPagesQuery(enabled = true) {
  return useInfiniteQuery({
    queryKey: queryKeys.focusDecisions,
    queryFn: ({ pageParam }) => fetchFocusDecisionPage(pageParam),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage.nextOffset ?? undefined,
    enabled,
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  });
}

export function useFocusAlertPagesQuery(enabled = true) {
  return useInfiniteQuery({
    queryKey: queryKeys.focusAlerts,
    queryFn: ({ pageParam }) => fetchFocusAlertPage(pageParam),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage.nextOffset ?? undefined,
    enabled,
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  });
}

export function useDashboardDigestPagesQuery(digest: FocusDigest, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: queryKeys.focusDigest(digest.id),
    queryFn: ({ pageParam }) => {
      if (digest.orphaned && !digest.originalTaskId) {
        throw new Error("Source task identity is unavailable. Inspect this Event in History instead of treating it as Global.");
      }
      return fetchFocusEventDigestPage({
        taskId: digest.taskId,
        keyPrefix: digest.keyPrefix,
        category: digest.category,
        sourceFamily: digest.sourceFamily,
        orphanedTaskId: digest.orphaned ? digest.originalTaskId : null,
      }, pageParam);
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage.nextOffset ?? undefined,
    enabled,
    refetchOnWindowFocus: true,
  });
}

export function useDashboardClearedPagesQuery(enabled: boolean) {
  return useInfiniteQuery({
    queryKey: queryKeys.focusCleared,
    queryFn: ({ pageParam }) => fetchFocusClearedPage(pageParam),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage.nextOffset ?? undefined,
    enabled,
    refetchOnWindowFocus: true,
  });
}
