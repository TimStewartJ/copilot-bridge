import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PRRef } from "../server/task-store.js";
import type { WorkMapSource } from "../server/work-map.js";
import type { ApiRouteTestState, DeferredPromptRunner } from "../test-support/api-routes.js";
import {
  createCopilotUsageTestHome,
  createMockSessionManager,
  createMockTranscriptionService,
  createRestartRuntimePaths,
  createTestApp,
  createWavBuffer,
  eventually,
  get,
  installApiRouteTestHooks,
  join,
  makeTestDir,
  mkdirSync,
  providers,
  publishOutboundAttachment,
  request,
  scheduler,
  writeCopilotUsageEvents,
  writeRawCopilotUsageEvents,
  writeFileSync,
  writeRestartState,
} from "../test-support/api-routes.js";

let app: ApiRouteTestState["app"];
let ctx: ApiRouteTestState["ctx"];
let db: ApiRouteTestState["db"];

installApiRouteTestHooks((state) => {
  ({ app, ctx, db } = state);
});

describe("Task enrichment routes", () => {
  it("GET /api/tasks/:id/enriched returns task with empty enrichment", async () => {
    const task = (await request(app).post("/api/tasks").send({ title: "Enriched" })).body.task;

    const res = await request(app).get(`/api/tasks/${task.id}/enriched`);
    expect(res.status).toBe(200);
    expect(res.body.task.title).toBe("Enriched");
    expect(res.body.workItems).toEqual([]);
    expect(res.body.pullRequests).toEqual([]);
  });

  it("GET /api/tasks/:id/enriched returns 404 for missing task", async () => {
    const res = await request(app).get("/api/tasks/nonexistent/enriched");
    expect(res.status).toBe(404);
  });

  it("GET /api/tasks/:id/enriched returns populated provider metadata", async () => {
    const enrichWorkItemsSpy = vi.spyOn(providers, "enrichWorkItems").mockResolvedValue([
      {
        id: "37655015",
        provider: "ado",
        title: "Review SDL bug",
        state: "Active",
        type: "Bug",
        assignedTo: "Tim Stewart",
        areaPath: "One\\Bridge",
        url: "https://msazure.visualstudio.com/One/_workitems/edit/37655015",
      },
    ]);
    const enrichPullRequestsSpy = vi.spyOn(providers, "enrichPullRequests").mockResolvedValue([
      {
        repoId: "503e1343-325a-43f5-a33b-04405569f3d5",
        repoName: "AzureStack-ZTP-OOBE",
        prId: 15411444,
        provider: "ado",
        title: "[Cherry-pick] Remove eastus2euap from Arc region dropdown",
        status: "completed",
        createdBy: "Tim Stewart",
        reviewerCount: 2,
        url: "https://msazure.visualstudio.com/One/_git/AzureStack-ZTP-OOBE/pullrequest/15411444",
      },
    ]);

    try {
      const task = ctx.taskStore.createTask("Enriched payload");
      ctx.taskStore.linkWorkItem(task.id, "37655015", "ado");
      ctx.taskStore.linkPR(task.id, {
        repoId: "503e1343-325a-43f5-a33b-04405569f3d5",
        repoName: "AzureStack-ZTP-OOBE",
        prId: 15411444,
        provider: "ado",
      });

      const res = await request(app).get(`/api/tasks/${task.id}/enriched`);

      expect(res.status).toBe(200);
      expect(res.body.task.id).toBe(task.id);
      expect(res.body.workItems).toEqual([
        {
          id: "37655015",
          provider: "ado",
          title: "Review SDL bug",
          state: "Active",
          type: "Bug",
          assignedTo: "Tim Stewart",
          areaPath: "One\\Bridge",
          url: "https://msazure.visualstudio.com/One/_workitems/edit/37655015",
        },
      ]);
      expect(res.body.pullRequests).toEqual([
        {
          repoId: "503e1343-325a-43f5-a33b-04405569f3d5",
          repoName: "AzureStack-ZTP-OOBE",
          prId: 15411444,
          provider: "ado",
          title: "[Cherry-pick] Remove eastus2euap from Arc region dropdown",
          status: "completed",
          createdBy: "Tim Stewart",
          reviewerCount: 2,
          url: "https://msazure.visualstudio.com/One/_git/AzureStack-ZTP-OOBE/pullrequest/15411444",
        },
      ]);
    } finally {
      enrichWorkItemsSpy.mockRestore();
      enrichPullRequestsSpy.mockRestore();
    }
  });
});

