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
  useRetryManagementJobMutation: vi.fn(),
}));

vi.mock("../../hooks/queries/useManagementJobs", () => hookMocks);

const fetchedAt = "2026-05-20T12:10:00.000Z";
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
  const retryMutateAsync = vi.fn(async () => ({
    job: createDetail(createJob({ id: "retry-job", status: "queued" })),
    retriedFrom: "job-1",
  }));

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
  hookMocks.useRetryManagementJobMutation.mockImplementation(() => ({
    isPending: false,
    mutateAsync: retryMutateAsync,
  }));

  return { cancelMutateAsync, retryMutateAsync };
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
});
