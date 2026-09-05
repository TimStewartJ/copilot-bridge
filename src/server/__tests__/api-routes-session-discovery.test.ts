import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "../session-manager.js";
import { makeTestDir } from "./helpers.js";
import { createTestApp } from "./test-app.js";
import request from "./test-http.js";

function createDiscoveryApp(catalog: "populated" | "empty" | "unavailable" = "populated") {
  const copilotHome = makeTestDir("session-discovery");
  const catalogPath = join(copilotHome, "session-store.db");
  if (catalog === "unavailable") {
    writeFileSync(catalogPath, "unreadable catalog");
  } else {
    const db = new DatabaseSync(catalogPath);
    try {
      db.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY, cwd TEXT, summary TEXT, created_at TEXT, updated_at TEXT
        );
      `);
      if (catalog === "populated") {
        const insert = db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?)");
        for (const id of ["catalog-only", "shared"]) {
          insert.run(id, copilotHome, `Catalog ${id}`, "2026-09-01T10:00:00.000Z", "2026-09-01T10:00:00.000Z");
        }
      }
    } finally {
      db.close();
    }
  }
  const testApp = createTestApp({ copilotHome });
  const { ctx } = testApp;
  ctx.sessionManager = new SessionManager({
    globalBus: ctx.globalBus,
    eventBusRegistry: ctx.eventBusRegistry,
    sessionTitles: ctx.sessionTitles,
    taskStore: ctx.taskStore,
    sessionMetaStore: ctx.sessionMetaStore,
    sessionWorkspaceStore: ctx.sessionWorkspaceStore,
    runtimePaths: ctx.runtimePaths,
    copilotHome,
    config: { sessionMcpServers: {} },
  });
  return { ...testApp, copilotHome };
}

function writePersistedSession(copilotHome: string, id: string, name: string, model = "gpt-5.6-sol") {
  const dir = join(copilotHome, "session-state", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "workspace.yaml"), [
    `id: ${id}`,
    `name: ${name}`,
    "created_at: 2026-09-05T10:00:00.000Z",
  ].join("\r\n"));
  writeFileSync(join(dir, "events.jsonl"), `${JSON.stringify({
    type: "session.start",
    timestamp: "2026-09-05T10:00:00.000Z",
    data: { sessionId: id, selectedModel: model },
  })}\n`);
}

describe("persisted session discovery", () => {
  it.each(["populated", "empty", "unavailable"] as const)(
    "discovers ordinary and HydraFusion sessions with a %s CLI catalog",
    async (catalog) => {
      const { app, ctx, copilotHome } = createDiscoveryApp(catalog);
      writePersistedSession(copilotHome, "ordinary", "Ordinary SDK session");
      writePersistedSession(copilotHome, "fusion", "HydraFusion SDK session", "hydrafusion");
      const task = ctx.taskStore.createTask("Existing missing sessions");
      ctx.taskStore.linkSession(task.id, "ordinary");
      ctx.taskStore.linkSession(task.id, "fusion");

      const res = await request(app).get("/api/sessions");

      expect(res.status).toBe(200);
      expect(res.body.sessions).toEqual(expect.arrayContaining([
        expect.objectContaining({ sessionId: "ordinary", summary: "Ordinary SDK session", linkedTaskIds: [task.id] }),
        expect.objectContaining({ sessionId: "fusion", summary: "HydraFusion SDK session", linkedTaskIds: [task.id] }),
      ]));
      expect(ctx.cliSessionCatalog?.getSession("ordinary")).toBeUndefined();
      expect(ctx.cliSessionCatalog?.getSession("fusion")).toBeUndefined();
    },
  );

  it("merges by ID, retains catalog-only sessions, and preserves workspace names and archive filtering", async () => {
    const { app, ctx, copilotHome } = createDiscoveryApp();
    writePersistedSession(copilotHome, "shared", "Current workspace title");
    writePersistedSession(copilotHome, "archived", "Archived SDK session");
    writePersistedSession(copilotHome, "quick-chat", "Unlinked SDK chat");
    writePersistedSession(copilotHome, "untitled", "");
    writePersistedSession(copilotHome, "b17e1000-0000-4000-8000-000000000001", "Disposable helper");
    ctx.sessionMetaStore.setArchived("archived", true);
    const task = ctx.taskStore.createTask("Untitled task chat");
    ctx.taskStore.linkSession(task.id, "untitled");

    const active = await request(app).get("/api/sessions");
    const all = await request(app).get("/api/sessions?includeArchived=true");

    expect(active.status).toBe(200);
    expect(active.body.sessions.map((session: { sessionId: string }) => session.sessionId).sort()).toEqual([
      "catalog-only", "quick-chat", "shared", "untitled",
    ]);
    expect(active.body.sessions.find((session: { sessionId: string }) => session.sessionId === "shared"))
      .toMatchObject({ summary: "Current workspace title", eventLogSizeBytes: expect.any(Number) });
    expect(active.body.sessions.find((session: { sessionId: string }) => session.sessionId === "untitled"))
      .toMatchObject({ summary: "New session", linkedTaskIds: [task.id] });
    expect(all.status).toBe(200);
    expect(all.body.sessions.map((session: { sessionId: string }) => session.sessionId).sort()).toEqual([
      "archived", "catalog-only", "quick-chat", "shared", "untitled",
    ]);
  });

  it("retains disk-only sessions beyond the optimistic grace period and discovers later creations", async () => {
    const { app, ctx, copilotHome } = createDiscoveryApp();
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    writePersistedSession(copilotHome, "first", "First SDK session");
    const listDisk = vi.spyOn(ctx.sessionManager, "listSessionsFromDisk");

    const first = await request(app).get("/api/sessions");
    expect(first.body.sessions).toEqual(expect.arrayContaining([expect.objectContaining({ sessionId: "first" })]));

    now += 121_000;
    const afterGrace = await request(app).get("/api/sessions");
    expect(afterGrace.body.sessions).toEqual(expect.arrayContaining([expect.objectContaining({ sessionId: "first" })]));

    writePersistedSession(copilotHome, "second", "Later SDK session", "hydrafusion");
    ctx.sessionManager.invalidateSessionListCache("session:create");
    ctx.globalBus.emit({ type: "sessions:changed", sessionId: "second" });

    await vi.waitFor(async () => {
      const refreshed = await request(app).get("/api/sessions");
      expect(refreshed.status).toBe(200);
      expect(refreshed.body.sessions).toEqual(expect.arrayContaining([
        expect.objectContaining({ sessionId: "first" }),
        expect.objectContaining({ sessionId: "second" }),
      ]));
    });
    expect(listDisk.mock.calls.length).toBeGreaterThan(1);
  });

  it("surfaces disk discovery errors instead of returning a misleading catalog-only list", async () => {
    const { app, ctx } = createDiscoveryApp();
    vi.spyOn(ctx.sessionManager, "listSessionsFromDisk").mockRejectedValueOnce(new Error("Session discovery failed"));

    const res = await request(app).get("/api/sessions");

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("Session discovery failed");
  });
});
