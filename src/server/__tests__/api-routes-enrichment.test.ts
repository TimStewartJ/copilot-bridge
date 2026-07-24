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
        id: "30000015",
        provider: "ado",
        title: "Review SDL bug",
        state: "Active",
        type: "Bug",
        assignedTo: "Tim Stewart",
        areaPath: "One\\Bridge",
        url: "https://exampleorg.visualstudio.com/One/_workitems/edit/30000015",
      },
    ]);
    const enrichPullRequestsSpy = vi.spyOn(providers, "enrichPullRequests").mockResolvedValue([
      {
        repoId: "a1a1a1a1-0000-4000-8000-000000000001",
        repoName: "example-repo",
        prId: 10000002,
        provider: "ado",
        title: "[Cherry-pick] Remove eastus2euap from Arc region dropdown",
        status: "completed",
        createdBy: "Tim Stewart",
        reviewerCount: 2,
        url: "https://exampleorg.visualstudio.com/One/_git/example-repo/pullrequest/10000002",
      },
    ]);

    try {
      const task = ctx.taskStore.createTask("Enriched payload");
      ctx.taskStore.linkWorkItem(task.id, "30000015", "ado");
      ctx.taskStore.linkPR(task.id, {
        repoId: "a1a1a1a1-0000-4000-8000-000000000001",
        repoName: "example-repo",
        prId: 10000002,
        provider: "ado",
      });

      const res = await request(app).get(`/api/tasks/${task.id}/enriched`);

      expect(res.status).toBe(200);
      expect(res.body.task.id).toBe(task.id);
      expect(res.body.workItems).toEqual([
        {
          id: "30000015",
          provider: "ado",
          title: "Review SDL bug",
          state: "Active",
          type: "Bug",
          assignedTo: "Tim Stewart",
          areaPath: "One\\Bridge",
          url: "https://exampleorg.visualstudio.com/One/_workitems/edit/30000015",
        },
      ]);
      expect(res.body.pullRequests).toEqual([
        {
          repoId: "a1a1a1a1-0000-4000-8000-000000000001",
          repoName: "example-repo",
          prId: 10000002,
          provider: "ado",
          title: "[Cherry-pick] Remove eastus2euap from Arc region dropdown",
          status: "completed",
          createdBy: "Tim Stewart",
          reviewerCount: 2,
          url: "https://exampleorg.visualstudio.com/One/_git/example-repo/pullrequest/10000002",
        },
      ]);
    } finally {
      enrichWorkItemsSpy.mockRestore();
      enrichPullRequestsSpy.mockRestore();
    }
  });
});
