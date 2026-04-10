import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../session-manager.js";
import { setupTestDb, createTestBus } from "./helpers.js";
import { createEventBusRegistry } from "../event-bus.js";
import { createSessionTitlesStore } from "../session-titles.js";
import { createTelemetryStore } from "../telemetry-store.js";

describe("SessionManager title generation telemetry", () => {
  let db: ReturnType<typeof setupTestDb>;
  let eventBusRegistry: ReturnType<typeof createEventBusRegistry>;
  let sessionTitles: ReturnType<typeof createSessionTitlesStore>;
  let telemetryStore: ReturnType<typeof createTelemetryStore>;

  beforeEach(() => {
    db = setupTestDb();
    eventBusRegistry = createEventBusRegistry();
    sessionTitles = createSessionTitlesStore(db);
    telemetryStore = createTelemetryStore(db);
  });

  function createManager(config: { model?: string } = {}) {
    return new SessionManager({
      tools: [],
      globalBus: createTestBus(),
      eventBusRegistry,
      sessionTitles,
      taskStore: {} as any,
      telemetryStore,
      config: { sessionMcpServers: {}, model: config.model },
    });
  }

  it("records a successful title generation attempt", async () => {
    const manager = createManager({ model: "gpt-5.4" }) as any;
    const sendAndWait = vi.fn().mockResolvedValue({ data: { content: "Project sync follow-up" } });
    const deleteSession = vi.fn().mockResolvedValue(undefined);
    const createSession = vi.fn().mockResolvedValue({ sessionId: "temp-title-session", sendAndWait });
    manager.client = {
      listModels: vi.fn().mockResolvedValue([{ id: "gpt-5-mini", policy: { state: "enabled" } }]),
      createSession,
      deleteSession,
    };

    await manager.generateSessionTitle("session-1", "User message", "Assistant reply");

    expect(createSession).toHaveBeenCalledWith({
      onPermissionRequest: expect.any(Function),
      model: "gpt-5-mini",
    });
    const spans = telemetryStore.querySpans({ name: "session.title_generation" });
    expect(spans).toHaveLength(1);
    expect(spans[0].sessionId).toBe("session-1");
    expect(spans[0].metadata).toMatchObject({
      outcome: "success",
      model: "gpt-5-mini",
      rawTitle: "Project sync follow-up",
      storedTitle: "Project sync follow-up",
      userChars: 12,
      assistantChars: 15,
    });
    expect(typeof spans[0].duration).toBe("number");
    expect(spans[0].duration).toBeGreaterThanOrEqual(0);
    expect(sessionTitles.getTitle("session-1")).toBe("Project sync follow-up");
    expect(deleteSession).toHaveBeenCalledWith("temp-title-session");
  });

  it("sends the full user and assistant text to title generation", async () => {
    const manager = createManager({ model: "gpt-5.4" }) as any;
    const userMessage = `${"user ".repeat(150)}tail-user`;
    const assistantResponse = `${"assistant ".repeat(150)}tail-assistant`;
    const sendAndWait = vi.fn().mockResolvedValue({ data: { content: "Long conversation title" } });
    manager.client = {
      listModels: vi.fn().mockResolvedValue([{ id: "gpt-5-mini", policy: { state: "enabled" } }]),
      createSession: vi.fn().mockResolvedValue({ sessionId: "temp-title-session", sendAndWait }),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    };

    await manager.generateSessionTitle("session-full", userMessage, assistantResponse);

    expect(sendAndWait).toHaveBeenCalledTimes(1);
    const prompt = sendAndWait.mock.calls[0][0].prompt as string;
    expect(prompt).toContain(`User: ${userMessage}`);
    expect(prompt).toContain(`Assistant: ${assistantResponse}`);
    expect(prompt).toContain("tail-user");
    expect(prompt).toContain("tail-assistant");

    const spans = telemetryStore.querySpans({ name: "session.title_generation", sessionId: "session-full" });
    expect(spans).toHaveLength(1);
    expect(spans[0].metadata).toMatchObject({
      outcome: "success",
      model: "gpt-5-mini",
      userChars: userMessage.length,
      assistantChars: assistantResponse.length,
    });
  });

  it("records invalid title responses with the rejection reason", async () => {
    const manager = createManager({ model: "gpt-5.4" }) as any;
    manager.client = {
      listModels: vi.fn().mockResolvedValue([{ id: "gpt-5-mini", policy: { state: "enabled" } }]),
      createSession: vi.fn().mockResolvedValue({
        sessionId: "temp-title-session",
        sendAndWait: vi.fn().mockResolvedValue({ data: { content: "Generate a concise 3-6 word title for this conversation." } }),
      }),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    };

    await manager.generateSessionTitle("session-2", "User message", "Assistant reply");

    const spans = telemetryStore.querySpans({ name: "session.title_generation" });
    expect(spans).toHaveLength(1);
    expect(spans[0].metadata).toMatchObject({
      outcome: "invalid",
      model: "gpt-5-mini",
      invalidReason: "prompt_echo",
      returnedChars: "Generate a concise 3-6 word title for this conversation.".length,
    });
    expect(spans[0].metadata).not.toHaveProperty("rawTitle");
    expect(sessionTitles.getTitle("session-2")).toBeUndefined();
  });

  it("classifies prompt echoes ahead of the length guard", async () => {
    const manager = createManager({ model: "gpt-5.4" }) as any;
    const echoedPrompt = [
      "Generate a concise 3-6 word title for this conversation.",
      "Reply with ONLY the title text — no quotes, no punctuation unless it's part of a name.",
      "",
      "User: A very long message that pushes the echoed output over the title length limit.",
      "Assistant: Another long reply that keeps the echoed output obviously prompt-shaped.",
    ].join("\n");
    manager.client = {
      listModels: vi.fn().mockResolvedValue([{ id: "gpt-5-mini", policy: { state: "enabled" } }]),
      createSession: vi.fn().mockResolvedValue({
        sessionId: "temp-title-session",
        sendAndWait: vi.fn().mockResolvedValue({ data: { content: echoedPrompt } }),
      }),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    };

    await manager.generateSessionTitle("session-echo", "User message", "Assistant reply");

    const spans = telemetryStore.querySpans({ name: "session.title_generation" });
    expect(spans).toHaveLength(1);
    expect(spans[0].metadata).toMatchObject({
      outcome: "invalid",
      model: "gpt-5-mini",
      invalidReason: "prompt_echo",
      returnedChars: echoedPrompt.length,
    });
    expect(spans[0].metadata).not.toHaveProperty("rawTitle");
  });

  it("records failed title generation attempts", async () => {
    const manager = createManager({ model: "gpt-5.4" }) as any;
    manager.client = {
      listModels: vi.fn().mockResolvedValue([{ id: "gpt-5-mini", policy: { state: "enabled" } }]),
      createSession: vi.fn().mockResolvedValue({
        sessionId: "temp-title-session",
        sendAndWait: vi.fn().mockRejectedValue(new Error("model offline")),
      }),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    };

    await manager.generateSessionTitle("session-3", "User message", "Assistant reply");

    const spans = telemetryStore.querySpans({ name: "session.title_generation" });
    expect(spans).toHaveLength(1);
    expect(spans[0].metadata).toMatchObject({
      outcome: "failed",
      model: "gpt-5-mini",
      error: "model offline",
      userChars: 12,
      assistantChars: 15,
    });
    expect(sessionTitles.getTitle("session-3")).toBeUndefined();
  });

  it("falls back to the configured model when preferred small models are unavailable", async () => {
    const manager = createManager({ model: "claude-sonnet-4.6" }) as any;
    const createSession = vi.fn().mockResolvedValue({
      sessionId: "temp-title-session",
      sendAndWait: vi.fn().mockResolvedValue({ data: { content: "Fallback title" } }),
    });
    manager.client = {
      listModels: vi.fn().mockResolvedValue([{ id: "claude-sonnet-4.6", policy: { state: "enabled" } }]),
      createSession,
      deleteSession: vi.fn().mockResolvedValue(undefined),
    };

    await manager.generateSessionTitle("session-fallback", "User message", "Assistant reply");

    expect(createSession).toHaveBeenCalledWith({
      onPermissionRequest: expect.any(Function),
      model: "claude-sonnet-4.6",
    });
    const spans = telemetryStore.querySpans({ name: "session.title_generation", sessionId: "session-fallback" });
    expect(spans).toHaveLength(1);
    expect(spans[0].metadata).toMatchObject({
      outcome: "success",
      model: "claude-sonnet-4.6",
    });
  });

  it("uses a same-family small model when available", async () => {
    const manager = createManager({ model: "claude-sonnet-4.6" }) as any;
    const createSession = vi.fn().mockResolvedValue({
      sessionId: "temp-title-session",
      sendAndWait: vi.fn().mockResolvedValue({ data: { content: "Claude title" } }),
    });
    manager.client = {
      listModels: vi.fn().mockResolvedValue([
        { id: "claude-sonnet-4.6", policy: { state: "enabled" } },
        { id: "claude-haiku-4.5", policy: { state: "enabled" } },
        { id: "gpt-5-mini", policy: { state: "enabled" } },
      ]),
      createSession,
      deleteSession: vi.fn().mockResolvedValue(undefined),
    };

    await manager.generateSessionTitle("session-claude-small", "User message", "Assistant reply");

    expect(createSession).toHaveBeenCalledWith({
      onPermissionRequest: expect.any(Function),
      model: "claude-haiku-4.5",
    });
    const spans = telemetryStore.querySpans({ name: "session.title_generation", sessionId: "session-claude-small" });
    expect(spans).toHaveLength(1);
    expect(spans[0].metadata).toMatchObject({
      outcome: "success",
      model: "claude-haiku-4.5",
    });
  });

  it("falls back to SDK default when the configured model is unavailable", async () => {
    const manager = createManager({ model: "claude-sonnet-4.6" }) as any;
    const createSession = vi.fn().mockResolvedValue({
      sessionId: "temp-title-session",
      sendAndWait: vi.fn().mockResolvedValue({ data: { content: "Default title" } }),
    });
    manager.client = {
      listModels: vi.fn().mockResolvedValue([{ id: "gpt-4.1", policy: { state: "enabled" } }]),
      createSession,
      deleteSession: vi.fn().mockResolvedValue(undefined),
    };

    await manager.generateSessionTitle("session-sdk-default", "User message", "Assistant reply");

    expect(createSession).toHaveBeenCalledWith({
      onPermissionRequest: expect.any(Function),
    });
    const spans = telemetryStore.querySpans({ name: "session.title_generation", sessionId: "session-sdk-default" });
    expect(spans).toHaveLength(1);
    expect(spans[0].metadata).toMatchObject({
      outcome: "success",
      model: "sdk-default",
    });
  });

  it("recomputes the small model after the configured model changes", async () => {
    const manager = createManager({ model: "gpt-5.4" }) as any;
    const createSession = vi.fn()
      .mockResolvedValueOnce({
        sessionId: "temp-title-session-1",
        sendAndWait: vi.fn().mockResolvedValue({ data: { content: "GPT title" } }),
      })
      .mockResolvedValueOnce({
        sessionId: "temp-title-session-2",
        sendAndWait: vi.fn().mockResolvedValue({ data: { content: "Claude title" } }),
      });
    manager.client = {
      listModels: vi.fn().mockResolvedValue([
        { id: "gpt-5-mini", policy: { state: "enabled" } },
        { id: "claude-haiku-4.5", policy: { state: "enabled" } },
      ]),
      createSession,
      deleteSession: vi.fn().mockResolvedValue(undefined),
    };

    await manager.generateSessionTitle("session-gpt", "User message", "Assistant reply");
    manager.deps.config.model = "claude-sonnet-4.6";
    manager.evictAllCachedSessions();
    await manager.generateSessionTitle("session-claude", "User message", "Assistant reply");

    expect(createSession).toHaveBeenNthCalledWith(1, {
      onPermissionRequest: expect.any(Function),
      model: "gpt-5-mini",
    });
    expect(createSession).toHaveBeenNthCalledWith(2, {
      onPermissionRequest: expect.any(Function),
      model: "claude-haiku-4.5",
    });
  });
});
