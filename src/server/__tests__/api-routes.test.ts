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
