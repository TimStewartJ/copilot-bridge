import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createSettingsStore, SettingsValidationError } from "../../settings-store.js";
import { HELM_SETTINGS_DEFAULTS } from "../../../shared/helm-settings.js";
import { createHelmRouter } from "../helm-router.js";
import type { AppContext } from "../../app-context.js";
import { createTestBus, makeTestDir, setupTestDb } from "../../__tests__/helpers.js";
import { HELM_POLICY, HelmError, HelmService } from "../helm-service.js";
import { createHelmStore } from "../helm-store.js";
import type { HelmBridgeFacade } from "../helm-tools.js";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

function createHarness() {
  let now = Date.parse("2026-09-18T09:00:00.000Z");
  const dataDir = makeTestDir("helm-service");
  const copilotHome = join(dataDir, ".copilot");
  const busy = new Set<string>();
  const globalBus = createTestBus();
  const sessionManager = {
    isSessionBusy: vi.fn((sessionId: string) => busy.has(sessionId)),
    listModels: vi.fn(async () => [
      { id: "claude-opus-5", supportedReasoningEfforts: ["low", "high"] },
      { id: "gpt-6-luna", supportedReasoningEfforts: ["none", "low"] },
      { id: "gpt-5.6-luna", supportedReasoningEfforts: ["none", "low"] },
    ]),
    createSession: vi.fn(async (options: { expectedSessionId?: string }) => ({ sessionId: options.expectedSessionId! })),
  };
  const ctx = {
    globalBus,
    sessionManager,
    settingsStore: { getSettings: () => ({ model: "claude-opus-5" }) },
    taskStore: { getTask: () => undefined, listTasks: () => [] },
    eventBusRegistry: { getBus: () => undefined },
    runtimePaths: { dataDir, docsDir: join(dataDir, "docs"), env: {} },
    copilotHome,
  } as unknown as AppContext;
  const facade: HelmBridgeFacade = {
    listSessions: async () => [],
    markRead: () => undefined,
    setArchived: () => undefined,
    sendMessage: async () => "started",
    createSession: async () => ({ sessionId: "worker" }),
  };
  const deleted: string[] = [];
  const store = createHelmStore(setupTestDb());
  const helm = new HelmService({
    ctx,
    store,
    facade,
    deleteSession: async (sessionId) => {
      deleted.push(sessionId);
    },
    now: () => now,
  });
  return {
    helm,
    store,
    ctx,
    sessionManager,
    globalBus,
    deleted,
    busy,
    copilotHome,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("HelmService conversations", () => {
  it("keeps settings and static voices available when optional model metadata fails", async () => {
    const { helm, ctx, sessionManager } = createHarness();
    ctx.settingsStore = createSettingsStore(setupTestDb());
    await helm.patchSettings({ model: "claude-opus-5" });
    sessionManager.listModels.mockRejectedValue(new Error("SDK unavailable"));
    const app = express().use(express.json()).use("/api/helm", createHelmRouter(helm));
    const read = await request(app).get("/api/helm/settings").expect(200);
    expect(read.body.settings.model).toBe("claude-opus-5");
    expect(read.body.voices).toContainEqual(expect.objectContaining({ id: "af_heart", name: expect.any(String) }));
    expect(read.body).not.toHaveProperty("models");
    expect(read.body.modelsError).toContain("unavailable");
    const saved = await request(app).patch("/api/helm/settings").send({ ...read.body.settings, patience: 0.7 }).expect(200);
    expect(saved.body.settings.patience).toBe(0.7);
    await request(app).patch("/api/helm/settings").send({ model: "gpt-6-luna" }).expect(503);
    expect((await helm.getSettings()).settings.model).toBe("claude-opus-5");
    await request(app).patch("/api/helm/settings").send({ model: "" }).expect(200);
    helm.dispose();
  });

  it("accepts the hub's exact eleven-field fixture and returns it unchanged", async () => {
    const { helm, ctx } = createHarness();
    ctx.settingsStore = createSettingsStore(setupTestDb());
    const app = express().use(express.json()).use("/api/helm", createHelmRouter(helm));
    const fixture = {
      model: "", typedReasoningEffort: "high", spokenReasoningEffort: "low",
      glossary: "SELFTEST names", voice: "af_heart", speed: 1.15, patience: 0.7,
      bargeIn: false, announce: "off", echoSafe: true, transport: "http",
    };
    expect(Object.keys(fixture)).toHaveLength(11);
    const saved = await request(app).patch("/api/helm/settings").send(fixture).expect(200);
    expect(saved.body.settings).toEqual(fixture);
    expect(saved.body.schemaVersion).toBe(1);
    expect((await request(app).get("/api/helm/settings").expect(200)).body.settings).toEqual(fixture);
    helm.dispose();
  });

  it("round-trips the complete dedicated settings contract without touching unrelated settings", async () => {
    const { helm, ctx, sessionManager } = createHarness();
    const db = setupTestDb();
    ctx.settingsStore = createSettingsStore(db);
    ctx.settingsStore.updateSettings({ model: "claude-opus-5", theme: "dark", helm: { glossary: "existing names" } });
    const app = express().use(express.json()).use("/api/helm", createHelmRouter(helm));
    const state = await request(app).get("/api/helm").expect(200);
    expect(state.body.settingsSchemaVersion).toBe(1);
    expect(sessionManager.listModels).not.toHaveBeenCalled();
    const initial = await request(app).get("/api/helm/settings").expect(200);
    expect(initial.body).toMatchObject({ schemaVersion: 1, settings: { ...HELM_SETTINGS_DEFAULTS, glossary: "existing names" } });
    const desired = {
      model: "claude-opus-5", typedReasoningEffort: "high", spokenReasoningEffort: "low",
      glossary: "Exact names\nTether", voice: "bm_george", speed: 1.4, patience: 0.85,
      bargeIn: false, announce: "all", echoSafe: false, transport: "http",
    };
    const saved = await request(app).patch("/api/helm/settings").send(desired).expect(200);
    expect(saved.body).toMatchObject({ schemaVersion: 1, settings: desired });
    ctx.settingsStore = createSettingsStore(db);
    expect((await request(app).get("/api/helm/settings").expect(200)).body).toEqual(saved.body);
    await request(app).patch("/api/helm/settings").send({ patience: 0 }).expect(200);
    expect((await helm.getSettings()).settings).toEqual({ ...desired, patience: 0 });
    expect(ctx.settingsStore.getSettings()).toMatchObject({ model: "claude-opus-5", theme: "dark" });
    expect(() => ctx.settingsStore.updateSettings({ helm: { speed: 9 } })).toThrow(SettingsValidationError);
    await helm.createConversation();
    expect(sessionManager.createSession).toHaveBeenLastCalledWith(expect.objectContaining({ model: "claude-opus-5", reasoningEffort: "high" }));
    expect(helm.getTurnReasoningEffort("spoken")).toBe("low");
    helm.dispose();
  });

  it("rejects invalid flat patches atomically", async () => {
    const { helm, ctx } = createHarness();
    ctx.settingsStore = createSettingsStore(setupTestDb());
    const app = express().use(express.json()).use("/api/helm", createHelmRouter(helm));
    const invalid = [
      [], { settings: {} }, { unknown: true }, { schemaVersion: 1 }, { configured: true },
      { speed: 0.74 }, { speed: 1.41 }, { patience: -0.1 }, { patience: 1.01 },
      { echoSafe: "false" }, { bargeIn: 1 }, { announce: "none" }, { transport: "udp" },
      { voice: "missing_voice" }, { model: "missing-model" }, { glossary: "x".repeat(2001) },
      { typedReasoningEffort: "" }, { spokenReasoningEffort: null }, { voice: "bm_george", speed: "1" },
    ];
    for (const patch of invalid) {
      const response = await request(app).patch("/api/helm/settings").send(patch).expect(400);
      expect(response.body.error).toBeTruthy();
      expect(ctx.settingsStore.getSettings().helm).toBeUndefined();
    }
    helm.dispose();
  });

  it("asks for max effort when typing and medium when speaking, until settings say otherwise", async () => {
    const { helm, ctx } = createHarness();
    expect(helm.getTurnReasoningEffort("typed")).toBe("max");
    expect(helm.getTurnReasoningEffort("spoken")).toBe("medium");
    expect((await helm.getState()).reasoningEfforts).toEqual({ typed: "max", spoken: "medium" });
    // Anything that isn't a hands-free turn is answered in the chat.
    expect(helm.getSessionProfile().defaultTurnReasoningEffort?.()).toBe("max");

    (ctx.settingsStore as { getSettings(): unknown }).getSettings = () => ({ model: "claude-opus-5", helm: { typedReasoningEffort: "high" } });
    expect(helm.getTurnReasoningEffort("typed")).toBe("high");
    expect(helm.getTurnReasoningEffort("spoken")).toBe("medium");
    // Read per turn: the profile built earlier follows the change.
    expect(helm.getSessionProfile().defaultTurnReasoningEffort?.()).toBe("high");
  });

  it("creates a conversation on GPT-6 Luna with the Helm profile registered first", async () => {
    const { helm, store, sessionManager } = createHarness();
    sessionManager.createSession.mockImplementationOnce(async (options: { expectedSessionId?: string }) => {
      // The profile resolver must already recognize the id while the session is being built.
      expect(store.isHelmSession(options.expectedSessionId)).toBe(true);
      return { sessionId: options.expectedSessionId! };
    });
    const conversation = await helm.createConversation();
    // Starts at the typed effort, clamped to what GPT-6 Luna supports here.
    expect(sessionManager.createSession).toHaveBeenCalledWith({
      expectedSessionId: conversation.sessionId,
      model: "gpt-6-luna",
      reasoningEffort: "low",
    });
    expect(conversation).toMatchObject({ turnCount: 0, kept: false, busy: false, handsFree: false, title: null });
    expect((await helm.getState()).current?.sessionId).toBe(conversation.sessionId);
  });

  it("honors a requested model and rolls back when creation fails", async () => {
    const { helm, store, sessionManager } = createHarness();
    const first = await helm.createConversation({ model: "claude-opus-5" });
    expect(sessionManager.createSession).toHaveBeenLastCalledWith({
      expectedSessionId: first.sessionId,
      model: "claude-opus-5",
      reasoningEffort: "high",
    });
    helm.recordTurn(first.sessionId);

    sessionManager.createSession.mockRejectedValueOnce(new Error("Session capacity reached"));
    await expect(helm.createConversation()).rejects.toThrow("Session capacity reached");
    expect(store.list().map((record) => record.sessionId)).toEqual([first.sessionId]);
    expect(store.getCurrent()?.sessionId).toBe(first.sessionId);
  });

  it("resets without deleting and offers the way back", async () => {
    const { helm, deleted } = createHarness();
    const first = await helm.createConversation();
    helm.recordTurn(first.sessionId);

    const fresh = await helm.startFresh();
    expect(fresh.current).toBeNull();
    expect(fresh.resumable?.sessionId).toBe(first.sessionId);
    expect(fresh.recent.map((entry) => entry.sessionId)).toEqual([first.sessionId]);
    expect(deleted).toEqual([]);

    const resumed = await helm.resumeConversation(first.sessionId);
    expect(resumed.sessionId).toBe(first.sessionId);
    expect((await helm.getState()).current?.sessionId).toBe(first.sessionId);
    await expect(helm.resumeConversation("missing")).rejects.toBeInstanceOf(HelmError);
  });

  it("drops a conversation nobody spoke in when it is replaced", async () => {
    const { helm, deleted, store } = createHarness();
    const empty = await helm.createConversation();
    const next = await helm.createConversation();
    await vi.waitFor(() => expect(deleted).toEqual([empty.sessionId]));
    expect(store.list().map((record) => record.sessionId)).toEqual([next.sessionId]);
  });

  it("opens fresh after a long idle but never while the conversation is in use", async () => {
    const { helm, advance, busy } = createHarness();
    const conversation = await helm.createConversation();
    helm.recordTurn(conversation.sessionId);

    advance(HELM_POLICY.freshAfterMs - HOUR);
    expect((await helm.getState()).current?.sessionId).toBe(conversation.sessionId);

    advance(2 * HOUR);
    busy.add(conversation.sessionId);
    expect((await helm.getState()).current?.sessionId).toBe(conversation.sessionId);
    busy.clear();

    const unbind = helm.bindHandsFree(conversation.sessionId, { requestHandsFree: () => undefined });
    expect((await helm.getState()).current).toMatchObject({ sessionId: conversation.sessionId, handsFree: true });
    unbind();

    const state = await helm.getState();
    expect(state.current).toBeNull();
    expect(state.resumable?.sessionId).toBe(conversation.sessionId);
  });

  it("treats a finished reply as activity", async () => {
    const { helm, globalBus, advance, store } = createHarness();
    const conversation = await helm.createConversation();
    advance(HOUR);
    globalBus.emit({ type: "session:idle", sessionId: conversation.sessionId });
    expect(store.get(conversation.sessionId)?.lastActiveAt).toBe("2026-09-18T10:00:00.000Z");
    globalBus.emit({ type: "session:idle", sessionId: "some-other-session" });
    helm.dispose();
    advance(HOUR);
    globalBus.emit({ type: "session:idle", sessionId: conversation.sessionId });
    expect(store.get(conversation.sessionId)?.lastActiveAt).toBe("2026-09-18T10:00:00.000Z");
  });

  it("reads the session's own name and follows renames", async () => {
    const { helm, copilotHome, globalBus } = createHarness();
    const conversation = await helm.createConversation();
    const sessionDir = join(copilotHome, "session-state", conversation.sessionId);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "workspace.yaml"), `id: ${conversation.sessionId}\nname: Morning triage\n`);
    expect((await helm.getState()).current?.title).toBe("Morning triage");
    globalBus.emit({ type: "session:title", sessionId: conversation.sessionId, title: "Tellus follow-ups" });
    expect((await helm.getState()).current?.title).toBe("Tellus follow-ups");
  });

  it("refuses to delete a conversation that is in use", async () => {
    const { helm, busy, deleted } = createHarness();
    const conversation = await helm.createConversation();
    const unbind = helm.bindHandsFree(conversation.sessionId, { requestHandsFree: () => undefined });
    await expect(helm.deleteConversation(conversation.sessionId)).rejects.toMatchObject({ status: 409 });
    unbind();
    busy.add(conversation.sessionId);
    await expect(helm.deleteConversation(conversation.sessionId)).rejects.toMatchObject({ status: 409 });
    busy.clear();
    await helm.deleteConversation(conversation.sessionId);
    expect(deleted).toEqual([conversation.sessionId]);
    await expect(helm.deleteConversation(conversation.sessionId)).rejects.toMatchObject({ status: 404 });
  });
});

