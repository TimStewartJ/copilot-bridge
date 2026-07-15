import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { request } from "./api-routes-test-helpers.js";
import { createTestApp } from "./helpers.js";
import { createManagementJobStore } from "../management-job-store.js";
import {
  clearRestartPending,
  refreshRestartState,
} from "../restart-controller.js";
import { readRestartSignalFile } from "../restart-signal.js";

afterEach(async () => {
  clearRestartPending();
  await refreshRestartState();
});

describe("server management API routes", () => {
  it("reports current in-memory session and agent activity", async () => {
    const { app, ctx } = createTestApp();
    ctx.sessionManager.getRuntimeActivity = () => ({
      sessions: { active: 3, stalled: 1, waitingForUserInput: 2 },
      agents: {
        running: 4,
        idle: 2,
        failed: 1,
        total: 9,
        liveSessions: 3,
        staleSessions: 1,
        unknownSessions: 0,
      },
    });

    const response = await request(app).get("/api/server/runtime-status");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      pid: process.pid,
      isStaging: false,
      sessions: { active: 3, stalled: 1, waitingForUserInput: 2 },
      agents: {
        running: 4,
        idle: 2,
        failed: 1,
        total: 9,
        liveSessions: 3,
        staleSessions: 1,
        unknownSessions: 0,
      },
    });
    expect(response.body.fetchedAt).toEqual(expect.any(String));
    expect(response.body.serverInstanceId).toEqual(expect.any(String));
    expect(response.body.uptimeSeconds).toEqual(expect.any(Number));
    expect(response.body.sourceManagementAvailable).toEqual(expect.any(Boolean));
  });

  it("queues an operational restart while counting every active session", async () => {
    const { app, ctx } = createTestApp();
    ctx.sessionManager.getActiveSessions = () => ["session-a", "session-b"];
    const dataDir = ctx.runtimePaths!.dataDir;

    const response = await request(app).post("/api/server/restart");

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ ok: true, waitingSessions: 2 });
    expect(readRestartSignalFile(join(dataDir, "restart.signal"))).toMatchObject({
      validationMode: "operational",
      source: "settings_ui",
    });
    await expect(refreshRestartState()).resolves.toMatchObject({
      phase: "waiting-for-sessions",
      waitingSessions: 2,
    });
  });

  it("rejects restart requests from staging previews and cross-site callers", async () => {
    const staging = createTestApp({ isStaging: true });
    const stagingResponse = await request(staging.app).post("/api/server/restart");
    expect(stagingResponse.status).toBe(404);
    expect(existsSync(join(staging.ctx.runtimePaths!.dataDir, "restart.signal"))).toBe(false);

    const production = createTestApp();
    const crossSiteResponse = await request(production.app)
      .post("/api/server/restart")
      .set("Host", "localhost:3333")
      .set("Origin", "https://evil.example.test");
    expect(crossSiteResponse.status).toBe(403);
    expect(existsSync(join(production.ctx.runtimePaths!.dataDir, "restart.signal"))).toBe(false);
  });

  it("rejects restart requests while an update or deploy job is active", async () => {
    const { app, ctx, db } = createTestApp();
    const store = createManagementJobStore(db, { dataDir: ctx.runtimePaths!.dataDir });
    ctx.managementJobStore = store;
    const active = store.enqueue("self_update", {});

    const response = await request(app).post("/api/server/restart");

    expect(response.status).toBe(409);
    expect(response.body.activeJob).toMatchObject({
      id: active.id,
      type: "self_update",
      status: "queued",
    });
    expect(existsSync(join(ctx.runtimePaths!.dataDir, "restart.signal"))).toBe(false);
  });
});
