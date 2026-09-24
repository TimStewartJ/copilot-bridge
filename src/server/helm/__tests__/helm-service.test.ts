import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
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
