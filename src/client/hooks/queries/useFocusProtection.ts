import { useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  cancelFocusProtection, createFocusProtection, fetchFocusProtectionCurrent,
  fetchFocusProtectionPage, previewFocusProtection,
} from "../../api";
import { invalidateFocusProtectionQueries } from "../../lib/focus-query-invalidation";
import { queryKeys } from "../../queryClient";

export function useFocusProtectionCurrentQuery(enabled = true) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.focusProtectionCurrent,
    queryFn: fetchFocusProtectionCurrent,
    enabled,
    staleTime: 0,
    retry: false,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });
  const [clock, setClock] = useState(Date.now);
  const requestedBoundary = useRef<string | null>(null);
  const protection = query.data?.current ?? query.data?.upcoming ?? null;
  const serverTime = query.data ? Date.parse(query.data.generatedAt) : NaN;
  const nowMs = Number.isFinite(serverTime) ? serverTime + Math.max(0, clock - query.dataUpdatedAt) : clock;
  const boundary = protection?.status === "active" ? protection.endsAt
    : protection?.status === "scheduled" ? protection.startsAt : null;
  const boundaryAt = boundary === null ? NaN : Date.parse(boundary);
  const boundaryReached = boundary !== null && nowMs >= boundaryAt;

  useEffect(() => {
    setClock(Date.now());
    if (!enabled || !protection) return;
    const timer = setInterval(() => setClock(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [enabled, protection?.id, protection?.status]);

  useEffect(() => {
    if (!enabled || !protection || !Number.isFinite(boundaryAt) || !Number.isFinite(serverTime)) return;
    const identity = `${protection.id}:${protection.status}:${boundary}`;
    if (requestedBoundary.current === identity) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const checkBoundary = () => {
      const localNow = Date.now();
      const remaining = boundaryAt - (serverTime + Math.max(0, localNow - query.dataUpdatedAt));
      if (remaining > 0) {
        timer = setTimeout(checkBoundary, Math.min(remaining, 24 * 60 * 60_000));
        return;
      }
      // Revalidation follows the server deadline, not the phase of the display
      // interval or a later React commit. The response still owns status.
      setClock(localNow);
      requestedBoundary.current = identity;
      void invalidateFocusProtectionQueries(queryClient);
    };
    checkBoundary();
    return () => clearTimeout(timer);
  }, [enabled, protection?.id, protection?.status, boundary, boundaryAt, serverTime, query.dataUpdatedAt, queryClient]);

  return {
    ...query,
    protection,
    nowMs,
    boundaryReached,
    statusUnknown: query.isPending || query.isError || boundaryReached
      || (query.data !== undefined && !Number.isFinite(serverTime))
      || (boundary !== null && !Number.isFinite(boundaryAt)),
  };
}

export function useFocusProtectionPagesQuery(enabled: boolean) {
  return useInfiniteQuery({
    queryKey: queryKeys.focusProtectionHistory,
    queryFn: ({ pageParam }) => fetchFocusProtectionPage(pageParam, 50),
    initialPageParam: 0,
    getNextPageParam: (page) => page.nextOffset ?? undefined,
    enabled,
    staleTime: 0,
    retry: false,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });
}

export function usePreviewFocusProtectionMutation() {
  return useMutation({ mutationFn: previewFocusProtection, retry: false });
}

export function useCreateFocusProtectionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createFocusProtection,
    retry: false,
    onSettled: () => invalidateFocusProtectionQueries(queryClient),
  });
}

export function useCancelFocusProtectionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: cancelFocusProtection,
    retry: false,
    onSettled: () => invalidateFocusProtectionQueries(queryClient),
  });
}
