import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { request, createTestApp } from "../test-support/api-routes.js";
import { createManagementJobStore } from "../server/management-job-store.js";
import { readRestartSignalFile, requestRestart } from "../server/restart-signal.js";
import { RESTART_RECOVERY_CONTINUE_PROMPT } from "../server/restart-resume.js";
import type { ServerShutdownCoordinator } from "../server/shutdown-coordinator.js";

function setupRestart() {
  const shutdown = vi.fn<ServerShutdownCoordinator["request"]>(async () => {});
  const fixture = createTestApp({}, { shutdownCoordinator: { request: shutdown, activeDeadline: () => null } });
  return { ...fixture, shutdown };
}

describe("api router server management reliability", () => {
  it("joins an existing restart without shutting down or refusing new work", async () => {
    const { app, ctx, shutdown } = setupRestart();
    ctx.sessionManager.getLifecycleBlockingSessionCount = vi.fn(() => 2);
    const first = await requestRestart(ctx.runtimePaths!.dataDir, { validationMode: "operational", source: "test" });
    const response = await request(app).post("/api/server/restart");
    expect(response.status).toBe(202);
    expect(response.body).toEqual({ ok: true, waitingOn: { sessions: 2, jobs: 0 } });
    expect(readRestartSignalFile(join(ctx.runtimePaths!.dataDir, "restart.signal"))).toEqual(first);
    expect(shutdown).not.toHaveBeenCalled();
    ctx.sessionManager.startWork = vi.fn();
    expect((await request(app).post("/api/chat").send({ sessionId: "session-a", prompt: "keep working" })).status).toBe(202);
    expect(ctx.sessionManager.startWork).toHaveBeenCalledOnce();
  });

  it("stores resume prompts before an explicitly requested immediate shutdown", async () => {
    const { app, ctx, shutdown } = setupRestart();
    ctx.sessionManager.getActiveRuns = vi.fn<typeof ctx.sessionManager.getActiveRuns>(() => [
      { sessionId: "session-a", promptAccepted: true, attentionMode: "normal" },
      { sessionId: "session-b", promptAccepted: true, attentionMode: "quiet" },
      { sessionId: "session-c", promptAccepted: false, attentionMode: "normal" },
    ]);
    shutdown.mockImplementation(async () => {
      expect(ctx.deferredPromptStore!.listForSession("session-a")).toEqual([
        expect.objectContaining({ prompt: RESTART_RECOVERY_CONTINUE_PROMPT, status: "pending" }),
      ]);
      expect(ctx.deferredPromptStore!.listForSession("session-b")).toEqual([]);
      expect(ctx.deferredPromptStore!.listForSession("session-c")).toEqual([]);
    });
    const response = await request(app).post("/api/server/restart").send({ force: true, resume: true });
    expect(response.status).toBe(202);
    expect(response.body).toEqual({ ok: true, forced: true, abortedRuns: 3, resumingRuns: 1 });
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it("clears interrupted-run markers before shutdown when the user declines resume", async () => {
    const { app, ctx, shutdown } = setupRestart();
    ctx.sessionManager.getActiveRuns = vi.fn<typeof ctx.sessionManager.getActiveRuns>(() => [{ sessionId: "session-a", promptAccepted: true, attentionMode: "normal" }]);
    ctx.interruptedRunStore!.markAccepted("session-a", "normal");
    ctx.interruptedRunStore!.markAccepted("unrelated-session", "normal");
    shutdown.mockImplementation(async () => {
      expect(ctx.interruptedRunStore!.list().map((marker) => marker.sessionId)).toEqual(["unrelated-session"]);
    });
    const response = await request(app).post("/api/server/restart").send({ force: true });
    expect(response.status).toBe(202);
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it("checks sessions and jobs again in the shutdown-if-idle handshake", async () => {
    const { app, ctx, db, shutdown } = setupRestart();
    ctx.sessionManager.getLifecycleBlockingSessionCount = vi.fn(() => 1);
    expect((await request(app).post("/api/shutdown").send({ ifIdle: true })).status).toBe(409);
    ctx.sessionManager.getLifecycleBlockingSessionCount = vi.fn(() => 0);
    const store = createManagementJobStore(db, { dataDir: ctx.runtimePaths!.dataDir });
    ctx.managementJobStore = store;
    const deploy = store.enqueue("staging_deploy", { stagingDir: "pending" });
    expect((await request(app).post("/api/shutdown").send({ ifIdle: true })).status).toBe(409);
    store.succeed(deploy.id, { restartDeferred: true });
    expect((await request(app).post("/api/shutdown").send({ ifIdle: true })).status).toBe(409);
    expect(shutdown).not.toHaveBeenCalled();
    store.succeed(deploy.id, { restartQueued: true, restartDeferred: false });
    expect((await request(app).post("/api/shutdown").send({ ifIdle: true })).status).toBe(200);
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it("waits for runtime activity and rechecks work arriving during the idle probe", async () => {
    const { app, ctx, shutdown } = setupRestart();
    ctx.sessionManager.isRuntimeIdle = vi.fn(async () => false);
    expect((await request(app).post("/api/shutdown").send({ ifIdle: true })).status).toBe(409);
    ctx.sessionManager.isRuntimeIdle = vi.fn(async () => {
      ctx.sessionManager.getLifecycleBlockingSessionCount = () => 1;
      return true;
    });
    expect((await request(app).post("/api/shutdown").send({ ifIdle: true })).status).toBe(409);
    expect(shutdown).not.toHaveBeenCalled();
  });

  it("waits for voice processing before accepting idle shutdown", async () => {
    const { app, ctx, shutdown } = setupRestart();
    ctx.transcriptionService.getActiveCount = () => 1;
    const response = await request(app).post("/api/shutdown").send({ ifIdle: true });
    expect(response.status).toBe(409);
    expect(response.body.operations).toBe(1);
    expect(shutdown).not.toHaveBeenCalled();
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
