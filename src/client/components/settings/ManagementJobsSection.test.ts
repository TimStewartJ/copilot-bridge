import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ManagementJobDetail,
  ManagementJobListResponse,
  ManagementJobSummary,
} from "../../management-job-api";
import {
  createReactDomHarness,
  findAllByTag,
  getReactProps,
  waitUntilAct,
  type ReactDomHarness,
} from "../../test-react-harness";
import { installDomShim } from "../../test-dom-shim";
import { ManagementJobsSection } from "./ManagementJobsSection";

const hookMocks = vi.hoisted(() => ({
  useManagementJobsQuery: vi.fn(),
  useManagementJobQuery: vi.fn(),
  useCancelManagementJobMutation: vi.fn(),
  useEnqueueManagementJobMutation: vi.fn(),
  useRetryManagementJobMutation: vi.fn(),
  useBridgeRuntimeStatusQuery: vi.fn(),
  useRestartBridgeMutation: vi.fn(),
  useEvictIdleCacheMutation: vi.fn(),
  useRestartStatusQuery: vi.fn(),
}));

vi.mock("../../hooks/queries/useManagementJobs", () => hookMocks);
vi.mock("../../hooks/queries/useBridgeRuntimeStatus", () => ({
  useBridgeRuntimeStatusQuery: hookMocks.useBridgeRuntimeStatusQuery,
  useRestartBridgeMutation: hookMocks.useRestartBridgeMutation,
  useEvictIdleCacheMutation: hookMocks.useEvictIdleCacheMutation,
}));
vi.mock("../../hooks/queries/useRestartStatus", () => ({
  useRestartStatusQuery: hookMocks.useRestartStatusQuery,
}));

const fetchedAt = "2026-05-20T12:10:00.000Z";
const runtimeCapacity = {
  contexts: { used: 11, retained: 14, limit: 32 },
  weightedUnits: { used: 17.5, retained: 22, limit: 64 },
  localMcpSlots: { used: 26, retained: 32 },
  cache: { readyParents: 10, protectedParents: 3, limit: 16 },
  cleanup: { pending: 1, failed: 0, limit: 32 },
  waitingRequests: 2,
  localMcpWeight: 0.25,
  waitTimeoutSeconds: 30,
};
const baseJob = {
  type: "staging_preview",
  createdAt: "2026-05-20T12:00:00.000Z",
  updatedAt: "2026-05-20T12:05:00.000Z",
  stale: false,
} as const;

function createJob(overrides: Partial<ManagementJobSummary>): ManagementJobSummary {
  return {
    ...baseJob,
    id: "job-1",
    status: "queued",
    ...overrides,
  };
}

function createDetail(job: ManagementJobSummary, overrides: Partial<ManagementJobDetail> = {}): ManagementJobDetail {
  return {
    ...job,
    input: { stagingDir: "/repo/staging", token: "secret-token" },
    result: { previewUrl: "/staging/demo/" },
    logTail: "recent log line",
    ...overrides,
  };
}

function createList(jobs: ManagementJobSummary[]): ManagementJobListResponse {
  return {
    jobs,
    activeCount: jobs.filter((job) => job.status === "queued" || job.status === "running").length,
    runningCount: jobs.filter((job) => job.status === "running").length,
    queuedCount: jobs.filter((job) => job.status === "queued").length,
    staleCount: jobs.filter((job) => job.stale).length,
    staleAfterMs: 300_000,
    fetchedAt,
  };
}

