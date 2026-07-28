import { describe, expect, it } from "vitest";
import type { ApiRouteTestState } from "./api-routes-test-helpers.js";
import {
  createTestApp,
  installApiRouteTestHooks,
  request,
} from "./api-routes-test-helpers.js";

let app: ApiRouteTestState["app"];
let ctx: ApiRouteTestState["ctx"];

installApiRouteTestHooks((state) => {
  ({ app, ctx } = state);
});

describe("Dashboard routes", () => {
  it("no longer serves the orphaned /api/dashboard aggregate endpoint", async () => {
    const res = await request(app).get("/api/dashboard");
    expect(res.status).toBe(404);
  });

  it("GET /api/dashboard/checklist returns open and completed checklist items", async () => {
    const task = ctx.taskStore.createTask("Dashboard task");
    const open = ctx.checklistStore.createChecklistItem(task.id, "Open item");
    const done = ctx.checklistStore.createChecklistItem(task.id, "Done item");
    ctx.checklistStore.updateChecklistItem(done.id, { done: true });

    const res = await request(app).get("/api/dashboard/checklist");

    expect(res.status).toBe(200);
    expect(res.body.openChecklistItems.map((item: any) => item.id)).toContain(open.id);
    expect(res.body.completedChecklistItems.map((item: any) => item.id)).toContain(done.id);
    expect(res.body.openChecklistItems[0]).toMatchObject({
      taskId: task.id,
      taskTitle: "Dashboard task",
    });
    // The aggregate-only payload is gone.
    expect(res.body).not.toHaveProperty("schedules");
    expect(res.body).not.toHaveProperty("taskMomentum");
    expect(res.body).not.toHaveProperty("orphanSessions");
  });

  it("GET /api/dashboard/checklist fails clearly when the checklist store is missing", async () => {
    const { app: brokenApp } = createTestApp({ checklistStore: undefined });

    const res = await request(brokenApp).get("/api/dashboard/checklist");

    expect(res.status).toBe(500);
  });
});
