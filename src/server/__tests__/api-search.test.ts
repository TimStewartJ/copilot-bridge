import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createMockSessionManager, makeTestDir } from "./helpers.js";
import { createTestApp } from "./test-app.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

describe("search API", () => {
  it("strictly validates query, scope, identifiers, and pagination", async () => {
    const { app } = createTestApp();

    await request(app).get("/api/search").expect(400, { error: "q is required" });
    await request(app).get("/api/search?q=needle&scope=task").expect(400, {
      error: "taskId is required for task scope",
    });
    await request(app).get("/api/search?q=needle&scope=session&sessionId=bad").expect(400, {
      error: "Valid sessionId is required",
    });
    await request(app).get("/api/search?q=needle&limit=0").expect(400, {
      error: "limit must be an integer between 1 and 50",
    });
    await request(app).get("/api/search?q=needle&scope=global&taskId=extra").expect(400, {
      error: "taskId is only valid for task scope",
    });
  });

  it("searches an archived session from disk without warming it", async () => {
    const copilotHome = makeTestDir("api-search-archived");
    mkdirSync(join(copilotHome, "session-state", SESSION_ID), { recursive: true });
    const manager = {
      ...createMockSessionManager(),
      listSessionsFromDisk: vi.fn(async () => [{ sessionId: SESSION_ID, summary: "Archived needle chat" }]),
      warmSession: vi.fn(async () => {}),
    };
    const { app, ctx } = createTestApp({
      copilotHome,
      sessionManager: manager as ReturnType<typeof createMockSessionManager>,
    });
    ctx.sessionMetaStore.setArchived(SESSION_ID, true);

    const response = await request(app)
      .get(`/api/search?q=needle&scope=session&sessionId=${SESSION_ID}&kind=chat`)
      .expect(200);

    expect(response.body.chats.items).toMatchObject([{
      sessionId: SESSION_ID,
      title: "Archived needle chat",
      archived: true,
      matches: [],
    }]);
    expect(response.body.coverage).toMatchObject({
      state: "ready",
      indexedSessions: 1,
      totalSessions: 1,
    });
    expect(manager.warmSession).not.toHaveBeenCalled();
  });
});

describe("messages-fast exact context API", () => {
  it("returns the explicit bounded context shape without warming", async () => {
    const copilotHome = makeTestDir("api-message-context");
    const sessionDir = join(copilotHome, "session-state", SESSION_ID);
    mkdirSync(sessionDir, { recursive: true });
    const events = Array.from({ length: 8 }, (_, index) => ({
      type: index % 2 === 0 ? "user.message" : "assistant.message",
      id: `event-${index}`,
      timestamp: `2026-09-01T10:00:0${index}.000Z`,
      data: { content: `message ${index}` },
    }));
    writeFileSync(join(sessionDir, "events.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
    const manager = {
      ...createMockSessionManager(),
      warmSession: vi.fn(async () => {}),
    };
    const { app } = createTestApp({
      copilotHome,
      sessionManager: manager as ReturnType<typeof createMockSessionManager>,
    });

    const response = await request(app)
      .get(`/api/sessions/${SESSION_ID}/messages-fast?aroundEventId=event-3&before=2&after=1`)
      .expect(200);

    expect(response.body).toMatchObject({
      aroundEventId: "event-3",
      total: 8,
      targetOffset: 3,
      startOffset: 1,
      endOffset: 5,
      hasMore: true,
      hasNewer: true,
      warm: false,
    });
    expect(manager.warmSession).not.toHaveBeenCalled();
  });

  it("returns 404 when the exact source event is missing", async () => {
    const copilotHome = makeTestDir("api-message-context-missing");
    const sessionDir = join(copilotHome, "session-state", SESSION_ID);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "events.jsonl"), "");
    const { app } = createTestApp({ copilotHome });

    const response = await request(app)
      .get(`/api/sessions/${SESSION_ID}/messages-fast?aroundEventId=missing`)
      .expect(404);
    expect(response.body).toMatchObject({ code: "message_not_found" });
  });
});
