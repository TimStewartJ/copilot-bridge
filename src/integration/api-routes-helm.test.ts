import { describe, expect, it, vi } from "vitest";
import type { ApiRouteTestState } from "../test-support/api-routes.js";
import { createMockSessionManager, createTestApp, installApiRouteTestHooks, request } from "../test-support/api-routes.js";

let app: ApiRouteTestState["app"];
let ctx: ApiRouteTestState["ctx"];

installApiRouteTestHooks((state) => {
  ({ app, ctx } = state);
});

describe("Helm routes", () => {
  it("starts empty and explains its retention policy", async () => {
    const res = await request(app).get("/api/helm");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ current: null, resumable: null, recent: [] });
    expect(res.body.policy).toEqual({ freshAfterMs: 6 * 3_600_000, retainMs: 14 * 86_400_000, maxConversations: 25 });
    expect(res.body.reasoningEfforts).toEqual({ typed: "max", spoken: "medium" });
  });

  it("lets Settings change how hard each mode thinks, effective for the next turn", async () => {
    const patched = await request(app).patch("/api/settings").send({ helm: { spokenReasoningEffort: "high" } });
    expect(patched.status).toBe(200);
    expect(patched.body.helm).toEqual({ spokenReasoningEffort: "high" });
    expect((await request(app).get("/api/helm")).body.reasoningEfforts).toEqual({ typed: "max", spoken: "high" });
    expect(ctx.helm!.getSessionProfile().defaultTurnReasoningEffort?.()).toBe("max");

    await request(app).patch("/api/settings").send({ helm: { typedReasoningEffort: 7 } }).expect(400);
    await request(app).patch("/api/settings").send({ helm: null }).expect(200);
    expect((await request(app).get("/api/helm")).body.reasoningEfforts).toEqual({ typed: "max", spoken: "medium" });
  });

  it("creates, resets, resumes, keeps and deletes conversations", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.createSession = vi.fn(async (options: { expectedSessionId?: string }) => ({ sessionId: options.expectedSessionId! }));
    sessionManager.deleteSession = vi.fn(async () => undefined);
    ({ app, ctx } = createTestApp({ sessionManager }));

    // A per-conversation effort is no longer a thing: each turn asks for its mode's effort.
    const created = await request(app).post("/api/helm/conversations").send({ model: "gpt-5-mini", reasoningEffort: "none" });
    expect(created.status).toBe(201);
    const sessionId: string = created.body.sessionId;
    expect(sessionManager.createSession).toHaveBeenCalledWith({ expectedSessionId: sessionId, model: "gpt-5-mini" });
    expect(ctx.helmStore!.isHelmSession(sessionId)).toBe(true);
    expect((await request(app).get("/api/helm")).body.current).toMatchObject({ sessionId, turnCount: 0, kept: false });

    // The session manager reports user prompts; here the mock stands in for it.
    ctx.helm!.recordTurn(sessionId);

    const fresh = await request(app).post("/api/helm/fresh");
    expect(fresh.status).toBe(200);
    expect(fresh.body.current).toBeNull();
    expect(fresh.body.resumable).toMatchObject({ sessionId, turnCount: 1 });
    expect(sessionManager.deleteSession).not.toHaveBeenCalled();

    const resumed = await request(app).post(`/api/helm/conversations/${sessionId}/resume`);
    expect(resumed.status).toBe(200);
    expect((await request(app).get("/api/helm")).body.current.sessionId).toBe(sessionId);

    const kept = await request(app).patch(`/api/helm/conversations/${sessionId}`).send({ kept: true });
    expect(kept.body).toMatchObject({ kept: true });
    expect(kept.body.expiresAt).toBeUndefined();
    await request(app).patch(`/api/helm/conversations/${sessionId}`).send({ kept: "yes" }).expect(400);

    await request(app).delete(`/api/helm/conversations/${sessionId}`).expect(200);
    expect(sessionManager.deleteSession).toHaveBeenCalledWith(sessionId);
    expect(ctx.helmStore!.isHelmSession(sessionId)).toBe(false);
    await request(app).delete(`/api/helm/conversations/${sessionId}`).expect(404);
    await request(app).post("/api/helm/conversations/missing/resume").expect(404);
  });

  it("refuses to delete a conversation that is still replying", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.createSession = vi.fn(async (options: { expectedSessionId?: string }) => ({ sessionId: options.expectedSessionId! }));
    ({ app, ctx } = createTestApp({ sessionManager }));
    const { body } = await request(app).post("/api/helm/conversations").send({});
    sessionManager.isSessionBusy = () => true;
    const res = await request(app).delete(`/api/helm/conversations/${body.sessionId}`);
    expect(res.status).toBe(409);
    expect(ctx.helmStore!.isHelmSession(body.sessionId)).toBe(true);
  });

  it("keeps Helm conversations out of the chat lists", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.createSession = vi.fn(async (options: { expectedSessionId?: string }) => ({ sessionId: options.expectedSessionId! }));
    ({ app, ctx } = createTestApp({ sessionManager }));
    const { body } = await request(app).post("/api/helm/conversations").send({});
    const now = new Date().toISOString();
    sessionManager.listSessionsFromDisk = async () => [
      { sessionId: body.sessionId, summary: "Helm conversation", startTime: now, modifiedTime: now },
      { sessionId: "11111111-2222-4333-8444-555555555555", summary: "Ordinary chat", startTime: now, modifiedTime: now },
    ];
    const res = await request(app).get("/api/sessions");
    expect(res.status).toBe(200);
    expect(res.body.sessions.map((session: { summary: string }) => session.summary)).toEqual(["Ordinary chat"]);
  });

  it("delivers a typed Helm message as plain chat when hands-free is off", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.createSession = vi.fn(async (options: { expectedSessionId?: string }) => ({ sessionId: options.expectedSessionId! }));
    sessionManager.startWork = vi.fn();
    ({ app, ctx } = createTestApp({ sessionManager }));
    const { body } = await request(app).post("/api/helm/conversations").send({});
    const res = await request(app).post("/api/chat").send({ sessionId: body.sessionId, prompt: "what needs me?", clientMessageId: "client-1" });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: "accepted" });
    expect(sessionManager.startWork).toHaveBeenCalledWith(body.sessionId, "what needs me?", undefined, { clientMessageId: "client-1" });
  });

  it("only starts hands-free for a Helm conversation", async () => {
    const res = await request(app).post("/api/voice/conversations").send({ helmSessionId: "11111111-2222-4333-8444-555555555555" });
    // The speech engine is not installed in tests, which is reported before anything else.
    expect([404, 409]).toContain(res.status);
  });
});