function findButtonByText(root: any, text: string): any {
  const button = findAllByTag(root, "BUTTON").find((candidate) => candidate.textContent?.trim() === text);
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

async function clickButton(harness: ReactDomHarness, text: string) {
  const button = findButtonByText(harness.dom.container, text);
  await harness.act(async () => {
    await getReactProps(button)?.onClick?.({ stopPropagation() {} });
  });
}

function mockManagementJobs(jobs: ManagementJobSummary[]) {
  const list = createList(jobs);
  const details = new Map(jobs.map((job) => [job.id, createDetail(job)]));
  const listRefetch = vi.fn(async () => list);
  const detailRefetch = vi.fn(async () => undefined);
  const cancelMutateAsync = vi.fn(async (id: string) => details.get(id));
  const enqueueMutateAsync = vi.fn(async () => ({
    jobId: "self-update-job",
    status: "queued",
    enqueuedAt: fetchedAt,
    reused: false,
    job: createDetail(createJob({ id: "self-update-job", type: "self_update", status: "queued" })),
  }));
  const retryMutateAsync = vi.fn(async () => ({
    job: createDetail(createJob({ id: "retry-job", status: "queued" })),
    retriedFrom: "job-1",
    reused: false,
  }));
  const restartMutateAsync = vi.fn(async () => ({ ok: true, waitingSessions: 2 }));
  const evictIdleCacheMutateAsync = vi.fn(async () => ({
    ok: true,
    evictedSessions: 7,
    protectedSessions: 3,
  }));
  const runtimeRefetch = vi.fn(async () => undefined);
  const restartStatusRefetch = vi.fn(async () => undefined);

  hookMocks.useManagementJobsQuery.mockImplementation(() => ({
    data: list,
    isLoading: false,
    isFetching: false,
    error: null,
    refetch: listRefetch,
  }));
  hookMocks.useManagementJobQuery.mockImplementation((id: string | undefined) => ({
    data: id ? details.get(id) : undefined,
    isLoading: false,
    isFetching: false,
    error: null,
    refetch: detailRefetch,
  }));
  hookMocks.useCancelManagementJobMutation.mockImplementation(() => ({
    isPending: false,
    mutateAsync: cancelMutateAsync,
  }));
  hookMocks.useEnqueueManagementJobMutation.mockImplementation(() => ({
    isPending: false,
    mutateAsync: enqueueMutateAsync,
  }));
  hookMocks.useRetryManagementJobMutation.mockImplementation(() => ({
    isPending: false,
    mutateAsync: retryMutateAsync,
  }));
  hookMocks.useBridgeRuntimeStatusQuery.mockImplementation(() => ({
    data: {
      fetchedAt,
      serverInstanceId: "server-1",
      pid: 4242,
      uptimeSeconds: 3_661,
      isStaging: false,
      sourceManagementAvailable: true,
      sessions: { active: 3, stalled: 1, waitingForUserInput: 2 },
      agents: {
        running: 2,
        idle: 1,
        failed: 1,
        total: 5,
        liveSessions: 3,
        staleSessions: 1,
        unknownSessions: 0,
      },
      capacity: runtimeCapacity,
    },
    isLoading: false,
    isFetching: false,
    error: null,
    refetch: runtimeRefetch,
  }));
  hookMocks.useRestartBridgeMutation.mockImplementation(() => ({
    isPending: false,
    mutateAsync: restartMutateAsync,
  }));
  hookMocks.useEvictIdleCacheMutation.mockImplementation(() => ({
    isPending: false,
    mutateAsync: evictIdleCacheMutateAsync,
  }));
  hookMocks.useRestartStatusQuery.mockImplementation(() => ({
    data: {
      pending: false,
      phase: "idle",
      waitingSessions: 0,
      requestedAt: null,
      serverInstanceId: "server-1",
      canAcceptNewWork: true,
    },
    isFetching: false,
    error: null,
    refetch: restartStatusRefetch,
  }));

  return {
    cancelMutateAsync,
    enqueueMutateAsync,
    retryMutateAsync,
    restartMutateAsync,
    evictIdleCacheMutateAsync,
  };
}

function installSelectAwareDomShim() {
  const dom = installDomShim();
  const documentRef = globalThis.document as typeof globalThis.document & { createElement: (tag: string) => any };
  const originalCreateElement = documentRef.createElement.bind(documentRef);
  documentRef.createElement = (tag: string) => {
    const element = originalCreateElement(tag);
    const normalizedTag = tag.toUpperCase();
    if (normalizedTag === "SELECT") {
      Object.defineProperty(element, "options", {
        configurable: true,
        get: () => Array.from(element.childNodes ?? []).filter((child: any) => child.tagName === "OPTION"),
      });
    }
    if (normalizedTag === "OPTION") {
      Object.defineProperty(element, "value", {
        configurable: true,
        get: () => element.getAttribute("value") ?? element.textContent ?? "",
        set: (value) => element.setAttribute("value", String(value)),
      });
      Object.defineProperty(element, "selected", { configurable: true, writable: true, value: false });
    }
    return element;
  };

  return {
    container: dom.container,
    cleanup() {
      documentRef.createElement = originalCreateElement;
      dom.cleanup();
    },
  };
}

async function renderSection() {
  const harness = await createReactDomHarness({ installDom: installSelectAwareDomShim });
  await harness.render(createElement(ManagementJobsSection));
  return harness;
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date(fetchedAt) });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("ManagementJobsSection", () => {
  it("renders inferred runner summary, stale warnings, disabled running cancel, and collapsed JSON", async () => {
    const running = createJob({
      id: "running-job-123456",
      status: "running",
      startedAt: "2026-05-20T12:01:00.000Z",
      heartbeatAt: "2026-05-20T12:00:00.000Z",
      heartbeatAgeMs: 600_000,
      runnerPid: 4242,
      stale: true,
    });
    const failed = createJob({ id: "failed-job", status: "failed", completedAt: "2026-05-20T12:08:00.000Z", error: "preview failed" });
    mockManagementJobs([running, failed]);

    const harness = await renderSection();
    try {
      await waitUntilAct(harness.act, () => (harness.dom.container.textContent ?? "").includes("recent log line"));
      const text = harness.dom.container.textContent ?? "";

      expect(text).toContain("Runner summary");
      expect(text).toContain("Runner health is inferred");
      expect(text).toContain("Stale");
      expect(text).toContain("Cancel unavailable");
      expect(text).toContain("Sanitized recent log tail");
      const details = findAllByTag(harness.dom.container, "DETAILS");
      expect(details.length).toBeGreaterThan(0);
      expect(details.every((node) => !getReactProps(node)?.open)).toBe(true);
    } finally {
      await harness.cleanup();
    }
  });

  it("cancels queued update jobs only after confirmation", async () => {
    const queued = createJob({ id: "queued-update", type: "self_update", status: "queued" });
    const { cancelMutateAsync } = mockManagementJobs([queued]);
    const confirm = vi.fn(() => true);
    const harness = await renderSection();
    try {
      (globalThis.window as unknown as { confirm: typeof confirm }).confirm = confirm;
      await clickButton(harness, "Cancel");

      expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Cancel queued Self update job"));
      expect(cancelMutateAsync).toHaveBeenCalledWith("queued-update");
      await waitUntilAct(harness.act, () => (harness.dom.container.textContent ?? "").includes("cancelled"));
    } finally {
      await harness.cleanup();
    }
  });

  it("retries failed jobs and reports the new queued job id", async () => {
    const failed = createJob({ id: "failed-preview", status: "failed", error: "preview failed" });
    const { retryMutateAsync } = mockManagementJobs([failed]);

    const harness = await renderSection();
    try {
      await clickButton(harness, "Retry");

      expect(retryMutateAsync).toHaveBeenCalledWith("failed-preview");
      await waitUntilAct(harness.act, () => (harness.dom.container.textContent ?? "").includes("Retry queued as retry-job"));
    } finally {
      await harness.cleanup();
    }
  });

  it("shows live activity and queues self-update and restart controls with confirmation", async () => {
    const {
      enqueueMutateAsync,
      restartMutateAsync,
      evictIdleCacheMutateAsync,
    } = mockManagementJobs([]);
    const confirm = vi.fn(() => true);
    const harness = await renderSection();
    try {
      (globalThis.window as unknown as { confirm: typeof confirm }).confirm = confirm;
      const text = harness.dom.container.textContent ?? "";
      expect(text).toContain("Current activity");
      expect(text).toContain("Active sessions");
      expect(text).toContain("Agents running");
      expect(text).toContain("1 stale snapshot excluded");
      expect(text).toContain("Copilot capacity");
      expect(text).toContain("Live contexts");
      expect(text).toContain("11 / 32");
      expect(text).toContain("17.5 / 64");
      expect(text).toContain("26");
      expect(text).toContain("2");
      expect(text).toContain("Parent cache 10/16, 3 protected");
      expect(text).toContain("Local MCP weight +0.25 per context");
      expect(text).toContain("2 requests are waiting for live capacity");
      expect(text).toContain("7 idle cached sessions can be evicted now.");

      await clickButton(harness, "Evict idle cache");
      expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Evict 7 idle cached sessions?"));
      expect(evictIdleCacheMutateAsync).toHaveBeenCalledOnce();
      await waitUntilAct(harness.act, () =>
        (harness.dom.container.textContent ?? "").includes("Evicted 7 idle cached sessions. 3 protected sessions were kept warm."),
      );

      await clickButton(harness, "Queue self-update");
      expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Queue a Bridge self-update job?"));
      expect(enqueueMutateAsync).toHaveBeenCalledWith({ type: "self_update" });
      await waitUntilAct(harness.act, () =>
        (harness.dom.container.textContent ?? "").includes("Self-update queued as self-updat"),
      );

      await clickButton(harness, "Restart Bridge");
      expect(confirm).toHaveBeenLastCalledWith(expect.stringContaining("3 active sessions, 1 stalled, 2 awaiting input"));
      expect(restartMutateAsync).toHaveBeenCalledOnce();
      await waitUntilAct(harness.act, () =>
        (harness.dom.container.textContent ?? "").includes("Restart queued. Waiting for 2 active sessions."),
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("disables restart-capable controls in staging previews", async () => {
    mockManagementJobs([]);
    hookMocks.useBridgeRuntimeStatusQuery.mockImplementation(() => ({
      data: {
        fetchedAt,
        serverInstanceId: "staging-server",
        pid: 5000,
        uptimeSeconds: 60,
        isStaging: true,
        sourceManagementAvailable: false,
        sessions: { active: 0, stalled: 0, waitingForUserInput: 0 },
        agents: {
          running: 0,
          idle: 0,
          failed: 0,
          total: 0,
          liveSessions: 0,
          staleSessions: 0,
          unknownSessions: 0,
        },
        capacity: {
          ...runtimeCapacity,
          contexts: { used: 0, retained: 0, limit: 32 },
          weightedUnits: { used: 0, retained: 0, limit: 64 },
          localMcpSlots: { used: 0, retained: 0 },
          cache: { readyParents: 0, protectedParents: 0, limit: 16 },
          cleanup: { pending: 0, failed: 0, limit: 32 },
          waitingRequests: 0,
        },
      },
      isLoading: false,
      isFetching: false,
      error: null,
      refetch: vi.fn(),
    }));

    const harness = await renderSection();
    try {
      const updateButton = findButtonByText(harness.dom.container, "Queue self-update");
      const restartButton = findButtonByText(harness.dom.container, "Restart Bridge");
      const evictIdleCacheButton = findButtonByText(harness.dom.container, "Evict idle cache");
      expect(getReactProps(updateButton)?.disabled).toBe(true);
      expect(getReactProps(restartButton)?.disabled).toBe(true);
      expect(getReactProps(evictIdleCacheButton)?.disabled).toBe(true);
      expect(harness.dom.container.textContent ?? "").toContain("Unavailable from staging previews.");
      expect(harness.dom.container.textContent ?? "").toContain("No idle cached sessions to evict.");
    } finally {
      await harness.cleanup();
    }
  });
});
