import { describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  deriveModelStateFromEventsContent,
  deriveModelStateFromEventsFile,
} from "../session-events-model.js";
import { SessionManager } from "../session-manager.js";
import { setupTestDb, createTestBus, createTestApp, makeTestDir } from "./helpers.js";
import { createEventBusRegistry } from "../event-bus.js";
import { createSessionTitlesStore } from "../session-titles.js";
import supertest from "supertest";

// ── Parser unit tests ───────────────────────────────────────────────────────

describe("deriveModelStateFromEventsContent", () => {
  it("returns empty state for empty content", () => {
    expect(deriveModelStateFromEventsContent("")).toEqual({});
  });

  it("returns empty state for content with no model events", () => {
    const content = [
      JSON.stringify({ type: "user.message", data: { content: "hello" } }),
      JSON.stringify({ type: "assistant.message", data: { content: "world" } }),
    ].join("\n");
    expect(deriveModelStateFromEventsContent(content)).toEqual({});
  });

  it("derives model from session.start", () => {
    const content = JSON.stringify({
      type: "session.start",
      data: { selectedModel: "claude-opus-4.7", reasoningEffort: "high" },
    });
    expect(deriveModelStateFromEventsContent(content)).toEqual({
      model: "claude-opus-4.7",
      reasoningEffort: "high",
    });
  });

  it("derives model from session.resume", () => {
    const content = JSON.stringify({
      type: "session.resume",
      data: { selectedModel: "gpt-5.5", reasoningEffort: "medium" },
    });
    expect(deriveModelStateFromEventsContent(content)).toEqual({
      model: "gpt-5.5",
      reasoningEffort: "medium",
    });
  });

  it("derives model from session.model_change", () => {
    const content = JSON.stringify({
      type: "session.model_change",
      data: { newModel: "claude-opus-4.7", reasoningEffort: "xhigh" },
    });
    expect(deriveModelStateFromEventsContent(content)).toEqual({
      model: "claude-opus-4.7",
      reasoningEffort: "xhigh",
    });
  });

  it("later event wins over earlier event", () => {
    const lines = [
      JSON.stringify({ type: "session.start", data: { selectedModel: "claude-opus-4.7", reasoningEffort: "low" } }),
      JSON.stringify({ type: "user.message", data: { content: "do something" } }),
      JSON.stringify({ type: "session.model_change", data: { newModel: "gpt-5.5", reasoningEffort: "high" } }),
    ];
    expect(deriveModelStateFromEventsContent(lines.join("\n"))).toEqual({
      model: "gpt-5.5",
      reasoningEffort: "high",
    });
  });

  it("resume overrides start", () => {
    const lines = [
      JSON.stringify({ type: "session.start", data: { selectedModel: "claude-opus-4.7", reasoningEffort: "low" } }),
      JSON.stringify({ type: "session.resume", data: { selectedModel: "gpt-5.5", reasoningEffort: "medium" } }),
    ];
    expect(deriveModelStateFromEventsContent(lines.join("\n"))).toEqual({
      model: "gpt-5.5",
      reasoningEffort: "medium",
    });
  });

  it("model_change preserves previous reasoningEffort when it omits it", () => {
    const lines = [
      JSON.stringify({ type: "session.start", data: { selectedModel: "claude-opus-4.7", reasoningEffort: "high" } }),
      JSON.stringify({ type: "session.model_change", data: { newModel: "gpt-5.5" } }),
    ];
    expect(deriveModelStateFromEventsContent(lines.join("\n"))).toEqual({
      model: "gpt-5.5",
      reasoningEffort: "high",
    });
  });

  it("skips malformed lines gracefully", () => {
    const lines = [
      "not json at all {{{",
      JSON.stringify({ type: "session.start", data: { selectedModel: "claude-opus-4.7" } }),
      "{ broken",
    ];
    expect(deriveModelStateFromEventsContent(lines.join("\n"))).toEqual({
      model: "claude-opus-4.7",
    });
  });

  it("skips blank lines", () => {
    const lines = [
      "",
      "   ",
      JSON.stringify({ type: "session.start", data: { selectedModel: "claude-opus-4.7" } }),
      "",
    ];
    expect(deriveModelStateFromEventsContent(lines.join("\n"))).toEqual({
      model: "claude-opus-4.7",
    });
  });

  it("ignores session.start without selectedModel", () => {
    const content = JSON.stringify({ type: "session.start", data: { otherField: "x" } });
    expect(deriveModelStateFromEventsContent(content)).toEqual({});
  });

  it("includes reasoningEffort-only start when model is present", () => {
    const content = JSON.stringify({
      type: "session.start",
      data: { selectedModel: "claude-opus-4.7", reasoningEffort: "low" },
    });
    const state = deriveModelStateFromEventsContent(content);
    expect(state.model).toBe("claude-opus-4.7");
    expect(state.reasoningEffort).toBe("low");
  });
});

