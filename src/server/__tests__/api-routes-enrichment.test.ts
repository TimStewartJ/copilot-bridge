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
  UserInputBrokerError,
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
