import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../db.js";
import { createMockSessionManager, makeTestDir } from "./helpers.js";
import { createTestApp } from "./test-app.js";

const BEFORE = "2020-01-01T00:00:00.000Z";

afterEach(() => { vi.restoreAllMocks(); });

describe("archiving a task settles its conversations", () => {
  function setup() {
    const { app, ctx } = createTestApp({
      sessionManager: { ...createMockSessionManager(), listSessionsFromDisk: vi.fn(async () => []) },
    });
    const events: Array<{ type: string }> = [];
    ctx.globalBus.subscribe((event: { type: string }) => { events.push(event); });
    return { app, ctx, events };
  }

  it("marks read only the open conversations that no active task still holds, in one broadcast", async () => {
    const { app, ctx, events } = setup();
    const closing = ctx.taskStore.createTask("Closing");
    const other = ctx.taskStore.createTask("Still active");
    for (const id of ["own", "shared", "filed", "already-read"]) ctx.taskStore.linkSession(closing.id, id);
    ctx.taskStore.linkSession(other.id, "shared");
    ctx.sessionMetaStore.setArchived("filed", true);
    ctx.readStateStore.markRead("already-read", "2999-01-01T00:00:00.000Z");

    const started = Date.now();
    await request(app).patch(`/api/tasks/${closing.id}`).send({ status: "archived" }).expect(200);

    const read = ctx.readStateStore.getReadState();
    expect(Object.keys(read).sort()).toEqual(["already-read", "own"]);
    expect(Date.parse(read.own)).toBeGreaterThanOrEqual(started);
    // A later read time is never moved back.
    expect(read["already-read"]).toBe("2999-01-01T00:00:00.000Z");
    expect(events.filter((event) => event.type === "readstate:changed")).toHaveLength(1);
    // Something that arrives after the archive is unread again.
    expect(ctx.readStateStore.isUnread("own", new Date(Date.now() + 60_000).toISOString())).toBe(true);
    expect(ctx.readStateStore.isUnread("own", BEFORE)).toBe(false);
  });

  it("does the same when completing archives the task, and nothing for other changes or a reopen", async () => {
    const { app, ctx, events } = setup();
    const task = ctx.taskStore.createTask("Finite");
    ctx.taskStore.linkSession(task.id, "chat");

    await request(app).patch(`/api/tasks/${task.id}`).send({ deferred: true }).expect(200);
    expect(ctx.readStateStore.getReadState()).toEqual({});

    await request(app).patch(`/api/tasks/${task.id}`).send({ completionAction: "complete-and-archive" }).expect(200);
    expect(Object.keys(ctx.readStateStore.getReadState())).toEqual(["chat"]);

    ctx.readStateStore.markUnread("chat");
    await request(app).patch(`/api/tasks/${task.id}`).send({ status: "active" }).expect(200);
    await request(app).patch(`/api/tasks/${task.id}`).send({ notes: "Reopened" }).expect(200);
    expect(ctx.readStateStore.getReadState()).toEqual({});
    expect(events.filter((event) => event.type === "readstate:changed")).toHaveLength(1);
  });

  it("still archives when the read state cannot be written", async () => {
    const { app, ctx } = setup();
    const task = ctx.taskStore.createTask("Closing");
    ctx.taskStore.linkSession(task.id, "chat");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(ctx.readStateStore, "markReadMany").mockImplementation(() => { throw new Error("disk full"); });

    const response = await request(app).patch(`/api/tasks/${task.id}`).send({ status: "archived" }).expect(200);
    expect(response.body.task.status).toBe("archived");
    expect(ctx.taskStore.getTask(task.id)?.status).toBe("archived");
  });
});

describe("one-time settlement of tasks archived earlier", () => {
  it("marks their open conversations read once, and leaves active tasks, archived chats and later unread alone", () => {
    const dataDir = makeTestDir("archived-task-chats-read");
    const first = openDatabase(dataDir);
    first.close();

    // An install from before the settlement: same data, no marker.
    const raw = new DatabaseSync(join(dataDir, "bridge.db"));
    raw.prepare("DELETE FROM settings WHERE key LIKE 'migration:%'").run();
    const task = raw.prepare(`INSERT INTO tasks (id, title, status, "order", createdAt, updatedAt) VALUES (?, ?, ?, 0, ?, ?)`);
    task.run("closed", "Closed", "archived", BEFORE, BEFORE);
    task.run("open", "Open", "active", BEFORE, BEFORE);
    const link = raw.prepare("INSERT INTO task_sessions (taskId, sessionId, linkedAt) VALUES (?, ?, ?)");
    for (const [taskId, sessionId] of [["closed", "leftover"], ["closed", "shared"], ["open", "shared"], ["open", "working"], ["closed", "filed"], ["closed", "read-ahead"]]) {
      link.run(taskId, sessionId, BEFORE);
    }
    raw.prepare("INSERT INTO bridge_session_state (sessionId, archived, createdAt, updatedAt) VALUES ('filed', 1, ?, ?)").run(BEFORE, BEFORE);
    raw.prepare("INSERT INTO read_state (sessionId, lastReadAt) VALUES ('read-ahead', '2999-01-01T00:00:00.000Z'), ('leftover', ?)").run(BEFORE);
    raw.close();

    const started = Date.now();
    const migrated = openDatabase(dataDir);
    const read = () => Object.fromEntries((migrated.prepare("SELECT sessionId, lastReadAt FROM read_state").all() as Array<{ sessionId: string; lastReadAt: string }>)
      .map((row) => [row.sessionId, row.lastReadAt]));
    expect(Object.keys(read()).sort()).toEqual(["leftover", "read-ahead"]);
    expect(Date.parse(read().leftover)).toBeGreaterThanOrEqual(started);
    expect(read().leftover).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(read()["read-ahead"]).toBe("2999-01-01T00:00:00.000Z");

    // It runs once: a conversation that turns unread afterwards stays unread across restarts.
    migrated.prepare("DELETE FROM read_state WHERE sessionId = 'leftover'").run();
    migrated.close();
    const reopened = openDatabase(dataDir);
    expect(reopened.prepare("SELECT 1 FROM read_state WHERE sessionId = 'leftover'").get()).toBeUndefined();
    reopened.close();
  });
});