describe("deriveModelStateFromEventsFile", () => {
  it("returns empty state when file does not exist", () => {
    expect(deriveModelStateFromEventsFile("/nonexistent/path/events.jsonl")).toEqual({});
  });

  it("reads and parses events from a real file", () => {
    const dir = makeTestDir("events-file-test");
    const eventsPath = join(dir, "events.jsonl");
    writeFileSync(
      eventsPath,
      JSON.stringify({ type: "session.start", data: { selectedModel: "gpt-5.5", reasoningEffort: "high" } }),
    );
    expect(deriveModelStateFromEventsFile(eventsPath)).toEqual({
      model: "gpt-5.5",
      reasoningEffort: "high",
    });
  });
});

// ── SessionManager.getSessionModelState ────────────────────────────────────

function createManager(copilotHome: string) {
  const db = setupTestDb();
  return new SessionManager({
    tools: [],
    globalBus: createTestBus(),
    eventBusRegistry: createEventBusRegistry(),
    sessionTitles: createSessionTitlesStore(db),
    taskStore: {
      findTaskBySessionId: vi.fn().mockReturnValue(null),
    } as any,
    settingsStore: {
      getMcpServers: () => ({}),
      getSettings: () => ({}),
    } as any,
    config: { sessionMcpServers: {} },
    copilotHome,
  }) as any;
}

describe("SessionManager.getSessionModelState", () => {
  it("returns source=unknown when no session cache and no events file", async () => {
    const dir = makeTestDir("model-state-unknown");
    const manager = createManager(dir);
    const result = await manager.getSessionModelState("missing-session");
    expect(result).toEqual({ source: "unknown" });
  });

  it("returns source=events from events.jsonl for inactive session", async () => {
    const dir = makeTestDir("model-state-events");
    const sessionDir = join(dir, "session-state", "my-session");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "events.jsonl"),
      JSON.stringify({ type: "session.start", data: { selectedModel: "gpt-5.5", reasoningEffort: "medium" } }),
    );
    const manager = createManager(dir);
    const result = await manager.getSessionModelState("my-session");
    expect(result).toEqual({ model: "gpt-5.5", reasoningEffort: "medium", source: "events" });
  });

  it("returns source=live for a cached active session with rpc", async () => {
    const dir = makeTestDir("model-state-live");
    const sessionDir = join(dir, "session-state", "live-session");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "events.jsonl"),
      JSON.stringify({ type: "session.start", data: { selectedModel: "old-model", reasoningEffort: "high" } }),
    );
    const manager = createManager(dir);
    const mockSession = {
      rpc: {
        model: {
          getCurrent: vi.fn().mockResolvedValue({ modelId: "live-model-id" }),
        },
      },
    };
    manager.sessionObjects.set("live-session", mockSession);

    const result = await manager.getSessionModelState("live-session");
    expect(result.source).toBe("live");
    expect(result.model).toBe("live-model-id");
    // reasoning from events.jsonl
    expect(result.reasoningEffort).toBe("high");
  });

  it("falls back to events when live rpc.getCurrent throws", async () => {
    const dir = makeTestDir("model-state-rpc-error");
    const sessionDir = join(dir, "session-state", "session-x");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "events.jsonl"),
      JSON.stringify({ type: "session.resume", data: { selectedModel: "fallback-model", reasoningEffort: "low" } }),
    );
    const manager = createManager(dir);
    const mockSession = {
      rpc: {
        model: {
          getCurrent: vi.fn().mockRejectedValue(new Error("RPC error")),
        },
      },
    };
    manager.sessionObjects.set("session-x", mockSession);

    const result = await manager.getSessionModelState("session-x");
    expect(result.source).toBe("events");
    expect(result.model).toBe("fallback-model");
  });

  it("falls back to events when live rpc returns no modelId", async () => {
    const dir = makeTestDir("model-state-no-modelid");
    const sessionDir = join(dir, "session-state", "session-y");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "events.jsonl"),
      JSON.stringify({ type: "session.model_change", data: { newModel: "event-model" } }),
    );
    const manager = createManager(dir);
    const mockSession = {
      rpc: { model: { getCurrent: vi.fn().mockResolvedValue({ modelId: undefined }) } },
    };
    manager.sessionObjects.set("session-y", mockSession);

    const result = await manager.getSessionModelState("session-y");
    expect(result.source).toBe("events");
    expect(result.model).toBe("event-model");
  });

  it("cached live model overrides event model while retaining reasoning from events", async () => {
    const dir = makeTestDir("model-state-live-override");
    const sessionDir = join(dir, "session-state", "session-z");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "events.jsonl"),
      [
        JSON.stringify({ type: "session.start", data: { selectedModel: "stale-model", reasoningEffort: "low" } }),
        JSON.stringify({ type: "session.model_change", data: { newModel: "new-model", reasoningEffort: "high" } }),
      ].join("\n"),
    );
    const manager = createManager(dir);
    const mockSession = {
      rpc: { model: { getCurrent: vi.fn().mockResolvedValue({ modelId: "live-current" }) } },
    };
    manager.sessionObjects.set("session-z", mockSession);

    const result = await manager.getSessionModelState("session-z");
    expect(result.source).toBe("live");
    expect(result.model).toBe("live-current");
    expect(result.reasoningEffort).toBe("high");
  });
});

