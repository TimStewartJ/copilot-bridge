import { describe, expect, it, vi } from "vitest";
import { setupTestDb } from "../../__tests__/helpers.js";
import { createReadStateStore } from "../../read-state-store.js";
import { createHelmThinkerStore } from "../thinker/store.js";
import { HelmThinker } from "../thinker/thinker.js";
import type { PacketBridge, ThinkerPacket } from "../thinker/context.js";

function packetBridge(): PacketBridge {
  return {
    id: "local", label: "lazrik", ok: true,
    questions: [{ sessionId: "s-q", requestId: "r1", kind: "user_input", question: "Install?", choices: ["Yes", "No"], allowFreeform: true, answerable: true, conversation: "Bot" }],
    replies: [{ sessionId: "s-r", conversation: "Flyer", activityAt: "2026-10-25T10:00:00.000Z" }],
    due: [], tasks: [{ taskId: "t1", title: "AWC", changed: true }], working: [], omitted: { questions: 0, replies: 0, due: 0, tasks: 0 },
    sessionIds: new Set(["s-q", "s-r"]),
  };
}

function setup(options: { staging?: boolean } = {}) {
  const db = setupTestDb();
  const store = createHelmThinkerStore(db);
  const readStateStore = createReadStateStore(db);
  const submitUserInputResponse = vi.fn(async () => ({ ok: true }));
  const hydratePendingInteractions = vi.fn(async (sessionId: string) => ({
    pendingUserInputs: sessionId === "s-q" ? [{ requestId: "r1", question: "Install?", choices: ["Yes", "No"], allowFreeform: true }] : [],
    pendingElicitations: [],
  }));
  const ctx: any = {
    isStaging: options.staging === true,
    readStateStore,
    settingsStore: { getSettings: () => ({}) },
    globalBus: { subscribe: () => () => undefined, emit: () => undefined },
    sessionManager: { hydratePendingInteractions, submitUserInputResponse, listModels: async () => [] },
    taskStore: { listTasks: () => [], getTask: () => undefined },
  };
  const emitReadStateChanged = vi.fn();
  const thinker = new HelmThinker({
    ctx, store,
    facade: { listSessions: async () => [], markRead: () => undefined, setArchived: () => undefined, sendMessage: async () => "started", createSession: async () => ({ sessionId: "x" }) },
    runtime: { watchSession: () => undefined },
    readSessions: async () => [],
    deleteSession: async () => undefined,
    emitReadStateChanged,
  });
  return { store, thinker, readStateStore, submitUserInputResponse, emitReadStateChanged };
}

function activate(thinker: HelmThinker, store: ReturnType<typeof createHelmThinkerStore>, runSession = "run-session") {
  const run = store.createRun({ sessionId: runSession, trigger: "manual", rebuild: false, model: null, effort: null });
  const packet: ThinkerPacket = { now: new Date().toISOString(), timezone: "UTC", trigger: "manual", rebuild: false, lastRunAt: null, bridges: [packetBridge()], memory: [], feedback: [], previousItems: [] };
  (thinker as any).active = { runId: run.id, sessionId: run.sessionId, packet };
  const publish = (thinker as any).getTools().find((tool: any) => tool.name === "helm_publish");
  return { run, publish: (args: unknown, sessionId = runSession) => publish.handler(args, { sessionId, toolCallId: "c", toolName: "helm_publish" }) };
}

const BRIEF = {
  summary: "Quiet day.",
  items: [{ kind: "question", bridge: "local", title: "Install?", recommendation: "Yes.", actions: [{ label: "Yes", primary: true, type: "answer", sessionId: "s-q", requestId: "r1", answer: "Yes" }], replyTo: { sessionId: "s-q" } }],
  handled: [{ bridge: "local", sessionId: "s-r", why: "FYI" }],
  memory: { threads: [{ bridge: "local", taskId: "t1", text: "Waiting on the return flight" }], proposeRules: [{ text: "Game mods are not urgent" }] },
};

function text(result: any): string {
  return JSON.stringify(result);
}

