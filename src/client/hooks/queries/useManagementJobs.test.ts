import { describe, expect, it } from "vitest";
import {
  ACTIVE_MANAGEMENT_JOB_REFETCH_MS,
  getManagementJobQueryOptions,
  getManagementJobRefetchInterval,
  getManagementJobsQueryOptions,
  getManagementJobsRefetchInterval,
} from "./useManagementJobs";
import type { ManagementJobDetail, ManagementJobListResponse, ManagementJobStatus } from "../../management-job-api";

function listWithStatuses(statuses: ManagementJobStatus[]): ManagementJobListResponse {
  return {
    jobs: statuses.map((status, index) => ({
      id: `job-${index}`,
      type: "self_update",
      status,
      createdAt: "2026-05-20T12:00:00.000Z",
      updatedAt: "2026-05-20T12:00:00.000Z",
      stale: false,
    })),
    activeCount: statuses.filter((status) => status === "queued" || status === "running").length,
    runningCount: statuses.filter((status) => status === "running").length,
    queuedCount: statuses.filter((status) => status === "queued").length,
    staleCount: 0,
    staleAfterMs: 300_000,
    fetchedAt: "2026-05-20T12:00:01.000Z",
  };
}

function detailWithStatus(status: ManagementJobStatus): Pick<ManagementJobDetail, "status"> {
  return { status };
}

describe("management job query helpers", () => {
  it("polls list queries while visible or summarized jobs are active", () => {
    expect(getManagementJobsRefetchInterval(undefined)).toBe(false);
    expect(getManagementJobsRefetchInterval(listWithStatuses(["succeeded", "failed", "cancelled"]))).toBe(false);
    expect(getManagementJobsRefetchInterval(listWithStatuses(["succeeded", "queued"]))).toBe(ACTIVE_MANAGEMENT_JOB_REFETCH_MS);
    expect(getManagementJobsRefetchInterval(listWithStatuses(["running"]))).toBe(ACTIVE_MANAGEMENT_JOB_REFETCH_MS);
    expect(getManagementJobsRefetchInterval({
      ...listWithStatuses(["succeeded"]),
      activeCount: 1,
      queuedCount: 1,
    })).toBe(ACTIVE_MANAGEMENT_JOB_REFETCH_MS);
  });

  it("polls detail queries only while the selected job is active", () => {
    expect(getManagementJobRefetchInterval(undefined)).toBe(false);
    expect(getManagementJobRefetchInterval(detailWithStatus("succeeded"))).toBe(false);
    expect(getManagementJobRefetchInterval(detailWithStatus("failed"))).toBe(false);
    expect(getManagementJobRefetchInterval(detailWithStatus("queued"))).toBe(ACTIVE_MANAGEMENT_JOB_REFETCH_MS);
    expect(getManagementJobRefetchInterval(detailWithStatus("running"))).toBe(ACTIVE_MANAGEMENT_JOB_REFETCH_MS);
  });

  it("uses function-form refetch intervals based on latest query data", () => {
    expect(typeof getManagementJobsQueryOptions().refetchInterval).toBe("function");
    expect(typeof getManagementJobQueryOptions("job-1").refetchInterval).toBe("function");
  });
});