describe("Work-reference preview route", () => {
  it("previews a configured ADO work-item link", async () => {
    ctx.settingsStore.updateSettings({
      providers: { ado: { org: "msazure", project: "One" } },
    });
    const workItem = {
      id: "37655015",
      provider: "ado" as const,
      title: "Review SDL bug",
      state: "Active",
      type: "Bug",
      assignedTo: "Tim Stewart",
      areaPath: "One\\Bridge",
      url: "https://msazure.visualstudio.com/One/_workitems/edit/37655015",
    };
    const enrichSpy = vi.spyOn(providers, "enrichWorkItems").mockResolvedValue([workItem]);

    try {
      const res = await request(app)
        .post("/api/work-references/preview")
        .send({ url: workItem.url });

      expect(res.status).toBe(200);
      expect(enrichSpy).toHaveBeenCalledWith([{ id: "37655015", provider: "ado" }]);
      expect(res.body).toEqual({ kind: "workItem", workItem });
    } finally {
      enrichSpy.mockRestore();
    }
  });

  it("previews a configured ADO pull-request link", async () => {
    ctx.settingsStore.updateSettings({
      providers: { ado: { org: "msazure", project: "One" } },
    });
    const pullRequest = {
      repoId: "repo-guid",
      repoName: "AzureStack-ZTP-OOBE",
      prId: 15411444,
      provider: "ado" as const,
      title: "Fix region dropdown",
      status: "active" as const,
      createdBy: "Tim Stewart",
      reviewerCount: 2,
      url: "https://msazure.visualstudio.com/One/_git/AzureStack-ZTP-OOBE/pullrequest/15411444",
    };
    const enrichSpy = vi.spyOn(providers, "enrichPullRequests").mockResolvedValue([pullRequest]);

    try {
      const res = await request(app)
        .post("/api/work-references/preview")
        .send({ url: pullRequest.url });

      expect(res.status).toBe(200);
      expect(enrichSpy).toHaveBeenCalledWith([{
        repoId: "AzureStack-ZTP-OOBE",
        repoName: "AzureStack-ZTP-OOBE",
        prId: 15411444,
        provider: "ado",
      }]);
      expect(res.body).toEqual({ kind: "pullRequest", pullRequest });
    } finally {
      enrichSpy.mockRestore();
    }
  });

  it("previews pull-request links from other projects in the configured organization", async () => {
    ctx.settingsStore.updateSettings({
      providers: { ado: { org: "msazure", project: "One" } },
    });
    const pullRequest = {
      repoId: "SFFLinux-OS-Composition",
      repoName: "SFFLinux-OS-Composition",
      prId: 17135261,
      provider: "ado" as const,
      title: "[SFF][Security] Restrict edgeuser OpenSSL privileges",
      status: "active" as const,
      createdBy: "Vibha Negi",
      reviewerCount: 3,
      url: "https://msazure.visualstudio.com/msk8s/_git/SFFLinux-OS-Composition/pullrequest/17135261",
    };
    const enrichSpy = vi.spyOn(providers, "enrichPullRequests").mockResolvedValue([pullRequest]);

    try {
      const res = await request(app)
        .post("/api/work-references/preview")
        .send({ url: "https://dev.azure.com/msazure/msk8s/_git/SFFLinux-OS-Composition/pullrequest/17135261" });

      expect(res.status).toBe(200);
      expect(enrichSpy).toHaveBeenCalledWith([{
        repoId: "SFFLinux-OS-Composition",
        repoName: "SFFLinux-OS-Composition",
        prId: 17135261,
        provider: "ado",
      }]);
      expect(res.body).toEqual({ kind: "pullRequest", pullRequest });
    } finally {
      enrichSpy.mockRestore();
    }
  });

  it("rejects links outside the configured ADO organization", async () => {
    ctx.settingsStore.updateSettings({
      providers: { ado: { org: "msazure", project: "One" } },
    });
    const enrichSpy = vi.spyOn(providers, "enrichWorkItems");

    try {
      const res = await request(app)
        .post("/api/work-references/preview")
        .send({ url: "https://other.visualstudio.com/Project/_workitems/edit/42" });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("does not match");
      expect(enrichSpy).not.toHaveBeenCalled();
    } finally {
      enrichSpy.mockRestore();
    }
  });
});

