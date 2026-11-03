import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createTestApp } from "../server/__tests__/test-app.js";
import { getBridgeToolDefinitions } from "../server/agent-tools-mcp/register.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const { withTestSourceCheckout } = await import("../server/__tests__/test-paths.js");
  return { ...actual, existsSync: withTestSourceCheckout(actual.existsSync) };
});

const ZONE = "America/Los_Angeles";

describe("calendar API", () => {
  it("keeps events, lists them beside deadlines and revisits, and answers errors plainly", async () => {
    const { app, ctx } = createTestApp();
    const task = ctx.taskStore.createTask("Trip", undefined, "task");
    ctx.taskStore.updateTask(task.id, { nextTouchAt: "2031-05-06T16:00:00.000Z" });
    ctx.checklistStore.createChecklistItem(task.id, "Book flights", "2031-05-07");

    const created = await request(app).post("/api/calendar/events").send({
      title: "Dentist", allDay: false, start: "2031-05-05T09:00:00-07:00", timezone: ZONE, location: "Main St", taskId: task.id,
      repeat: { every: "week", interval: 1 },
    });
    expect(created.status).toBe(201);
    expect(created.body.event).toMatchObject({ start: "2031-05-05T16:00:00.000Z", end: "2031-05-05T17:00:00.000Z", createdBy: "user" });
    const id = created.body.event.id;

    const week = await request(app).get("/api/calendar").query({ from: "2031-05-05", to: "2031-05-11", timezone: ZONE });
    expect(week.status).toBe(200);
    expect(week.body.items.map((item: { kind: string; title: string }) => `${item.kind}:${item.title}`))
      .toEqual(["event:Dentist", "revisit:Trip", "deadline:Book flights"]);
    expect((await request(app).get("/api/calendar").query({ from: "2031-05-05", to: "2031-05-11", timezone: ZONE, taskId: task.id })).body.items).toHaveLength(3);

    const cleared = await request(app).patch(`/api/calendar/events/${id}`).send({ location: null, repeat: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.event.location).toBeUndefined();
    expect(cleared.body.event.repeat).toBeUndefined();
    expect((await request(app).get(`/api/calendar/events/${id}`)).body.event.title).toBe("Dentist");

    for (const [method, path, body] of [
      ["post", "/api/calendar/events", { title: "No zone", allDay: false, start: "2031-05-05T09:00:00-07:00" }],
      ["post", "/api/calendar/events", { title: "Backwards", allDay: true, start: "2031-05-05", end: "2031-05-04", timezone: ZONE }],
      ["post", "/api/calendar/events", { title: "Naive time", allDay: false, start: "2031-05-05T09:00", timezone: ZONE }],
      ["post", "/api/calendar/events", { title: "No such day", allDay: false, start: "2031-02-30T09:00:00Z", timezone: ZONE }],
      ["patch", `/api/calendar/events/${id}`, { allDay: true }],
      ["patch", `/api/calendar/events/${id}`, { colour: "red" }],
    ] as const) {
      const response = await request(app)[method](path).send(body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect((await request(app).get("/api/calendar").query({ from: "2031-05-05", to: "2031-09-05", timezone: ZONE })).status).toBe(400);

    ctx.taskStore.deleteTask(task.id);
    expect(ctx.calendarStore!.getEvent(id)?.taskId).toBeUndefined();
    expect((await request(app).delete(`/api/calendar/events/${id}`)).status).toBe(200);
    expect((await request(app).delete(`/api/calendar/events/${id}`)).status).toBe(404);
    expect((await request(app).get(`/api/calendar/events/${id}`)).status).toBe(404);

    const names = getBridgeToolDefinitions(ctx).map((tool) => tool.name);
    for (const name of ["calendar_list", "calendar_event_create", "calendar_event_update", "calendar_event_delete"]) expect(names).toContain(name);
  });

  it("imports events by externalId without duplicates, and deletes them in bulk", async () => {
    const { app, ctx } = createTestApp();
    const tools = new Map(getBridgeToolDefinitions(ctx).map((tool) => [tool.name, tool]));
    const call = (name: string, args: Record<string, unknown>) => tools.get(name)!.handler(args, {}) as Promise<any>;
    const task = ctx.taskStore.createTask("Trip", undefined, "task");
    const imported = (n: number, overrides: Record<string, unknown> = {}) => ({
      title: `Meeting ${n}`, start: `2031-05-0${n}T09:00:00-07:00`, timezone: ZONE, externalId: `source:${n}`, ...overrides,
    });

    const first = await call("calendar_event_create", { events: [imported(5), imported(6), { title: "Local", start: "2031-05-07T09:00:00-07:00", timezone: ZONE }] });
    expect(first).toMatchObject({ success: true, created: 3, updated: 0, unchanged: 0 });
    const [five, six, local] = first.results;
    expect(five).toMatchObject({ externalId: "source:5", result: "created" });
    expect(local.externalId).toBeUndefined();

    // Linking an imported event to a task survives later imports that do not name one.
    await call("calendar_event_update", { eventId: five.eventId, taskId: task.id });
    const again = await call("calendar_event_create", { events: [imported(5), imported(6, { location: "Room 2" })] });
    expect(again).toMatchObject({ created: 0, updated: 1, unchanged: 1 });
    expect(again.results).toEqual([
      { eventId: five.eventId, externalId: "source:5", result: "unchanged" },
      { eventId: six.eventId, externalId: "source:6", result: "updated" },
    ]);
    expect(ctx.calendarStore!.getEvent(five.eventId)?.taskId).toBe(task.id);
    expect(ctx.calendarStore!.getEvent(six.eventId)?.location).toBe("Room 2");
    const repeat = await call("calendar_event_create", { events: [imported(5), imported(6, { location: "Room 2" })] });
    expect(repeat).toMatchObject({ created: 0, updated: 0, unchanged: 2 });

    // The single-event shape upserts too, and so does the REST route.
    expect(await call("calendar_event_create", imported(6, { title: "Renamed" }))).toMatchObject({ result: "updated", event: { id: six.eventId, title: "Renamed" } });
    const posted = await request(app).post("/api/calendar/events").send({ ...imported(6, { title: "Renamed" }), allDay: false });
    expect(posted.status).toBe(200);
    expect(posted.body).toMatchObject({ result: "unchanged", event: { id: six.eventId } });
    expect(ctx.calendarStore!.listEvents()).toHaveLength(3);

    // A batch is saved whole or not at all.
    const rejected = await call("calendar_event_create", { events: [imported(8), imported(8)] });
    expect(rejected.resultType).toBe("failure");
    expect(rejected.textResultForLlm).toContain("events[1]");
    expect((await call("calendar_event_create", { events: [imported(9), imported(8, { taskId: "missing-task" })] })).resultType).toBe("failure");
    expect(ctx.calendarStore!.listEvents()).toHaveLength(3);
    expect((await call("calendar_event_update", { eventId: local.eventId, externalId: "source:5" })).resultType).toBe("failure");

    const listed = await call("calendar_list", { from: "2031-05-05", to: "2031-05-11", timezone: ZONE });
    expect(listed.items.filter((item: { kind: string }) => item.kind === "event").map((item: { eventId: string; externalId?: string }) => [item.eventId, item.externalId]))
      .toEqual([[five.eventId, "source:5"], [six.eventId, "source:6"], [local.eventId, undefined]]);

    expect(await call("calendar_event_delete", { eventIds: [five.eventId, "missing", six.eventId] }))
      .toEqual({ success: true, deleted: [five.eventId, six.eventId], notFound: ["missing"] });
    expect(ctx.calendarStore!.listEvents().map((event) => event.id)).toEqual([local.eventId]);
    expect((await call("calendar_event_delete", { eventId: "missing" })).resultType).toBe("failure");
  });

  it("keeps where an imported event came from and lists every import source", async () => {
    const { ctx } = createTestApp();
    const tools = new Map(getBridgeToolDefinitions(ctx).map((tool) => [tool.name, tool]));
    const call = (name: string, args: Record<string, unknown>) => tools.get(name)!.handler(args, {}) as Promise<any>;
    const at = (day: number) => `2031-05-0${day}T09:00:00-07:00`;

    const saved = await call("calendar_event_create", { events: [
      { title: "Standup", start: at(5), timezone: ZONE, externalId: "a:1", source: " Work-Mail " },
      { title: "Far away", start: "2031-09-01T09:00:00-07:00", timezone: ZONE, externalId: "b:1", source: "family" },
      { title: "Unnamed", start: at(6), timezone: ZONE, externalId: "c:1" },
      { title: "Dentist", start: at(7), timezone: ZONE },
    ] });
    expect(saved).toMatchObject({ success: true, created: 4 });
    expect(ctx.calendarStore!.getEvent(saved.results[0].eventId)?.source).toBe("work-mail");

    // Sources cover every stored event, not just the window, so the filters stay put between weeks.
    const listed = await call("calendar_list", { from: "2031-05-05", to: "2031-05-11", timezone: ZONE });
    expect(listed.importedSources).toEqual(["family", "work-mail", "imported"]);
    expect(listed.items.filter((item: { kind: string }) => item.kind === "event").map((item: { title: string; source?: string }) => [item.title, item.source]))
      .toEqual([["Standup", "work-mail"], ["Unnamed", undefined], ["Dentist", undefined]]);

    // Re-importing without a source clears it, like any other field the import leaves out.
    expect(await call("calendar_event_create", { title: "Standup", start: at(5), timezone: ZONE, externalId: "a:1" })).toMatchObject({ result: "updated" });
    expect(ctx.calendarStore!.getEvent(saved.results[0].eventId)?.source).toBeUndefined();

    expect((await call("calendar_event_create", { title: "Own", start: at(8), timezone: ZONE, source: "outlook" })).textResultForLlm).toContain("source needs an externalId");
    expect((await call("calendar_event_create", { title: "Bad", start: at(8), timezone: ZONE, externalId: "d:1", source: "has space" })).resultType).toBe("failure");
  });

  it("gives own events and each source a colour the person can change", async () => {
    const { app, ctx } = createTestApp();
    ctx.calendarStore!.saveEvents([
      { title: "Standup", allDay: false, start: "2031-05-05T09:00:00-07:00", timezone: ZONE, externalId: "o:1", source: "outlook" },
      { title: "Hike", allDay: false, start: "2031-05-06T09:00:00-07:00", timezone: ZONE, externalId: "f:1", source: "family" },
    ]);
    const colors = async () => (await request(app).get("/api/calendar").query({ from: "2031-05-05", to: "2031-05-11", timezone: ZONE })).body.colors;
    expect(await colors()).toEqual({ own: "emerald", sources: { family: "slate", outlook: "blue" } });

    expect((await request(app).patch("/api/calendar/colors").send({ own: "amber", sources: { family: "rose" } })).status).toBe(200);
    expect((await request(app).patch("/api/calendar/colors").send({ sources: { outlook: "indigo" } })).status).toBe(200);
    expect(await colors()).toEqual({ own: "amber", sources: { family: "rose", outlook: "indigo" } });

    expect((await request(app).patch("/api/calendar/colors").send({ own: "teal" })).status).toBe(400);
    expect((await request(app).patch("/api/calendar/colors").send({ sources: { "Not A Source": "blue" } })).status).toBe(400);
    expect(await colors()).toEqual({ own: "amber", sources: { family: "rose", outlook: "indigo" } });
  });
});