describe("HelmService retention", () => {
  it("expires idle conversations but spares kept, current and in-use ones", async () => {
    const { helm, advance, deleted, busy, store } = createHarness();
    const old = await helm.createConversation();
    helm.recordTurn(old.sessionId);
    const keeper = await helm.createConversation();
    helm.recordTurn(keeper.sessionId);
    await helm.setKept(keeper.sessionId, true);
    const working = await helm.createConversation();
    helm.recordTurn(working.sessionId);
    busy.add(working.sessionId);
    const current = await helm.createConversation();
    helm.recordTurn(current.sessionId);

    advance(HELM_POLICY.retainMs + DAY);
    expect(await helm.prune()).toBe(1);
    expect(deleted).toEqual([old.sessionId]);
    expect(store.list().map((record) => record.sessionId).sort()).toEqual([keeper.sessionId, working.sessionId, current.sessionId].sort());
    expect((await helm.getConversation(keeper.sessionId))?.expiresAt).toBeUndefined();
    expect((await helm.getConversation(working.sessionId))?.expiresAt).toEqual(expect.any(String));
  });

  it("caps how many conversations are retained, oldest first", async () => {
    const { helm, advance, deleted } = createHarness();
    const created: string[] = [];
    for (let index = 0; index < HELM_POLICY.maxConversations + 3; index++) {
      const conversation = await helm.createConversation();
      helm.recordTurn(conversation.sessionId);
      created.push(conversation.sessionId);
      advance(60_000);
    }
    expect(await helm.prune()).toBe(2);
    expect(deleted.sort()).toEqual(created.slice(0, 2).sort());
  });

  it("tracks what a conversation dispatched so hands-free can announce it", async () => {
    const { helm } = createHarness();
    const conversation = await helm.createConversation();
    helm.watchSession(conversation.sessionId, "worker-1");
    helm.watchSession(undefined, "worker-2");
    helm.watchSession(conversation.sessionId, conversation.sessionId);
    expect(helm.isWatched(conversation.sessionId, "worker-1")).toBe(true);
    expect(helm.isWatched(conversation.sessionId, "worker-2")).toBe(false);
    expect(helm.isWatched(conversation.sessionId, conversation.sessionId)).toBe(false);
  });
});

