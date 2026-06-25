import { API_BASE, ApiError } from "./api";

export const MANAGEMENT_JOB_TYPES = ["self_update", "staging_preview", "staging_deploy"] as const;
export const MANAGEMENT_JOB_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;

export type ManagementJobType = typeof MANAGEMENT_JOB_TYPES[number];
export type ManagementJobStatus = typeof MANAGEMENT_JOB_STATUSES[number];

export interface ManagementJobSummary {
  id: string;
  type: ManagementJobType;
  status: ManagementJobStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  heartbeatAt?: string;
  runnerPid?: number;
  cancelRequestedAt?: string;
  error?: string;
  stale: boolean;
  heartbeatAgeMs?: number;
}

export interface ManagementJobDetail extends ManagementJobSummary {
  input: unknown;
  result?: unknown;
  logTail?: string;
}

export interface ManagementJobListResponse {
  jobs: ManagementJobSummary[];
  activeCount: number;
  runningCount: number;
  queuedCount: number;
  staleCount: number;
  staleAfterMs: number;
  fetchedAt: string;
}

export interface ManagementJobLogResponse {
  jobId: string;
  logTail: string;
}

export interface RetryManagementJobResponse {
  job: ManagementJobDetail;
  retriedFrom: string;
  reused: boolean;
}

export interface ManagementJobFilters {
  types?: ManagementJobType | readonly ManagementJobType[];
  statuses?: ManagementJobStatus | readonly ManagementJobStatus[];
  limit?: number;
}

interface FetchOptions {
  signal?: AbortSignal;
}

async function parseApiError(res: Response): Promise<ApiError> {
  const err = await res.json().catch(() => ({ error: res.statusText }));
  const message = err && typeof err === "object" && "error" in err && typeof err.error === "string"
    ? err.error
    : res.statusText;
  let details = err && typeof err === "object" && "details" in err ? err.details : undefined;
  if (err && typeof err === "object" && "activeJob" in err && err.activeJob !== undefined) {
    const activeJob = (err as { activeJob: unknown }).activeJob;
    if (details && typeof details === "object" && !Array.isArray(details)) {
      details = { ...(details as Record<string, unknown>), activeJob };
    } else if (details === undefined) {
      details = { activeJob };
    }
  }
  return new ApiError(message || res.statusText, res.status, details);
}

async function managementJobFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, init);
  if (!res.ok) throw await parseApiError(res);
  return res.json() as Promise<T>;
}

function appendValues(params: URLSearchParams, name: string, value: string | readonly string[] | undefined): void {
  if (!value) return;
  if (typeof value === "string") {
    params.append(name, value);
    return;
  }
  for (const item of value) params.append(name, item);
}

function managementJobsQueryString(filters: ManagementJobFilters = {}): string {
  const params = new URLSearchParams();
  appendValues(params, "type", filters.types);
  appendValues(params, "status", filters.statuses);
  if (typeof filters.limit === "number" && Number.isFinite(filters.limit)) {
    params.set("limit", String(filters.limit));
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

export async function fetchManagementJobs(
  filters: ManagementJobFilters = {},
  options: FetchOptions = {},
): Promise<ManagementJobListResponse> {
  return managementJobFetch<ManagementJobListResponse>(
    `/api/management-jobs${managementJobsQueryString(filters)}`,
    { signal: options.signal },
  );
}

export async function fetchManagementJob(
  id: string,
  options: FetchOptions = {},
): Promise<ManagementJobDetail> {
  return managementJobFetch<ManagementJobDetail>(
    `/api/management-jobs/${encodeURIComponent(id)}`,
    { signal: options.signal },
  );
}

export async function fetchManagementJobLog(
  id: string,
  tailBytes?: number,
  options: FetchOptions = {},
): Promise<string> {
  const params = new URLSearchParams();
  if (typeof tailBytes === "number" && Number.isFinite(tailBytes)) {
    params.set("tailBytes", String(tailBytes));
  }
  const query = params.toString();
  const response = await managementJobFetch<ManagementJobLogResponse>(
    `/api/management-jobs/${encodeURIComponent(id)}/log${query ? `?${query}` : ""}`,
    { signal: options.signal },
  );
  return response.logTail;
}

export async function cancelManagementJob(id: string): Promise<ManagementJobDetail> {
  return managementJobFetch<ManagementJobDetail>(
    `/api/management-jobs/${encodeURIComponent(id)}/cancel`,
    { method: "POST", headers: { "Content-Type": "application/json" } },
  );
}

export async function retryManagementJob(id: string): Promise<RetryManagementJobResponse> {
  return managementJobFetch<RetryManagementJobResponse>(
    `/api/management-jobs/${encodeURIComponent(id)}/retry`,
    { method: "POST", headers: { "Content-Type": "application/json" } },
  );
}

export interface EnqueueManagementJobRequest {
  type: ManagementJobType;
  input?: Record<string, unknown>;
}

export interface EnqueueManagementJobResponse {
  jobId: string;
  status: ManagementJobStatus;
  enqueuedAt: string;
  reused: boolean;
  job: ManagementJobDetail;
}

export async function enqueueManagementJob(
  request: EnqueueManagementJobRequest,
): Promise<EnqueueManagementJobResponse> {
  return managementJobFetch<EnqueueManagementJobResponse>(
    "/api/management-jobs",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    },
  );
}
