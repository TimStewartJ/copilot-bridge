import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { request } from "./api-routes-test-helpers.js";
import { createTestApp } from "./test-app.js";
import {
  beginRestartPending,
  forceClearRestartPending,
  refreshRestartState,
} from "../restart-controller.js";
import { parseRestartSignalContent } from "../restart-signal.js";
import { RESTART_RECOVERY_CONTINUE_PROMPT } from "../restart-resume.js";

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
    expect(parseRestartSignalContent(
      readFileSync(join(ctx.runtimePaths!.dataDir, "restart.signal"), "utf8"),
    )).toMatchObject({
      validationMode: "operational",
      requestId: expect.any(String),
      source: "settings_ui",
    });
  });

  it("aborts a pending restart's interactive runs and queues durable resume prompts", async () => {
    const { app, ctx } = createTestApp();
    let lifecycleBlockingCount = 2;
    ctx.sessionManager.getLifecycleBlockingSessionCount = vi.fn(() => lifecycleBlockingCount);
    ctx.sessionManager.failAllActiveRuns = vi.fn(() => {
      lifecycleBlockingCount = 0;
      return [
        { sessionId: "session-a", promptAccepted: true, attentionMode: "normal" as const },
        { sessionId: "session-b", promptAccepted: true, attentionMode: "quiet" as const },
        { sessionId: "session-c", promptAccepted: false, attentionMode: "normal" as const },
      ];
    });
    beginRestartPending();

    const response = await request(app)
      .post("/api/server/restart")
      .send({ force: true, resume: true });

    expect(response.status).toBe(202);
    expect(response.body).toEqual({
      ok: true,
      waitingSessions: 0,
      forced: true,
      failedRuns: 3,
      resumingRuns: 1,
    });
    expect(ctx.deferredPromptStore?.listForSession("session-a")).toEqual([
      expect.objectContaining({
        prompt: RESTART_RECOVERY_CONTINUE_PROMPT,
        status: "pending",
      }),
    ]);
    expect(ctx.deferredPromptStore?.listForSession("session-b")).toEqual([]);
    expect(ctx.deferredPromptStore?.listForSession("session-c")).toEqual([]);
  });

  it("clears only the matching restart request and rejects malformed identities", async () => {
    const { app } = createTestApp();
    const first = beginRestartPending();
    const second = beginRestartPending();

    const staleResponse = await request(app)
      .post("/api/restart-clear")
      .send({ requestId: first.requestId });
    expect(staleResponse.status).toBe(200);
    expect(staleResponse.body).toEqual({ ok: true, cleared: false });
    expect((await refreshRestartState()).requestId).toBe(second.requestId);

    const invalidResponse = await request(app)
      .post("/api/restart-clear")
      .send({ requestId: " " });
    expect(invalidResponse.status).toBe(400);
    expect((await refreshRestartState()).requestId).toBe(second.requestId);

    const currentResponse = await request(app)
      .post("/api/restart-clear")
      .send({ requestId: second.requestId });
    expect(currentResponse.status).toBe(200);
    expect(currentResponse.body).toEqual({ ok: true, cleared: true });
    expect((await refreshRestartState()).phase).toBe("idle");
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
