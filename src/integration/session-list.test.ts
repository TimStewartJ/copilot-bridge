import { afterEach, describe, expect, it, vi } from "vitest";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { createMockSessionManager, createTestApp, request } from "../test-support/api-routes.js";
import { createSessionList, type SessionListRow } from "../server/session-list.js";

type Ctx = ReturnType<typeof createTestApp>["ctx"];

/** A build the test finishes by hand. */
function deferredBuild() {
  let resolve!: (rows: SessionListRow[]) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<SessionListRow[]>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const named = (...sessionIds: string[]): SessionListRow[] =>
  sessionIds.map((sessionId) => ({ sessionId, summary: `Chat ${sessionId}` }));

/** The owner on real stores, with a disk listing the test controls. Each listing is one build. */
function createOwner(
  listSessionsFromDisk: (options?: { includeArchived?: boolean }) => Promise<SessionListRow[]>,
  getStatus: Parameters<typeof createSessionList>[1]["getStatus"] = () => ({ runState: "idle", needsUserInput: false }),
) {
  const listing = vi.fn(listSessionsFromDisk);
  const sessionManager = { ...createMockSessionManager(), listSessionsFromDisk: listing } as any;
  const { ctx } = createTestApp({ sessionManager });
  const list = createSessionList(ctx, {
    getStatus,
    summarizeWorkspace: async () => ({ source: "none" }),
  });
  return { ctx, list, listing };
}

const ids = (rows: SessionListRow[]) => rows.map((row) => row.sessionId);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("session list: one build at a time, never older than the reader", () => {
  it("gives a reader that arrives after an invalidation the build that started after it", async () => {
    const builds = [deferredBuild(), deferredBuild()];
    const { list, listing } = createOwner(() => builds[listing.mock.calls.length - 1]!.promise);

    const before = list.read();
    await vi.waitFor(() => expect(listing).toHaveBeenCalledTimes(1));
    // A mutation answers while the first build is still reading.
    list.invalidate("test:mutation");
    const after = list.read();
    const alsoAfter = list.read();

    builds[0]!.resolve(named("old"));
    await vi.waitFor(() => expect(listing).toHaveBeenCalledTimes(2));
    builds[1]!.resolve(named("old", "new"));

    expect(ids(await before)).toEqual(["old"]);
    expect(ids(await after)).toEqual(["old", "new"]);
    expect(ids(await alsoAfter)).toEqual(["old", "new"]);
    expect(listing).toHaveBeenCalledTimes(2);
  });

  it("costs exactly two builds for any number of invalidations during one build", async () => {
    const builds = [deferredBuild(), deferredBuild()];
    const { list, listing } = createOwner(() => builds[listing.mock.calls.length - 1]!.promise);

    const first = list.read();
    await vi.waitFor(() => expect(listing).toHaveBeenCalledTimes(1));
    const readers: Array<Promise<SessionListRow[]>> = [];
    for (let i = 0; i < 20; i++) {
      list.invalidate(`test:burst-${i}`);
      readers.push(list.read());
    }
    builds[0]!.resolve(named("a"));
    await first;
    await vi.waitFor(() => expect(listing).toHaveBeenCalledTimes(2));
    builds[1]!.resolve(named("a", "b"));

    for (const reader of readers) expect(ids(await reader)).toEqual(["a", "b"]);
    expect(ids(await list.read())).toEqual(["a", "b"]);
    expect(listing).toHaveBeenCalledTimes(2);
  });

  it("starts a third build when something changes during the follow-up", async () => {
    const builds = [deferredBuild(), deferredBuild(), deferredBuild()];
    const { list, listing } = createOwner(() => builds[listing.mock.calls.length - 1]!.promise);

    const first = list.read();
    await vi.waitFor(() => expect(listing).toHaveBeenCalledTimes(1));
    list.invalidate("test:first-change");
    const second = list.read();
    builds[0]!.resolve(named("one"));
    await vi.waitFor(() => expect(listing).toHaveBeenCalledTimes(2));
    list.invalidate("test:second-change");
    const third = list.read();
    builds[1]!.resolve(named("one", "two"));
    await vi.waitFor(() => expect(listing).toHaveBeenCalledTimes(3));
    builds[2]!.resolve(named("one", "two", "three"));

    expect(ids(await first)).toEqual(["one"]);
    expect(ids(await second)).toEqual(["one", "two"]);
    expect(ids(await third)).toEqual(["one", "two", "three"]);
    expect(listing).toHaveBeenCalledTimes(3);
  });

  it("rejects the waiters of a failed build, runs the queued one, and builds again later", async () => {
    const builds = [deferredBuild(), deferredBuild(), deferredBuild()];
    const { list, listing } = createOwner(() => builds[listing.mock.calls.length - 1]!.promise);

    const waiter = list.read();
    const sameBuild = list.read();
    await vi.waitFor(() => expect(listing).toHaveBeenCalledTimes(1));
    list.invalidate("test:mutation");
    const queued = list.read();
    builds[0]!.reject(new Error("disk went away"));

    await expect(waiter).rejects.toThrow("disk went away");
    await expect(sameBuild).rejects.toThrow("disk went away");
    await vi.waitFor(() => expect(listing).toHaveBeenCalledTimes(2));
    builds[1]!.reject(new Error("still away"));
    await expect(queued).rejects.toThrow("still away");

    const later = list.read();
    await vi.waitFor(() => expect(listing).toHaveBeenCalledTimes(3));
    builds[2]!.resolve(named("back"));
    expect(ids(await later)).toEqual(["back"]);
  });

  it("keeps the two lists independent", async () => {
    const archivedBuild = deferredBuild();
    const { ctx, list, listing } = createOwner((options) =>
      options?.includeArchived ? archivedBuild.promise : Promise.resolve(named("active")));
    ctx.sessionMetaStore.setArchived("archived", true);

    const all = list.read(true);
    await vi.waitFor(() => expect(listing).toHaveBeenCalledTimes(1));
    // The archived list is still building; the active one does not wait for it.
    expect(ids(await list.read())).toEqual(["active"]);
    archivedBuild.resolve(named("active", "archived"));
    expect(ids(await all).sort()).toEqual(["active", "archived"]);
    expect(listing).toHaveBeenCalledTimes(2);

    list.invalidate("test:archived-only", ["all"]);
    expect(ids(await list.read())).toEqual(["active"]);
    expect(listing).toHaveBeenCalledTimes(2);
    await list.read(true);
    expect(listing).toHaveBeenCalledTimes(3);
  });

  it("serves rows older than 30 seconds at once and replaces them with one build", async () => {
    let now = Date.parse("2026-05-01T12:00:00.000Z");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let name = "Before";
    const { list, listing } = createOwner(async () => [{ sessionId: "s", summary: name }]);

    expect((await list.read())[0]!.summary).toBe("Before");
    name = "After";
    now += 31_000;
    const stale = await Promise.all([list.read(), list.read(), list.read()]);

    expect(stale.map((rows) => rows[0]!.summary)).toEqual(["Before", "Before", "Before"]);
    await vi.waitFor(async () => expect((await list.read())[0]!.summary).toBe("After"));
    expect(listing).toHaveBeenCalledTimes(2);
  });
});

describe("session list: what a response reads", () => {
  it("reads no whole table, in the build or in the response", async () => {
    const { ctx, list } = createOwner(async () => named("one", "two"));
    const task = ctx.taskStore.createTask("Linked");
    ctx.taskStore.linkSession(task.id, "one");
    ctx.readStateStore.markRead("two", "2026-05-01T12:00:00.000Z");
    const wholeTable = [
      vi.spyOn(ctx.sessionMetaStore, "listMeta"),
      vi.spyOn(ctx.bridgeSessionStateStore, "listStates"),
      vi.spyOn(ctx.readStateStore, "getReadState"),
      vi.spyOn(ctx.taskStore, "listTasks"),
      vi.spyOn(ctx.taskStore, "findTaskBySessionId"),
      vi.spyOn(ctx.sessionWorkspaceStore, "listWorkspaces"),
      vi.spyOn(ctx.scheduleStore, "listSchedules"),
    ];

    const rows = await list.read();
    await list.read();

    expect(rows.find((row) => row.sessionId === "one")).toMatchObject({ linkedTaskIds: [task.id] });
    for (const read of wholeTable) expect(read).not.toHaveBeenCalled();
  });

  it("shows a change made after the build in the very next response, without a build", async () => {
    const { ctx, list, listing } = createOwner(async () => named("a", "b", "c"));
    await list.read();

    ctx.sessionMetaStore.setArchived("a", true);
    const task = ctx.taskStore.createTask("Linked later");
    ctx.taskStore.linkSession(task.id, "b");
    ctx.sessionMetaStore.setLastVisibleActivityAt("c", "2026-05-01T12:00:00.000Z");
    const schedule = ctx.scheduleStore.createSchedule({
      taskId: task.id, name: "Nightly", prompt: "run", type: "cron", cron: "0 3 * * *",
    } as any);
    ctx.sessionMetaStore.setScheduleMeta("c", schedule.id, "Nightly");
    const rows = await list.read();

    expect(ids(rows)).toEqual(["c", "b"]);
    expect(rows[0]).toMatchObject({
      lastVisibleActivityAt: "2026-05-01T12:00:00.000Z",
      modifiedTime: "2026-05-01T12:00:00.000Z",
      triggeredBy: "schedule",
      scheduleName: "Nightly",
      scheduleEnabled: true,
    });
    expect(rows[1]).toMatchObject({ linkedTaskIds: [task.id], archived: false, archivedAt: null });

    ctx.scheduleStore.updateSchedule(schedule.id, { enabled: false });
    expect((await list.read())[0]).toMatchObject({ scheduleEnabled: false });
    expect(listing).toHaveBeenCalledTimes(1);
  });

  it("lists an unnamed chat from the response after it was read, without a build", async () => {
    const { ctx, list, listing } = createOwner(async () => [
      { sessionId: "quiet", lastVisibleActivityAt: "2026-05-01T10:00:00.000Z" },
    ]);
    expect(await list.read()).toEqual([]);

    ctx.readStateStore.markRead("quiet");

    expect(ids(await list.read())).toEqual(["quiet"]);
    expect(listing).toHaveBeenCalledTimes(1);
  });

  it("shows a chat that became visible at once, and gives it its details from exactly one build", async () => {
    const { ctx, list, listing } = createOwner(async () => [{ sessionId: "quiet" }]);
    expect(await list.read()).toEqual([]);

    // An attention write announces nothing a build reads, so nothing was invalidated.
    ctx.sessionMetaStore.setLastAttentionAt("quiet", "2026-05-01T10:00:00.000Z");
    const atOnce = await list.read();

    expect(ids(atOnce)).toEqual(["quiet"]);
    expect(atOnce[0]).not.toHaveProperty("workspace");
    await vi.waitFor(async () => expect((await list.read())[0]).toHaveProperty("workspace"));
    expect((await list.read())[0]).toMatchObject({ sessionId: "quiet", hasPlan: false, eventLogSizeBytes: 0 });
    expect(listing).toHaveBeenCalledTimes(2);
  });

  it("builds once, not per response, for a shown chat that builds leave without details", async () => {
    // Busy whenever a response looks, idle whenever a build looks: no build ever gives it details.
    let building = false;
    const { list, listing } = createOwner(
      async () => { building = true; return [{ sessionId: "flapping" }]; },
      () => ({ runState: building ? "idle" : "busy", needsUserInput: false }),
    );
    const buildSettled = async (count: number) => {
      await vi.waitFor(() => expect(listing).toHaveBeenCalledTimes(count));
      await list.base();
      building = false;
    };
    await list.read();
    await buildSettled(1);

    for (let response = 0; response < 5; response++) {
      const rows = await list.read();
      expect(ids(rows)).toEqual(["flapping"]);
      expect(rows[0]).not.toHaveProperty("workspace");
      if (response === 0) await buildSettled(2);
      // Lets a build that a response wrongly asked for start before the count is taken.
      await new Promise((resolve) => setImmediate(resolve));
    }

    expect(listing).toHaveBeenCalledTimes(2);
  });

  it("does not ask again after the build for a newly visible chat failed, nor for a page of named sessions", async () => {
    const { ctx, list, listing } = createOwner(async () => {
      if (listing.mock.calls.length > 1) throw new Error("disk unavailable");
      return [{ sessionId: "quiet" }];
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await list.read();
    ctx.sessionMetaStore.setLastAttentionAt("quiet", "2026-05-01T10:00:00.000Z");

    for (let response = 0; response < 4; response++) {
      expect(ids(await list.read())).toEqual(["quiet"]);
      await new Promise((resolve) => setImmediate(resolve));
    }
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining("build failed"), "disk unavailable"));
    // The rows of such a page belong to no list, whatever they hold.
    ctx.sessionMetaStore.setArchived("gone", true);
    vi.spyOn(ctx.sessionManager, "readSessionsFromDisk").mockResolvedValue([]);
    for (let response = 0; response < 3; response++) {
      expect(ids(await list.readSessions(["gone"]))).toEqual(["gone"]);
      await new Promise((resolve) => setImmediate(resolve));
    }

    expect(listing).toHaveBeenCalledTimes(2);
  });

  it("reads each table once for a very long list, with the same result", async () => {
    const quiet = Array.from({ length: 8_000 }, (_, index) => ({ sessionId: `quiet-${index}` }));
    const { ctx, list } = createOwner(async () => [...named("a", "b"), ...quiet]);
    ctx.sessionMetaStore.setArchived("a", true);
    const task = ctx.taskStore.createTask("Linked");
    ctx.taskStore.linkSession(task.id, "a");
    ctx.readStateStore.markRead("b");
    const scan = vi.spyOn(ctx.sessionMetaStore, "listMeta");
    const byId = vi.spyOn(ctx.sessionMetaStore, "listMetaFor");

    const all = await list.read(true);

    expect(ids(all).sort()).toEqual(["a", "b"]);
    expect(all.find((row) => row.sessionId === "a")).toMatchObject({ archived: true, linkedTaskIds: [task.id] });
    expect(scan).toHaveBeenCalled();
    expect(byId).not.toHaveBeenCalled();
  });

  it("falls back to what the listing said for a session with no state row", async () => {
    const { list } = createOwner(async () => [
      { sessionId: "listed-only", summary: "Listed", lastVisibleActivityAt: "2026-05-01T10:00:00.000Z", modifiedTime: "2026-05-01T09:00:00.000Z" },
    ]);

    expect(await list.read()).toEqual([expect.objectContaining({
      sessionId: "listed-only",
      archived: false,
      archivedAt: null,
      lastVisibleActivityAt: "2026-05-01T10:00:00.000Z",
      modifiedTime: "2026-05-01T10:00:00.000Z",
      linkedTaskIds: [],
    })]);
  });

  it("reads named sessions without building a list, and keeps a row for one whose files are gone", async () => {
    const { ctx, list, listing } = createOwner(async () => named("kept"));
    ctx.sessionMetaStore.setArchived("kept", true);
    ctx.sessionMetaStore.setArchived("gone", true);
    vi.spyOn(ctx.sessionManager, "readSessionsFromDisk").mockResolvedValue(named("kept"));

    const rows = await list.readSessions(["gone", "kept"]);

    expect(rows.map((row) => [row.sessionId, row.summary, row.archived]).sort()).toEqual([
      ["gone", "Untitled session", true],
      ["kept", "Chat kept", true],
    ]);
    expect(listing).not.toHaveBeenCalled();
  });
});

describe("session list routes", () => {
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  function createApp(sessionIds: string[]) {
    const listSessionsFromDisk = vi.fn(async () => named(...sessionIds));
    const sessionManager = { ...createMockSessionManager(), listSessionsFromDisk } as any;
    return { ...createTestApp({ sessionManager }), listSessionsFromDisk };
  }

  it("builds nothing for any number of archive events", async () => {
    const sessionIds = Array.from({ length: 12 }, (_, index) => `chat-${index}`);
    const { app, listSessionsFromDisk } = createApp(sessionIds);
    expect((await request(app).get("/api/sessions")).body.sessions).toHaveLength(12);

    for (const sessionId of sessionIds.slice(0, 10)) {
      expect((await request(app).patch(`/api/sessions/${sessionId}`).send({ archived: true })).status).toBe(200);
      const listed = (await request(app).get("/api/sessions")).body.sessions.map((s: any) => s.sessionId);
      expect(listed).not.toContain(sessionId);
    }

    expect((await request(app).get("/api/sessions")).body.sessions.map((s: any) => s.sessionId).sort()).toEqual(["chat-10", "chat-11"]);
    expect(listSessionsFromDisk).toHaveBeenCalledTimes(1);
  });

  it("reflects a task link made after the build in the next response", async () => {
    const { app, ctx } = createApp(["chat"]);
    await request(app).get("/api/sessions");
    const task = ctx.taskStore.createTask("Later");

    ctx.taskStore.linkSession(task.id, "chat");
    const linked = await request(app).get("/api/sessions");

    expect(linked.body.sessions).toEqual([expect.objectContaining({ sessionId: "chat", linkedTaskIds: [task.id] })]);
  });

  it("lists a chat whose creation has answered but not finished, and drops it when the creation fails", async () => {
    // What SessionManager does for a background creation: the id at once; the folder, or the
    // failure, and the announcement of either only when the runtime is done.
    const pending = new Set<string>();
    const onDisk: SessionListRow[] = [];
    let created = 0;
    const sessionManager = {
      ...createMockSessionManager(),
      listSessionsFromDisk: vi.fn(async () => [...onDisk]),
      listPendingSessionCreationIds: () => [...pending],
      createSession: vi.fn(async () => {
        const sessionId = `chat-${created += 1}`;
        pending.add(sessionId);
        return { sessionId };
      }),
    } as any;
    const { app, ctx } = createTestApp({ sessionManager });
    const task = ctx.taskStore.createTask("Launch");
    const createAndLink = async () => {
      const { sessionId } = (await request(app).post("/api/sessions").send({})).body;
      await request(app).post(`/api/tasks/${task.id}/link`).send({ type: "session", sessionId });
      return sessionId as string;
    };
    const list = async () => (await request(app).get("/api/sessions")).body.sessions as SessionListRow[];

    const first = await createAndLink();
    expect(await list()).toEqual([expect.objectContaining({ sessionId: first, linkedTaskIds: [task.id], summary: "New session" })]);

    pending.delete(first);
    onDisk.push({ sessionId: first, summary: "Named by the runtime", startTime: "2026-05-01T10:00:00.000Z" });
    ctx.globalBus.emit({ type: "sessions:changed", sessionId: first });
    expect(await list()).toEqual([expect.objectContaining({
      sessionId: first, linkedTaskIds: [task.id], summary: "Named by the runtime", startTime: "2026-05-01T10:00:00.000Z",
    })]);

    const failing = await createAndLink();
    expect(ids(await list()).sort()).toEqual([first, failing]);
    pending.delete(failing);
    ctx.taskStore.unlinkSession(task.id, failing);
    ctx.globalBus.emit({ type: "sessions:changed", sessionId: failing });
    expect(ids(await list())).toEqual([first]);
  });

  it("answers a request whose body was read to its end", async () => {
    const { app } = createApp(["chat"]);

    // Node marks such a request destroyed although its client is still waiting.
    const res = await request(app).get("/api/sessions").set("Content-Type", "application/json").send("{}");

    expect(res.status).toBe(200);
    expect(res.body.sessions).toEqual([expect.objectContaining({ sessionId: "chat" })]);
  });

  it("does no response work for a client that left, and still answers the others", async () => {
    const build = deferredBuild();
    const listSessionsFromDisk = vi.fn(() => build.promise);
    const sessionManager = { ...createMockSessionManager(), listSessionsFromDisk } as any;
    const { app, ctx } = createTestApp({ sessionManager });
    const overlayRead = vi.spyOn(ctx.readStateStore, "getReadStateFor");
    server = app.listen(0);
    const sockets: Socket[] = [];
    server.on("connection", (socket) => sockets.push(socket));
    await new Promise<void>((resolve) => server!.once("listening", () => resolve()));
    const { port } = server.address() as AddressInfo;
    const get = () => {
      const req = httpRequest({ host: "127.0.0.1", port, path: "/api/sessions", agent: false });
      const body = new Promise<{ status: number; text: string }>((resolve, reject) => {
        req.on("response", (res) => {
          let text = "";
          res.on("data", (chunk) => { text += chunk; });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
        });
        req.on("error", reject);
      });
      req.end();
      return { req, body };
    };

    const leaving = get();
    const staying = get();
    await vi.waitFor(() => expect(listSessionsFromDisk).toHaveBeenCalledTimes(1));
    // Both requests are in and waiting on the one build before the first client goes.
    await vi.waitFor(() => expect(
      ctx.telemetryStore!.querySpans({ name: "session.enrichedList.cache", limit: 10 }),
    ).toHaveLength(2));
    // The first socket to close is the leaving client's; the server marks its response then.
    const gone = new Promise<void>((resolve) => { for (const socket of sockets) socket.once("close", () => resolve()); });
    leaving.body.catch(() => undefined);
    leaving.req.destroy();
    await gone;
    const overlayReadsBefore = overlayRead.mock.calls.length;
    build.resolve(named("chat"));

    const answer = await staying.body;
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.text).sessions).toEqual([expect.objectContaining({ sessionId: "chat" })]);
    // One reader of volatile state at build time, one for the client that stayed, none for the one that left.
    expect(overlayRead.mock.calls.length - overlayReadsBefore).toBe(2);
    expect(listSessionsFromDisk).toHaveBeenCalledTimes(1);
  });
});
