import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { annotateClientMessageIds, createChatMessageIdStore } from "../chat-message-id-store.js";
import { createMockSessionManager, makeTestDir, setupTestDb } from "./helpers.js";
import { createTestApp } from "./test-app.js";

const SESSION_ID = "22222222-2222-4222-8222-222222222222";

describe("chat message id store", () => {
  it("looks up client message ids per session in one call and forgets a deleted session", () => {
    const store = createChatMessageIdStore(setupTestDb());
    store.record(SESSION_ID, "message-1", "client-1");
    store.record(SESSION_ID, "message-2", "client-2");
    store.record("other-session", "message-1", "client-other");
    // A resend under the same runtime id keeps the latest browser id.
    store.record(SESSION_ID, "message-2", "client-2b");

    expect(store.getClientMessageIds(SESSION_ID, ["message-1", "message-2", "message-3", "message-1"]))
      .toEqual(new Map([["message-1", "client-1"], ["message-2", "client-2b"]]));
    expect(store.getClientMessageIds(SESSION_ID, [])).toEqual(new Map());

    store.forgetSession(SESSION_ID);
    expect(store.getClientMessageIds(SESSION_ID, ["message-1"])).toEqual(new Map());
    expect(store.getClientMessageIds("other-session", ["message-1"])).toEqual(new Map([["message-1", "client-other"]]));
  });

  it("annotates only user messages, with one lookup per page, and never fails the read", () => {
    const entries = [
      { id: "entry-0", type: "message", role: "user", messageId: "message-1" },
      { id: "entry-1", type: "message", role: "assistant", messageId: "message-2" },
      { id: "entry-2", type: "tool" },
      { id: "entry-3", type: "message", role: "user", messageId: "message-unknown" },
      { id: "entry-4", type: "message", role: "user" },
    ];
    const getClientMessageIds = vi.fn(() => new Map([["message-1", "client-1"], ["message-2", "client-2"]]));

    const annotated = annotateClientMessageIds({ getClientMessageIds }, SESSION_ID, entries);

    expect(getClientMessageIds).toHaveBeenCalledTimes(1);
    expect(getClientMessageIds).toHaveBeenCalledWith(SESSION_ID, ["message-1", "message-unknown"]);
    expect(annotated[0]).toEqual({ ...entries[0], clientMessageId: "client-1" });
    expect(entries[0]).not.toHaveProperty("clientMessageId");
    expect(annotated.slice(1)).toEqual(entries.slice(1));

    const failing = vi.fn(() => {
      throw new Error("database is locked");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(annotateClientMessageIds({ getClientMessageIds: failing }, SESSION_ID, entries)).toBe(entries);
    } finally {
      warn.mockRestore();
    }
    expect(annotateClientMessageIds(undefined, SESSION_ID, entries)).toBe(entries);
  });
});

describe("messages-fast client message ids", () => {
  it("names the browser message each saved user message was sent as", async () => {
    const copilotHome = makeTestDir("api-client-message-ids");
    const sessionDir = join(copilotHome, "session-state", SESSION_ID);
    mkdirSync(sessionDir, { recursive: true });
    const events = [
      { type: "user.message", id: "event-1", timestamp: "2026-10-22T10:00:00.000Z", data: { content: "first", messageId: "message-1" } },
      { type: "assistant.message", id: "event-2", timestamp: "2026-10-22T10:00:01.000Z", data: { content: "reply" } },
      { type: "user.message", id: "event-3", timestamp: "2026-10-22T10:00:02.000Z", data: { content: "second", messageId: "message-2" } },
      { type: "user.message", id: "event-4", timestamp: "2026-10-22T10:00:03.000Z", data: { content: "third" } },
    ];
    writeFileSync(join(sessionDir, "events.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
    const manager = { ...createMockSessionManager(), warmSession: vi.fn(async () => {}) };
    const { app, ctx } = createTestApp({
      copilotHome,
      sessionManager: manager as ReturnType<typeof createMockSessionManager>,
    });
    ctx.chatMessageIdStore?.record(SESSION_ID, "message-1", "client-1");
    const userMessages = (body: { messages: Array<Record<string, unknown>> }) => body.messages
      .filter((message) => message.role === "user")
      .map((message) => ({
        content: message.content,
        messageId: message.messageId,
        clientMessageId: message.clientMessageId,
      }));
    const expected = [
      { content: "first", messageId: "message-1", clientMessageId: "client-1" },
      { content: "second", messageId: "message-2", clientMessageId: undefined },
      { content: "third", messageId: undefined, clientMessageId: undefined },
    ];

    const around = await request(app)
      .get(`/api/sessions/${SESSION_ID}/messages-fast?aroundEventId=event-2&before=5&after=5`)
      .expect(200);
    expect(userMessages(around.body)).toEqual(expected);

    manager.readMessagesFromDisk = vi.fn(async () => ({
      messages: [
        { id: "entry-0", type: "message", role: "user", content: "first", messageId: "message-1" },
        { id: "entry-1", type: "message", role: "assistant", content: "reply" },
      ],
      total: 2,
      hasMore: false,
      coverage: {},
    })) as unknown as typeof manager.readMessagesFromDisk;
    const page = await request(app).get(`/api/sessions/${SESSION_ID}/messages-fast?limit=50`).expect(200);
    expect(userMessages(page.body)).toEqual([expected[0]]);
  });
});