// ── GET /api/sessions/:id/model route ──────────────────────────────────────

describe("GET /api/sessions/:id/model route", () => {
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const missingSessionId = "22222222-2222-4222-8222-222222222222";
  const errorSessionId = "33333333-3333-4333-8333-333333333333";

  it("returns model state JSON with source field", async () => {
    const { app } = createTestApp();
    const res = await supertest(app).get(`/api/sessions/${sessionId}/model`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("source");
  });

  it("returns 400 for invalid session IDs", async () => {
    const { app } = createTestApp();
    const res = await supertest(app).get("/api/sessions/not-a-uuid/model");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sessionId/i);
  });

  it("returns 200 with source=unknown when no state found", async () => {
    const { app } = createTestApp();
    const res = await supertest(app).get(`/api/sessions/${missingSessionId}/model`);
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("unknown");
  });

  it("returns model and reasoningEffort when manager provides them", async () => {
    const { app } = createTestApp({
      sessionManager: {
        listSessions: async () => [],
        listSessionsFromDisk: () => [],
        getSessionActivity: () => [],
        isSessionBusy: () => false,
        getSessionRunState: () => "idle",
        getPendingUserInputCount: () => 0,
        isSessionWarm: () => false,
        setSessionModel: async (_id: string, model: string, reasoningEffort?: string) => ({
          model,
          ...(reasoningEffort ? { reasoningEffort } : {}),
        }),
        getSessionModelState: async () => ({
          model: "claude-opus-4.7",
          reasoningEffort: "high",
          source: "events" as const,
        }),
      } as any,
    });
    const res = await supertest(app).get(`/api/sessions/${sessionId}/model`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ model: "claude-opus-4.7", reasoningEffort: "high", source: "events" });
  });

  it("returns 500 on internal error", async () => {
    const { app } = createTestApp({
      sessionManager: {
        listSessions: async () => [],
        listSessionsFromDisk: () => [],
        getSessionActivity: () => [],
        isSessionBusy: () => false,
        getSessionRunState: () => "idle",
        getPendingUserInputCount: () => 0,
        isSessionWarm: () => false,
        setSessionModel: async () => { throw new Error("oops"); },
        getSessionModelState: async () => { throw new Error("getSessionModelState failed"); },
      } as any,
    });
    const res = await supertest(app).get(`/api/sessions/${errorSessionId}/model`);
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/getSessionModelState failed/i);
  });
});