describe("Dashboard work map route", () => {
  const spies: Array<{ mockRestore: () => void }> = [];
  // The provider registry outlives a test's app, so an earlier test's ADO settings would still answer.
  beforeEach(() => providers.clearProviderCache());
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  /** An Azure DevOps where everything asked about exists and nothing links anything. */
  function fakeAdo(options: { assigned?: string[]; hold?: Promise<void> } = {}) {
    return {
      org: "msazure",
      project: "One",
      fetchCurrentUser: vi.fn(async () => {
        await options.hold;
        return { displayName: "Tim Stewart" };
      }),
      fetchAssignedWorkItemIds: vi.fn(async () => ({ ids: options.assigned ?? [], warnings: [] })),
      fetchWorkItemLinks: vi.fn(async () => ({ pullRequests: [], relations: [], warnings: [] })),
      fetchPullRequestWorkItems: vi.fn(async () => ({ links: [], warnings: [] })),
      fetchWorkItems: vi.fn(async (ids: string[]) => ids.map((id) => ({
        id,
        provider: "ado" as const,
        title: `Work item ${id}`,
        state: "Active",
        type: "Task",
        assignedTo: null,
        areaPath: null,
        url: `https://example.test/workitems/${id}`,
      }))),
      fetchPullRequests: vi.fn(async (prs: PRRef[]) => prs.map((pr) => ({
        repoId: pr.repoId,
        repoName: pr.repoName ?? null,
        prId: pr.prId,
        provider: "ado" as const,
        title: `PR ${pr.prId}`,
        status: "active" as const,
        createdBy: null,
        reviewerCount: 0,
        url: `https://example.test/pullrequests/${pr.prId}`,
      }))),
    } satisfies WorkMapSource;
  }

  /** Makes the route read `ado`. The returned function waits until that many map requests have reached the route. */
  function useAdo(ado: WorkMapSource) {
    const waiting = new Map<number, () => void>();
    let arrived = 0;
    spies.push(vi.spyOn(providers, "getAdoProvider").mockImplementation(() => {
      arrived += 1;
      waiting.get(arrived)?.();
      return ado as ReturnType<typeof providers.getAdoProvider>;
    }));
    return (count: number) => new Promise<void>((resolve) => {
      if (arrived >= count) resolve();
      else waiting.set(count, resolve);
    });
  }

  function held() {
    let release: () => void = () => {};
    const hold = new Promise<void>((resolve) => { release = resolve; });
    return { hold, release };
  }

  it("stays disabled when Azure DevOps is not configured", async () => {
    const task = ctx.taskStore.createTask("Track the feature");
    ctx.taskStore.linkWorkItem(task.id, "10", "ado");

    const res = await request(app).get("/api/dashboard/work-map?assignedToMe=1");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      enabled: false,
      currentUser: null,
      org: null,
      project: null,
      tasks: [],
      workItems: [],
      contextWorkItems: [],
      pullRequests: [],
      warnings: [],
    });
    expect((await request(app).get("/api/dashboard/work-map/progress")).body).toEqual({ progress: null });
  });

  it("builds the map from the tasks that link ADO work, for the filters asked for", async () => {
    const ado = fakeAdo({ assigned: ["13"] });
    useAdo(ado);
    const active = ctx.taskStore.createTask("Track the feature");
    ctx.taskStore.linkWorkItem(active.id, "10", "ado");
    ctx.taskStore.linkPR(active.id, { repoId: "repo-guid", repoName: "copilot-bridge", prId: 20, provider: "ado" });
    const archived = ctx.taskStore.createTask("Historical implementation");
    ctx.taskStore.linkWorkItem(archived.id, "12", "ado");
    ctx.taskStore.updateTask(archived.id, { status: "archived" });
    ctx.taskStore.createTask("Links nothing");

    const res = await request(app).get("/api/dashboard/work-map");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      enabled: true,
      currentUser: { displayName: "Tim Stewart" },
      org: "msazure",
      project: "One",
      tasks: [expect.objectContaining({ id: active.id, title: "Track the feature", status: "active" })],
      workItems: [expect.objectContaining({
        id: "10",
        title: "Work item 10",
        taskIds: [active.id],
        pullRequestKeys: [],
        assignedToCurrentUser: false,
        relations: [],
      })],
      contextWorkItems: [],
      pullRequests: [expect.objectContaining({ key: "repo-guid:20", title: "PR 20", taskIds: [active.id], workItemIds: [] })],
      warnings: [],
    });
    expect(ado.fetchAssignedWorkItemIds).not.toHaveBeenCalled();

    const assigned = await request(app).get("/api/dashboard/work-map?assignedToMe=1");

    expect(assigned.body.workItems.map((item: { id: string; assignedToCurrentUser: boolean }) => [item.id, item.assignedToCurrentUser]))
      .toEqual([["13", true], ["10", false]]);
    expect(ado.fetchAssignedWorkItemIds).toHaveBeenCalledTimes(1);

    const withArchived = await request(app).get("/api/dashboard/work-map?includeArchived=true");

    expect(withArchived.body.tasks.map((task: { id: string }) => task.id).sort()).toEqual([active.id, archived.id].sort());
    expect(withArchived.body.workItems.map((item: { id: string }) => item.id).sort()).toEqual(["10", "12"]);
  });

  it("shares one build between requests that arrive together and reports how far it is", async () => {
    const { hold, release } = held();
    const ado = fakeAdo({ hold });
    const arrivals = useAdo(ado);
    const task = ctx.taskStore.createTask("Track the feature");
    ctx.taskStore.linkWorkItem(task.id, "10", "ado");

    const first = request(app).get("/api/dashboard/work-map").then((res) => res);
    const second = request(app).get("/api/dashboard/work-map").then((res) => res);
    await arrivals(2);

    expect((await request(app).get("/api/dashboard/work-map/progress")).body).toEqual({
      progress: { label: "Connecting to Azure DevOps", step: 1, steps: 4, done: 0, total: 0 },
    });
    // Nothing is being built for the other filter combinations.
    expect((await request(app).get("/api/dashboard/work-map/progress?includeArchived=1")).body).toEqual({ progress: null });

    release();
    const [firstRes, secondRes] = await Promise.all([first, second]);

    expect(firstRes.status).toBe(200);
    expect(secondRes.body).toEqual(firstRes.body);
    expect(ado.fetchCurrentUser).toHaveBeenCalledTimes(1);
    expect((await request(app).get("/api/dashboard/work-map/progress")).body).toEqual({ progress: null });
  });

  it("reads Azure DevOps again for a refresh, without joining a build that is already running", async () => {
    const { hold, release } = held();
    const ado = fakeAdo({ hold });
    const arrivals = useAdo(ado);
    const expire = vi.spyOn(providers, "expireAdoProviderData").mockImplementation(() => {});
    spies.push(expire);

    const running = request(app).get("/api/dashboard/work-map").then((res) => res);
    await arrivals(1);
    expect(expire).not.toHaveBeenCalled();

    const refreshed = request(app).get("/api/dashboard/work-map?refresh=1").then((res) => res);
    await arrivals(2);
    release();
    const results = await Promise.all([running, refreshed]);

    expect(results.map((res) => res.status)).toEqual([200, 200]);
    expect(expire).toHaveBeenCalledTimes(1);
    // The refresh did not take the answer of the build that started before it.
    expect(ado.fetchCurrentUser).toHaveBeenCalledTimes(2);
  });

  it("answers 500 with the reason when the build fails", async () => {
    const ado = fakeAdo();
    ado.fetchCurrentUser.mockRejectedValueOnce(new Error("ADO is unreachable"));
    useAdo(ado);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    spies.push(consoleError);

    const failed = await request(app).get("/api/dashboard/work-map");

    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({ error: "ADO is unreachable" });
    // The failed build is not kept: the next request builds again.
    expect((await request(app).get("/api/dashboard/work-map")).status).toBe(200);
  });
});