describe("Helm thinker", () => {
  it("accepts one publication only from its own running session, then serves the brief", async () => {
    const { store, thinker, readStateStore, emitReadStateChanged } = setup();
    const { run, publish } = activate(thinker, store);

    expect(text(await publish(BRIEF, "some-other-session"))).toMatch(/only works inside the thinker run/);
    expect(text(await publish({ summary: "x", items: [{ kind: "fyi", bridge: "nowhere", title: "t", recommendation: "r" }] }))).toMatch(/was not published/);
    expect(text(await publish(BRIEF))).toMatch(/"success":true/);
    expect(text(await publish(BRIEF))).toMatch(/already published/);

    // The FYI reply was marked read, only through what the run saw.
    expect(readStateStore.getReadStateFor(["s-r"])["s-r"]).toBe("2026-10-25T10:00:00.000Z");
    expect(emitReadStateChanged).toHaveBeenCalled();
    expect(store.findByKey("thread", "local:t1")?.text).toBe("Waiting on the return flight");
    expect(store.listMemory().find((entry) => entry.kind === "rule")).toMatchObject({ status: "proposed", author: "helm" });

    store.finishRun(run.id, { status: "done" });
    (thinker as any).active = undefined;
    const view = await thinker.getBrief();
    expect(view.brief?.items[0]?.title).toBe("Install?");
    expect(view.handled).toHaveLength(1);
    expect(view.proposed).toHaveLength(1);
  });

  it("proposes only when Tim switched routine handling off", async () => {
    const { store, thinker, readStateStore } = setup();
    store.updateSettings({ autonomy: "propose" });
    const { publish } = activate(thinker, store);
    await publish(BRIEF);
    expect(readStateStore.getReadStateFor(["s-r"])["s-r"]).toBeUndefined();
  });

  it("undoes a handled reply unless Tim read it further meanwhile", async () => {
    const { store, thinker, readStateStore } = setup();
    const { run, publish } = activate(thinker, store);
    await publish(BRIEF);
    const [handled] = store.listHandled(run.id);
    thinker.undoHandled(handled!.id);
    expect(readStateStore.getReadStateFor(["s-r"])["s-r"]).toBeUndefined();
    expect(() => thinker.undoHandled(handled!.id)).toThrow(/Already undone/);
    expect(store.pendingFeedback().map((entry) => entry.kind)).toEqual(["undo"]);
  });

  it("re-checks a question is still waiting before answering it, and records the outcome", async () => {
    const { store, thinker, submitUserInputResponse } = setup();
    const { run, publish } = activate(thinker, store);
    await publish(BRIEF);
    store.finishRun(run.id, { status: "done" });

    await expect(thinker.act(run.id, "i1", { actionId: "a1" })).resolves.toEqual({ ok: true, outcome: "Answered: Yes" });
    expect(submitUserInputResponse).toHaveBeenCalledWith("s-q", "r1", { answer: "Yes", wasFreeform: false });
    expect(store.getItemStates(run.id).i1).toMatchObject({ status: "done", outcome: "Answered: Yes" });

    // In Tim's own words, matched to a choice when it is one.
    thinker.feedback(run.id, "i1", { kind: "reopen" });
    await thinker.act(run.id, "i1", { text: "no" });
    expect(submitUserInputResponse).toHaveBeenLastCalledWith("s-q", "r1", { answer: "No", wasFreeform: false });
    await expect(thinker.act(run.id, "i9", { actionId: "a1" })).rejects.toThrow(/no longer in the brief/);
  });

  it("acts on an item once, only from the current brief, and frees it again when the action fails", async () => {
    const { store, thinker, submitUserInputResponse } = setup();
    const { run, publish } = activate(thinker, store);
    await publish(BRIEF);
    store.finishRun(run.id, { status: "done" });
    (thinker as any).active = undefined;

    submitUserInputResponse.mockRejectedValueOnce(new Error("runtime busy"));
    await expect(thinker.act(run.id, "i1", { actionId: "a1" })).rejects.toThrow(/runtime busy/);
    expect(store.getItemStates(run.id).i1?.status).toBe("open");

    const [first, second] = await Promise.allSettled([thinker.act(run.id, "i1", { actionId: "a1" }), thinker.act(run.id, "i1", { actionId: "a1" })]);
    expect([first.status, second.status].sort()).toEqual(["fulfilled", "rejected"]);
    expect(submitUserInputResponse).toHaveBeenCalledTimes(2);

    const next = activate(thinker, store, "run-session-2");
    await next.publish(BRIEF);
    store.finishRun(next.run.id, { status: "done" });
    await expect(thinker.act(run.id, "i1", { actionId: "a1" })).rejects.toThrow(/newer brief/);
  });

  it("ignores a publication that arrives after the run was given up", async () => {
    const { store, thinker } = setup();
    const { publish } = activate(thinker, store);
    (thinker as any).active.fenced = true;
    expect(text(await publish(BRIEF))).toMatch(/only works inside the thinker run/);
    expect(store.latestRun()?.briefJson).toBeNull();
  });

  it("looks on the Helm model, at its tier's effort and context", async () => {
    const { thinker } = setup();
    const ctx = (thinker as any).ctx;
    ctx.settingsStore.getSettings = () => ({
      model: "gpt-6-luna",
      modelPresets: { preset3: { model: "claude-opus-5.5", reasoningEffort: "max", contextTier: "long_context" } },
      modelRoles: { helm: { tier: "preset3" } },
    });
    ctx.sessionManager.listModels = async () => [
      { id: "gpt-6-luna", billing: { tokenPrices: { outputPrice: 50 } }, supportedReasoningEfforts: ["low", "high"] },
      { id: "claude-opus-5.5", billing: { tokenPrices: { outputPrice: 900 } }, supportedReasoningEfforts: ["low", "high", "max"] },
    ];
    await expect((thinker as any).chooseModel()).resolves.toEqual({ model: "claude-opus-5.5", effort: "max", contextTier: "long_context" });
    ctx.settingsStore.getSettings = () => ({ model: "gpt-6-luna" });
    await expect((thinker as any).chooseModel()).resolves.toEqual({ model: "gpt-6-luna", effort: "high" });
  });

  it("keeps Tim's own entries within the limits too", () => {
    const { thinker } = setup();
    for (let index = 0; index < 15; index++) thinker.addMemory({ kind: "priority", text: `Priority ${index}` });
    expect(() => thinker.addMemory({ kind: "priority", text: "One too many" })).toThrow(/at most 15/);
  });

  it("lets Tim keep, correct and forget memory, and keeps his entries his", () => {
    const { store, thinker } = setup();
    const proposed = store.addMemory({ kind: "rule", text: "Helm's idea", author: "helm", status: "proposed" });
    expect(thinker.updateMemory(proposed.id, { status: "active" })).toMatchObject({ status: "active", author: "user" });
    const mine = thinker.addMemory({ kind: "priority", text: "Ministry first on weekends" });
    expect(mine).toMatchObject({ author: "user", status: "active", source: "Tim" });
    thinker.updateMemory(mine.id, { status: "forgotten" });
    expect(thinker.listMemory().some((entry) => entry.id === mine.id)).toBe(false);
    expect(() => thinker.addMemory({ kind: "picture", text: "x" })).toThrow(/kind must be/);
  });

  it("fails runs a restart interrupted and never schedules itself in a staged preview", () => {
    const { store, thinker } = setup({ staging: true });
    store.createRun({ sessionId: "old", trigger: "schedule", rebuild: false, model: null, effort: null });
    thinker.start();
    expect(store.latestRun()).toMatchObject({ status: "failed", error: expect.stringMatching(/restarted/) });
    expect((thinker as any).nextRunAt).toBeNull();
    thinker.dispose();
  });

  it("forgets old runs only after their conversations are deleted", async () => {
    const { store, thinker } = setup();
    const old = store.createRun({ sessionId: "old-run", trigger: "schedule", rebuild: false, model: null, effort: null });
    store.finishRun(old.id, { status: "done" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    for (let index = 0; index < 5; index++) {
      const recent = store.createRun({ sessionId: `recent-${index}`, trigger: "schedule", rebuild: false, model: null, effort: null });
      store.finishRun(recent.id, { status: "done" });
    }
    const deleteSession = vi.fn(async (_sessionId: string): Promise<void> => { throw new Error("Cannot delete a busy session"); });
    (thinker as any).deleteSession = deleteSession;
    (thinker as any).now = () => new Date(Date.now() + 90 * 86_400_000);
    await (thinker as any).retention();
    expect(deleteSession).toHaveBeenCalledWith("old-run");
    expect(store.getRun(old.id)).toBeTruthy();
    deleteSession.mockImplementation(async () => undefined);
    await (thinker as any).retention();
    expect(store.getRun(old.id)).toBeFalsy();
    thinker.dispose();
  });

  it("lets Helm's chat read any configured Bridge without marking anything read", async () => {
    const { thinker } = setup();
    const messages = vi.fn(async () => [{ role: "assistant", content: "Booked.", timestamp: "2026-10-25T10:00:00.000Z" }]);
    (thinker as any).sources = () => [{ id: "local", label: "lazrik", messages }];
    await expect(thinker.readConversation("local", "s-r")).resolves.toEqual({ bridge: "local", messages: [{ role: "assistant", at: "2026-10-25T10:00:00.000Z", content: "Booked." }] });
    await expect(thinker.readConversation("pc", "s-r")).rejects.toThrow(/Unknown bridge "pc". Bridges: local/);
    await expect(thinker.readBridge("pc")).rejects.toThrow(/Unknown bridge/);
    expect(thinker.listBridges()).toEqual([{ id: "local", label: "lazrik" }]);
  });
});
