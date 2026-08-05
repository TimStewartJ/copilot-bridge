import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionStorageMeasurement, SessionStorageReader } from "../session-storage-reader.js";
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

describe("Task routes", () => {
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

  it("GET /api/tasks/:id/session-storage warns when a linked session directory is missing", async () => {
    const task = ctx.taskStore.createTask("Missing storage task");
    const sessionId = "11111111-2222-4333-8444-555555555555";
    ctx.taskStore.linkSession(task.id, sessionId);

    const res = await request(app).get(`/api/tasks/${task.id}/session-storage`);

    expect(res.status).toBe(200);
    expect(res.body.totalDiskSizeBytes).toBe(0);
    expect(res.body.sessions).toEqual([{
      sessionId,
      diskSizeBytes: 0,
      storageWarning: {
        code: "missing",
        message: "Session storage directory is missing.",
      },
    }]);
  });

  it("GET /api/tasks/:id/session-storage leaves other requests responsive while sizing is pending", async () => {
    let signalSizingStarted!: () => void;
    const sizingStarted = new Promise<void>((resolve) => {
      signalSizingStarted = resolve;
    });
    let resolveMeasurement!: (measurement: SessionStorageMeasurement) => void;
    const pendingMeasurement = new Promise<SessionStorageMeasurement>((resolve) => {
      resolveMeasurement = resolve;
    });
    const sessionStorageReader: SessionStorageReader = {
      measureSession: vi.fn(async () => {
        signalSizingStarted();
        return pendingMeasurement;
      }),
    };
    const local = createTestApp(undefined, { sessionStorageReader });
    const task = local.ctx.taskStore.createTask("Responsive storage task");
    const sessionId = "66666666-7777-4888-8999-aaaaaaaaaaaa";
    local.ctx.taskStore.linkSession(task.id, sessionId);

    let storageSettled = false;
    const storageResponsePromise = request(local.app)
      .get(`/api/tasks/${task.id}/session-storage`)
      .then((response) => {
        storageSettled = true;
        return response;
      });
    await sizingStarted;

    try {
      const healthResponse = await request(local.app).get("/api/health");
      expect(healthResponse.status).toBe(200);
      expect(healthResponse.body.ok).toBe(true);
      expect(storageSettled).toBe(false);
    } finally {
      resolveMeasurement({ status: "complete", diskSizeBytes: 42 });
    }

    const storageResponse = await storageResponsePromise;
    expect(storageResponse.status).toBe(200);
    expect(storageResponse.body.totalDiskSizeBytes).toBe(42);
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
        muted: true,
        notes: "Some notes",
        doneWhen: "Shipped to production",
        nextAction: "Verify telemetry",
        waitingOn: "Customer confirmation",
        nextTouchAt: "2026-05-02T09:00:00.000Z",
      });
    expect(res.status).toBe(200);
    expect(res.body.task.title).toBe("Updated");
    expect(res.body.task.muted).toBe(true);
    expect(res.body.task.notes).toBe("Some notes");
    expect(res.body.task.doneWhen).toBe("Shipped to production");
    expect(res.body.task.nextAction).toBe("Verify telemetry");
    expect(res.body.task.waitingOn).toBe("Customer confirmation");
    expect(res.body.task.nextTouchAt).toBe("2026-05-02T09:00:00.000Z");

    const get = await request(app).get(`/api/tasks/${id}`);
    expect(get.status).toBe(200);
    expect(get.body.task).toEqual(expect.objectContaining({
      doneWhen: "Shipped to production",
      muted: true,
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

  it("POST /api/tasks/:id/link rejects an ambiguous provider instead of defaulting to ado", async () => {
    const create = await request(app).post("/api/tasks").send({ title: "Ambiguous Link" });
    const id = create.body.task.id;

    const res = await request(app)
      .post(`/api/tasks/${id}/link`)
      .send({ type: "workItem", workItemId: "4242" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Pass provider explicitly");

    const task = await request(app).get(`/api/tasks/${id}`);
    expect(task.body.task.workItems).toEqual([]);
  });

  it("POST /api/tasks/:id/link infers github from a github.com reference", async () => {
    const create = await request(app).post("/api/tasks").send({ title: "Inferred Link" });
    const id = create.body.task.id;

    const res = await request(app)
      .post(`/api/tasks/${id}/link`)
      .send({ type: "workItem", workItemId: "https://github.com/octo/widget/issues/7" });

    expect(res.status).toBe(200);
    expect(res.body.task.workItems).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "octo/widget#7", provider: "github" })]),
    );
  });

  it("POST /api/tasks/:id/link stores a canonical github repo id and rejects a bad prId", async () => {
    const create = await request(app).post("/api/tasks").send({ title: "PR Link" });
    const id = create.body.task.id;

    const linked = await request(app)
      .post(`/api/tasks/${id}/link`)
      .send({ type: "pr", repoName: "https://github.com/octo/widget", prId: 12, provider: "github" });

    expect(linked.status).toBe(200);
    expect(linked.body.task.pullRequests).toEqual([
      expect.objectContaining({ repoId: "octo/widget", repoName: "https://github.com/octo/widget", prId: 12, provider: "github" }),
    ]);

    for (const prId of [0, -3, 1.5, "abc", null]) {
      const bad = await request(app)
        .post(`/api/tasks/${id}/link`)
        .send({ type: "pr", repoName: "octo/widget", prId, provider: "github" });
      expect(bad.status).toBe(400);
      expect(bad.body.error).toContain("prId must be a positive whole number");
    }
  });

  it("DELETE /api/tasks/:id/link removes a pull request stored under a legacy raw repo id", async () => {
    const create = await request(app).post("/api/tasks").send({ title: "Legacy PR Link" });
    const id = create.body.task.id;
    // Legacy row: repoId was written as the raw display name before canonicalization.
    ctx.taskStore.linkPR(id, { repoId: "https://github.com/octo/widget", repoName: "https://github.com/octo/widget", prId: 5, provider: "github" });

    const res = await request(app)
      .delete(`/api/tasks/${id}/link`)
      .send({ type: "pr", repoName: "https://github.com/octo/widget", prId: 5, provider: "github" });

    expect(res.status).toBe(200);
    expect(res.body.task.pullRequests).toEqual([]);
  });

  it("DELETE /api/tasks/:id/link without a provider unlinks a PR across providers", async () => {
    const create = await request(app).post("/api/tasks").send({ title: "Cross provider unlink" });
    const id = create.body.task.id;
    ctx.taskStore.linkPR(id, { repoId: "repo", repoName: "repo", prId: 1, provider: "ado" });
    ctx.taskStore.linkPR(id, { repoId: "repo", repoName: "repo", prId: 1, provider: "linear" });

    const res = await request(app)
      .delete(`/api/tasks/${id}/link`)
      .send({ type: "pr", repoName: "repo", prId: 1 });

    expect(res.status).toBe(200);
    expect(res.body.task.pullRequests).toEqual([]);
  });

  it("POST /api/tasks/:id/link rejects a blank work item reference", async () => {
    const create = await request(app).post("/api/tasks").send({ title: "Blank work item" });
    const id = create.body.task.id;

    const res = await request(app)
      .post(`/api/tasks/${id}/link`)
      .send({ type: "workItem", provider: "github" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("workItemId is required");
  });

  it("round-trips a legacy bare repoId through unlink and relink (undo path)", async () => {
    const create = await request(app).post("/api/tasks").send({ title: "Legacy bare repoId" });
    const id = create.body.task.id;
    // Row written before repo ids were canonicalized: durable id is a bare name.
    ctx.taskStore.linkPR(id, { repoId: "space43", repoName: "space43", prId: 200, provider: "github" });

    const unlinked = await request(app)
      .delete(`/api/tasks/${id}/link`)
      .send({ type: "pr", repoId: "space43", repoName: "space43", prId: 200, provider: "github" });
    expect(unlinked.status).toBe(200);
    expect(unlinked.body.task.pullRequests).toEqual([]);

    // Exactly what the PullRequestList undo toast re-sends.
    const relinked = await request(app)
      .post(`/api/tasks/${id}/link`)
      .send({ type: "pr", repoId: "space43", repoName: "space43", prId: 200, provider: "github" });
    expect(relinked.status).toBe(200);
    expect(relinked.body.task.pullRequests).toEqual([
      expect.objectContaining({ repoId: "space43", repoName: "space43", prId: 200, provider: "github" }),
    ]);
  });

  it("POST /api/tasks/:id/link preserves a durable ADO repository id", async () => {
    const create = await request(app).post("/api/tasks").send({ title: "ADO PR Link" });
    const id = create.body.task.id;

    const res = await request(app)
      .post(`/api/tasks/${id}/link`)
      .send({ type: "pr", repoId: "3f2b9c62-0d6a-4b73-8a9b-2f4e0d1a5c77", repoName: "Widget.Service", prId: 8, provider: "ado" });

    expect(res.status).toBe(200);
    expect(res.body.task.pullRequests).toEqual([
      expect.objectContaining({ repoId: "3f2b9c62-0d6a-4b73-8a9b-2f4e0d1a5c77", repoName: "Widget.Service", prId: 8, provider: "ado" }),
    ]);
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

  it("PATCH /api/task-groups/:id applies a full valid update", async () => {
    const create = await request(app)
      .post("/api/task-groups")
      .send({ name: "Old Name" });
    const id = create.body.group.id;

    const res = await request(app)
      .patch(`/api/task-groups/${id}`)
      .send({ name: "Renamed", color: "purple", collapsed: true, notes: "hello" });
    expect(res.status).toBe(200);
    expect(res.body.group.name).toBe("Renamed");
    expect(res.body.group.color).toBe("purple");
    expect(res.body.group.collapsed).toBe(true);
    expect(res.body.group.notes).toBe("hello");
  });

  it("PATCH /api/task-groups/:id rejects unknown fields with 400", async () => {
    const create = await request(app)
      .post("/api/task-groups")
      .send({ name: "Group" });
    const id = create.body.group.id;

    const res = await request(app)
      .patch(`/api/task-groups/${id}`)
      .send({ colour: "blue" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unknown field/);

    const list = await request(app).get("/api/task-groups");
    const unchanged = list.body.groups.find((g: { id: string }) => g.id === id);
    expect(unchanged.name).toBe("Group");
  });

  it("PATCH /api/task-groups/:id rejects an invalid color with 400 and leaves the group unchanged", async () => {
    const create = await request(app)
      .post("/api/task-groups")
      .send({ name: "Group" });
    const id = create.body.group.id;
    const originalColor = create.body.group.color;

    const res = await request(app)
      .patch(`/api/task-groups/${id}`)
      .send({ color: "bad" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/color must be one of/);

    const list = await request(app).get("/api/task-groups");
    const unchanged = list.body.groups.find((g: { id: string }) => g.id === id);
    expect(unchanged.color).toBe(originalColor);
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

  it("POST /api/tasks/:taskId/checklist-items validates create fields", async () => {
    const invalidBodies: Array<[Record<string, unknown>, string]> = [
      [{ text: 42 }, "text must be a non-empty string"],
      [{ text: "" }, "text must be a non-empty string"],
      [{ text: "Due soon", deadline: "tomorrow" }, "deadline must be null or a YYYY-MM-DD date"],
      [{ text: "Write tests", extra: true }, 'Unknown field: "extra"'],
    ];

    for (const [body, message] of invalidBodies) {
      const res = await request(app)
        .post(`/api/tasks/${taskId}/checklist-items`)
        .send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toContain(message);
    }

    const list = await request(app).get(`/api/tasks/${taskId}/checklist-items`);
    expect(list.body.checklistItems).toEqual([]);
  });

  it("POST /api/tasks/:taskId/checklist-items returns 404 for a missing task", async () => {
    const res = await request(app)
      .post("/api/tasks/missing/checklist-items")
      .send({ text: "No host" });
    expect(res.status).toBe(404);
    expect(res.body.error).toContain("Task missing not found");
  });

  it("PATCH /api/checklist-items/:id rejects invalid mutation values", async () => {
    const create = await request(app)
      .post(`/api/tasks/${taskId}/checklist-items`)
      .send({ text: "Draft" });
    const id = create.body.checklistItem.id;

    const invalidBodies: Array<[Record<string, unknown>, string]> = [
      [{ done: "false" }, "done must be boolean"],
      [{ deadline: "tomorrow" }, "deadline must be null or a YYYY-MM-DD date"],
      [{ text: 42 }, "text must be a non-empty string"],
      [{ text: "" }, "text must be a non-empty string"],
      [{ extra: true }, 'Unknown field: "extra"'],
    ];

    for (const [body, message] of invalidBodies) {
      const res = await request(app)
        .patch(`/api/checklist-items/${id}`)
        .send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toContain(message);
    }

    const list = await request(app).get(`/api/tasks/${taskId}/checklist-items`);
    expect(list.body.checklistItems).toHaveLength(1);
    expect(list.body.checklistItems[0]).toEqual(expect.objectContaining({ text: "Draft", done: false }));
    expect(list.body.checklistItems[0].deadline).toBeUndefined();
  });

  it("PATCH /api/checklist-items/:id returns 404 for a missing item", async () => {
    const res = await request(app)
      .patch("/api/checklist-items/missing")
      .send({ text: "No item" });
    expect(res.status).toBe(404);
    expect(res.body.error).toContain("Checklist item missing not found");
  });

  it("DELETE /api/checklist-items/:id returns 404 for a missing item", async () => {
    const res = await request(app).delete("/api/checklist-items/missing");
    expect(res.status).toBe(404);
    expect(res.body.error).toContain("Checklist item missing not found");
  });

  it("POST /api/checklist-items creates a global checklist item", async () => {
    const res = await request(app)
      .post("/api/checklist-items")
      .send({ text: "Global checklist item" });
    expect(res.status).toBe(200);
    expect(res.body.checklistItem.text).toBe("Global checklist item");
    expect(res.body.checklistItem.taskId).toBeNull();
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
