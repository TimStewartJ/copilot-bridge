import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clearRestartPending, SessionManager } from "../session-manager.js";
import { setupTestDb, createTestBus, createTestApp, makeTestDir } from "./helpers.js";
import { createEventBusRegistry } from "../event-bus.js";
import { createSessionTitlesStore } from "../session-titles.js";
import supertest from "supertest";

function createManager(copilotHome?: string) {
  const db = setupTestDb();
  return new SessionManager({
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
    ...(copilotHome ? { copilotHome } : {}),
  }) as any;
}

function createMockSession(currentModelId?: string) {
  const setModel = vi.fn(async () => {});
  const getCurrent = vi.fn(async () => ({ modelId: currentModelId }));
  return {
    setModel,
    getCurrentModel: getCurrent,
    disconnect: vi.fn(),
  };
}

const GPT_55_TIERED_MODEL = {
  id: "gpt-5.5",
  name: "GPT-5.5",
  capabilities: {
    limits: {
      max_context_window_tokens: 1_050_000,
      max_prompt_tokens: 922_000,
      max_output_tokens: 128_000,
    },
  },
  billing: {
    tokenPrices: {
      inputPrice: 500,
      outputPrice: 3000,
      cachePrice: 50,
      batchSize: 1_000_000,
      contextMax: 272_000,
      longContext: {
        inputPrice: 1000,
        outputPrice: 4500,
        cachePrice: 100,
        contextMax: 1_050_000,
      },
    },
  },
};

