import { describe, expect, it, vi } from "vitest";
import { createMockSessionManager, createTestApp, request } from "../test-support/api-routes.js";

describe("GET /api/sessions/:id/model route", () => {
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const missingSessionId = "22222222-2222-4222-8222-222222222222";
  const errorSessionId = "33333333-3333-4333-8333-333333333333";

  it("returns 400 for invalid session IDs", async () => {
    const { app } = createTestApp();
    const res = await request(app).get("/api/sessions/not-a-uuid/model");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sessionId/i);
  });

  it("returns 200 with source=unknown when no state found", async () => {
    const { app } = createTestApp();
    const res = await request(app).get(`/api/sessions/${missingSessionId}/model`);
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("unknown");
  });

  it("answers for a chat still being created once it is made, not with guesses", async () => {
    let created = false;
    const { app } = createTestApp({
      sessionManager: {
        ...createMockSessionManager(),
        waitForSessionCreation: vi.fn(async () => { created = true; }),
        getSessionModelState: async () => (created
          ? { model: "model-picked", source: "live" as const }
          : { source: "unknown" as const }),
        getSessionPlaybook: () => (created ? { playbook: "research", source: "user", label: "Research" } : {}),
      } as any,
    });
    const res = await request(app).get(`/api/sessions/${sessionId}/model`);
    expect(res.body).toEqual({ model: "model-picked", source: "live", playbook: { playbook: "research", source: "user", label: "Research" } });
  });

  it("returns 500 on internal error", async () => {
    const { app } = createTestApp({
      sessionManager: {
        listSessions: async () => [],
        listSessionsFromDisk: () => [],
        getSessionActivity: () => [],
        isSessionBusy: () => false,
        getSessionRunState: () => "idle",
        getPendingUserInputCount: () => 0,
        isSessionWarm: () => false,
        waitForSessionCreation: async () => {},
        setSessionModel: async () => { throw new Error("oops"); },
        getSessionModelState: async () => { throw new Error("getSessionModelState failed"); },
      } as any,
    });
    const res = await request(app).get(`/api/sessions/${errorSessionId}/model`);
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/getSessionModelState failed/i);
  });
});

describe("PATCH /api/sessions/:id/model route", () => {
  const sessionId = "11111111-1111-4111-8111-111111111111";

  it("returns 400 when model is missing", async () => {
    const { app } = createTestApp();
    const res = await request(app).patch(`/api/sessions/${sessionId}/model`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/model/i);
  });

  it("returns 400 when model is empty string or only whitespace", async () => {
    const { app } = createTestApp();
    for (const model of ["", "   "]) {
      const res = await request(app).patch(`/api/sessions/${sessionId}/model`).send({ model });
      expect(res.status, `model=${JSON.stringify(model)}`).toBe(400);
    }
  });

  it("returns 400 when reasoningEffort is not advertised by the SDK", async () => {
    const { app } = createTestApp({
      sessionManager: {
        ...createMockSessionManager(),
        listModels: async () => [
          { id: "gpt-5.5", name: "GPT-5.5", supportedReasoningEfforts: ["low", "medium", "high", "xhigh"] },
        ],
      } as any,
    });
    const res = await request(app)
      .patch(`/api/sessions/${sessionId}/model`)
      .send({ model: "gpt-5.5", reasoningEffort: "extreme" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/reasoningEffort/i);
  });

  it("accepts an SDK-advertised reasoningEffort the legacy allowlist would have rejected", async () => {
    const setSessionModel = vi.fn(async (_id: string, model: string, reasoningEffort?: string, contextTier?: string) => ({
      model, reasoningEffort, contextTier,
    }));
    const { app } = createTestApp({
      sessionManager: {
        ...createMockSessionManager(),
        setSessionModel,
        listModels: async () => [
          { id: "claude-opus-4.7-1m", name: "Opus 1M", supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"] },
        ],
      } as any,
    });
    const res = await request(app)
      .patch(`/api/sessions/${sessionId}/model`)
      .send({ model: "claude-opus-4.7-1m", reasoningEffort: "max", contextTier: "long_context" });
    expect(res.status).toBe(200);
    expect(setSessionModel).toHaveBeenCalledWith(sessionId, "claude-opus-4.7-1m", "max", "long_context");
    expect(res.body).toEqual({ model: "claude-opus-4.7-1m", reasoningEffort: "max", contextTier: "long_context" });
  });

  it("returns 400 when contextTier is invalid", async () => {
    const { app } = createTestApp();
    const res = await request(app)
      .patch(`/api/sessions/${sessionId}/model`)
      .send({ model: "gpt-5.5", contextTier: "huge" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/contextTier/i);
  });

  it("returns 409 when session is busy", async () => {
    const { app } = createTestApp({
      sessionManager: {
        listSessions: async () => [],
        listSessionsFromDisk: () => [],
        getSessionActivity: () => [],
        isSessionBusy: () => false,
        getSessionRunState: () => "idle",
        getPendingUserInputCount: () => 0,
        isSessionWarm: () => false,
        waitForSessionCreation: async () => {},
        setSessionModel: async () => {
          throw new Error("Cannot switch model on a busy session");
        },
      } as any,
    });
    const res = await request(app)
      .patch(`/api/sessions/${sessionId}/model`)
      .send({ model: "gpt-5.5" });
    expect(res.status).toBe(409);
  });

  it("returns the compaction confirmation and forwards the follow-up compaction decision", async () => {
    const confirmation = { targetModelDisplayName: "GPT-5 mini", currentTokens: 156_169, targetLimit: 128_000 };
    const setSessionModel = vi.fn()
      .mockResolvedValueOnce({ status: "confirmation_required", model: "gpt-5-mini", confirmation })
      .mockResolvedValueOnce({ status: "applied", model: "gpt-5-mini", modelId: "gpt-5-mini" });
    const { app } = createTestApp({
      sessionManager: { ...createMockSessionManager(), setSessionModel } as any,
    });

    const probe = await request(app)
      .patch(`/api/sessions/${sessionId}/model`)
      .send({ model: "gpt-5-mini" });
    expect(probe.status).toBe(200);
    expect(probe.body).toEqual({ status: "confirmation_required", model: "gpt-5-mini", confirmation });
    expect(setSessionModel).toHaveBeenNthCalledWith(1, sessionId, "gpt-5-mini", undefined, undefined);

    const compact = await request(app)
      .patch(`/api/sessions/${sessionId}/model`)
      .send({ model: "gpt-5-mini", compactionDecision: "compact" });
    expect(compact.status).toBe(200);
    expect(compact.body).toEqual({ status: "applied", model: "gpt-5-mini", modelId: "gpt-5-mini" });
    expect(setSessionModel).toHaveBeenNthCalledWith(2, sessionId, "gpt-5-mini", undefined, undefined, {
      compactionDecision: "compact",
    });
  });

  it("returns 400 when compactionDecision is invalid", async () => {
    const setSessionModel = vi.fn();
    const { app } = createTestApp({
      sessionManager: { ...createMockSessionManager(), setSessionModel } as any,
    });
    const res = await request(app)
      .patch(`/api/sessions/${sessionId}/model`)
      .send({ model: "gpt-5-mini", compactionDecision: "maybe" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/compactionDecision/);
    expect(setSessionModel).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid session IDs", async () => {
    const { app } = createTestApp();
    const res = await request(app)
      .patch("/api/sessions/not-a-uuid/model")
      .send({ model: "gpt-5.5" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sessionId/i);
  });
});
