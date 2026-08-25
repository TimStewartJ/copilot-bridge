import { afterEach, describe, expect, it, vi } from "vitest";
import { request } from "./api-routes-test-helpers.js";
import { createTestApp } from "./test-app.js";
import {
  forceClearRestartPending,
  refreshRestartState,
} from "../restart-controller.js";

afterEach(async () => {
  forceClearRestartPending();
  await refreshRestartState();
});

describe("api router server management reliability", () => {
  it("fails active runs before queueing a forced restart", async () => {
    const { app, ctx } = createTestApp();
    let lifecycleBlockingCount = 2;
    ctx.sessionManager.getLifecycleBlockingSessionCount = vi.fn(() => lifecycleBlockingCount);
    ctx.sessionManager.failAllActiveRuns = vi.fn(() => {
      lifecycleBlockingCount = 0;
      return [
        { sessionId: "session-a", promptAccepted: true, attentionMode: "normal" as const },
        { sessionId: "session-b", promptAccepted: false, attentionMode: "quiet" as const },
      ];
    });

    const response = await request(app)
      .post("/api/server/restart")
      .send({ force: true });

    expect(response.status).toBe(202);
    expect(ctx.sessionManager.failAllActiveRuns).toHaveBeenCalledWith("Bridge restart forced by operator");
    expect(response.body).toEqual({
      ok: true,
      waitingSessions: 0,
      forced: true,
      failedRuns: 2,
    });
  });

  it("does not fail active runs for a normal restart", async () => {
    const { app, ctx } = createTestApp();
    ctx.sessionManager.getLifecycleBlockingSessionCount = vi.fn(() => 2);
    ctx.sessionManager.failAllActiveRuns = vi.fn(() => [
      { sessionId: "session-a", promptAccepted: true, attentionMode: "normal" as const },
    ]);

    const response = await request(app).post("/api/server/restart");

    expect(response.status).toBe(202);
    expect(ctx.sessionManager.failAllActiveRuns).not.toHaveBeenCalled();
    expect(response.body).toEqual({ ok: true, waitingSessions: 2 });
  });

  it("includes agent backend status in health", async () => {
    const { app, ctx } = createTestApp();
    ctx.sessionManager.getBackendStatus = vi.fn(() => ({
      state: "reconnecting" as const,
      connection: "disconnected" as const,
      pid: null,
      createdAt: "2026-08-24T12:00:00.000Z",
      lastDisconnect: {
        at: "2026-08-24T12:01:00.000Z",
        reason: "transport_closed",
      },
      disconnectCount: 1,
      recoveryCount: 0,
      lastRecoveryAt: null,
      lastRecoveryError: "backend unavailable",
      lastInterruptedSessionCount: 3,
      lastAutoResumedSessionCount: 0,
    }));

    const response = await request(app).get("/api/health");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      agentBackend: {
        state: "reconnecting",
        connection: "disconnected",
        disconnectCount: 1,
        lastInterruptedSessionCount: 3,
      },
    });
  });
});