describe("SessionManager.setSessionModel", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearRestartPending();
  });

  it("calls setModel on a cached session and returns model info", async () => {
    const manager = createManager();
    const session = createMockSession("gpt-5.5");
    manager.backend = {};
    manager.sessionObjects.set("session-1", session);

    const result = await manager.setSessionModel("session-1", "gpt-5.5");

    expect(session.setModel).toHaveBeenCalledWith("gpt-5.5", undefined);
    expect(result).toEqual({ model: "gpt-5.5", modelId: "gpt-5.5" });
  });

  it("passes reasoningEffort to setModel", async () => {
    const manager = createManager();
    const session = createMockSession("gpt-5.5");
    manager.backend = {};
    manager.sessionObjects.set("session-1", session);

    const result = await manager.setSessionModel("session-1", "claude-opus-4.7", "high");

    expect(session.setModel).toHaveBeenCalledWith("claude-opus-4.7", { reasoningEffort: "high" });
    expect(result).toMatchObject({ model: "claude-opus-4.7", reasoningEffort: "high" });
  });

  it("caps tiered models when selecting the default context tier", async () => {
    const manager = createManager(makeTestDir("model-context-default"));
    const session = createMockSession("gpt-5.5");
    manager.backend = {};
    manager.modelMetadataForContextTiers = [GPT_55_TIERED_MODEL];
    manager.sessionObjects.set("session-1", session);

    const result = await manager.setSessionModel("session-1", "gpt-5.5", undefined, "default");

    expect(session.setModel).toHaveBeenCalledWith("gpt-5.5", {
      modelCapabilities: {
        limits: {
          max_context_window_tokens: 272_000,
          max_prompt_tokens: 144_000,
        },
      },
    });
    expect(result).toMatchObject({ model: "gpt-5.5", contextTier: "default" });
    await expect(manager.getSessionModelState("session-1")).resolves.toMatchObject({
      model: "gpt-5.5",
      contextTier: "default",
    });
  });

  it("leaves tiered model limits uncapped when selecting long context", async () => {
    const manager = createManager(makeTestDir("model-context-long"));
    const session = createMockSession("gpt-5.5");
    manager.backend = {};
    manager.modelMetadataForContextTiers = [GPT_55_TIERED_MODEL];
    manager.sessionObjects.set("session-1", session);

    const result = await manager.setSessionModel("session-1", "gpt-5.5", undefined, "long_context");

    expect(session.setModel).toHaveBeenCalledWith("gpt-5.5", undefined);
    expect(result).toMatchObject({ model: "gpt-5.5", contextTier: "long_context" });
  });

  it("resumes a cold (non-cached) session WITHOUT model config, then sets model", async () => {
    const manager = createManager();
    const session = createMockSession("previous-model");
    const resumeSession = vi.fn().mockResolvedValue(session);
    manager.backend = { resumeSession };

    const result = await manager.setSessionModel("cold-session", "gpt-5.5");

    // Should resume without model config
    expect(resumeSession).toHaveBeenCalledWith(
      "cold-session",
      expect.not.objectContaining({ model: expect.anything() }),
    );
    // Should call setModel after resume
    expect(session.setModel).toHaveBeenCalledWith("gpt-5.5", undefined);
    expect(result.model).toBe("gpt-5.5");
    // Should cache the resumed session
    expect(manager.sessionObjects.get("cold-session")).toBe(session);
  });

  it("reapplies persisted model capability overrides when resuming before a switch", async () => {
    const copilotHome = makeTestDir("model-context-resume");
    const manager = createManager(copilotHome);
    const session = createMockSession("previous-model");
    const resumeSession = vi.fn().mockResolvedValue(session);
    manager.backend = { resumeSession };
    mkdirSync(join(copilotHome, "session-state", "cold-session"), { recursive: true });
    const modelCapabilities = {
      limits: {
        max_context_window_tokens: 272_000,
        max_prompt_tokens: 144_000,
      },
    };
    writeFileSync(
      join(copilotHome, "session-state", "cold-session", "bridge-model-state.json"),
      JSON.stringify({ model: "gpt-5.5", contextTier: "default", modelCapabilities }),
    );

    await manager.setSessionModel("cold-session", "claude-opus-4.7");

    expect(resumeSession).toHaveBeenCalledWith(
      "cold-session",
      expect.objectContaining({ modelCapabilities }),
    );
  });

  it("does not let a superseded cold switch resume overwrite a newer cached session", async () => {
    const manager = createManager();
    const resumedSession = createMockSession("stale-resume-model");
    const newerSession = createMockSession("newer-cached-model");
    let resolveResume!: (session: typeof resumedSession) => void;
    const resumeSession = vi.fn(() => new Promise<typeof resumedSession>((resolve) => {
      resolveResume = resolve;
    }));
    manager.backend = { resumeSession };

    const switching = manager.setSessionModel("cold-session", "gpt-5.5");
    manager.sessionObjects.set("cold-session", newerSession);

    resolveResume(resumedSession);
    await switching;

    expect(manager.sessionObjects.get("cold-session")).toBe(newerSession);
    expect(resumedSession.disconnect).toHaveBeenCalledTimes(1);
    expect(resumedSession.setModel).not.toHaveBeenCalled();
    expect(newerSession.setModel).toHaveBeenCalledWith("gpt-5.5", undefined);
  });

  it("marks the session busy until the model switch finishes", async () => {
    const manager = createManager();
    let resolveSetModel!: () => void;
    const session = createMockSession("gpt-5.5");
    session.setModel = vi.fn(() => new Promise<void>((resolve) => {
      resolveSetModel = resolve;
    }));
    manager.backend = {};
    manager.sessionObjects.set("session-1", session);

    const switching = manager.setSessionModel("session-1", "gpt-5.5");

    expect(manager.isSessionBusy("session-1")).toBe(true);
    expect(manager.getSessionRunState("session-1")).toBe("busy");
    expect(manager.getActiveSessions()).toEqual(["session-1"]);
    await expect(manager.setSessionModel("session-1", "claude-opus-4.7"))
      .rejects.toThrow("Cannot switch model on a busy session");

    resolveSetModel();
    await switching;

    expect(manager.isSessionBusy("session-1")).toBe(false);
    expect(manager.getSessionRunState("session-1")).toBe("idle");
    expect(manager.getActiveSessions()).toEqual([]);
  });

  it("defers global eviction while a cached model switch is in progress", async () => {
    const manager = createManager();
    let resolveSetModel!: () => void;
    const session = createMockSession("gpt-5.5");
    session.setModel = vi.fn(() => new Promise<void>((resolve) => {
      resolveSetModel = resolve;
    }));
    manager.backend = {};
    manager.sessionObjects.set("session-1", session);

    const switching = manager.setSessionModel("session-1", "gpt-5.5");
    manager.evictAllCachedSessions();
    await vi.waitFor(() => expect(session.setModel).toHaveBeenCalled());

    expect(session.disconnect).not.toHaveBeenCalled();
    expect(manager.sessionObjects.get("session-1")).toBe(session);

    resolveSetModel();
    await switching;

    expect(session.disconnect).toHaveBeenCalledTimes(1);
    expect(manager.sessionObjects.has("session-1")).toBe(false);
  });

  it("defers global eviction while a cold model switch is resuming", async () => {
    const manager = createManager();
    let resolveResume!: (session: ReturnType<typeof createMockSession>) => void;
    const session = createMockSession("gpt-5.5");
    const resumeSession = vi.fn(() => new Promise<typeof session>((resolve) => {
      resolveResume = resolve;
    }));
    manager.backend = { resumeSession };

    const switching = manager.setSessionModel("cold-session", "gpt-5.5");
    manager.evictAllCachedSessions();

    expect(manager.sessionObjects.has("cold-session")).toBe(false);

    resolveResume(session);
    await switching;

    expect(session.disconnect).toHaveBeenCalledTimes(1);
    expect(manager.sessionObjects.has("cold-session")).toBe(false);
  });

  it("preserves existing reasoningEffort when a switch omits reasoningEffort", async () => {
    const copilotHome = makeTestDir("model-switch-preserve-reasoning");
    const sessionDir = join(copilotHome, "session-state", "session-1");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "events.jsonl"),
      JSON.stringify({ type: "session.start", data: { selectedModel: "gpt-5.5", reasoningEffort: "high" } }),
    );
    const manager = createManager(copilotHome);
    const session = createMockSession("claude-opus-4.7");
    manager.backend = {};
    manager.sessionObjects.set("session-1", session);

    const result = await manager.setSessionModel("session-1", "claude-opus-4.7");

    expect(session.setModel).toHaveBeenCalledWith("claude-opus-4.7", { reasoningEffort: "high" });
    expect(result).toMatchObject({ model: "claude-opus-4.7", reasoningEffort: "high" });
  });

  it("serves live reasoningEffort from explicit switch state before events catch up", async () => {
    const copilotHome = makeTestDir("model-switch-live-reasoning");
    const sessionDir = join(copilotHome, "session-state", "session-1");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "events.jsonl"),
      JSON.stringify({ type: "session.start", data: { selectedModel: "gpt-5.5", reasoningEffort: "low" } }),
    );
    const manager = createManager(copilotHome);
    const session = createMockSession("gpt-5.5");
    manager.backend = {};
    manager.sessionObjects.set("session-1", session);

    await manager.setSessionModel("session-1", "gpt-5.5", "high");

    await expect(manager.getSessionModelState("session-1")).resolves.toEqual({
      model: "gpt-5.5",
      reasoningEffort: "high",
      source: "live",
    });
  });

  it("preserves live reasoningEffort on back-to-back switches before events catch up", async () => {
    const copilotHome = makeTestDir("model-switch-live-reasoning-preserve");
    const sessionDir = join(copilotHome, "session-state", "session-1");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "events.jsonl"),
      JSON.stringify({ type: "session.start", data: { selectedModel: "gpt-5.5", reasoningEffort: "low" } }),
    );
    const manager = createManager(copilotHome);
    const setModel = vi.fn(async () => {});
    const getCurrent = vi.fn()
      .mockResolvedValueOnce({ modelId: "gpt-5.5" })
      .mockResolvedValueOnce({ modelId: "gpt-5.5" })
      .mockResolvedValueOnce({ modelId: "claude-opus-4.7" });
    const session = {
      setModel,
      getCurrentModel: getCurrent,
      disconnect: vi.fn(),
    };
    manager.backend = {};
    manager.sessionObjects.set("session-1", session);

    await manager.setSessionModel("session-1", "gpt-5.5", "high");
    await manager.setSessionModel("session-1", "claude-opus-4.7");

    expect(setModel).toHaveBeenNthCalledWith(1, "gpt-5.5", { reasoningEffort: "high" });
    expect(setModel).toHaveBeenNthCalledWith(2, "claude-opus-4.7", { reasoningEffort: "high" });
  });

  it("rejects busy sessions", async () => {
    const manager = createManager();
    manager.backend = { resumeSession: vi.fn() };
    manager.sessionRuns.set("busy-session", {
      state: "busy",
      startedAt: Date.now(),
      lastEventAt: Date.now(),
    });

    await expect(manager.setSessionModel("busy-session", "gpt-5.5")).rejects.toThrow(
      "Cannot switch model on a busy session",
    );
    expect(manager.backend.resumeSession).not.toHaveBeenCalled();
  });

  it("rejects when client is not initialized", async () => {
    const manager = createManager();
    // client is null by default

    await expect(manager.setSessionModel("session-1", "gpt-5.5")).rejects.toThrow(
      "SessionManager not initialized",
    );
  });

  it("omits reasoningEffort from result when not provided", async () => {
    const manager = createManager();
    const session = createMockSession(undefined);
    manager.backend = {};
    manager.sessionObjects.set("session-1", session);

    const result = await manager.setSessionModel("session-1", "gpt-5.5");

    expect(result).not.toHaveProperty("reasoningEffort");
  });
});

