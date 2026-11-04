import { describe, expect, it } from "vitest";
import type { ApiRouteTestState } from "../test-support/api-routes.js";
import { installApiRouteTestHooks, request } from "../test-support/api-routes.js";

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

  it("POST /api/sessions/batch announces a bulk archive once", async () => {
    ctx.sessionManager.listSessionsFromDisk = async () => [
      { sessionId: "s1", summary: "Archive me", startTime: "2026-04-19T00:00:00.000Z" },
      { sessionId: "untouched", summary: "Keep me", startTime: "2026-04-18T00:00:00.000Z" },
    ];
    const visible = async () => (await request(app).get("/api/sessions").expect(200)).body.sessions.map((session: { sessionId: string }) => session.sessionId);
    expect(await visible()).toEqual(["s1", "untouched"]);
    const events: Array<{ type: string }> = [];
    ctx.globalBus.subscribe((event) => { if (event.type === "session:archived") events.push(event); });

    const archive = await request(app)
      .post("/api/sessions/batch")
      .send({ sessionIds: ["s1", "s2", "s3", "s2"], action: "archive" });
    expect(archive.status).toBe(200);
    expect(await visible()).toEqual(["untouched"]);
    expect(archive.body).toEqual({ ok: true, errors: {} });
    const restore = await request(app)
      .post("/api/sessions/batch")
      .send({ sessionIds: ["s1"], action: "unarchive" });
    expect(restore.body).toEqual({ ok: true, errors: {} });

    expect(events).toEqual([
      { type: "session:archived", sessionIds: ["s1", "s2", "s3"], archived: true },
      { type: "session:archived", sessionId: "s1", archived: false },
    ]);
    expect(ctx.sessionMetaStore.isArchived("s1")).toBe(false);
    expect(ctx.sessionMetaStore.isArchived("s2")).toBe(true);
    expect(ctx.sessionMetaStore.isArchived("s3")).toBe(true);
  });

  it("POST /api/sessions/batch requires sessionIds", async () => {
    const res = await request(app)
      .post("/api/sessions/batch")
      .send({ action: "archive" });
    expect(res.status).toBe(400);
  });

  it("POST /api/sessions/batch marks sessions read", async () => {
    const first = "2026-01-05T10:00:00.000Z";
    const second = "2026-01-06T10:00:00.000Z";
    ctx.sessionMetaStore.setLastVisibleActivityAt("s1", first);
    ctx.sessionMetaStore.setLastVisibleActivityAt("s2", second);
    ctx.sessionMetaStore.setLastVisibleActivityAt("unselected", first);

    await request(app).post("/api/sessions/batch").send({ sessionIds: ["s1", "s2"], action: "markRead" }).expect(200);
    const saved = await request(app).get("/api/read-state").expect(200);
    expect(saved.body).toEqual({ s1: first, s2: second });
  });
});
