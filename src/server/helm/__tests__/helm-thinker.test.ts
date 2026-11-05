import { describe, expect, it, onTestFinished, vi } from "vitest";
import { setupTestDb } from "../../__tests__/helpers.js";
import { createReadStateStore } from "../../read-state-store.js";
import { createHelmThinkerStore } from "../thinker/store.js";
import { HelmThinker } from "../thinker/thinker.js";
import type { PacketBridge, ThinkerPacket } from "../thinker/context.js";
import { RunSources } from "../thinker/outside-sources.js";
import { MAX_CHARS, validatePublication } from "../thinker/publish.js";

function packetBridge(): PacketBridge {
  return {
    id: "local", label: "otherbox", ok: true,
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
    mcpServerStore: {
      getMcpServer: (id: string) => id === "mail-id"
        ? { id, name: "Mail", enabledByDefault: false, createdAt: "", updatedAt: "", config: { type: "local", command: "mail-mcp", args: [] } }
        : undefined,
    },
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
  return { ctx, store, thinker, readStateStore, submitUserInputResponse, emitReadStateChanged };
}

function setupClock(at: Date, options?: { staging?: boolean }) {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.setSystemTime(at);
  const fixture = setup(options);
  onTestFinished(async () => {
    await fixture.thinker.dispose();
    vi.useRealTimers();
  });
  return fixture;
}

function packet(): ThinkerPacket {
  return { now: new Date().toISOString(), timezone: "UTC", trigger: "manual", rebuild: false, lastRunAt: null, bridges: [packetBridge()], memory: [], feedback: [], previousItems: [], outsideSources: [] };
}

function activate(thinker: HelmThinker, store: ReturnType<typeof createHelmThinkerStore>, runSession = "run-session") {
  const run = store.createRun({ sessionId: runSession, trigger: "manual", rebuild: false, model: null, effort: null });
  (thinker as any).active = { runId: run.id, sessionId: run.sessionId, packet: packet(), controller: new AbortController(), carriedSources: [] };
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

const ITEM = { kind: "fyi", bridge: "local", title: "Install?", recommendation: "Yes." };
const withItem = (extra: object) => ({ summary: "x", items: [{ ...ITEM, ...extra }] });
const withMemory = (memory: object) => ({ summary: "x", items: [], memory });

// Each row finds a limit in the tool's schema and builds a publication that sits on it.
const TEXT_LIMITS: Array<[string, (schema: any) => any, (value: string) => unknown]> = [
  ["summary", (s) => s.summary, (value) => ({ summary: value, items: [] })],
  ["item title", (s) => s.items.items.properties.title, (value) => withItem({ title: value })],
  ["recommendation", (s) => s.items.items.properties.recommendation, (value) => withItem({ recommendation: value })],
  ["why", (s) => s.items.items.properties.why, (value) => withItem({ why: value })],
  ["evidence label", (s) => s.items.items.properties.evidence.items.properties.label, (value) => withItem({ evidence: [{ label: value, taskId: "t1" }] })],
  ["action label", (s) => s.items.items.properties.actions.items.properties.label, (value) => withItem({ actions: [{ label: value, type: "open", taskId: "t1" }] })],
  ["answer", (s) => s.items.items.properties.actions.items.properties.answer, (value) => withItem({ actions: [{ label: "Yes", type: "answer", sessionId: "s-q", requestId: "r1", answer: value }] })],
  ["message", (s) => s.items.items.properties.actions.items.properties.message, (value) => withItem({ actions: [{ label: "Send", type: "send", sessionId: "s-r", message: value }] })],
  ["proposal", (s) => s.proposals.items.properties.text, (value) => ({ summary: "x", items: [], proposals: [{ bridge: "local", text: value }] })],
  ["watching", (s) => s.watching.items.properties.text, (value) => ({ summary: "x", items: [], watching: [{ bridge: "local", text: value }] })],
  ["handled why", (s) => s.handled.items.properties.why, (value) => ({ summary: "x", items: [], handled: [{ bridge: "local", sessionId: "s-r", why: value }] })],
  ["thread", (s) => s.memory.properties.threads.items.properties.text, (value) => withMemory({ threads: [{ bridge: "local", taskId: "t1", text: value }] })],
  ["person", (s) => s.memory.properties.people.items.properties.text, (value) => withMemory({ people: [{ key: "k", text: value }] })],
  ["date", (s) => s.memory.properties.dates.items.properties.text, (value) => withMemory({ dates: [{ key: "k", text: value }] })],
  ["proposed rule", (s) => s.memory.properties.proposeRules.items.properties.text, (value) => withMemory({ proposeRules: [{ text: value }] })],
  ["proposed priority", (s) => s.memory.properties.proposePriorities.items.properties.text, (value) => withMemory({ proposePriorities: [{ text: value }] })],
];

const LIST_LIMITS: Array<[string, (schema: any) => any, (count: number) => unknown]> = [
  ["items", (s) => s.items, (count) => ({ summary: "x", items: Array(count).fill(ITEM) })],
  ["evidence", (s) => s.items.items.properties.evidence, (count) => withItem({ evidence: Array(count).fill({ label: "AWC", taskId: "t1" }) })],
  ["actions", (s) => s.items.items.properties.actions, (count) => withItem({ actions: Array(count).fill({ label: "Open", type: "open", taskId: "t1" }) })],
  ["proposals", (s) => s.proposals, (count) => ({ summary: "x", items: [], proposals: Array(count).fill({ bridge: "local", text: "Close it" }) })],
  ["watching", (s) => s.watching, (count) => ({ summary: "x", items: [], watching: Array(count).fill({ bridge: "local", text: "A reply" }) })],
  ["handled", (s) => s.handled, (count) => ({ summary: "x", items: [], handled: Array(count).fill({ bridge: "local", sessionId: "s-r", why: "FYI" }) })],
];

function statedLimit(field: { description?: string }): number {
  const stated = /At most (\d+)/.exec(field.description ?? "");
  expect(stated, `no limit in: ${field.description}`).not.toBeNull();
  return Number(stated![1]);
}

function publishSchema() {
  const { thinker } = setup();
  return (thinker as any).getTools().find((tool: any) => tool.name === "helm_publish").inputSchema.properties;
}

describe("helm_publish schema", () => {
  it("names every too-long field in one reply, so a run can fix them together", async () => {
    const { store, thinker } = setup();
    const { publish } = activate(thinker, store);
    const why = "x".repeat(MAX_CHARS.why + 1);
    const reply = text(await publish({
      summary: "x",
      items: [{ ...ITEM, why }, { ...ITEM, why }],
      watching: [{ bridge: "local", text: "x".repeat(MAX_CHARS.watching + 1) }],
    }));
    expect(reply).toContain("item 1: why");
    expect(reply).toContain("item 2: why");
    expect(reply).toContain("watching 1: text");
  });
  it.each(TEXT_LIMITS)("states the longest %s the publication check accepts", (_name, field, build) => {
    const limit = statedLimit(field(publishSchema()));
    expect(validatePublication(build("x".repeat(limit)), packet(), [])).toMatchObject({ ok: true });
    expect(validatePublication(build("x".repeat(limit + 1)), packet(), [])).toMatchObject({ ok: false });
  });

  it.each(LIST_LIMITS)("states the most %s the publication check accepts", (_name, field, build) => {
    const limit = statedLimit(field(publishSchema()));
    expect(validatePublication(build(limit), packet(), [])).toMatchObject({ ok: true });
    expect(validatePublication(build(limit + 1), packet(), [])).toMatchObject({ ok: false });
  });
});

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

  it("lets a look read its own sources and marks what it writes with every source that may have shaped it", async () => {
    const { store, thinker } = setup();
    await expect(thinker.patchSettings({ sources: [{ serverId: "nope", tools: ["x"] }] })).rejects.toThrow(/does not exist/);
    await thinker.patchSettings({ sources: [{ serverId: "mail-id", tools: ["search_mail"] }] });

    const { run, publish } = activate(thinker, store);
    const active = (thinker as any).active;
    active.sources = await RunSources.open({
      selections: thinker.getSettings().sources,
      servers: new Map([["mail-id", (thinker as any).ctx.mcpServerStore.getMcpServer("mail-id")]]),
      connect: async () => ({ tools: [{ name: "search_mail", readOnly: true }], call: async () => ({ text: "Landlord: rent is due Friday", isError: false }), close: async () => undefined }),
    });
    active.packet.outsideSources = [{ name: "mail", ok: true, lastReadAt: null, tools: [{ name: "search_mail" }] }];
    // A rule an earlier look wrote from a calendar source reaches this run through memory.
    active.carriedSources = ["calendar-id"];
    const readSource = (thinker as any).getTools().find((tool: any) => tool.name === "read_source");
    const read = (sessionId: string) => readSource.handler({ source: "mail", tool: "search_mail", arguments: { query: "is:unread" } }, { sessionId, toolCallId: "c", toolName: "read_source" });

    expect(text(await read("some-other-session"))).toMatch(/only works inside the look/);
    expect(text(await read(run.sessionId))).toMatch(/OUTSIDE_SOURCE source=\\"mail\\".*rent is due Friday/);

    expect(text(await publish({ ...BRIEF, items: [{ kind: "due", bridge: "local", source: "mail", title: "Rent", recommendation: "Pay it." }], memory: { ...BRIEF.memory, dates: [{ key: "rent", text: "Rent due Friday", source: "mail: landlord" }] } }))).toMatch(/"success":true/);
    const written = store.listMemory().filter((entry) => entry.author === "helm");
    expect(written.length).toBeGreaterThan(1);
    expect(written.every((entry) => entry.fromSources.join() === "calendar-id,mail-id")).toBe(true);
    expect(store.getRun(run.id)).toMatchObject({ fromSources: ["calendar-id", "mail-id"], sources: [{ serverId: "mail-id", name: "mail", ok: true, used: true }] });
    expect(store.getSourceCoverage()).toEqual({ "mail-id": run.startedAt });

    // Tim correcting an entry keeps what may have shaped it.
    const date = written.find((entry) => entry.kind === "date")!;
    thinker.updateMemory(date.id, { text: "Rent due Thursday" });
    expect(store.getMemory(date.id)?.fromSources).toEqual(["calendar-id", "mail-id"]);

    store.finishRun(run.id, { status: "done" });
    (thinker as any).active = undefined;
    const view = await thinker.getBrief();
    expect(view.brief?.items[0]).toMatchObject({ source: "mail" });
    expect(view.sourceNames).toMatchObject({ "mail-id": "Mail", "calendar-id": "a removed source" });
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

  it("starts a tidy-up chat on the task, and keeps a started chat whose first message wasn't confirmed", async () => {
    const { store, thinker } = setup();
    const ctx = (thinker as any).ctx;
    const task = { id: "t1", title: "AWC", kind: "task", workItems: [], notes: "Long notes", cwd: undefined, sessionIds: [] as string[] };
    ctx.taskStore.getTask = (id: string) => (id === "t1" ? task : undefined);
    ctx.taskStore.linkSession = (_taskId: string, sessionId: string) => { task.sessionIds.push(sessionId); };
    ctx.sessionManager.createTaskSession = vi.fn()
      .mockResolvedValueOnce({ sessionId: "tidy-1" })
      .mockResolvedValueOnce({ sessionId: "tidy-2" });
    ctx.sessionManager.startWorkAndWaitForDelivery = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("runtime busy"));
    const { run, publish } = activate(thinker, store);
    (thinker as any).active.packet.bridges[0].tasks[0].tidy = ["notes are 30,000 characters"];
    await publish({ ...BRIEF, proposals: [
      { bridge: "local", text: "Tidy AWC", actions: [{ label: "Tidy", type: "tidy_task", taskId: "t1" }] },
      { bridge: "local", text: "Tidy AWC again", actions: [{ label: "Tidy", type: "tidy_task", taskId: "t1" }] },
    ] });
    store.finishRun(run.id, { status: "done" });
    (thinker as any).active = undefined;

    await expect(thinker.act(run.id, "p1", { actionId: "a1" })).resolves.toEqual({ ok: true, outcome: "Started a tidy-up chat", sessionId: "tidy-1" });
    expect(task.sessionIds).toEqual(["tidy-1"]);
    expect(ctx.sessionManager.startWorkAndWaitForDelivery).toHaveBeenCalledWith("tidy-1", expect.stringContaining('Tidy the standing instructions and notes of the task "AWC" (taskId: t1)'));
    // The chat exists, so the proposal is done and points at it instead of offering a second chat.
    await expect(thinker.act(run.id, "p2", { actionId: "a1" })).resolves.toMatchObject({ sessionId: "tidy-2", outcome: expect.stringMatching(/open it to check/) });
    expect(store.getItemStates(run.id).p2?.status).toBe("done");
  });

  it("holds a new brief as unseen until Tim has seen it, and only the latest brief can be seen", async () => {
    const { store, thinker } = setup();
    expect(thinker.getBriefStatus()).toEqual({ runId: null, seen: true, running: false });
    const first = activate(thinker, store);
    await first.publish(BRIEF);
    store.finishRun(first.run.id, { status: "done" });
    const second = activate(thinker, store, "run-session-2");
    expect(thinker.getBriefStatus()).toEqual({ runId: first.run.id, seen: false, running: true });
    await second.publish(BRIEF);
    store.finishRun(second.run.id, { status: "done" });
    (thinker as any).active = undefined;

    expect(thinker.getBriefStatus()).toEqual({ runId: second.run.id, seen: false, running: false });
    expect(thinker.markBriefSeen(first.run.id)).toEqual({ runId: second.run.id, seen: false, running: false });
    expect(thinker.markBriefSeen(second.run.id)).toEqual({ runId: second.run.id, seen: true, running: false });
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

  it("fails interrupted runs in a preview without scheduling looks, but still accepts a manual look", async () => {
    const { store, thinker } = setupClock(new Date(2026, 9, 25, 16), { staging: true });
    store.createRun({ sessionId: "old", trigger: "schedule", rebuild: false, model: null, effort: null });
    store.updateSettings({ times: ["17:00", "18:00"] });
    vi.setSystemTime(new Date(2026, 9, 25, 17, 59, 30));
    thinker.start();
    expect(store.latestRun()).toMatchObject({ status: "failed", error: expect.stringMatching(/restarted/) });
    expect(await thinker.getBrief()).toMatchObject({ preview: true, nextRunAt: null });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(thinker.listRuns()).toHaveLength(1);
    expect(await thinker.think({ trigger: "manual", rebuild: true })).toMatchObject({ trigger: "manual", rebuild: true });
    await vi.advanceTimersByTimeAsync(0);
  });

  it.each([
    { hour: 9, minute: 0, manual: false, triggers: ["schedule"] }, // starting exactly on the slot
    { hour: 10, minute: 29, manual: false, triggers: ["schedule"] }, // 90 minutes late when replayed
    { hour: 10, minute: 29, manual: true, triggers: ["manual"] },
    { hour: 10, minute: 59, manual: false, triggers: [] }, // exactly two hours when replayed
  ])("rechecks the missed 09:00 slot after startup at $hour:$minute, manual=$manual", async ({ hour, minute, manual, triggers }) => {
    const { store, thinker } = setupClock(new Date(2026, 9, 25, hour, minute));
    store.updateSettings({ times: ["08:30", "09:00"], rebuildWeekday: 0 });
    thinker.start();
    expect((await thinker.getBrief()).nextRunAt).toBe(new Date(2026, 9, 26, 8, 30).toISOString());
    await vi.advanceTimersByTimeAsync(59_999);
    expect(thinker.listRuns()).toHaveLength(0);
    if (manual) {
      await thinker.think({ trigger: "manual" });
      await vi.advanceTimersByTimeAsync(0);
      expect(thinker.getRunning()).toBeNull();
    }
    await vi.advanceTimersByTimeAsync(1);
    expect(thinker.listRuns().map((run) => run.trigger)).toEqual(triggers);
    if (triggers[0] === "schedule") expect(thinker.listRuns()[0]?.rebuild).toBe(true);
  });

  it.each(["disable", "edit", "empty", "dispose"])("cancels both the delayed replay and old regular slot on %s", async (change) => {
    const { store, thinker } = setupClock(new Date(2026, 9, 25, 8, 45, 30));
    store.updateSettings({ times: ["08:00", "08:47"] });
    thinker.start();
    if (change === "dispose") await thinker.dispose();
    else if (change === "disable") await thinker.patchSettings({ enabled: false });
    else await thinker.patchSettings({ times: change === "empty" ? [] : ["08:45", "09:00"] });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(thinker.listRuns()).toHaveLength(0);
    expect((await thinker.getBrief()).nextRunAt).toBe(change === "edit" ? new Date(2026, 9, 25, 9).toISOString() : null);
  });

  it.each([
    { time: "02:30", slot: new Date(2026, 2, 8, 2, 30) }, // 03:30 in a US spring gap
    { time: "01:30", slot: new Date(2026, 10, 1, 1, 30) }, // first occurrence in a US autumn fold
  ])("dispatches one local $time slot across a clock change", async ({ time, slot }) => {
    const { store, thinker } = setupClock(new Date(slot.getTime() - 60_000));
    store.updateSettings({ times: [time] });
    thinker.start();
    expect((await thinker.getBrief()).nextRunAt).toBe(slot.toISOString());
    await vi.advanceTimersByTimeAsync(90 * 60_000);
    expect(thinker.listRuns()).toMatchObject([{ trigger: "schedule", startedAt: slot.toISOString() }]);
  });

  it.each(["08:30", "08:31"])("drops the older %s look still choosing a model when the next slot starts", async (firstSlot) => {
    const { ctx, store, thinker } = setupClock(new Date(2026, 9, 25, 8, 30, 59));
    let release!: () => void;
    const choosing = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(ctx.sessionManager, "listModels").mockImplementationOnce(async () => { await choosing; return []; });
    // The first slot is either a startup replay or a regular deadline.
    store.updateSettings({ times: [firstSlot, "08:32"], rebuildWeekday: 0 });
    thinker.start();
    await vi.advanceTimersByTimeAsync(61_000);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(thinker.listRuns()).toMatchObject([{ trigger: "schedule", rebuild: true }]);
  });

  it("skips a regular slot during a manual look without retrying it", async () => {
    const { ctx, thinker } = setupClock(new Date(2026, 9, 25, 17, 59, 30));
    let finish!: () => void;
    const finishing = new Promise<void>((resolve) => { finish = resolve; });
    ctx.sessionManager.getSessionUsageMetrics = async () => { await finishing; return { aiCredits: 0 }; };
    thinker.start();
    await thinker.think({ trigger: "manual" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(thinker.getRunning()?.trigger).toBe("manual");
    finish();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(thinker.listRuns().map((run) => run.trigger)).toEqual(["manual"]);
    expect((await thinker.getBrief()).nextRunAt).toBe(new Date(2026, 9, 26, 8).toISOString());
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
    (thinker as any).sources = () => [{ id: "local", label: "otherbox", messages }];
    await expect(thinker.readConversation("local", "s-r")).resolves.toEqual({ bridge: "local", messages: [{ role: "assistant", at: "2026-10-25T10:00:00.000Z", content: "Booked." }] });
    await expect(thinker.readConversation("pc", "s-r")).rejects.toThrow(/Unknown bridge "pc". Bridges: local/);
    await expect(thinker.readBridge("pc")).rejects.toThrow(/Unknown bridge/);
    expect(thinker.listBridges()).toEqual([{ id: "local", label: "otherbox" }]);
  });
});
