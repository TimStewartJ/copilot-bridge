import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createTestApp } from "../server/__tests__/test-app.js";
import { getBridgeToolDefinitions } from "../server/agent-tools-mcp/register.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const { withTestSourceCheckout } = await import("../server/__tests__/test-paths.js");
  return { ...actual, existsSync: withTestSourceCheckout(actual.existsSync) };
});

describe("native Home API and retained Bridge routes", () => {
  it("uses the existing task and checklist mutations with no dashboard domain", async () => {
    const { app, ctx, db } = createTestApp();
    const task = ctx.taskStore.createTask("Native work", undefined, "ongoing");
    ctx.taskStore.updateTask(task.id, { notes: "Preserved context", nextAction: "Read and decide", waitingOn: "An external reply" });
    const item = ctx.checklistStore.createChecklistItem(null, "Accepted global action", "2000-01-01", { key: "test-global" });
    const home = await request(app).get("/api/home");
    expect(home.status).toBe(200);
    expect(home.body.tasks.items[0]).toMatchObject({ id: task.id, nextAction: "Read and decide" });
    expect(home.body.actions.items[0].id).toBe(item.id);
    const changed = await request(app).patch(`/api/actions/${item.id}`).send({ done: true });
    expect(changed.status).toBe(200);
    expect(ctx.checklistStore.getChecklistItem(item.id)?.done).toBe(true);
    expect(ctx.taskStore.getTask(task.id)?.notes).toBe("Preserved context");
    for (const retired of ["/api/focus", "/api/focus/alerts", "/api/feed"]) expect((await request(app).get(retired)).status).toBe(410);
    expect((await request(app).get("/api/tasks")).status).toBe(200);
    expect((await request(app).get("/api/settings")).status).toBe(200);
    const retiredPolicy = await request(app).patch("/api/settings").send({ focusNotifications: { enableAuthorizedImmediate: true } });
    expect(retiredPolicy.status).toBe(400);
    expect(retiredPolicy.body.error).toContain("retired");
    const names = getBridgeToolDefinitions(ctx).map(tool => tool.name);
    for (const name of ["task_update_momentum", "action_add", "docs_write", "send_attachment", "schedule_create", "staging_preview"]) expect(names).toContain(name);
    expect(names.some(name => /^(focus_|decision_|alert_|event_|feed_)/.test(name))).toBe(false);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
    expect(tables).not.toContain("decisions");
    expect(tables).not.toContain("works");
  });
  it("fetches the exact native form only on demand and never revives an ended request", async () => {
    const { app, ctx } = createTestApp();
    const form = { requestId: "native-request", message: "Choose", mode: "form" as const, requestedSchema: {
      type: "object" as const, properties: { choice: { type: "string" as const, enum: ["A", "B"] } } } };
    const read = vi.spyOn(ctx.sessionManager, "hydratePendingInteractions").mockResolvedValue({ pendingUserInputs: [], pendingElicitations: [form] });
    const received = await request(app).get("/api/home/inputs/session/elicitation/native-request");
    expect(received.status).toBe(200);
    expect(received.body).toMatchObject({ kind: "elicitation", sessionId: "session", request: form });
    read.mockResolvedValue({ pendingUserInputs: [], pendingElicitations: [] });
    expect((await request(app).get("/api/home/inputs/session/elicitation/native-request")).status).toBe(404);
  });
});