describe("Helm session profile", () => {
  it("replaces what the session is while keeping the manager's lifecycle fields", async () => {
    const { helm } = createHarness();
    const profile = helm.getSessionProfile();
    expect(profile.toolNames).toContain("bridge_overview");
    expect(profile.toolNames).toContain("hands_free");
    const onPermissionRequest = () => undefined;
    const applied = profile.apply({
      sessionId: "abc",
      model: "gpt-5.6-luna",
      streaming: true,
      memory: { enabled: false },
      onPermissionRequest,
      // Capabilities ordinary sessions have, or may gain later. None of them are Helm's.
      pluginDirectories: ["/plugins/computer-use"],
      someFutureCapability: { enabled: true },
      tools: [{ name: "powershell" }],
      excludedTools: ["report_intent"],
      mcpServers: { github: {} },
      skillDirectories: ["/skills"],
      customAgents: [{ name: "reviewer" }],
      agent: "reviewer",
      systemMessage: { mode: "customize", content: "coding agent" },
    }) as Record<string, any>;
    expect(applied).toMatchObject({ sessionId: "abc", model: "gpt-5.6-luna", streaming: true, memory: { enabled: false } });
    expect(applied.onPermissionRequest).toBe(onPermissionRequest);
    // An allowlist, not a denylist: a field nobody has heard of yet is dropped too.
    expect(applied.pluginDirectories).toBeUndefined();
    expect(applied.someFutureCapability).toBeUndefined();
    expect(applied.githubMcpToolConfig).toBeUndefined();
    expect(applied.availableTools).toEqual(profile.toolNames);
    expect(applied.tools.map((tool: { name: string }) => tool.name)).toEqual(profile.toolNames);
    expect(applied.mcpServers).toEqual({});
    expect(applied.skillDirectories).toEqual([]);
    expect(applied.customAgents).toBeUndefined();
    expect(applied.agent).toBeUndefined();
    expect(applied.systemMessage.mode).toBe("replace");
    expect(applied.systemMessage.content).toContain("You are Helm");
    expect(applied.systemMessage.content).toContain("claude-opus-5");
    expect(String(applied.workingDirectory)).toContain("helm");
  });
});
