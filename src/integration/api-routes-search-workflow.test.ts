import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createMockSessionManager,
  createTestApp,
  makeTestDir,
  request,
} from "../test-support/api-routes.js";
import type { BridgeSearchResponse } from "../shared/search.js";

const SESSION_ID = "cc72d2b5-c445-47f1-8f8f-0703538716b9";

function createSearchWorld() {
  const copilotHome = makeTestDir("search-workflow");
  const sessionDir = join(copilotHome, "session-state", SESSION_ID);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, "workspace.yaml"), [
    "summary: Archived search conversation",
    "created_at: 2026-09-01T10:00:00.000Z",
  ].join("\n"));
  const events = Array.from({ length: 120 }, (_, index) => ({
    id: `message-${index}`,
    type: "user.message",
    timestamp: "2026-09-01T10:00:00.000Z",
    data: { content: index === 10 ? "Remember the cobalt lighthouse passage." : `Ordinary message ${index}.` },
  }));
  const eventsPath = join(sessionDir, "events.jsonl");
  const saveEvents = () => writeFileSync(eventsPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  saveEvents();
  const sessionManager = createMockSessionManager();
  sessionManager.listSessionsFromDisk = vi.fn().mockResolvedValue([{
    sessionId: SESSION_ID,
    summary: "Archived search conversation",
    startTime: "2026-09-01T10:00:00.000Z",
    modifiedTime: "2026-09-01T10:00:00.000Z",
  }]);
  const world = createTestApp({ copilotHome, sessionManager });
  return { ...world, events, saveEvents, sessionManager };
}

async function search(app: ReturnType<typeof createTestApp>["app"], query: Record<string, string>): Promise<BridgeSearchResponse> {
  const response = await request(app).get("/api/search").query(query);
  expect(response.status).toBe(200);
  return response.body;
}

describe("Search retrieval workflow", () => {
  it("finds all three domains and opens an archived passage beyond the initial history window without warming", async () => {
    const { app, ctx, sessionManager } = createSearchWorld();
    const task = ctx.taskStore.createTask("Cobalt lighthouse project");
    ctx.taskStore.linkSession(task.id, SESSION_ID);
    await request(app).patch(`/api/sessions/${SESSION_ID}`).send({ archived: true }).expect(200);
    await request(app).put("/api/docs/pages/cobalt-notes").send({
      content: "# Navigation notes\n\nThe cobalt lighthouse is the reference point.",
    }).expect(200);

    const result = await search(app, { q: '"cobalt lighthouse"' });
    expect(result.coverage.state).toBe("ready");
    expect(result.chats.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sessionId: SESSION_ID,
        archived: true,
        taskId: task.id,
        matches: expect.arrayContaining([expect.objectContaining({ sourceEventId: "message-10" })]),
      }),
    ]));
    expect(result.tasks.items.map((hit) => hit.taskId)).toContain(task.id);
    expect(result.docs.items.map((hit) => hit.path)).toContain("cobalt-notes");

    const context = await request(app)
      .get(`/api/sessions/${SESSION_ID}/messages-fast`)
      .query({ aroundEventId: "message-10", before: "10", after: "9" });
    expect(context.status).toBe(200);
    expect(context.body.messages).toHaveLength(20);
    expect(context.body.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceEventId: "message-10" }),
    ]));
    expect(context.body.hasNewer).toBe(true);
    expect(sessionManager.warmSession).not.toHaveBeenCalled();

    const scoped = await search(app, { q: "cobalt", scope: "session", sessionId: SESSION_ID });
    expect(scoped.chats.total).toBe(1);
    expect(scoped.tasks.total).toBe(0);
    expect(scoped.docs.total).toBe(0);
    const taskScoped = await search(app, { q: "cobalt", scope: "task", taskId: task.id });
    expect(taskScoped.chats.total).toBe(1);
    expect(taskScoped.tasks.total).toBe(1);
    expect(taskScoped.docs.total).toBe(0);
  });

  it("does not retain rewritten passages or silently resolve removed message links", async () => {
    const { app, events, saveEvents, sessionManager } = createSearchWorld();
    expect((await search(app, { q: "cobalt" })).chats.total).toBe(1);
    events.splice(10, 1);
    saveEvents();

    expect((await search(app, { q: "cobalt" })).chats.total).toBe(0);
    const removed = await request(app)
      .get(`/api/sessions/${SESSION_ID}/messages-fast`)
      .query({ aroundEventId: "message-10" });
    expect(removed.status).toBe(404);
    expect(removed.body.error).toBeTruthy();
    expect(sessionManager.warmSession).not.toHaveBeenCalled();
  });

  it("rejects ambiguous scopes and exposes Docs failure separately from chat matches", async () => {
    const { app, ctx } = createSearchWorld();
    await request(app).get("/api/search").query({ q: "cobalt", scope: "task" }).expect(400);
    await request(app).get("/api/search").query({ q: "cobalt", scope: "global", sessionId: SESSION_ID }).expect(400);
    expect(ctx.docsIndex).toBeDefined();
    vi.spyOn(ctx.docsIndex!, "search").mockImplementation(() => {
      throw new Error("Docs index unavailable");
    });
    const result = await search(app, { q: "cobalt" });
    expect(result.coverage.state).toBe("partial");
    expect(result.coverage.errors.join(" ")).toMatch(/docs/i);
    expect(result.chats.total).toBe(1);
  });
});
