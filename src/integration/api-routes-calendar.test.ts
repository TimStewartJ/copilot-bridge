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
});
