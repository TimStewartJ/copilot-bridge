import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { request } from "../test-support/api-routes.js";
import { createTestApp } from "../test-support/api-routes.js";
import {
  beginRestartPending,
  forceClearRestartPending,
  isRestartCutoverInProgress,
  isRestartForced,
  refreshRestartState,
} from "../server/restart-controller.js";
import { parseRestartSignalContent } from "../server/restart-signal.js";
import { RESTART_RECOVERY_CONTINUE_PROMPT } from "../server/restart-resume.js";

afterEach(async () => {
  forceClearRestartPending();
  await refreshRestartState();
});

describe("api router server management reliability", () => {
  it("forces cutover before aborting active work for a forced restart", async () => {
    const { app, ctx } = createTestApp();
    ctx.sessionManager.getLifecycleBlockingSessionCount = vi.fn(() => 2);
    ctx.sessionManager.getActiveRuns = vi.fn(() => [
      { sessionId: "session-a", promptAccepted: true, attentionMode: "normal" as const },
      { sessionId: "session-b", promptAccepted: false, attentionMode: "quiet" as const },
    ]);
    ctx.interruptedRunStore!.markAccepted("session-a", "normal");
    ctx.interruptedRunStore!.markAccepted("session-elsewhere", "normal");
    ctx.sessionManager.abortActiveWork = vi.fn(async () => {
      expect(isRestartCutoverInProgress()).toBe(true);
      // Declined resume: the marker is gone before the launcher can cut over mid-abort,
      // so the next boot cannot resume a run the user chose to drop.
      expect(ctx.interruptedRunStore!.list().map((marker) => marker.sessionId)).toEqual(["session-elsewhere"]);
    });

    const response = await request(app)
      .post("/api/server/restart")
      .send({ force: true });

    expect(response.status).toBe(202);
    expect(ctx.sessionManager.abortActiveWork).toHaveBeenCalledOnce();
    expect(response.body).toEqual({
      ok: true,
      waitingSessions: 2,
      forced: true,
      abortedRuns: 2,
    });
    expect((await request(app).get("/api/busy")).body).toMatchObject({ restartForced: true });
    expect((await request(app).get("/api/restart-status")).body).toMatchObject({ canAcceptNewWork: false });

    forceClearRestartPending();
    expect(isRestartForced()).toBe(false);
    expect(isRestartCutoverInProgress()).toBe(false);
  });

  it("does not abort active work for a normal restart", async () => {
    const { app, ctx } = createTestApp();
    ctx.sessionManager.getLifecycleBlockingSessionCount = vi.fn(() => 2);
    ctx.sessionManager.abortActiveWork = vi.fn(async () => {});

    const response = await request(app).post("/api/server/restart");

    expect(response.status).toBe(202);
    expect(ctx.sessionManager.abortActiveWork).not.toHaveBeenCalled();
    expect(isRestartForced()).toBe(false);
    expect(response.body).toEqual({ ok: true, waitingSessions: 2 });
    expect(parseRestartSignalContent(
      readFileSync(join(ctx.runtimePaths!.dataDir, "restart.signal"), "utf8"),
    )).toMatchObject({
      validationMode: "operational",
      requestId: expect.any(String),
      source: "settings_ui",
    });
  });

  it("queues durable resume prompts before aborting a pending restart's runs", async () => {
    const { app, ctx } = createTestApp();
    ctx.sessionManager.getLifecycleBlockingSessionCount = vi.fn(() => 3);
    ctx.sessionManager.getActiveRuns = vi.fn(() => [
      { sessionId: "session-a", promptAccepted: true, attentionMode: "normal" as const },
      { sessionId: "session-b", promptAccepted: true, attentionMode: "quiet" as const },
      { sessionId: "session-c", promptAccepted: false, attentionMode: "normal" as const },
    ]);
    ctx.interruptedRunStore!.markAccepted("session-a", "normal");
    ctx.sessionManager.abortActiveWork = vi.fn(async () => {
      expect(ctx.deferredPromptStore?.listForSession("session-a")).toHaveLength(1);
      // Requested resume: the marker stays, so a cutover mid-abort still resumes the run.
      expect(ctx.interruptedRunStore!.list().map((marker) => marker.sessionId)).toEqual(["session-a"]);
    });
    beginRestartPending();

    const response = await request(app)
      .post("/api/server/restart")
      .send({ force: true, resume: true });

    expect(response.status).toBe(202);
    expect(ctx.sessionManager.abortActiveWork).toHaveBeenCalledOnce();
    expect(response.body).toEqual({
      ok: true,
      waitingSessions: 3,
      forced: true,
      abortedRuns: 3,
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
      recoveryBlockedAt: null,
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
