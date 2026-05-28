import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import {
  cancelManagementJob,
  enqueueManagementJob,
  fetchManagementJob,
  fetchManagementJobLog,
  fetchManagementJobs,
  retryManagementJob,
  type EnqueueManagementJobResponse,
  type ManagementJobDetail,
  type ManagementJobListResponse,
} from "./management-job-api";

const summary = {
  id: "job-1",
  type: "self_update",
  status: "queued",
  createdAt: "2026-05-20T12:00:00.000Z",
  updatedAt: "2026-05-20T12:00:00.000Z",
  stale: false,
} as const;

const detail: ManagementJobDetail = {
  ...summary,
  input: { channel: "stable" },
  logTail: "queued",
};

function stubJsonResponse(body: unknown, init: { ok?: boolean; status?: number; statusText?: string } = {}) {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.statusText ?? "OK",
    json: async () => body,
  })));
}

function fetchMock() {
  return vi.mocked(fetch);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("management job client API", () => {
  it("fetches lists with repeated type and status filters", async () => {
    const response: ManagementJobListResponse = {
      jobs: [summary],
      activeCount: 1,
      runningCount: 0,
      queuedCount: 1,
      staleCount: 0,
      staleAfterMs: 300_000,
      fetchedAt: "2026-05-20T12:00:01.000Z",
    };
    stubJsonResponse(response);

    await expect(fetchManagementJobs({
      types: ["self_update", "staging_deploy"],
      statuses: ["queued", "running"],
      limit: 25,
    })).resolves.toEqual(response);

    expect(fetchMock()).toHaveBeenCalledWith(
      "/api/management-jobs?type=self_update&type=staging_deploy&status=queued&status=running&limit=25",
      { signal: undefined },
    );
  });

  it("fetches detail, log, cancel, and retry endpoints", async () => {
    stubJsonResponse(detail);
    await expect(fetchManagementJob("job/1")).resolves.toEqual(detail);
    expect(fetchMock()).toHaveBeenLastCalledWith("/api/management-jobs/job%2F1", { signal: undefined });

    stubJsonResponse({ jobId: "job/1", logTail: "tail" });
    await expect(fetchManagementJobLog("job/1", 4096)).resolves.toBe("tail");
    expect(fetchMock()).toHaveBeenLastCalledWith("/api/management-jobs/job%2F1/log?tailBytes=4096", { signal: undefined });

    stubJsonResponse(detail);
    await expect(cancelManagementJob("job/1")).resolves.toEqual(detail);
    expect(fetchMock()).toHaveBeenLastCalledWith(
      "/api/management-jobs/job%2F1/cancel",
      { method: "POST", headers: { "Content-Type": "application/json" } },
    );

    stubJsonResponse({ job: detail, retriedFrom: "old-job" });
    await expect(retryManagementJob("old-job")).resolves.toEqual({ job: detail, retriedFrom: "old-job" });
    expect(fetchMock()).toHaveBeenLastCalledWith(
      "/api/management-jobs/old-job/retry",
      { method: "POST", headers: { "Content-Type": "application/json" } },
    );
  });

  it("throws ApiError with server details", async () => {
    stubJsonResponse({ error: "cannot retry", details: { reason: "active_job" } }, {
      ok: false,
      status: 409,
      statusText: "Conflict",
    });

    const request = retryManagementJob("job-1");
    await expect(request).rejects.toBeInstanceOf(ApiError);
    await expect(request).rejects.toMatchObject({
      status: 409,
      message: "cannot retry",
      details: { reason: "active_job" },
    });
  });

  it("posts an enqueue request with type and input", async () => {
    const response: EnqueueManagementJobResponse = {
      jobId: detail.id,
      status: "queued",
      enqueuedAt: detail.createdAt,
      reused: false,
      job: detail,
    };
    stubJsonResponse(response, { status: 201 });

    await expect(
      enqueueManagementJob({ type: "staging_preview", input: { stagingDir: "staging-fixture" } }),
    ).resolves.toEqual(response);
    expect(fetchMock()).toHaveBeenLastCalledWith(
      "/api/management-jobs",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "staging_preview", input: { stagingDir: "staging-fixture" } }),
      },
    );
  });

  it("surfaces enqueue conflicts as ApiError with activeJob in details", async () => {
    stubJsonResponse(
      { error: "A staging_deploy management job is already queued.", activeJob: { id: "deploy-1", type: "staging_deploy", status: "queued" } },
      { ok: false, status: 409, statusText: "Conflict" },
    );

    const request = enqueueManagementJob({ type: "self_update" });
    await expect(request).rejects.toBeInstanceOf(ApiError);
    await expect(request).rejects.toMatchObject({
      status: 409,
      details: { activeJob: { id: "deploy-1", type: "staging_deploy", status: "queued" } },
    });
  });
});
