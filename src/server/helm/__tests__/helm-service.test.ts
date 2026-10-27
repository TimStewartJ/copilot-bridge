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
import { applyHelmSessionProfile } from "../helm-session-profile.js";
import { defineBridgeTool } from "../../agent-tools-mcp/adapter.js";
import type { HelmBridgeFacade } from "../helm-tools.js";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

function createHarness() {
  let now = Date.parse("2026-09-18T09:00:00.000Z");
  const dataDir = makeTestDir("helm-service");
  const copilotHome = join(dataDir, ".copilot");
  const busy = new Set<string>();
  const globalBus = createTestBus();
  const visibleActivity = new Map<string, string>();
  const sessionManager = {
    isSessionBusy: vi.fn((sessionId: string) => busy.has(sessionId)),
    listModels: vi.fn(async () => [
      { id: "claude-opus-5", billing: { tokenPrices: { inputPrice: 500, outputPrice: 2500, cachePrice: 50, batchSize: 1_000_000 } }, supportedReasoningEfforts: ["low", "high"] },
      { id: "gpt-6-luna", billing: { tokenPrices: { inputPrice: 10, outputPrice: 50, cachePrice: 1, batchSize: 1_000_000 } }, supportedReasoningEfforts: ["none", "low"] },
      { id: "gpt-5.6-luna", billing: { tokenPrices: { inputPrice: 20, outputPrice: 120, cachePrice: 2, batchSize: 1_000_000 } }, supportedReasoningEfforts: ["none", "low"] },
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
    sessionMetaStore: { getMeta: (sessionId: string) => ({ lastVisibleActivityAt: visibleActivity.get(sessionId) }) },
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
    visibleActivity,
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
    // The retired model is kept as written, so it needs no model list to check against.
    await request(app).patch("/api/helm/settings").send({ model: "gpt-6-luna" }).expect(200);
    expect((await helm.getSettings()).settings.model).toBe("gpt-6-luna");
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
    // The retired model and efforts are kept for Tether; nothing reads them.
    expect(ctx.settingsStore.getSettings().modelRoles?.helm).toBeUndefined();
    // The hub sends exactly these eleven fields, including an empty model, and reads them back unchanged.
    const hubFixture = {
      model: "", typedReasoningEffort: "high", spokenReasoningEffort: "low",
      glossary: "SELFTEST names", voice: "af_heart", speed: 1.15, patience: 0.7,
      bargeIn: false, announce: "off", echoSafe: true, transport: "http",
    };
    const hubSaved = await request(app).patch("/api/helm/settings").send(hubFixture).expect(200);
    expect(hubSaved.body).toMatchObject({ schemaVersion: 1 });
    expect(hubSaved.body.settings).toEqual(hubFixture);
    expect((await request(app).get("/api/helm/settings").expect(200)).body.settings).toEqual(hubFixture);
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
      { voice: "missing_voice" }, { glossary: "x".repeat(2001) },
      { typedReasoningEffort: "" }, { spokenReasoningEffort: null }, { voice: "bm_george", speed: "1" },
    ];
    for (const patch of invalid) {
      const response = await request(app).patch("/api/helm/settings").send(patch).expect(400);
      expect(response.body.error).toBeTruthy();
      expect(ctx.settingsStore.getSettings().helm).toBeUndefined();
    }
    helm.dispose();
  });

  it("creates a conversation on Helm's model with the Helm profile registered first", async () => {
    const { helm, store, sessionManager } = createHarness();
    sessionManager.createSession.mockImplementationOnce(async (options: { expectedSessionId?: string }) => {
      // The profile resolver must already recognize the id while the session is being built.
      expect(store.isHelmSession(options.expectedSessionId)).toBe(true);
      return { sessionId: options.expectedSessionId! };
    });
    const conversation = await helm.createConversation();
    // Automatic: the user's default model, at the typed effort clamped to what it supports.
    expect(sessionManager.createSession).toHaveBeenCalledWith({
      expectedSessionId: conversation.sessionId,
      model: "claude-opus-5",
      reasoningEffort: "high",
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

    const unbind = helm.bindHandsFree(conversation.sessionId);
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

  it("records when Helm replied, timed by the chat's visible activity, and tells clients", async () => {
    const { helm, globalBus, store, visibleActivity } = createHarness();
    const conversation = await helm.createConversation();
    const announced: unknown[] = [];
    globalBus.subscribe((event) => { if (event.type === "helm:changed") announced.push(event); });

    // A turn that ended without a reply (aborted, or only Tim's own message) is not a reply.
    visibleActivity.set(conversation.sessionId, "2026-09-18T09:05:00.000Z");
    globalBus.emit({ type: "session:idle", sessionId: conversation.sessionId });
    expect((await helm.getConversation(conversation.sessionId))?.lastReplyAt).toBeNull();

    visibleActivity.set(conversation.sessionId, "2026-09-18T09:10:00.000Z");
    globalBus.emit({ type: "session:idle", sessionId: conversation.sessionId, assistantPreview: "Done." });
    expect((await helm.getConversation(conversation.sessionId))?.lastReplyAt).toBe("2026-09-18T09:10:00.000Z");
    expect(announced).toEqual([{ type: "helm:changed", reason: "conversation" }]);

    // An older time never moves it back.
    store.recordReply(conversation.sessionId, "2026-09-18T09:00:00.000Z");
    expect(store.get(conversation.sessionId)?.lastReplyAt).toBe("2026-09-18T09:10:00.000Z");

    // Undoing the turn takes the reply with it.
    visibleActivity.set(conversation.sessionId, "2026-09-18T09:05:00.000Z");
    globalBus.emit({ type: "session:history-truncated", sessionId: conversation.sessionId });
    expect(store.get(conversation.sessionId)?.lastReplyAt).toBe("2026-09-18T09:05:00.000Z");
    expect(announced).toHaveLength(2);
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
    const unbind = helm.bindHandsFree(conversation.sessionId);
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
  it("expires idle conversations but spares kept, current, in-use and waiting ones", async () => {
    const { helm, advance, deleted, busy, store, ctx } = createHarness();
    const old = await helm.createConversation();
    helm.recordTurn(old.sessionId);
    const keeper = await helm.createConversation();
    helm.recordTurn(keeper.sessionId);
    await helm.setKept(keeper.sessionId, true);
    const working = await helm.createConversation();
    helm.recordTurn(working.sessionId);
    busy.add(working.sessionId);
    // Deleting a conversation cancels its deferred work and drops a result still on its way.
    const deferring = await helm.createConversation();
    helm.recordTurn(deferring.sessionId);
    const awaitingResult = await helm.createConversation();
    helm.recordTurn(awaitingResult.sessionId);
    Object.assign(ctx, {
      deferredPromptStore: {
        listForSession: (sessionId: string) => (sessionId === deferring.sessionId ? [{ status: "pending" }] : []),
        listDeliveriesForSession: (sessionId: string) => (sessionId === awaitingResult.sessionId ? [{ status: "pending" }] : []),
      },
      deferLoopStore: { listForSession: () => [] },
    });
    const current = await helm.createConversation();
    helm.recordTurn(current.sessionId);

    advance(HELM_POLICY.retainMs + DAY);
    expect(await helm.prune()).toBe(1);
    expect(deleted).toEqual([old.sessionId]);
    expect(store.list().map((record) => record.sessionId).sort())
      .toEqual([keeper.sessionId, working.sessionId, deferring.sessionId, awaitingResult.sessionId, current.sessionId].sort());
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

describe("Helm session profiles", () => {
  it("makes Helm's chat an ordinary Assistant chat with Helm's own tools and guidance added", async () => {
    const { helm } = createHarness();
    const profile = helm.getSessionProfile();
    expect(profile.configOptions?.()).toMatchObject({
      promptProfile: "assistant",
      promptRole: expect.stringContaining("you are Helm"),
      extraGuidance: expect.stringContaining("(claude-opus-5)"),
    });
    const expected = profile.expectedToolNames(["task_list", "session_start"]);
    expect(expected).toEqual(expect.arrayContaining(["task_list", "session_start", "bridge_overview", "read_bridge"]));
    const applied = profile.apply({
      sessionId: "abc",
      tools: [{ name: "task_list" }, { name: "bridge_overview" }],
      excludedTools: ["report_intent"],
      mcpServers: { github: {} },
      skillDirectories: ["/skills"],
      systemMessage: { mode: "customize", content: "ordinary guidance" },
    }) as Record<string, any>;
    const names = applied.tools.map((tool: { name: string }) => tool.name);
    // Helm's own bridge_overview replaces a same-named one, and the chat keeps every other tool.
    expect(names.filter((name: string) => name === "bridge_overview")).toHaveLength(1);
    expect(names).toEqual(expect.arrayContaining(["task_list", "send_to_session", "helm_brief", "read_bridge"]));
    // Its reused, size-capped wrappers of Bridge tools are for the looks; the chat has the originals.
    expect(names.filter((name: string) => name === "task_list")).toHaveLength(1);
    expect(new Set(names).size).toBe(names.length);
    expect(applied.excludedTools).toEqual(["report_intent", "ask_user"]);
    expect(applied.mcpServers).toEqual({ github: {} });
    expect(applied.skillDirectories).toEqual(["/skills"]);
    expect(applied.availableTools).toBeUndefined();
    expect(applied.systemMessage).toEqual({ mode: "customize", content: "ordinary guidance" });
  });

  it("moves conversations pinned to the old Helm folder to the Bridge workspace", async () => {
    const { helm, ctx } = createHarness();
    const legacy = await helm.createConversation();
    helm.recordTurn(legacy.sessionId);
    const elsewhere = await helm.createConversation();
    const workspaceDir = makeTestDir("helm-workspace");
    const pins = new Map<string, string>([
      [legacy.sessionId, join(ctx.runtimePaths!.dataDir, "helm")],
      [elsewhere.sessionId, "/projects/site"],
    ]);
    Object.assign(ctx.runtimePaths!, { workspaceDir });
    Object.assign(ctx, {
      sessionWorkspaceStore: {
        getWorkspace: (sessionId: string) => (pins.has(sessionId) ? { cwd: pins.get(sessionId)!, updatedAt: "" } : undefined),
        setWorkspace: (sessionId: string, cwd: string) => pins.set(sessionId, cwd),
      },
    });
    expect(helm.moveLegacyWorkspaces()).toBe(1);
    expect(pins.get(legacy.sessionId)).toBe(workspaceDir);
    expect(pins.get(elsewhere.sessionId)).toBe("/projects/site");
  });

  it("keeps a look locked to Helm's own tools and instructions", () => {
    const onPermissionRequest = () => undefined;
    const tools = [defineBridgeTool("bridge_overview", { description: "Overview", handler: async () => "ok" })];
    const applied = applyHelmSessionProfile({
      sessionId: "abc",
      model: "gpt-5.6-luna",
      streaming: true,
      memory: { enabled: false },
      onPermissionRequest,
      // Capabilities ordinary sessions have, or may gain later. None of them are a look's.
      pluginDirectories: ["/plugins/computer-use"],
      someFutureCapability: { enabled: true },
      tools: [{ name: "powershell" }],
      excludedTools: ["report_intent"],
      mcpServers: { github: {} },
      enableConfigDiscovery: true,
      skillDirectories: ["/skills"],
      customAgents: [{ name: "reviewer" }],
      agent: "reviewer",
      systemMessage: { mode: "customize", content: "coding agent" },
    }, { tools, workingDirectory: "/data/helm/thinker", systemPrompt: "You are Helm's look." }) as Record<string, any>;
    expect(applied).toMatchObject({ sessionId: "abc", model: "gpt-5.6-luna", streaming: true, memory: { enabled: false } });
    expect(applied.onPermissionRequest).toBe(onPermissionRequest);
    // An allowlist, not a denylist: a field nobody has heard of yet is dropped too.
    expect(applied.pluginDirectories).toBeUndefined();
    expect(applied.someFutureCapability).toBeUndefined();
    expect(applied.availableTools).toEqual(["bridge_overview"]);
    expect(applied.tools.map((tool: { name: string }) => tool.name)).toEqual(["bridge_overview"]);
    expect(applied.mcpServers).toEqual({});
    expect(applied.enableConfigDiscovery).toBe(false);
    expect(applied.skillDirectories).toEqual([]);
    expect(applied.customAgents).toBeUndefined();
    expect(applied.agent).toBeUndefined();
    expect(applied.systemMessage).toEqual({ mode: "replace", content: "You are Helm's look." });
    expect(applied.workingDirectory).toBe("/data/helm/thinker");
  });
});
