import {
  getManagementJobStaleAfterMs,
  type ManagementJob,
  type ManagementJobStatus,
  type ManagementJobType,
} from "./management-job-store.js";

export interface ManagementJobSummaryResponse {
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

export interface ManagementJobDetailResponse extends ManagementJobSummaryResponse {
  input: unknown;
  result?: unknown;
  logTail?: string;
}

export interface ManagementJobResponseOptions {
  now?: Date;
  staleAfterMs?: number;
}

function heartbeatAgeMs(job: ManagementJob, nowMs: number): number | undefined {
  if (job.status !== "running" || !job.heartbeatAt) return undefined;
  const heartbeatMs = Date.parse(job.heartbeatAt);
  if (!Number.isFinite(heartbeatMs)) return undefined;
  return Math.max(0, nowMs - heartbeatMs);
}

export function managementJobStaleAfterMs(): number {
  return getManagementJobStaleAfterMs(process.env);
}

export function toManagementJobSummaryResponse(
  job: ManagementJob,
  options: ManagementJobResponseOptions = {},
): ManagementJobSummaryResponse {
  const nowMs = options.now?.getTime() ?? Date.now();
  const staleAfterMs = options.staleAfterMs ?? managementJobStaleAfterMs();
  const ageMs = heartbeatAgeMs(job, nowMs);
  const stale = job.status === "running" && (ageMs === undefined || ageMs > staleAfterMs);

  return {
    id: job.id,
    type: job.type,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    heartbeatAt: job.heartbeatAt,
    runnerPid: job.runnerPid,
    cancelRequestedAt: job.cancelRequestedAt,
    error: job.error,
    stale,
    heartbeatAgeMs: ageMs,
  };
}

export function toManagementJobDetailResponse(
  job: ManagementJob,
  options: ManagementJobResponseOptions & { logTail?: string } = {},
): ManagementJobDetailResponse {
  return {
    ...toManagementJobSummaryResponse(job, options),
    input: job.input,
    result: job.result,
    logTail: options.logTail,
  };
}
