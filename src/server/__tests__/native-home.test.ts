import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHomeReader, latestHomeReply, parseHomeQuery } from "../home.js";
import { createTaskStore } from "../task-store.js";
import { createTaskGroupStore } from "../task-group-store.js";
import { createChecklistStore } from "../checklist-store.js";
import { createReadStateStore } from "../read-state-store.js";
import { createScheduleStore } from "../schedule-store.js";
import { setupTestDb, createTestBus } from "./helpers.js";
import type { DatabaseSync } from "../db.js";
import type { SessionManager } from "../session-manager.js";
import { formatTaskMomentumContext } from "../session-task-momentum.js";

describe("native Home composition", () => {
  let db: DatabaseSync;
  beforeEach(() => { db = setupTestDb(); });
  afterEach(() => { db.close(); vi.restoreAllMocks(); });
  function setup(sessions: unknown[] = []) {
    const bus = createTestBus(), taskStore = createTaskStore(db, bus), checklistStore = createChecklistStore(db, bus);
    const readStateStore = createReadStateStore(db);
    const manager = {
      getSessionRunState: vi.fn<SessionManager["getSessionRunState"]>(() => "idle"),
      getPendingUserInputCount: vi.fn<SessionManager["getPendingUserInputCount"]>(() => 0),
      hydratePendingInteractions: vi.fn<SessionManager["hydratePendingInteractions"]>(async () => ({ pendingUserInputs: [], pendingElicitations: [] })),
      readMessagesFromDisk: vi.fn<SessionManager["readMessagesFromDisk"]>(async id => ({ messages: [{ id: "message", type: "message", role: "assistant", sourceEventId: `reply-${id}`, content: "A source-backed answer" }], total: 1, hasMore: false, coverage: {} })),
    };
    const scheduleStore = createScheduleStore(db);
    const reader = createHomeReader({ taskStore, checklistStore, readStateStore, scheduleStore, taskGroupStore: createTaskGroupStore(db, bus), sessionManager: manager }, async () => sessions);
    return { ...reader, taskStore, checklistStore, readStateStore, scheduleStore, manager };
  }
  it("uses existing task momentum and identities without creating new work records", async () => {
    const app = setup([{ sessionId: "conversation", summary: "Compare options", lastActivityAt: "2026-09-21T12:00:00Z" }]);
    const task = app.taskStore.createTask("Ongoing research", undefined, "ongoing");
    app.taskStore.updateTask(task.id, { notes: "Context must not be duplicated".repeat(1000), nextAction: "Read the comparison", waitingOn: "A reply", nextTouchAt: "2000-01-01T00:00:00Z" });
    app.taskStore.linkSession(task.id, "conversation");
    const before = app.taskStore.getTask(task.id);
    const home = await app.snapshot();
    expect(home.tasks.items[0]).toMatchObject({ id: task.id, kind: "ongoing", nextAction: "Read the comparison", waitingOn: "A reply", sessionId: "conversation" });
    expect(home.tasks.items[0]).not.toHaveProperty("notes");
    expect(home.followUps.items[0].taskId).toBe(task.id);
    expect(app.taskStore.getTask(task.id)).toEqual(before);
    expect(home.replies.items[0].sourceEventId).toBe("reply-conversation");
    expect(app.readStateStore.getReadState()).toEqual({});
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
    for (const removed of ["works", "commitments", "human_requests", "results", "proposals", "decisions", "alerts", "focus_events", "feed_cards"]) expect(tables).not.toContain(removed);
  });
  it("keeps deferred tasks out of working sections, but not revisits, inputs, replies or deadlines", async () => {
    const app = setup([{ sessionId: "waiting", lastActivityAt: "2026-09-21T12:00:00Z" }, { sessionId: "reply", lastActivityAt: "2026-09-21T12:00:00Z" }]);
    const task = app.taskStore.createTask("Deferred ongoing work", undefined, "ongoing");
    app.taskStore.updateTask(task.id, { deferred: true, nextTouchAt: "2000-01-01T00:00:00Z", nextAction: "Read comparison" });
    for (const session of ["waiting", "reply"]) app.taskStore.linkSession(task.id, session);
    app.manager.getPendingUserInputCount.mockImplementation(id => id === "waiting" ? 1 : 0);
    app.manager.getSessionRunState.mockImplementation(id => id === "waiting" ? "busy" : "idle");
    app.manager.hydratePendingInteractions.mockResolvedValue({ pendingElicitations: [], pendingUserInputs: [{ requestId: "ask", question: "Choose", allowFreeform: true }] });
    const action = app.checklistStore.createChecklistItem(task.id, "Accepted deadline", "2000-01-01");
    const home = await app.snapshot();
    expect(home.tasks.total).toBe(0);
    expect(home.deferredTaskTotal).toBe(1);
    expect(home.followUps.items).toEqual([expect.objectContaining({ taskId: task.id, deferred: true })]);
    expect(home.inputs.items[0]).toMatchObject({ sessionId: "waiting", requestId: "ask" });
    expect(home.replies.items[0]).toMatchObject({ sessionId: "reply", sourceEventId: "reply-reply" });
    expect(home.actions.items[0].id).toBe(action.id);
    expect((await app.snapshot("tasks")).tasks.items[0]).toMatchObject({ id: task.id, deferred: true });
    expect(app.taskStore.getTask(task.id)?.deferred).toBe(true);
    const context = formatTaskMomentumContext(app.taskStore.getTask(task.id)!);
    expect(context).toContain("- Deferred:");
    expect(context).toContain("Running sessions, schedules and session defers are not paused");
    expect(context).toContain("- Next step: Read comparison");
    app.taskStore.updateTask(task.id, { deferred: false });
    expect((await app.snapshot()).tasks.items[0].id).toBe(task.id);
  });

  it("keeps undated deferred work reachable and does not treat future revisit dates as deferral", async () => {
    const app = setup();
    const deferred = app.taskStore.createTask("Set aside");
    const future = app.taskStore.createTask("Still working");
    app.taskStore.updateTask(deferred.id, { deferred: true });
    app.taskStore.updateTask(future.id, { nextTouchAt: "9999-01-01T00:00:00Z" });
    const home = await app.snapshot();
    expect(home.tasks.items.map(task => task.id)).toEqual([future.id]);
    expect(home.followUps.items).toEqual([]);
    expect((await app.snapshot("tasks")).tasks.total).toBe(2);
    app.taskStore.updateTask(deferred.id, { muted: true });
    expect((await app.snapshot("tasks")).tasks.total).toBe(1);
    expect((await app.snapshot()).deferredTaskTotal).toBe(0);
  });

  it("deduplicates a shared session question and preserves exact elicitation schema", async () => {
    const app = setup([{ sessionId: "shared", summary: "Shared question" }]);
    for (const name of ["One", "Two"]) app.taskStore.linkSession(app.taskStore.createTask(name).id, "shared");
    app.manager.getPendingUserInputCount.mockReturnValue(1);
    const request = { requestId: "native-form", message: "Choose", mode: "form" as const,
      requestedSchema: { type: "object" as const, properties: { value: { type: "string" as const, enum: ["A", "B"] } } } };
    app.manager.hydratePendingInteractions.mockResolvedValue({ pendingUserInputs: [], pendingElicitations: [request] });
    const first = await app.snapshot();
    expect(first.inputs.total).toBe(1);
    expect(first.inputs.items[0]).toMatchObject({ kind: "elicitation", sessionId: "shared", requestId: request.requestId, question: request.message, pendingCount: 1 });
    expect(first.inputs.items[0]).not.toHaveProperty("requestedSchema");
    app.manager.hydratePendingInteractions.mockResolvedValue({ pendingUserInputs: [], pendingElicitations: [] });
    expect((await app.snapshot()).inputs.total).toBe(0);
  });
  it("preserves global checklist items and excludes context-only waiting from due attention", async () => {
    const app = setup(), task = app.taskStore.createTask("Waiting");
    app.taskStore.updateTask(task.id, { waitingOn: "External reply" });
    const global = app.checklistStore.createChecklistItem(null, "Accepted global action");
    const due = app.checklistStore.createChecklistItem(task.id, "Due action", "2000-01-01");
    const home = await app.snapshot();
    expect(home.followUps.total).toBe(0);
    expect(home.actions.items.map(item => item.id)).toEqual([due.id, global.id]);
    expect(home.actionCounts).toEqual({ open: 2, overdue: 1, dueToday: 0 });
    expect((await app.snapshot("actions")).actions.items.some(item => item.id === global.id)).toBe(true);
  });
  it("shows the soonest checklist items on the overview with their task's group colour and live deadline counts", async () => {
    const app = setup();
    const group = createTaskGroupStore(db, createTestBus()).createGroup("Group", "rose");
    const task = app.taskStore.createTask("Grouped", group.id);
    const today = (await app.snapshot()).today;
    const items = [
      app.checklistStore.createChecklistItem(task.id, "Undated"),
      app.checklistStore.createChecklistItem(task.id, "Later", "9999-01-01"),
      app.checklistStore.createChecklistItem(task.id, "Today", today),
      app.checklistStore.createChecklistItem(null, "Overdue", "2000-01-01"),
    ];
    for (let index = 0; index < 4; index++) app.checklistStore.createChecklistItem(task.id, `Extra ${index}`);
    const home = await app.snapshot();
    expect(home.actions.items.map(item => item.text).slice(0, 4)).toEqual(["Overdue", "Today", "Later", "Undated"]);
    expect(home.actions.items).toHaveLength(5);
    expect(home.actions.hasMore).toBe(true);
    expect(home.actions.items.find(item => item.id === items[2].id)).toMatchObject({ taskTitle: "Grouped", groupColor: "rose" });
    expect(home.actionCounts).toEqual({ open: 8, overdue: 1, dueToday: 1 });
  });
  it("bounds response bodies and transcript reads, caches replies, and never lets busy activity masquerade as a return", async () => {
    const sessions = Array.from({ length: 35 }, (_, index) => ({ sessionId: String(index), lastActivityAt: "2026-09-21T12:00:00Z" }));
    const app = setup(sessions);
    app.manager.getSessionRunState.mockImplementation(id => id === "0" ? "busy" : "idle");
    expect((await app.snapshot()).replies.items).toHaveLength(3);
    expect(app.manager.readMessagesFromDisk).toHaveBeenCalledTimes(3);
    await app.snapshot(); expect(app.manager.readMessagesFromDisk).toHaveBeenCalledTimes(3);
    const page = await app.snapshot("replies", 20);
    expect(page.replies.total).toBe(34); expect(page.replies.items).toHaveLength(14);
    expect(app.manager.readMessagesFromDisk.mock.calls.every(([, options]) => options?.limit === 40)).toBe(true);
  });
  it("does not invent a reply from a tool, reasoning or a previous answer before a new user message", () => {
    expect(latestHomeReply([
      { id: "old", type: "message", role: "assistant", content: "Old answer", sourceEventId: "old" },
      { id: "user", type: "message", role: "user", content: "New question" },
      { id: "thought", type: "reasoning", content: "Thinking" },
      { id: "tool", type: "tool" },
    ])).toBeUndefined();
  });
  it("surfaces unavailable request sources explicitly and validates paging", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const app = setup([{ sessionId: "waiting" }]);
    app.manager.getPendingUserInputCount.mockReturnValue(1);
    app.manager.hydratePendingInteractions.mockRejectedValue(new Error("Disconnected"));
    const result = await app.snapshot();
    expect(result.inputErrors[0].error).toBe("Disconnected");
    expect(() => parseHomeQuery({ section: "decisions" })).toThrow("Unknown");
    expect(() => parseHomeQuery({ offset: "-1" })).toThrow("offset");
  });
  it("bounds native hydration to the current page of waiting conversations", async () => {
    const app = setup(Array.from({ length: 55 }, (_, index) => ({ sessionId: `waiting-${index}` })));
    app.manager.getPendingUserInputCount.mockReturnValue(1);
    app.manager.hydratePendingInteractions.mockImplementation(async id => ({ pendingElicitations: [],
      pendingUserInputs: [{ requestId: `${id}-request`, question: "Choose", allowFreeform: true }] }));
    const first = await app.snapshot();
    expect(app.manager.hydratePendingInteractions).toHaveBeenCalledTimes(3);
    expect(first.inputs.total).toBe(55);
    expect(first.inputs.hasMore).toBe(true);
    const next = await app.snapshot("inputs", 20);
    expect(app.manager.hydratePendingInteractions).toHaveBeenCalledTimes(23);
    expect(next.inputs.items).toHaveLength(20);
  });
  it("keeps saved task context readable when the session index is partially malformed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const app = setup([null, { sessionId: "valid" }]);
    const task = app.taskStore.createTask("Still readable");
    const home = await app.snapshot();
    expect(home.tasks.items[0].id).toBe(task.id);
    expect(home.sourceErrors[0]).toContain("1 session record");
    expect(home.inputs.total).toBeNull();
    expect(home.replies.total).toBeNull();
  });
  it("uses the same latest activity and read boundary as native conversations, not an older attention timestamp", async () => {
    const app = setup([{ sessionId: "returned", lastAttentionAt: "2026-09-21T10:00:00Z",
      lastVisibleActivityAt: "2026-09-21T12:00:00Z", lastActivityAt: "2026-09-21T12:00:00Z" }]);
    app.readStateStore.markRead("returned", "2026-09-21T11:00:00Z");
    expect((await app.snapshot()).replies.items[0].sessionId).toBe("returned");
    expect(app.readStateStore.getReadState().returned).toBe("2026-09-21T11:00:00.000Z");
  });
  it("coalesces a task's returns only on the overview and keeps every unread conversation reachable", async () => {
    const app = setup([{ sessionId: "first", lastActivityAt: "2026-09-21T10:00:00Z" }, { sessionId: "second", lastActivityAt: "2026-09-21T11:00:00Z" }]);
    const task = app.taskStore.createTask("Two conversations");
    app.taskStore.linkSession(task.id, "first"); app.taskStore.linkSession(task.id, "second");
    expect((await app.snapshot()).replies.items.map(item => item.sessionId)).toEqual(["second"]);
    expect((await app.snapshot("replies")).replies.items.map(item => item.sessionId)).toEqual(["second", "first"]);
  });

  it("derives task sections from task facts only, never from the checklist", async () => {
    const app = setup([{ sessionId: "recent-chat", lastActivityAt: new Date().toISOString() }]);
    const old = new Date(Date.now() - 90 * 86_400_000).toISOString();
    const quiet = app.taskStore.createTask("Quiet idea");
    const inMotion = app.taskStore.createTask("Active work");
    const revisit = app.taskStore.createTask("Check back");
    const checklistOnly = app.taskStore.createTask("Has an overdue to-do");
    db.prepare("UPDATE tasks SET createdAt = ? WHERE id IN (?, ?, ?)").run(old, quiet.id, revisit.id, checklistOnly.id);
    app.taskStore.linkSession(inMotion.id, "recent-chat");
    app.taskStore.recordUserMessage("recent-chat");
    app.taskStore.updateTask(revisit.id, { nextTouchAt: "2000-01-01T00:00:00Z" });
    app.checklistStore.createChecklistItem(checklistOnly.id, "Overdue to-do", "2000-01-01");
    const home = await app.snapshot();
    expect(home.attention.map(row => row.id)).toEqual([revisit.id]);
    expect(home.attention[0].reasons).toEqual(["revisit"]);
    expect(home.resume.map(row => row.id)).toEqual([inMotion.id]);
    expect(home.quiet.items.map(row => row.id).sort()).toEqual([quiet.id, checklistOnly.id].sort());
    expect(home.taskCounts).toMatchObject({ needs_you: 1, in_motion: 1, gone_quiet: 2 });
    expect(home.actionCounts.overdue).toBe(1);
  });

  it("never calls a task with unreadable conversations quiet", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const app = setup([null, { sessionId: "valid" }]);
    const old = new Date(Date.now() - 90 * 86_400_000).toISOString();
    const linked = app.taskStore.createTask("Has a conversation");
    const unlinked = app.taskStore.createTask("No conversations");
    db.prepare("UPDATE tasks SET createdAt = ? WHERE id IN (?, ?)").run(old, linked.id, unlinked.id);
    app.taskStore.linkSession(linked.id, "maybe-busy");
    const home = await app.snapshot();
    expect(home.quiet.items.map(row => row.id)).toEqual([unlinked.id]);
    expect(home.taskCounts.no_next_step).toBe(1);
  });

  it("counts messages Tim sends, never conversations he only read", async () => {
    const app = setup([{ sessionId: "read-only" }, { sessionId: "written" }]);
    const old = new Date(Date.now() - 90 * 86_400_000).toISOString();
    const read = app.taskStore.createTask("Only read");
    const written = app.taskStore.createTask("Wrote in it");
    db.prepare("UPDATE tasks SET createdAt = ? WHERE id IN (?, ?)").run(old, read.id, written.id);
    app.taskStore.linkSession(read.id, "read-only");
    app.taskStore.linkSession(written.id, "written");
    app.readStateStore.markRead("read-only", new Date().toISOString());
    const before = app.taskStore.getTask(written.id)!;
    app.taskStore.recordUserMessage("written");
    app.taskStore.recordUserMessage("written", "2000-01-01T00:00:00.000Z");
    expect(app.taskStore.getTask(written.id)!.updatedAt).toBe(before.updatedAt);
    const home = await app.snapshot();
    expect(home.quiet.items.map(row => row.id)).toEqual([read.id]);
    expect(home.quiet.items[0].lastTouchKind).toBe("created");
    expect(home.resume.map(row => ({ id: row.id, kind: row.lastTouchKind }))).toEqual([{ id: written.id, kind: "message" }]);
  });

  it("treats Tim's own edits as engagement, silently from the task's point of view", async () => {
    const app = setup();
    const task = app.taskStore.createTask("Old but just edited");
    db.prepare("UPDATE tasks SET createdAt = ? WHERE id = ?").run(new Date(Date.now() - 90 * 86_400_000).toISOString(), task.id);
    expect((await app.snapshot()).quiet.items.map(row => row.id)).toEqual([task.id]);
    app.taskStore.updateTask(task.id, { nextAction: "Decide" }, { source: "user" });
    const home = await app.snapshot();
    expect(home.quiet.total).toBe(0);
    expect(home.resume[0]).toMatchObject({ id: task.id, state: "in_motion", lastTouchKind: "edited" });
  });

  it("counts enabled schedules and active defers as automation, so their tasks never look abandoned", async () => {
    const app = setup();
    const task = app.taskStore.createTask("Weekly monitor");
    db.prepare("UPDATE tasks SET createdAt = ? WHERE id = ?").run(new Date(Date.now() - 90 * 86_400_000).toISOString(), task.id);
    app.scheduleStore.createSchedule({ taskId: task.id, name: "Weekly", prompt: "Check", type: "cron", cron: "0 8 * * 1" } as never);
    const home = await app.snapshot();
    expect(home.quiet.total).toBe(0);
    expect(home.taskCounts.no_next_step).toBe(1);
  });

  it("still serves the legacy task fields for a client loaded before task states", async () => {
    const app = setup();
    app.taskStore.createTask("Legacy");
    const legacy = await app.snapshot("tasks");
    expect(legacy.tasks.items).toHaveLength(1);
    expect(Array.isArray(legacy.followUps.items)).toBe(true);
    expect(parseHomeQuery({ section: "quiet" }).section).toBe("quiet");
  });
});
