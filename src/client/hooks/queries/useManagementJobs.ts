import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  cancelManagementJob,
  enqueueManagementJob,
  fetchManagementJob,
  fetchManagementJobs,
  retryManagementJob,
  type ManagementJobDetail,
  type ManagementJobFilters,
  type ManagementJobListResponse,
  type ManagementJobStatus,
  type EnqueueManagementJobRequest,
} from "../../management-job-api";
import { queryKeys } from "../../queryClient";

export const ACTIVE_MANAGEMENT_JOB_REFETCH_MS = 2_000;

export function isActiveManagementJobStatus(status: ManagementJobStatus): boolean {
  return status === "queued" || status === "running";
}

export function getManagementJobsRefetchInterval(data?: ManagementJobListResponse): number | false {
  return (data?.activeCount ?? 0) > 0 || data?.jobs.some((job) => isActiveManagementJobStatus(job.status))
    ? ACTIVE_MANAGEMENT_JOB_REFETCH_MS
    : false;
}

export function getManagementJobRefetchInterval(data?: Pick<ManagementJobDetail, "status">): number | false {
  return data && isActiveManagementJobStatus(data.status)
    ? ACTIVE_MANAGEMENT_JOB_REFETCH_MS
    : false;
}

export function invalidateManagementJobQueries(queryClient: Pick<QueryClient, "invalidateQueries">): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.managementJobsRoot });
}

export function getManagementJobsQueryOptions(filters: ManagementJobFilters = {}) {
  return queryOptions({
    queryKey: queryKeys.managementJobs(filters),
    queryFn: ({ signal }) => fetchManagementJobs(filters, { signal }),
    refetchInterval: (currentQuery) => getManagementJobsRefetchInterval(currentQuery.state.data),
    refetchIntervalInBackground: false,
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
  });
}

export function getManagementJobQueryOptions(id: string) {
  return queryOptions({
    queryKey: queryKeys.managementJob(id),
    queryFn: ({ signal }) => fetchManagementJob(id, { signal }),
    refetchInterval: (currentQuery) => getManagementJobRefetchInterval(currentQuery.state.data),
    refetchIntervalInBackground: false,
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
  });
}

export function useManagementJobsQuery(filters: ManagementJobFilters = {}) {
  return useQuery(getManagementJobsQueryOptions(filters));
}

export function useManagementJobQuery(id: string | undefined) {
  return useQuery({
    ...getManagementJobQueryOptions(id!),
    enabled: !!id,
  });
}

export function useCancelManagementJobMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => cancelManagementJob(id),
    onSuccess: (job) => {
      queryClient.setQueryData(queryKeys.managementJob(job.id), job);
    },
    onSettled: () => {
      invalidateManagementJobQueries(queryClient);
    },
  });
}

export function useEnqueueManagementJobMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: EnqueueManagementJobRequest) => enqueueManagementJob(request),
    onSuccess: ({ job }) => {
      queryClient.setQueryData(queryKeys.managementJob(job.id), job);
    },
    onSettled: () => {
      invalidateManagementJobQueries(queryClient);
    },
  });
}

export function useRetryManagementJobMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => retryManagementJob(id),
    onSuccess: ({ job }) => {
      queryClient.setQueryData(queryKeys.managementJob(job.id), job);
    },
    onSettled: () => {
      invalidateManagementJobQueries(queryClient);
    },
  });
}
