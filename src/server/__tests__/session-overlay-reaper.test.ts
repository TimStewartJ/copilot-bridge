import request from "supertest";
import { describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createMockSessionManager, createTestApp } from "./helpers.js";
import { runSessionOverlayReaper } from "../session-overlay-reaper.js";
import type { DatabaseSync } from "../db.js";

const oldIso = "2026-01-01T00:00:00.000Z";
const nowIso = new Date().toISOString();

function ageState(db: DatabaseSync, sessionId: string, updatedAt = oldIso): void {
  db.prepare("UPDATE bridge_session_state SET createdAt = ?, updatedAt = ? WHERE sessionId = ?")
    .run(updatedAt, updatedAt, sessionId);
}

describe("session overlay reaper", () => {
  it("dry-runs safely and applies only stale unreferenced overlay rows", () => {
    const sessionManager = {
      ...createMockSessionManager(),
      getActiveSessions: () => ["active-session"],
      getPendingUserInputCount: (sessionId: string) => sessionId === "pending-input" ? 1 : 0,
    };
    const { ctx, db } = createTestApp({
      sessionManager,
      cliSessionCatalog: {
        listSessions: () => [{ sessionId: "catalog-session" }],
      } as any,
    });
    const task = ctx.taskStore.createTask("Referenced");

    for (const sessionId of [
      "orphan",
      "task-linked",
      "disk-session",
      "catalog-session",
      "recent-session",
      "active-session",
      "pending-input",
    ]) {
      ctx.bridgeSessionStateStore.setTitleOverride(sessionId, `Title ${sessionId}`);
      ageState(db, sessionId, sessionId === "recent-session" ? nowIso : oldIso);
    }
    ctx.taskStore.linkSession(task.id, "task-linked");
    mkdirSync(join(ctx.copilotHome!, "session-state", "disk-session"), { recursive: true });
    ctx.eventBusRegistry.getOrCreateBus("active-session");

    const dryRun = runSessionOverlayReaper(ctx, { dryRun: true, minimumAgeMs: 24 * 60 * 60 * 1000 });

    expect(dryRun.wouldReap).toBe(1);
    expect(dryRun.reaped).toBe(0);
    expect(dryRun.rows.find((row) => row.sessionId === "orphan")).toMatchObject({
      decision: "reap",
      reasons: [],
    });
    expect(dryRun.rows.find((row) => row.sessionId === "task-linked")?.reasons).toContain("task_link");
    expect(dryRun.rows.find((row) => row.sessionId === "disk-session")?.reasons).toContain("exists_on_disk");
    expect(dryRun.rows.find((row) => row.sessionId === "catalog-session")?.reasons).toContain("exists_in_cli_catalog");
    expect(dryRun.rows.find((row) => row.sessionId === "recent-session")?.reasons).toContain("too_recent");
    expect(dryRun.rows.find((row) => row.sessionId === "active-session")?.reasons).toEqual(expect.arrayContaining([
      "active_session",
      "event_bus",
    ]));
    expect(dryRun.rows.find((row) => row.sessionId === "pending-input")?.reasons).toContain("pending_user_input");

    const applied = runSessionOverlayReaper(ctx, { dryRun: false, minimumAgeMs: 24 * 60 * 60 * 1000 });

    expect(applied.reaped).toBe(1);
    expect(ctx.bridgeSessionStateStore.getState("orphan")).toBeUndefined();
    expect(ctx.bridgeSessionStateStore.getState("task-linked")).toBeDefined();
    expect(ctx.bridgeSessionStateStore.getState("disk-session")).toBeDefined();
    expect(ctx.bridgeSessionStateStore.getState("catalog-session")).toBeDefined();
  });

  it("retains rows when the CLI catalog is unavailable", () => {
    const { ctx, db } = createTestApp({
      cliSessionCatalog: { listSessions: () => undefined } as any,
    });
    ctx.bridgeSessionStateStore.setTitleOverride("catalog-unknown", "Keep");
    ageState(db, "catalog-unknown");

    const report = runSessionOverlayReaper(ctx, { dryRun: false, minimumAgeMs: 24 * 60 * 60 * 1000 });

    expect(report.reaped).toBe(0);
    expect(report.rows[0]).toMatchObject({
      sessionId: "catalog-unknown",
      decision: "retain",
      reasons: ["cli_catalog_unavailable"],
    });
    expect(ctx.bridgeSessionStateStore.getState("catalog-unknown")).toBeDefined();
  });

  it("reports deleted-schedule run groups and deletes them only on explicit apply", async () => {
    const { app, db } = createTestApp({
      cliSessionCatalog: { listSessions: () => [] } as any,
    });
    db.prepare("INSERT INTO schedule_runs (scheduleId, sessionId, recordedAt) VALUES (?, ?, ?)")
      .run("deleted-schedule", "run-1", oldIso);
    db.prepare("INSERT INTO schedule_runs (scheduleId, sessionId, recordedAt) VALUES (?, ?, ?)")
      .run("deleted-schedule", "run-2", oldIso);

    const dryRun = await request(app)
      .post("/api/maintenance/session-overlay-reaper")
      .send({ dryRun: true, cleanupDeletedScheduleRuns: true, minimumAgeMs: 0 })
      .expect(200);

    expect(dryRun.body.deletedScheduleRuns).toMatchObject({
      wouldDelete: 2,
      deleted: 0,
    });
    expect((db.prepare("SELECT COUNT(*) AS count FROM schedule_runs").get() as any).count).toBe(2);

    const applied = await request(app)
      .post("/api/maintenance/session-overlay-reaper")
      .send({ dryRun: false, cleanupDeletedScheduleRuns: true, minimumAgeMs: 0 })
      .expect(200);

    expect(applied.body.deletedScheduleRuns).toMatchObject({
      wouldDelete: 2,
      deleted: 2,
    });
    expect((db.prepare("SELECT COUNT(*) AS count FROM schedule_runs").get() as any).count).toBe(0);
  });
});
