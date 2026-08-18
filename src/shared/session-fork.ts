export const SESSION_FORK_JOB_STATUSES = ["queued", "running", "succeeded", "failed"] as const;

export type SessionForkJobStatus = typeof SESSION_FORK_JOB_STATUSES[number];

export interface SessionForkJob {
  id: string;
  sourceSessionId: string;
  status: SessionForkJobStatus;
  bounded: boolean;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  sessionId?: string;
  error?: string;
}

export interface StartSessionForkResponse {
  job: SessionForkJob;
  reused: boolean;
}

export function isSessionForkJobTerminal(status: SessionForkJobStatus): boolean {
  return status === "succeeded" || status === "failed";
}
