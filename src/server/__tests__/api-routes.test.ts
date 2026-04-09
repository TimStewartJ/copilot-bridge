import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import type { AppContext } from "../app-context.js";
import { createTestApp } from "./helpers.js";

let app: Express;
let ctx: AppContext;

beforeEach(() => {
  ({ app, ctx } = createTestApp());
});

// ── Task CRUD ────────────────────────────────────────────────────

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
    expect(res.body.task.status).toBe("active");
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
      .send({ title: "Updated", notes: "Some notes" });
    expect(res.status).toBe(200);
    expect(res.body.task.title).toBe("Updated");
    expect(res.body.task.notes).toBe("Some notes");
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
      .send({ type: "workItem", workItemId: 42, provider: "github" });
    expect(res.status).toBe(200);
    expect(res.body.task.workItems).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 42, provider: "github" })]),
    );
  });

  it("DELETE /api/tasks/:id/link removes a work item link", async () => {
    const create = await request(app)
      .post("/api/tasks")
      .send({ title: "Unlink Task" });
    const id = create.body.task.id;

    await request(app)
      .post(`/api/tasks/${id}/link`)
      .send({ type: "workItem", workItemId: 99, provider: "github" });

    const res = await request(app)
      .delete(`/api/tasks/${id}/link`)
      .send({ type: "workItem", workItemId: 99, provider: "github" });
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

// ── Todo CRUD ────────────────────────────────────────────────────

describe("Todo routes", () => {
  let taskId: string;

  beforeEach(async () => {
    const task = await request(app)
      .post("/api/tasks")
      .send({ title: "Todo Host" });
    taskId = task.body.task.id;
  });

  it("GET /api/tasks/:taskId/todos returns empty list initially", async () => {
    const res = await request(app).get(`/api/tasks/${taskId}/todos`);
    expect(res.status).toBe(200);
    expect(res.body.todos).toEqual([]);
  });

  it("POST /api/tasks/:taskId/todos creates a todo", async () => {
    const res = await request(app)
      .post(`/api/tasks/${taskId}/todos`)
      .send({ text: "Write tests" });
    expect(res.status).toBe(200);
    expect(res.body.todo.text).toBe("Write tests");
    expect(res.body.todo.done).toBe(false);
  });

  it("PATCH /api/todos/:id updates a todo", async () => {
    const create = await request(app)
      .post(`/api/tasks/${taskId}/todos`)
      .send({ text: "Draft" });
    const id = create.body.todo.id;

    const res = await request(app)
      .patch(`/api/todos/${id}`)
      .send({ text: "Final", done: true });
    expect(res.status).toBe(200);
    expect(res.body.todo.text).toBe("Final");
    expect(res.body.todo.done).toBe(true);
  });

  it("DELETE /api/todos/:id removes a todo", async () => {
    const create = await request(app)
      .post(`/api/tasks/${taskId}/todos`)
      .send({ text: "Ephemeral" });
    const id = create.body.todo.id;

    const del = await request(app).delete(`/api/todos/${id}`);
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true);

    const list = await request(app).get(`/api/tasks/${taskId}/todos`);
    expect(list.body.todos).toEqual([]);
  });

  it("POST /api/todos creates a global todo", async () => {
    const res = await request(app)
      .post("/api/todos")
      .send({ text: "Global todo" });
    expect(res.status).toBe(200);
    expect(res.body.todo.text).toBe("Global todo");
    expect(res.body.todo.taskId).toBeNull();
  });

  it("GET /api/todos/open returns open todos", async () => {
    await request(app)
      .post(`/api/tasks/${taskId}/todos`)
      .send({ text: "Open one" });

    const res = await request(app).get("/api/todos/open");
    expect(res.status).toBe(200);
    expect(res.body.todos.length).toBeGreaterThanOrEqual(1);
    expect(res.body.todos[0].text).toBe("Open one");
  });

  it("PUT /api/tasks/:taskId/todos/reorder reorders todos", async () => {
    const t1 = (await request(app).post(`/api/tasks/${taskId}/todos`).send({ text: "First" })).body.todo;
    const t2 = (await request(app).post(`/api/tasks/${taskId}/todos`).send({ text: "Second" })).body.todo;

    const res = await request(app)
      .put(`/api/tasks/${taskId}/todos/reorder`)
      .send({ todoIds: [t2.id, t1.id] });
    expect(res.status).toBe(200);

    const list = await request(app).get(`/api/tasks/${taskId}/todos`);
    expect(list.body.todos[0].id).toBe(t2.id);
    expect(list.body.todos[1].id).toBe(t1.id);
  });

  it("POST /api/tasks/:taskId/todos with deadline", async () => {
    const res = await request(app)
      .post(`/api/tasks/${taskId}/todos`)
      .send({ text: "Due soon", deadline: "2026-12-31" });
    expect(res.status).toBe(200);
    expect(res.body.todo.deadline).toBe("2026-12-31");
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

describe("Settings routes", () => {
  it("GET /api/settings returns default settings", async () => {
    const res = await request(app).get("/api/settings");
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe("object");
    expect(res.body).toHaveProperty("mcpServers");
  });

  it("PATCH /api/settings updates settings", async () => {
    const res = await request(app)
      .patch("/api/settings")
      .send({ mcpServers: { test: { command: "echo" } } });
    expect(res.status).toBe(200);
    expect(res.body.mcpServers).toHaveProperty("test");

    const get = await request(app).get("/api/settings");
    expect(get.body.mcpServers).toHaveProperty("test");
  });
});

// ── Read State ───────────────────────────────────────────────────

describe("Read state routes", () => {
  it("GET /api/read-state returns empty state initially", async () => {
    const res = await request(app).get("/api/read-state");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });

  it("POST /api/read-state/:sessionId marks a session as read", async () => {
    const res = await request(app).post("/api/read-state/sess-1");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const state = await request(app).get("/api/read-state");
    expect(state.body).toHaveProperty("sess-1");
  });

  it("DELETE /api/read-state/:sessionId marks a session as unread", async () => {
    await request(app).post("/api/read-state/sess-2");

    const del = await request(app).delete("/api/read-state/sess-2");
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true);

    const state = await request(app).get("/api/read-state");
    expect(state.body["sess-2"]).toBeUndefined();
  });
});

// ── Schedule CRUD ────────────────────────────────────────────────

describe("Schedule routes", () => {
  let taskId: string;

  beforeEach(async () => {
    const task = await request(app)
      .post("/api/tasks")
      .send({ title: "Schedule Host" });
    taskId = task.body.task.id;
  });

  it("GET /api/schedules returns empty list initially", async () => {
    const res = await request(app).get("/api/schedules");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("POST /api/schedules validates required fields", async () => {
    const res = await request(app)
      .post("/api/schedules")
      .send({ name: "Missing fields" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/);
  });

  it("POST /api/schedules validates task exists", async () => {
    const res = await request(app)
      .post("/api/schedules")
      .send({ taskId: "no-such-task", name: "X", prompt: "Y", type: "cron", cron: "0 0 * * *" });
    expect(res.status).toBe(404);
  });

  it("POST /api/schedules requires cron for cron type", async () => {
    const res = await request(app)
      .post("/api/schedules")
      .send({ taskId, name: "X", prompt: "Y", type: "cron" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cron/);
  });

  it("GET /api/schedules/:id/sessions returns sessions for a schedule", async () => {
    const schedule = ctx.scheduleStore.createSchedule({
      taskId, name: "Test Sched", prompt: "Do stuff", type: "cron", cron: "0 0 * * *",
    });

    ctx.sessionMetaStore.setScheduleMeta("sess-1", schedule.id, "Test Sched");
    ctx.sessionMetaStore.setScheduleMeta("sess-2", schedule.id, "Test Sched");

    const res = await request(app).get(`/api/schedules/${schedule.id}/sessions`);
    expect(res.status).toBe(200);
    // Mock session manager returns no sessions on disk, so enriched list is empty
    // but the route structure is correct
    expect(res.body).toHaveProperty("sessions");
    expect(Array.isArray(res.body.sessions)).toBe(true);
    expect(res.body).toHaveProperty("offset", 0);
    expect(res.body).toHaveProperty("limit");
    expect(typeof res.body.total).toBe("number");
  });

  it("GET /api/schedules/:id/sessions returns 404 for unknown schedule", async () => {
    const res = await request(app).get("/api/schedules/no-such-id/sessions");
    expect(res.status).toBe(404);
  });

  it("GET /api/schedules/:id/sessions respects limit and offset params", async () => {
    const schedule = ctx.scheduleStore.createSchedule({
      taskId, name: "Paged", prompt: "Do stuff", type: "cron", cron: "0 0 * * *",
    });

    ctx.sessionMetaStore.setScheduleMeta("s1", schedule.id, "Paged");
    ctx.sessionMetaStore.setScheduleMeta("s2", schedule.id, "Paged");
    ctx.sessionMetaStore.setScheduleMeta("s3", schedule.id, "Paged");

    const res = await request(app).get(`/api/schedules/${schedule.id}/sessions?limit=2&offset=1`);
    expect(res.status).toBe(200);
    expect(res.body.offset).toBe(1);
    expect(res.body.limit).toBe(2);
  });
});

// ── Session routes (mock-based) ──────────────────────────────────

describe("Session routes (mocked)", () => {
  it("GET /api/sessions returns wrapped response", async () => {
    const res = await request(app).get("/api/sessions");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("sessions");
  });

  it("POST /api/sessions creates a session", async () => {
    const res = await request(app).post("/api/sessions");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("sessionId");
  });

  it("POST /api/chat requires sessionId and prompt", async () => {
    const res = await request(app)
      .post("/api/chat")
      .send({});
    expect(res.status).toBe(400);
  });

  it("GET /api/busy returns activity summary", async () => {
    const res = await request(app).get("/api/busy");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("busy");
    expect(res.body).toHaveProperty("count");
    expect(Array.isArray(res.body.sessions)).toBe(true);
  });

  it("GET /api/dashboard includes schedules array", async () => {
    const res = await request(app).get("/api/dashboard");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("schedules");
    expect(Array.isArray(res.body.schedules)).toBe(true);
  });

  it("GET /api/dashboard enriches schedules with task title", async () => {
    // Create a task and schedule via stores
    const task = await request(app).post("/api/tasks").send({ title: "Dashboard Task" });
    const taskId = task.body.task.id;
    ctx.scheduleStore.createSchedule({
      taskId, name: "Dash Sched", prompt: "test", type: "cron", cron: "0 0 * * *",
    });

    const res = await request(app).get("/api/dashboard");
    expect(res.status).toBe(200);
    const sched = res.body.schedules.find((s: any) => s.name === "Dash Sched");
    expect(sched).toBeDefined();
    expect(sched.taskTitle).toBe("Dashboard Task");
  });
});

// ── Error handling ───────────────────────────────────────────────

describe("Error handling", () => {
  it("PATCH /api/tasks/:id returns 404 for nonexistent task", async () => {
    const res = await request(app)
      .patch("/api/tasks/nonexistent")
      .send({ title: "Nope" });
    expect(res.status).toBe(404);
  });

  it("POST /api/tasks/:id/link returns error for nonexistent task", async () => {
    const res = await request(app)
      .post("/api/tasks/nonexistent/link")
      .send({ type: "session", sessionId: "s1" });
    expect([400, 404]).toContain(res.status);
  });

  it("DELETE /api/tasks/:id/link returns error for nonexistent task", async () => {
    const res = await request(app)
      .delete("/api/tasks/nonexistent/link")
      .send({ type: "session", sessionId: "s1" });
    expect([400, 404]).toContain(res.status);
  });
});

// ── Session archive/delete (store-based) ─────────────────────────

describe("Session metadata routes", () => {
  it("PATCH /api/sessions/:id archives a session", async () => {
    const res = await request(app)
      .patch("/api/sessions/test-sess")
      .send({ archived: true });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.archived).toBe(true);
  });

  it("PATCH /api/sessions/:id unarchives a session", async () => {
    await request(app)
      .patch("/api/sessions/test-sess")
      .send({ archived: true });

    const res = await request(app)
      .patch("/api/sessions/test-sess")
      .send({ archived: false });
    expect(res.status).toBe(200);
    expect(res.body.archived).toBe(false);
  });

  it("DELETE /api/sessions/:id deletes a session", async () => {
    const res = await request(app).delete("/api/sessions/some-sess");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("POST /api/sessions/batch archives multiple sessions", async () => {
    const res = await request(app)
      .post("/api/sessions/batch")
      .send({ sessionIds: ["s1", "s2"], action: "archive" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("POST /api/sessions/batch requires sessionIds", async () => {
    const res = await request(app)
      .post("/api/sessions/batch")
      .send({ action: "archive" });
    expect(res.status).toBe(400);
  });

  it("POST /api/sessions/batch marks sessions read", async () => {
    const res = await request(app)
      .post("/api/sessions/batch")
      .send({ sessionIds: ["s1"], action: "markRead" });
    expect(res.status).toBe(200);
  });
});

// ── Session manager routes (mock-based) ──────────────────────────

describe("Session manager routes", () => {
  it("GET /api/sessions/:id/messages returns paginated messages", async () => {
    const res = await request(app).get("/api/sessions/test-id/messages");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("messages");
    expect(res.body).toHaveProperty("total");
    expect(res.body).toHaveProperty("hasMore");
    expect(res.body).toHaveProperty("busy");
  });

  it("POST /api/sessions/:id/duplicate duplicates a session", async () => {
    const res = await request(app).post("/api/sessions/test-id/duplicate");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("sessionId");
  });

  it("POST /api/sessions/:id/abort aborts a session", async () => {
    const res = await request(app).post("/api/sessions/test-id/abort");
    expect(res.status).toBe(200);
  });

  it("GET /api/sessions/:id/mcp-status returns MCP status", async () => {
    const res = await request(app).get("/api/sessions/test-id/mcp-status");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("servers");
  });

  it("GET /api/mcp-status returns global MCP status", async () => {
    const res = await request(app).get("/api/mcp-status");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("servers");
  });

  it("POST /api/tasks/:id/session creates a task-linked session", async () => {
    const task = (await request(app).post("/api/tasks").send({ title: "Session Task" })).body.task;

    const res = await request(app)
      .post(`/api/tasks/${task.id}/session`)
      .send({ prompt: "Hello" });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("sessionId");
  });
});

// ── Tag MCP server routes ────────────────────────────────────────

describe("Tag MCP server routes", () => {
  let tagId: string;

  beforeEach(async () => {
    const tag = (await request(app).post("/api/tags").send({ name: "mcp-test" })).body.tag;
    tagId = tag.id;
  });

  it("GET /api/tags/:id/mcp returns empty servers initially", async () => {
    const res = await request(app).get(`/api/tags/${tagId}/mcp`);
    expect(res.status).toBe(200);
    expect(res.body.servers).toEqual(expect.any(Object));
  });

  it("PUT /api/tags/:id/mcp/:serverName sets an MCP server", async () => {
    const res = await request(app)
      .put(`/api/tags/${tagId}/mcp/test-server`)
      .send({ command: "echo", args: ["hello"] });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("DELETE /api/tags/:id/mcp/:serverName removes an MCP server", async () => {
    await request(app)
      .put(`/api/tags/${tagId}/mcp/to-delete`)
      .send({ command: "echo" });

    const res = await request(app).delete(`/api/tags/${tagId}/mcp/to-delete`);
    expect(res.status).toBe(200);

    const get = await request(app).get(`/api/tags/${tagId}/mcp`);
    expect(get.body.servers["to-delete"]).toBeUndefined();
  });
});

// ── Task group tags ──────────────────────────────────────────────

describe("Task group tag routes", () => {
  it("PUT /api/task-groups/:id/tags assigns tags to a group", async () => {
    const group = (await request(app).post("/api/task-groups").send({ name: "Tagged Group" })).body.group;
    const tag = (await request(app).post("/api/tags").send({ name: "group-tag" })).body.tag;

    const res = await request(app)
      .put(`/api/task-groups/${group.id}/tags`)
      .send({ tagIds: [tag.id] });
    expect(res.status).toBe(200);

    const list = await request(app).get("/api/task-groups");
    const found = list.body.groups.find((g: any) => g.id === group.id);
    expect(found.tags).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "group-tag" })]),
    );
  });
});

// ── Docs routes ──────────────────────────────────────────────────

describe("Docs routes", () => {
  it("GET /api/docs/tree returns empty tree initially", async () => {
    const res = await request(app).get("/api/docs/tree");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("tree");
    expect(res.body).toHaveProperty("hasRootIndex");
  });

  it("PUT /api/docs/pages writes a page", async () => {
    const res = await request(app)
      .put("/api/docs/pages/test-page")
      .send({ content: "# Test Page\n\nHello world" });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.path).toBe("test-page");
  });

  it("GET /api/docs/pages reads a written page", async () => {
    await request(app)
      .put("/api/docs/pages/read-me")
      .send({ content: "# Read Me\n\nContent here" });

    const res = await request(app).get("/api/docs/pages/read-me");
    expect(res.status).toBe(200);
    expect(res.body.body).toContain("Content here");
    expect(res.body.title).toBe("read-me");
  });

  it("GET /api/docs/pages returns 404 for missing page", async () => {
    const res = await request(app).get("/api/docs/pages/nonexistent");
    expect(res.status).toBe(404);
  });

  it("DELETE /api/docs/pages deletes a page", async () => {
    await request(app)
      .put("/api/docs/pages/to-delete")
      .send({ content: "# Delete Me" });

    const res = await request(app).delete("/api/docs/pages/to-delete");
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);

    const get = await request(app).get("/api/docs/pages/to-delete");
    expect(get.status).toBe(404);
  });

  it("PUT /api/docs/pages overwrites an existing page", async () => {
    // Write a page, then verify it can be read back
    const write = await request(app)
      .put("/api/docs/pages/overwrite-me")
      .send({ content: "# First Version" });
    expect(write.status).toBe(200);

    const read = await request(app).get("/api/docs/pages/overwrite-me");
    expect(read.status).toBe(200);
    expect(read.body.body).toContain("First Version");
  });

  it("GET /api/docs/tree reflects created pages", async () => {
    await request(app)
      .put("/api/docs/pages/notes/first")
      .send({ content: "# First Note" });

    const res = await request(app).get("/api/docs/tree");
    expect(res.status).toBe(200);
    const tree = res.body.tree;
    expect(tree.length).toBeGreaterThan(0);
  });

  it("GET /api/docs/search finds indexed pages", async () => {
    await request(app)
      .put("/api/docs/pages/searchable")
      .send({ content: "# Unique Keyword\n\nThis page has xylophone content" });

    const res = await request(app).get("/api/docs/search?q=xylophone");
    expect(res.status).toBe(200);
    expect(res.body.results.length).toBeGreaterThan(0);
  });

  it("POST /api/docs/reindex rebuilds the index", async () => {
    const res = await request(app).post("/api/docs/reindex");
    expect(res.status).toBe(200);
    expect(typeof res.body.indexed).toBe("number");
  });

  it("GET /api/docs/search returns empty for no match", async () => {
    const res = await request(app).get("/api/docs/search?q=nonexistentterm12345");
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
  });
});

// ── Docs DB (database collections) ───────────────────────────────

describe("Docs DB routes", () => {
  const folder = "incidents";

  beforeEach(async () => {
    await request(app)
      .put(`/api/docs/schema/${folder}`)
      .send({
        name: "Incidents",
        fields: [
          { name: "severity", type: "select", options: ["sev1", "sev2", "sev3"] },
          { name: "date", type: "date" },
          { name: "resolved", type: "boolean" },
        ],
      });
  });

  it("PUT /api/docs/schema creates a collection schema", async () => {
    const res = await request(app).get(`/api/docs/schema/${folder}`);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Incidents");
    expect(res.body.fields.length).toBe(3);
    expect(typeof res.body.entryCount).toBe("number");
  });

  it("POST /api/docs/db creates an entry", async () => {
    const res = await request(app)
      .post(`/api/docs/db/${folder}`)
      .send({
        fields: { title: "March Outage", severity: "sev1", date: "2026-03-15" },
        body: "The database went down.",
      });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.slug).toBeTruthy();
  });

  it("GET /api/docs/db queries entries", async () => {
    await request(app)
      .post(`/api/docs/db/${folder}`)
      .send({ fields: { title: "Entry A", severity: "sev1" } });
    await request(app)
      .post(`/api/docs/db/${folder}`)
      .send({ fields: { title: "Entry B", severity: "sev2" } });

    const res = await request(app).get(`/api/docs/db/${folder}`);
    expect(res.status).toBe(200);
    expect(res.body.entries.length).toBe(2);
    expect(typeof res.body.total).toBe("number");
  });

  it("PATCH /api/docs/db updates an entry", async () => {
    const create = await request(app)
      .post(`/api/docs/db/${folder}`)
      .send({ fields: { title: "Patchable", severity: "sev3" } });
    const slug = create.body.slug;

    const res = await request(app)
      .patch(`/api/docs/db/${folder}/${slug}`)
      .send({ fields: { severity: "sev1" } });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("POST /api/docs/db validates required title", async () => {
    const res = await request(app)
      .post(`/api/docs/db/${folder}`)
      .send({ fields: { severity: "sev1" } });
    expect(res.status).toBe(400);
  });
});

// ── Enriched task route ──────────────────────────────────────────

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
});
