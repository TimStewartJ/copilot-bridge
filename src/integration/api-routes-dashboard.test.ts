import { describe, expect, it } from "vitest";
import type { ApiRouteTestState } from "../test-support/api-routes.js";
import {
  createTestApp,
  installApiRouteTestHooks,
  request,
} from "../test-support/api-routes.js";

let app: ApiRouteTestState["app"];
let ctx: ApiRouteTestState["ctx"];

installApiRouteTestHooks((state) => {
  ({ app, ctx } = state);
});

describe("Dashboard routes", () => {
  it("GET /api/dashboard/focus returns open and completed actions", async () => {
    const task = ctx.taskStore.createTask("Dashboard task");
    const open = ctx.checklistStore.createChecklistItem(task.id, "Open item");
    const done = ctx.checklistStore.createChecklistItem(task.id, "Done item");
    ctx.checklistStore.updateChecklistItem(done.id, { done: true });

    const res = await request(app).get("/api/dashboard/focus");

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

  it("keeps the legacy checklist endpoint compatible with Focus", async () => {
    const task = ctx.taskStore.createTask("Legacy dashboard task");
    const open = ctx.checklistStore.createChecklistItem(task.id, "Legacy open item");

    const res = await request(app).get("/api/dashboard/checklist");

    expect(res.status).toBe(200);
    expect(res.body.openChecklistItems.map((item: any) => item.id)).toContain(open.id);
  });

  it("GET /api/dashboard/focus fails clearly when the checklist store is missing", async () => {
    const { app: brokenApp } = createTestApp({ checklistStore: undefined });

    const res = await request(brokenApp).get("/api/dashboard/focus");

    expect(res.status).toBe(500);
  });
});
