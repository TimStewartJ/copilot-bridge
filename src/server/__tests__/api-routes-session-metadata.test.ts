import { describe, expect, it } from "vitest";
import type { ApiRouteTestState } from "./api-routes-test-helpers.js";
import { installApiRouteTestHooks, request } from "./api-routes-test-helpers.js";

let app: ApiRouteTestState["app"];
let ctx: ApiRouteTestState["ctx"];

installApiRouteTestHooks((state) => {
  ({ app, ctx } = state);
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

  it("DELETE /api/sessions/:id prunes read state for the deleted session", async () => {
    ctx.readStateStore.markRead("deleted-sess", "2026-05-21T12:00:00.000Z");
    ctx.readStateStore.markRead("kept-sess", "2026-05-21T12:05:00.000Z");

    const res = await request(app).delete("/api/sessions/deleted-sess");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const state = await request(app).get("/api/read-state");
    expect(state.body["deleted-sess"]).toBeUndefined();
    expect(state.body["kept-sess"]).toBe("2026-05-21T12:05:00.000Z");
  });

  it("POST /api/sessions/batch archives multiple sessions", async () => {
    const res = await request(app)
      .post("/api/sessions/batch")
      .send({ sessionIds: ["s1", "s2"], action: "archive" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("POST /api/sessions/batch invalidates the cached session list after archiving", async () => {
    ctx.sessionManager.listSessionsFromDisk = async () => [
      { sessionId: "s1", summary: "Session one", startTime: "2026-04-19T00:00:00.000Z", lastVisibleActivityAt: "2026-04-19T00:00:00.000Z" } as any,
      { sessionId: "s2", summary: "Session two", startTime: "2026-04-19T00:00:00.000Z", lastVisibleActivityAt: "2026-04-19T00:00:00.000Z" } as any,
    ];
    ctx.readStateStore.markRead("s1");
    ctx.readStateStore.markRead("s2");

    const before = await request(app).get("/api/sessions");
    expect(before.status).toBe(200);
    expect(before.body.sessions.map((session: { sessionId: string }) => session.sessionId)).toEqual(["s1", "s2"]);

    const archive = await request(app)
      .post("/api/sessions/batch")
      .send({ sessionIds: ["s1"], action: "archive" });
    expect(archive.status).toBe(200);
    expect(archive.body.ok).toBe(true);

    const after = await request(app).get("/api/sessions");
    expect(after.status).toBe(200);
    expect(after.body.sessions.map((session: { sessionId: string }) => session.sessionId)).toEqual(["s2"]);
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