describe("PATCH /api/sessions/:id/model route", () => {
  const sessionId = "11111111-1111-4111-8111-111111111111";

  it("returns 400 when model is missing", async () => {
    const { app } = createTestApp();
    const res = await supertest(app).patch(`/api/sessions/${sessionId}/model`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/model/i);
  });

  it("returns 400 when model is empty string", async () => {
    const { app } = createTestApp();
    const res = await supertest(app).patch(`/api/sessions/${sessionId}/model`).send({ model: "" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when model is only whitespace", async () => {
    const { app } = createTestApp();
    const res = await supertest(app).patch(`/api/sessions/${sessionId}/model`).send({ model: "   " });
    expect(res.status).toBe(400);
  });

  it("returns 400 when reasoningEffort is invalid", async () => {
    const { app } = createTestApp();
    const res = await supertest(app)
      .patch(`/api/sessions/${sessionId}/model`)
      .send({ model: "gpt-5.5", reasoningEffort: "extreme" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/reasoningEffort/i);
  });

  it("returns 400 when contextTier is invalid", async () => {
    const { app } = createTestApp();
    const res = await supertest(app)
      .patch(`/api/sessions/${sessionId}/model`)
      .send({ model: "gpt-5.5", contextTier: "huge" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/contextTier/i);
  });

  it("returns 200 with model info on success", async () => {
    const { app } = createTestApp();
    const res = await supertest(app)
      .patch(`/api/sessions/${sessionId}/model`)
      .send({ model: "  gpt-5.5  " });
    expect(res.status).toBe(200);
    expect(res.body.model).toBe("gpt-5.5");
  });

  it("passes valid contextTier values to the session manager", async () => {
    const setSessionModel = vi.fn(async (
      _id: string,
      model: string,
      reasoningEffort?: string,
      contextTier?: string,
    ) => ({
      model,
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(contextTier ? { contextTier } : {}),
    }));
    const { app } = createTestApp({
      sessionManager: {
        listSessions: async () => [],
        listSessionsFromDisk: () => [],
        getSessionActivity: () => [],
        isSessionBusy: () => false,
        getSessionRunState: () => "idle",
        getPendingUserInputCount: () => 0,
        isSessionWarm: () => false,
        setSessionModel,
        getSessionModelState: async () => ({ source: "unknown" as const }),
      } as any,
    });

    const res = await supertest(app)
      .patch(`/api/sessions/${sessionId}/model`)
      .send({ model: "gpt-5.5", reasoningEffort: "high", contextTier: "long_context" });

    expect(res.status).toBe(200);
    expect(setSessionModel).toHaveBeenCalledWith(sessionId, "gpt-5.5", "high", "long_context");
    expect(res.body).toMatchObject({
      model: "gpt-5.5",
      reasoningEffort: "high",
      contextTier: "long_context",
    });
  });

  it("accepts valid reasoningEffort values", async () => {
    const { app } = createTestApp();
    for (const effort of ["low", "medium", "high", "xhigh"]) {
      const res = await supertest(app)
        .patch(`/api/sessions/${sessionId}/model`)
        .send({ model: "claude-opus-4.7", reasoningEffort: effort });
      expect(res.status).toBe(200);
      expect(res.body.reasoningEffort).toBe(effort);
    }
  });

  it("returns 409 when session is busy", async () => {
    const { app } = createTestApp({
      sessionManager: {
        listSessions: async () => [],
        listSessionsFromDisk: () => [],
        getSessionActivity: () => [],
        isSessionBusy: () => false,
        getSessionRunState: () => "idle",
        getPendingUserInputCount: () => 0,
        isSessionWarm: () => false,
        setSessionModel: async () => {
          throw new Error("Cannot switch model on a busy session");
        },
      } as any,
    });
    const res = await supertest(app)
      .patch(`/api/sessions/${sessionId}/model`)
      .send({ model: "gpt-5.5" });
    expect(res.status).toBe(409);
  });

  it("returns 400 for invalid session IDs", async () => {
    const { app } = createTestApp();
    const res = await supertest(app)
      .patch("/api/sessions/not-a-uuid/model")
      .send({ model: "gpt-5.5" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sessionId/i);
  });
});
