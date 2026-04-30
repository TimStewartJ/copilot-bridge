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

describe("Task routes", () => {
  it("GET /api/tasks returns empty list initially", async () => {
    const res = await request(app).get("/api/tasks");
    expect(res.status).toBe(200);
    expect(res.body.tasks).toEqual([]);
  });

  it("POST /api/tasks creates a task", async () => {
    const res = await request(app)
      .post("/api/tasks")
      .send({ title: "Test Task" });
    expect(res.status).toBe(200);
    expect(res.body.task.title).toBe("Test Task");
    expect(res.body.task.id).toBeTruthy();
    expect(res.body.task.kind).toBe("task");
    expect(res.body.task.status).toBe("active");
  });

  it("POST /api/tasks accepts kind and returns it from list/get", async () => {
    const create = await request(app)
      .post("/api/tasks")
      .send({ title: "Keep running", kind: "ongoing" });
    expect(create.status).toBe(200);
    expect(create.body.task.kind).toBe("ongoing");

    const id = create.body.task.id;
    const get = await request(app).get(`/api/tasks/${id}`);
    expect(get.status).toBe(200);
    expect(get.body.task.kind).toBe("ongoing");

    const list = await request(app).get("/api/tasks");
    expect(list.status).toBe(200);
    expect(list.body.tasks).toEqual(
      expect.arrayContaining([expect.objectContaining({ id, kind: "ongoing" })]),
    );
  });

  it("GET /api/tasks/:id returns the created task", async () => {
    const create = await request(app)
      .post("/api/tasks")
      .send({ title: "Lookup Task" });
    const id = create.body.task.id;

    const res = await request(app).get(`/api/tasks/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.task.title).toBe("Lookup Task");
  });

  it("GET /api/tasks/:id/session-storage returns recursive size for linked sessions only", async () => {
    const task = ctx.taskStore.createTask("Storage task");
    const linkedSessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    ctx.taskStore.linkSession(task.id, linkedSessionId);
    ctx.taskStore.linkSession(task.id, "../not-a-session");
    const linkedDir = join(ctx.copilotHome!, "session-state", linkedSessionId);
    const unlinkedDir = join(ctx.copilotHome!, "session-state", "unlinked-session");
    mkdirSync(join(linkedDir, "files"), { recursive: true });
    mkdirSync(unlinkedDir, { recursive: true });
    writeFileSync(join(linkedDir, "events.jsonl"), "event bytes\n");
    writeFileSync(join(linkedDir, "files", "artifact.txt"), "artifact bytes");
    writeFileSync(join(unlinkedDir, "events.jsonl"), "not counted");

    const res = await request(app).get(`/api/tasks/${task.id}/session-storage`);

    expect(res.status).toBe(200);
    expect(res.body.taskId).toBe(task.id);
    expect(res.body.totalDiskSizeBytes).toBe("event bytes\n".length + "artifact bytes".length);
    expect(res.body.sessions).toEqual(expect.arrayContaining([
      {
        sessionId: linkedSessionId,
        diskSizeBytes: "event bytes\n".length + "artifact bytes".length,
      },
      {
        sessionId: "../not-a-session",
        diskSizeBytes: 0,
      },
    ]));
  });

  it("GET /api/tasks/:id returns 404 for missing task", async () => {
    const res = await request(app).get("/api/tasks/nonexistent");
    expect(res.status).toBe(404);
  });

  it("PATCH /api/tasks/:id updates a task", async () => {
    const create = await request(app)
      .post("/api/tasks")
      .send({ title: "Original" });
    const id = create.body.task.id;

    const res = await request(app)
      .patch(`/api/tasks/${id}`)
      .send({
        title: "Updated",
        notes: "Some notes",
        doneWhen: "Shipped to production",
        nextAction: "Verify telemetry",
        waitingOn: "Customer confirmation",
        nextTouchAt: "2026-05-02T09:00:00.000Z",
      });
    expect(res.status).toBe(200);
    expect(res.body.task.title).toBe("Updated");
    expect(res.body.task.notes).toBe("Some notes");
    expect(res.body.task.doneWhen).toBe("Shipped to production");
    expect(res.body.task.nextAction).toBe("Verify telemetry");
    expect(res.body.task.waitingOn).toBe("Customer confirmation");
    expect(res.body.task.nextTouchAt).toBe("2026-05-02T09:00:00.000Z");

    const get = await request(app).get(`/api/tasks/${id}`);
    expect(get.status).toBe(200);
    expect(get.body.task).toEqual(expect.objectContaining({
      doneWhen: "Shipped to production",
      nextAction: "Verify telemetry",
      waitingOn: "Customer confirmation",
      nextTouchAt: "2026-05-02T09:00:00.000Z",
    }));
  });

  it("PATCH /api/tasks/:id updates kind and rejects invalid kinds", async () => {
    const create = await request(app)
      .post("/api/tasks")
      .send({ title: "Kind patch" });
    const id = create.body.task.id;

    const update = await request(app)
      .patch(`/api/tasks/${id}`)
      .send({ kind: "ongoing" });
    expect(update.status).toBe(200);
    expect(update.body.task.kind).toBe("ongoing");

    const get = await request(app).get(`/api/tasks/${id}`);
    expect(get.status).toBe(200);
    expect(get.body.task.kind).toBe("ongoing");

    const invalid = await request(app)
      .patch(`/api/tasks/${id}`)
      .send({ kind: "invalid" });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toContain("kind must be either 'task' or 'ongoing'");
  });

  it("PATCH /api/tasks/:id normalizes kind-only switches to ongoing", async () => {
    const create = await request(app)
      .post("/api/tasks")
      .send({ title: "Kind patch normalize" });
    const id = create.body.task.id;

    const seeded = await request(app)
      .patch(`/api/tasks/${id}`)
      .send({ status: "done", doneWhen: "Shipped to production" });
    expect(seeded.status).toBe(200);

    const update = await request(app)
      .patch(`/api/tasks/${id}`)
      .send({ kind: "ongoing" });
    expect(update.status).toBe(200);
    expect(update.body.task.kind).toBe("ongoing");
    expect(update.body.task.status).toBe("active");
    expect(update.body.task.doneWhen).toBeUndefined();

    const get = await request(app).get(`/api/tasks/${id}`);
    expect(get.status).toBe(200);
    expect(get.body.task.kind).toBe("ongoing");
    expect(get.body.task.status).toBe("active");
    expect(get.body.task.doneWhen).toBeUndefined();
  });

  it("PATCH /api/tasks/:id derives completedAt from explicit completion and reopening only", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T10:00:00.000Z"));

    const create = await request(app)
      .post("/api/tasks")
      .send({ title: "Complete via route" });
    const id = create.body.task.id;

    vi.setSystemTime(new Date("2026-04-01T12:34:56.000Z"));
    const completed = await request(app)
      .patch(`/api/tasks/${id}`)
      .send({ completionAction: "complete-and-archive", completedAt: "1999-01-01T00:00:00.000Z" });
    expect(completed.status).toBe(200);
    expect(completed.body.task.status).toBe("archived");
    expect(completed.body.task.completedAt).toBe("2026-04-01T12:34:56.000Z");

    vi.setSystemTime(new Date("2026-04-01T13:00:00.000Z"));
    const preserved = await request(app)
      .patch(`/api/tasks/${id}`)
      .send({ notes: "done already", completedAt: "2030-01-01T00:00:00.000Z" });
    expect(preserved.status).toBe(200);
    expect(preserved.body.task.completedAt).toBe("2026-04-01T12:34:56.000Z");

    vi.setSystemTime(new Date("2026-04-01T14:00:00.000Z"));
    const reopened = await request(app)
      .patch(`/api/tasks/${id}`)
      .send({ status: "active", completedAt: "2030-01-01T00:00:00.000Z" });
    expect(reopened.status).toBe(200);
    expect(reopened.body.task.completedAt).toBeUndefined();
  });

  it("PATCH /api/tasks/:id normalizes legacy done updates into complete-and-archive", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T10:00:00.000Z"));

    const create = await request(app)
      .post("/api/tasks")
      .send({ title: "Legacy complete via route" });
    const id = create.body.task.id;

    vi.setSystemTime(new Date("2026-04-01T12:34:56.000Z"));
    const completed = await request(app)
      .patch(`/api/tasks/${id}`)
      .send({ status: "done", completedAt: "1999-01-01T00:00:00.000Z" });

    expect(completed.status).toBe(200);
    expect(completed.body.task.status).toBe("archived");
    expect(completed.body.task.completedAt).toBe("2026-04-01T12:34:56.000Z");
  });

  it("PATCH /api/tasks/:id rejects re-completing archived tasks", async () => {
    const create = await request(app)
      .post("/api/tasks")
      .send({ title: "Archive protection via route" });
    const id = create.body.task.id;

    const archived = await request(app)
      .patch(`/api/tasks/${id}`)
      .send({ status: "archived" });
    expect(archived.status).toBe(200);

    const completionAction = await request(app)
      .patch(`/api/tasks/${id}`)
      .send({ completionAction: "complete-and-archive" });
    expect(completionAction.status).toBe(400);
    expect(completionAction.body.error).toContain("Archived tasks cannot be completed again");

    const legacyDone = await request(app)
      .patch(`/api/tasks/${id}`)
      .send({ status: "done" });
    expect(legacyDone.status).toBe(400);
    expect(legacyDone.body.error).toContain("Archived tasks cannot be completed again");
  });

  it("PATCH /api/tasks/:id archiving an incomplete task does not set completedAt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T10:00:00.000Z"));

    const create = await request(app)
      .post("/api/tasks")
      .send({ title: "Archive via route" });
    const id = create.body.task.id;

    vi.setSystemTime(new Date("2026-04-01T12:34:56.000Z"));
    const archived = await request(app)
      .patch(`/api/tasks/${id}`)
      .send({ status: "archived", completedAt: "1999-01-01T00:00:00.000Z" });
    expect(archived.status).toBe(200);
    expect(archived.body.task.status).toBe("archived");
    expect(archived.body.task.completedAt).toBeUndefined();
  });

  it("DELETE /api/tasks/:id removes a task", async () => {
    const create = await request(app)
      .post("/api/tasks")
      .send({ title: "To Delete" });
    const id = create.body.task.id;

    const del = await request(app).delete(`/api/tasks/${id}`);
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true);

    const get = await request(app).get(`/api/tasks/${id}`);
    expect(get.status).toBe(404);
  });

  it("POST /api/tasks/:id/link links a work item", async () => {
    const create = await request(app)
      .post("/api/tasks")
      .send({ title: "Linked Task" });
    const id = create.body.task.id;

    const res = await request(app)
      .post(`/api/tasks/${id}/link`)
      .send({ type: "workItem", workItemId: "42", provider: "github" });
    expect(res.status).toBe(200);
    expect(res.body.task.workItems).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "42", provider: "github" })]),
    );
  });

  it("DELETE /api/tasks/:id/link removes a work item link", async () => {
    const create = await request(app)
      .post("/api/tasks")
      .send({ title: "Unlink Task" });
    const id = create.body.task.id;

    await request(app)
      .post(`/api/tasks/${id}/link`)
      .send({ type: "workItem", workItemId: "99", provider: "github" });

    const res = await request(app)
      .delete(`/api/tasks/${id}/link`)
      .send({ type: "workItem", workItemId: "99", provider: "github" });
    expect(res.status).toBe(200);
    expect(res.body.task.workItems).toEqual([]);
  });

  it("PUT /api/tasks/reorder reorders tasks", async () => {
    const t1 = (await request(app).post("/api/tasks").send({ title: "A" })).body.task;
    const t2 = (await request(app).post("/api/tasks").send({ title: "B" })).body.task;

    const res = await request(app)
      .put("/api/tasks/reorder")
      .send({ taskIds: [t2.id, t1.id] });
    expect(res.status).toBe(200);

    const list = await request(app).get("/api/tasks");
    expect(list.body.tasks[0].id).toBe(t2.id);
    expect(list.body.tasks[1].id).toBe(t1.id);
  });

  it("POST /api/tasks with groupId assigns to group", async () => {
    const group = (await request(app).post("/api/task-groups").send({ name: "G" })).body.group;

    const res = await request(app)
      .post("/api/tasks")
      .send({ title: "Grouped Task", groupId: group.id });
    expect(res.status).toBe(200);
    expect(res.body.task.groupId).toBe(group.id);
  });

  it("PATCH /api/tasks/:id normalizes paused status updates to active", async () => {
    const create = await request(app).post("/api/tasks").send({ title: "Normalize status" });
    const id = create.body.task.id;

    const update = await request(app).patch(`/api/tasks/${id}`).send({ status: "paused" });
    expect(update.status).toBe(200);
    expect(update.body.task.status).toBe("active");

    const get = await request(app).get(`/api/tasks/${id}`);
    expect(get.status).toBe(200);
    expect(get.body.task.status).toBe("active");
  });

  it("PATCH /api/tasks/:id clears momentum fields when passed empty strings", async () => {
    const create = await request(app).post("/api/tasks").send({ title: "Clear Momentum" });
    const id = create.body.task.id;

    await request(app).patch(`/api/tasks/${id}`).send({
      doneWhen: "Merged",
      nextAction: "Deploy",
      waitingOn: "Review",
      nextTouchAt: "2030-01-01T00:00:00.000Z",
    });

    const cleared = await request(app).patch(`/api/tasks/${id}`).send({
      doneWhen: "",
      nextAction: "",
      waitingOn: "   ",
      nextTouchAt: "",
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.task.doneWhen).toBeUndefined();
    expect(cleared.body.task.nextAction).toBeUndefined();
    expect(cleared.body.task.waitingOn).toBeUndefined();
    expect(cleared.body.task.nextTouchAt).toBeUndefined();

    // Verify persistence via GET
    const get = await request(app).get(`/api/tasks/${id}`);
    expect(get.body.task.doneWhen).toBeUndefined();
    expect(get.body.task.nextAction).toBeUndefined();
    expect(get.body.task.waitingOn).toBeUndefined();
    expect(get.body.task.nextTouchAt).toBeUndefined();
  });

  it("PATCH /api/tasks/:id clears parked momentum when a task is marked done", async () => {
    const create = await request(app).post("/api/tasks").send({ title: "Close me out" });
    const id = create.body.task.id;

    await request(app).patch(`/api/tasks/${id}`).send({
      doneWhen: "Rolled out to all tenants",
      nextAction: "Check the dashboard",
      waitingOn: "Support confirmation",
      nextTouchAt: "2030-01-01T00:00:00.000Z",
    });

    const done = await request(app).patch(`/api/tasks/${id}`).send({ status: "done" });
    expect(done.status).toBe(200);
    expect(done.body.task.status).toBe("archived");
    expect(done.body.task.doneWhen).toBe("Rolled out to all tenants");
    expect(done.body.task.nextAction).toBeUndefined();
    expect(done.body.task.waitingOn).toBeUndefined();
    expect(done.body.task.nextTouchAt).toBeUndefined();

    const get = await request(app).get(`/api/tasks/${id}`);
    expect(get.status).toBe(200);
    expect(get.body.task.status).toBe("archived");
    expect(get.body.task.doneWhen).toBe("Rolled out to all tenants");
    expect(get.body.task.nextAction).toBeUndefined();
    expect(get.body.task.waitingOn).toBeUndefined();
    expect(get.body.task.nextTouchAt).toBeUndefined();
  });

  it("PATCH /api/tasks/:id clears parked momentum when a task is archived", async () => {
    const create = await request(app).post("/api/tasks").send({ title: "Archive me" });
    const id = create.body.task.id;

    await request(app).patch(`/api/tasks/${id}`).send({
      nextAction: "Check the dashboard",
      waitingOn: "Support confirmation",
      nextTouchAt: "2030-01-01T00:00:00.000Z",
    });

    const archived = await request(app).patch(`/api/tasks/${id}`).send({ status: "archived" });
    expect(archived.status).toBe(200);
    expect(archived.body.task.status).toBe("archived");
    expect(archived.body.task.nextAction).toBeUndefined();
    expect(archived.body.task.waitingOn).toBeUndefined();
    expect(archived.body.task.nextTouchAt).toBeUndefined();

    const get = await request(app).get(`/api/tasks/${id}`);
    expect(get.status).toBe(200);
    expect(get.body.task.status).toBe("archived");
    expect(get.body.task.nextAction).toBeUndefined();
    expect(get.body.task.waitingOn).toBeUndefined();
    expect(get.body.task.nextTouchAt).toBeUndefined();
  });

  it("PATCH /api/tasks/:id rejects parked momentum updates for done tasks", async () => {
    const create = await request(app).post("/api/tasks").send({ title: "Stay closed" });
    const id = create.body.task.id;

    await request(app).patch(`/api/tasks/${id}`).send({ status: "done" });

    const invalid = await request(app)
      .patch(`/api/tasks/${id}`)
      .send({ nextAction: "Actually keep working on this" });

    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toContain("nextAction, waitingOn, and nextTouchAt can only be set on active tasks");

    const get = await request(app).get(`/api/tasks/${id}`);
    expect(get.status).toBe(200);
    expect(get.body.task.status).toBe("archived");
    expect(get.body.task.nextAction).toBeUndefined();
  });

  it("PATCH /api/tasks/:id rejects invalid nextTouchAt values", async () => {
    const create = await request(app).post("/api/tasks").send({ title: "Invalid touch" });
    const id = create.body.task.id;

    for (const nextTouchAt of ["not-a-date", "2026-02-31T00:00:00.000Z", "2026-05-02 09:30", 123]) {
      const invalid = await request(app)
        .patch(`/api/tasks/${id}`)
        .send({ nextTouchAt });

      expect(invalid.status).toBe(400);
      expect(invalid.body.error).toContain("nextTouchAt must be a valid ISO timestamp with timezone");
    }

    const get = await request(app).get(`/api/tasks/${id}`);
    expect(get.status).toBe(200);
    expect(get.body.task.nextTouchAt).toBeUndefined();
  });

  it("PATCH /api/tasks/:id rejects invalid status values", async () => {
    const create = await request(app).post("/api/tasks").send({ title: "Invalid status" });
    const id = create.body.task.id;

    const invalid = await request(app)
      .patch(`/api/tasks/${id}`)
      .send({ status: "bogus" });

    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toContain("status must be one of: active, done, archived");

    const get = await request(app).get(`/api/tasks/${id}`);
    expect(get.status).toBe(200);
    expect(get.body.task.status).toBe("active");
  });
});

// ── Task Group CRUD ──────────────────────────────────────────────

describe("Task group routes", () => {
  it("GET /api/task-groups returns empty list initially", async () => {
    const res = await request(app).get("/api/task-groups");
    expect(res.status).toBe(200);
    expect(res.body.groups).toEqual([]);
  });

  it("POST /api/task-groups creates a group", async () => {
    const res = await request(app)
      .post("/api/task-groups")
      .send({ name: "Frontend" });
    expect(res.status).toBe(200);
    expect(res.body.group.name).toBe("Frontend");
    expect(res.body.group.id).toBeTruthy();
  });

  it("PATCH /api/task-groups/:id updates a group", async () => {
    const create = await request(app)
      .post("/api/task-groups")
      .send({ name: "Old Name" });
    const id = create.body.group.id;

    const res = await request(app)
      .patch(`/api/task-groups/${id}`)
      .send({ name: "New Name" });
    expect(res.status).toBe(200);
    expect(res.body.group.name).toBe("New Name");
  });

  it("DELETE /api/task-groups/:id deletes a group", async () => {
    const create = await request(app)
      .post("/api/task-groups")
      .send({ name: "Temp" });
    const id = create.body.group.id;

    const del = await request(app).delete(`/api/task-groups/${id}`);
    expect(del.status).toBe(200);
    expect(del.body.success).toBe(true);

    const list = await request(app).get("/api/task-groups");
    expect(list.body.groups).toEqual([]);
  });

  it("PUT /api/task-groups/reorder reorders groups", async () => {
    const g1 = (await request(app).post("/api/task-groups").send({ name: "A" })).body.group;
    const g2 = (await request(app).post("/api/task-groups").send({ name: "B" })).body.group;

    const res = await request(app)
      .put("/api/task-groups/reorder")
      .send({ groupIds: [g2.id, g1.id] });
    expect(res.status).toBe(200);
  });
});

// ── Checklist CRUD ───────────────────────────────────────────────

describe("Checklist routes", () => {
  let taskId: string;

  beforeEach(async () => {
    const task = await request(app)
      .post("/api/tasks")
      .send({ title: "Checklist Host" });
    taskId = task.body.task.id;
  });

  it("GET /api/tasks/:taskId/checklist-items returns empty list initially", async () => {
    const res = await request(app).get(`/api/tasks/${taskId}/checklist-items`);
    expect(res.status).toBe(200);
    expect(res.body.checklistItems).toEqual([]);
  });

  it("POST /api/tasks/:taskId/checklist-items creates a checklist item", async () => {
    const res = await request(app)
      .post(`/api/tasks/${taskId}/checklist-items`)
      .send({ text: "Write tests" });
    expect(res.status).toBe(200);
    expect(res.body.checklistItem.text).toBe("Write tests");
    expect(res.body.checklistItem.done).toBe(false);
  });

  it("PATCH /api/checklist-items/:id updates a checklist item", async () => {
    const create = await request(app)
      .post(`/api/tasks/${taskId}/checklist-items`)
      .send({ text: "Draft" });
    const id = create.body.checklistItem.id;

    const res = await request(app)
      .patch(`/api/checklist-items/${id}`)
      .send({ text: "Final", done: true });
    expect(res.status).toBe(200);
    expect(res.body.checklistItem.text).toBe("Final");
    expect(res.body.checklistItem.done).toBe(true);
  });

  it("DELETE /api/checklist-items/:id removes a checklist item", async () => {
    const create = await request(app)
      .post(`/api/tasks/${taskId}/checklist-items`)
      .send({ text: "Ephemeral" });
    const id = create.body.checklistItem.id;

    const del = await request(app).delete(`/api/checklist-items/${id}`);
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true);

    const list = await request(app).get(`/api/tasks/${taskId}/checklist-items`);
    expect(list.body.checklistItems).toEqual([]);
  });

  it("POST /api/checklist-items creates a global checklist item", async () => {
    const res = await request(app)
      .post("/api/checklist-items")
      .send({ text: "Global checklist item" });
    expect(res.status).toBe(200);
    expect(res.body.checklistItem.text).toBe("Global checklist item");
    expect(res.body.checklistItem.taskId).toBeNull();
  });

  it("GET /api/checklist-items/open returns open checklist items", async () => {
    await request(app)
      .post(`/api/tasks/${taskId}/checklist-items`)
      .send({ text: "Open one" });

    const res = await request(app).get("/api/checklist-items/open");
    expect(res.status).toBe(200);
    expect(res.body.checklistItems.length).toBeGreaterThanOrEqual(1);
    expect(res.body.checklistItems[0].text).toBe("Open one");
  });

  it("PUT /api/tasks/:taskId/checklist-items/reorder reorders checklist items", async () => {
    const t1 = (await request(app).post(`/api/tasks/${taskId}/checklist-items`).send({ text: "First" })).body.checklistItem;
    const t2 = (await request(app).post(`/api/tasks/${taskId}/checklist-items`).send({ text: "Second" })).body.checklistItem;

    const res = await request(app)
      .put(`/api/tasks/${taskId}/checklist-items/reorder`)
      .send({ checklistItemIds: [t2.id, t1.id] });
    expect(res.status).toBe(200);

    const list = await request(app).get(`/api/tasks/${taskId}/checklist-items`);
    expect(list.body.checklistItems[0].id).toBe(t2.id);
    expect(list.body.checklistItems[1].id).toBe(t1.id);
  });

  it("POST /api/tasks/:taskId/checklist-items with deadline", async () => {
    const res = await request(app)
      .post(`/api/tasks/${taskId}/checklist-items`)
      .send({ text: "Due soon", deadline: "2026-12-31" });
    expect(res.status).toBe(200);
    expect(res.body.checklistItem.deadline).toBe("2026-12-31");
  });

  it("old /api/todos routes are not exposed", async () => {
    expect((await request(app).get(`/api/tasks/${taskId}/todos`)).status).toBe(404);
    expect((await request(app).post(`/api/tasks/${taskId}/todos`).send({ text: "Old route" })).status).toBe(404);
    expect((await request(app).post("/api/todos").send({ text: "Old route" })).status).toBe(404);
    expect((await request(app).get("/api/todos/open")).status).toBe(404);
    expect((await request(app).put(`/api/tasks/${taskId}/todos/reorder`).send({ todoIds: [] })).status).toBe(404);
  });
});

// ── Tag CRUD ─────────────────────────────────────────────────────

describe("Tag routes", () => {
  it("GET /api/tags returns empty list initially", async () => {
    const res = await request(app).get("/api/tags");
    expect(res.status).toBe(200);
    expect(res.body.tags).toEqual([]);
  });

  it("POST /api/tags creates a tag", async () => {
    const res = await request(app)
      .post("/api/tags")
      .send({ name: "urgent", color: "rose" });
    expect(res.status).toBe(200);
    expect(res.body.tag.name).toBe("urgent");
    expect(res.body.tag.color).toBe("rose");
  });

  it("PATCH /api/tags/:id updates a tag", async () => {
    const create = await request(app)
      .post("/api/tags")
      .send({ name: "old" });
    const id = create.body.tag.id;

    const res = await request(app)
      .patch(`/api/tags/${id}`)
      .send({ name: "new", color: "blue" });
    expect(res.status).toBe(200);
    expect(res.body.tag.name).toBe("new");
  });

  it("DELETE /api/tags/:id deletes a tag", async () => {
    const create = await request(app)
      .post("/api/tags")
      .send({ name: "temp" });
    const id = create.body.tag.id;

    const del = await request(app).delete(`/api/tags/${id}`);
    expect(del.status).toBe(200);
    expect(del.body.success).toBe(true);

    const list = await request(app).get("/api/tags");
    expect(list.body.tags).toEqual([]);
  });

  it("PUT /api/tags/reorder reorders tags", async () => {
    const t1 = (await request(app).post("/api/tags").send({ name: "alpha" })).body.tag;
    const t2 = (await request(app).post("/api/tags").send({ name: "beta" })).body.tag;

    const res = await request(app)
      .put("/api/tags/reorder")
      .send({ tagIds: [t2.id, t1.id] });
    expect(res.status).toBe(200);
  });

  it("PUT /api/tasks/:id/tags assigns tags to a task", async () => {
    const task = (await request(app).post("/api/tasks").send({ title: "Tagged" })).body.task;
    const tag = (await request(app).post("/api/tags").send({ name: "priority" })).body.tag;

    const res = await request(app)
      .put(`/api/tasks/${task.id}/tags`)
      .send({ tagIds: [tag.id] });
    expect(res.status).toBe(200);

    const get = await request(app).get(`/api/tasks/${task.id}`);
    expect(get.body.task.tags).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: tag.id, name: "priority" })]),
    );
  });
});

// ── Settings ─────────────────────────────────────────────────────
