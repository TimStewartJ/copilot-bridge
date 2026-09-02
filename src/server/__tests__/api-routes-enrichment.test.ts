import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiRouteTestState, DeferredPromptRunner } from "./api-routes-test-helpers.js";
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
  RESTART_PENDING_MESSAGE,
  request,
  scheduler,
  writeCopilotUsageEvents,
  writeRawCopilotUsageEvents,
  writeFileSync,
  writeRestartState,
} from "./api-routes-test-helpers.js";

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

  it("rejects links outside the configured ADO organization or project", async () => {
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
  it("stays disabled when the ADO provider is not configured", async () => {
    const relationshipSpy = vi.spyOn(providers, "fetchAdoWorkItemPullRequestLinks");
    try {
      const res = await request(app).get("/api/dashboard/work-map");

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        enabled: false,
        assignedToMe: false,
        org: null,
        project: null,
        tasks: [],
        workItems: [],
        pullRequests: [],
        warnings: [],
      });
      expect(relationshipSpy).not.toHaveBeenCalled();
    } finally {
      relationshipSpy.mockRestore();
    }
  });

  it("joins ADO relationships with the Bridge tasks that own either endpoint", async () => {
    ctx.settingsStore.updateSettings({
      providers: { ado: { org: "msazure", project: "One" } },
    });
    const enrichWorkItemsSpy = vi.spyOn(providers, "enrichWorkItems").mockImplementation(async (refs) =>
      refs.map((ref) => ({
        id: ref.id,
        provider: "ado",
        title: `Work item ${ref.id}`,
        state: ref.id === "10" ? "Active" : "New",
        type: "Feature",
        assignedTo: "Tim Stewart",
        areaPath: "One\\Bridge",
        url: `https://example.test/workitems/${ref.id}`,
      })));
    const enrichPullRequestsSpy = vi.spyOn(providers, "enrichPullRequests").mockImplementation(async (refs) =>
      refs.map((ref) => ({
        ...ref,
        repoName: ref.repoName ?? "copilot-bridge",
        title: `PR ${ref.prId}`,
        status: "active",
        createdBy: "Tim Stewart",
        reviewerCount: 1,
        url: `https://example.test/pullrequests/${ref.prId}`,
      })));
    const relationshipSpy = vi.spyOn(providers, "fetchAdoWorkItemPullRequestLinks")
      .mockImplementation(async (ids) => ({
        links: [
          { workItemId: "10", repoId: "repo-guid", repoAliases: ["copilot-bridge"], prId: 20 },
          { workItemId: "11", repoId: "repo-guid", repoAliases: ["copilot-bridge"], prId: 20 },
          ...(ids.includes("13")
            ? [{ workItemId: "13", repoId: "repo-two", repoAliases: ["other-repo"], prId: 30 }]
            : []),
        ],
        warnings: [],
      }));
    const currentUserSpy = vi.spyOn(providers, "fetchAdoCurrentUser").mockResolvedValue({
      displayName: "Tim Stewart",
    });
    const assignedWorkItemsSpy = vi.spyOn(providers, "fetchAdoAssignedWorkItemIds").mockResolvedValue({
      ids: ["13"],
      warnings: [],
    });

    try {
      const workItemTask = ctx.taskStore.createTask("Track the feature");
      ctx.taskStore.linkWorkItem(workItemTask.id, "10", "ado");
      const pullRequestTask = ctx.taskStore.createTask("Review the implementation");
      ctx.taskStore.linkPR(pullRequestTask.id, {
        repoId: "copilot-bridge",
        repoName: "copilot-bridge",
        prId: 20,
        provider: "ado",
      });
      const archivedTask = ctx.taskStore.createTask("Historical implementation");
      ctx.taskStore.linkWorkItem(archivedTask.id, "12", "ado");
      ctx.taskStore.updateTask(archivedTask.id, { status: "archived" });

      const res = await request(app).get("/api/dashboard/work-map");

      expect(res.status).toBe(200);
      expect(relationshipSpy).toHaveBeenNthCalledWith(
        1,
        ["10"],
        [{ repoId: "copilot-bridge", repoName: "copilot-bridge", prId: 20, provider: "ado" }],
      );
      expect(res.body).toMatchObject({
        enabled: true,
        includeArchived: false,
        assignedToMe: false,
        currentUser: { displayName: "Tim Stewart" },
        org: "msazure",
        project: "One",
        warnings: [],
      });
      expect(res.body.tasks).toHaveLength(2);
      expect(res.body.tasks).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: workItemTask.id, title: "Track the feature" }),
        expect.objectContaining({ id: pullRequestTask.id, title: "Review the implementation" }),
      ]));
      expect(res.body.workItems).toEqual([
        expect.objectContaining({
          id: "10",
          taskIds: [workItemTask.id],
          pullRequestKeys: ["repo-guid:20"],
          assignedToCurrentUser: false,
        }),
        expect.objectContaining({
          id: "11",
          taskIds: [],
          pullRequestKeys: ["repo-guid:20"],
        }),
      ]);
      expect(res.body.pullRequests).toEqual([
        expect.objectContaining({
          key: "repo-guid:20",
          repoId: "repo-guid",
          repoName: "copilot-bridge",
          taskIds: [pullRequestTask.id],
          workItemIds: ["10", "11"],
        }),
      ]);

      const assignedRes = await request(app).get("/api/dashboard/work-map?assignedToMe=1");

      expect(assignedRes.status).toBe(200);
      expect(assignedWorkItemsSpy).toHaveBeenCalledTimes(1);
      expect(relationshipSpy).toHaveBeenNthCalledWith(
        2,
        ["13", "10"],
        [{ repoId: "copilot-bridge", repoName: "copilot-bridge", prId: 20, provider: "ado" }],
      );
      expect(assignedRes.body.assignedToMe).toBe(true);
      expect(assignedRes.body.workItems).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: "13",
          taskIds: [],
          pullRequestKeys: ["repo-two:30"],
          assignedToCurrentUser: true,
        }),
      ]));
      expect(assignedRes.body.pullRequests).toEqual(expect.arrayContaining([
        expect.objectContaining({
          key: "repo-two:30",
          repoId: "repo-two",
          prId: 30,
          title: null,
          status: null,
          taskIds: [],
          workItemIds: ["13"],
        }),
      ]));
      expect(enrichPullRequestsSpy).toHaveBeenNthCalledWith(
        2,
        [{ repoId: "repo-guid", repoName: "copilot-bridge", prId: 20, provider: "ado" }],
      );

      const archivedRes = await request(app).get("/api/dashboard/work-map?includeArchived=1");

      expect(archivedRes.status).toBe(200);
      expect(relationshipSpy).toHaveBeenNthCalledWith(
        3,
        ["10", "12"],
        [{ repoId: "copilot-bridge", repoName: "copilot-bridge", prId: 20, provider: "ado" }],
      );
      expect(archivedRes.body.includeArchived).toBe(true);
      expect(archivedRes.body.tasks).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: archivedTask.id, status: "archived" }),
      ]));
      expect(archivedRes.body.workItems).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "12", taskIds: [archivedTask.id] }),
      ]));
    } finally {
      enrichWorkItemsSpy.mockRestore();
      enrichPullRequestsSpy.mockRestore();
      relationshipSpy.mockRestore();
      currentUserSpy.mockRestore();
      assignedWorkItemsSpy.mockRestore();
    }
  });
});
