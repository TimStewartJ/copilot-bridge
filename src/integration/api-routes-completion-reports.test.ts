import { describe, expect, it } from "vitest";
import { createTestApp, request } from "../test-support/api-routes.js";

const sessionId = "22222222-2222-4222-8222-222222222222";

describe("completion report routes", () => {
  it("lists a chat's and a task's reports newest first", async () => {
    const { app, ctx } = createTestApp();
    const task = ctx.taskStore.createTask("Report host");
    const store = ctx.completionReportStore!;
    const report = (summary: string, createdAt: string) => store.add({
      sessionId, taskId: task.id, status: "verified", summary, createdAt,
      evidence: [{ kind: "tested", claim: "unit tests pass", result: "pass" }], unverified: [],
    });
    report("first", "2026-01-01T00:00:00.000Z");
    report("second", "2026-01-02T00:00:00.000Z");

    const bySession = await request(app).get(`/api/sessions/${sessionId}/completion-reports`).expect(200);
    expect(bySession.body.reports.map((entry: { summary: string }) => entry.summary)).toEqual(["second", "first"]);
    expect(bySession.body.reports[0].evidence).toEqual([{ kind: "tested", claim: "unit tests pass", result: "pass" }]);

    const byTask = await request(app).get(`/api/tasks/${task.id}/completion-reports`).expect(200);
    expect(byTask.body.reports).toHaveLength(2);
    expect((await request(app).get("/api/sessions/not-a-uuid/completion-reports")).status).toBe(400);
    expect((await request(app).get("/api/tasks/missing/completion-reports")).status).toBe(404);
  });
});
