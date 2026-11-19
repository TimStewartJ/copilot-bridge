import { describe, expect, it, vi } from "vitest";
import { setupTestDb } from "./helpers.js";
import {
  createModelComparisonService,
  createModelComparisonStore,
  parseJudgeReply,
  pickJudges,
  readFirstTurn,
  type JudgeCatalogModel,
  type ModelComparisonDeps,
} from "../model-comparison.js";
import { decideComparisonTwinTool, isComparisonTwinSessionId } from "../comparison-twin.js";
import type { AppSettings } from "../settings-store.js";

const at = (second: number) => new Date(Date.UTC(2026, 2, 2, 9, 0, second)).toISOString();
const user = (content: string, second: number) => ({ type: "user.message", id: `u${second}`, timestamp: at(second), data: { content } });
const say = (content: string, second: number, tools = false) => ({
  type: "assistant.message",
  id: `m${second}`,
  timestamp: at(second),
  data: { content, toolRequests: tools ? [{ toolCallId: `t${second + 1}` }] : [] },
});
const toolStart = (second: number) => ({
  type: "tool.execution_start",
  timestamp: at(second),
  data: { toolCallId: `t${second}`, toolName: "bash", arguments: { command: "ls" } },
});
const toolDone = (second: number, started: number) => ({
  type: "tool.execution_complete",
  timestamp: at(second),
  data: { toolCallId: `t${started}`, success: true, result: { content: "file.txt" } },
});
const turnEnd = (second: number) => ({ type: "assistant.turn_end", timestamp: at(second), data: {} });

const answeredTurn = (prompt: string, reply: string) => [
  user(prompt, 0), say("", 1, true), toolStart(2), toolDone(3, 2), turnEnd(4), say(reply, 5), turnEnd(6),
];

describe("readFirstTurn", () => {
  it.each([
    ["answered", answeredTurn("Tidy the list", "Done."), "ended"],
    ["still working", [user("Tidy the list", 0), say("", 1, true), toolStart(2)], "open"],
    ["answered, then a follow-up", [...answeredTurn("Tidy the list", "Done."), user("Thanks", 9)], "ended"],
    ["steered before it answered", [user("Tidy the list", 0), say("", 1, true), toolStart(2), user("Also sort it", 3)], "steered"],
    ["stopped", [user("Tidy the list", 0), say("", 1, true), { type: "abort", timestamp: at(2), data: {} }], "stopped"],
  ])("reads a first turn that was %s", (_name, events, state) => {
    expect(readFirstTurn(events).state).toBe(state);
  });

  it("ignores sub-agent events and keeps only the first turn", () => {
    const turn = readFirstTurn([
      ...answeredTurn("Tidy the list", "Done."),
      { type: "assistant.message", agentId: "helper", timestamp: at(7), data: { content: "inner", toolRequests: [] } },
      user("Next thing", 9),
      say("Later reply", 10),
    ]);
    expect(turn).toMatchObject({ prompt: "Tidy the list", metrics: { toolCalls: 1 } });
    expect(turn.transcript).toContain("Done.");
    expect(turn.transcript).not.toContain("inner");
    expect(turn.transcript).not.toContain("Later reply");
  });
});

describe("parseJudgeReply", () => {
  const scores = { outcome: 4, correctness: 5, efficiency: 3, clarity: 4 };
  it("accepts the asked-for JSON, even wrapped in other text, and rejects any other shape", () => {
    expect(parseJudgeReply(`Here: {"scores":{"1":${JSON.stringify(scores)},"2":${JSON.stringify(scores)}},"winner":"2","reason":"Checked its work."}`))
      .toEqual({ winner: "2", scores: { "1": scores, "2": scores }, reason: "Checked its work." });
    expect(parseJudgeReply(`{"scores":{"1":${JSON.stringify(scores)},"2":${JSON.stringify({ ...scores, clarity: 9 })}},"winner":"1"}`)).toBeUndefined();
    expect(parseJudgeReply(`{"scores":{"1":${JSON.stringify(scores)},"2":${JSON.stringify(scores)}},"winner":"A"}`)).toBeUndefined();
  });
});

describe("decideComparisonTwinTool", () => {
  it.each([
    ["staging_deploy", undefined, true],
    ["phone-phone_create_reminder", undefined, true],
    ["ask_user", undefined, true],
    ["browser_exec", { context: "authenticated" }, true],
    ["browser_exec", { context: "public" }, false],
    ["bash", undefined, false],
    ["docs_read", undefined, false],
  ])("%s %j denied: %s", (tool, args, denied) => {
    expect(decideComparisonTwinTool(tool, args) !== undefined).toBe(denied);
  });
});

const priced = (id: string, outputPrice: number, efforts = ["low", "high"]): JudgeCatalogModel => ({
  id, supportedReasoningEfforts: efforts, billing: { tokenPrices: { outputPrice } },
});
const ARMS = { a: { model: "gpt-6" }, b: { model: "claude-9" } };

describe("pickJudges", () => {
  const catalog = [
    { id: "auto" },
    priced("gpt-6", 1000), priced("claude-9", 1000), priced("gpt-5", 500),
    priced("gemini-5-pro", 1000), priced("gemini-5-flash", 200), priced("gemini-4-ultra", 1500),
    priced("grok-3", 600), priced("grok-4-heavy", 9000), priced("mai-2", 800, []),
    { ...priced("zeta-1", 12000), policy: { state: "disabled" } },
  ];
  const ids = (judges: ReturnType<typeof pickJudges>) => judges.map((judge) => judge.setup.model);

  it("takes the best models of the makers neither arm uses, strongest first", () => {
    const judges = pickJudges(catalog, ARMS);
    expect(ids(judges)).toEqual(["grok-4-heavy", "gemini-4-ultra"]);
    expect(judges.every((judge) => judge.otherFamily && !judge.pinned)).toBe(true);
    expect(judges[0].setup).toEqual({ model: "grok-4-heavy", reasoningEffort: "high", contextTier: "default" });
  });

  it("judges on the model, effort and context the user chose for a maker", () => {
    const judges = pickJudges(catalog, ARMS, { bestModels: { gemini: { model: "gemini-5-pro", reasoningEffort: "low" } } });
    expect(judges.map((judge) => judge.setup)).toContainEqual({ model: "gemini-5-pro", reasoningEffort: "low", contextTier: "default" });
    const pinned = pickJudges(catalog, ARMS, { pinned: ["gemini-5-pro"], bestModels: { gemini: { model: "gemini-5-pro", reasoningEffort: "low" } } });
    expect(pinned[0]).toEqual({ setup: { model: "gemini-5-pro", reasoningEffort: "low", contextTier: "default" }, otherFamily: true, pinned: true });
  });

  it.each([
    ["a pin replaces the first automatic pick", { pinned: ["gpt-5"] }, ["gpt-5", "grok-4-heavy"]],
    ["an unknown pin is ignored", { pinned: ["gone-1"] }, ["grok-4-heavy", "gemini-4-ultra"]],
  ])("%s", (_name, options, expected) => {
    expect(ids(pickJudges(catalog, ARMS, options))).toEqual(expected);
  });

  it("falls back to a model of an arm's maker that is not an arm, marked as the same family", () => {
    const judges = pickJudges([priced("gpt-6", 1000), priced("claude-9", 1000), priced("gpt-5", 500)], ARMS);
    expect(judges).toEqual([{ setup: { model: "gpt-5", reasoningEffort: "high", contextTier: "default" }, otherFamily: false, pinned: false }]);
  });
});

const SETTINGS: AppSettings = {
  modelPresets: { preset1: { model: "gemini-5" }, preset2: { model: "gpt-6" }, preset3: { model: "claude-9", reasoningEffort: "high" } },
  modelAbTest: { enabled: true, a: { tier: "preset2" }, b: { tier: "preset3" }, startedAt: "2026-03-02T08:00:00.000Z" },
} as AppSettings;
const SCORES = { outcome: 3, correctness: 3, efficiency: 3, clarity: 3 };
const MAIN = "11111111-2222-4333-8444-555555555555";

/** Picks the response that contains `pick`, whichever order it is shown in. */
function judgeFavouring(pick: string) {
  return (prompt: string) => {
    const second = prompt.indexOf("=== Response 2 ===");
    const winner = prompt.indexOf(pick) > second ? "2" : "1";
    return JSON.stringify({ scores: { "1": SCORES, "2": SCORES }, winner, reason: `Response ${winner} finished the job.` });
  };
}

const CATALOG = [priced("gpt-6", 1000), priced("claude-9", 1000), priced("gemini-5", 1000), priced("grok-3", 600)];

function setup(randoms: number[]) {
  const db = setupTestDb();
  const store = createModelComparisonStore(db);
  const events = new Map<string, unknown[]>();
  const models = new Map<string, string>();
  const queue = [...randoms];
  const clock = { now: Date.parse("2026-03-02T10:00:00.000Z") };
  const judgeFor: Record<string, (prompt: string) => string> = { "gemini-5": judgeFavouring("Twin reply."), "grok-3": judgeFavouring("Twin reply.") };
  const deps: ModelComparisonDeps = {
    store,
    getSettings: () => SETTINGS,
    listModels: async () => CATALOG,
    createTwinWorkspace: vi.fn(async (_main: string, twin: string) => ({ cwd: `/work/${twin}/app`, repo: "/repo", worktree: `/work/${twin}` })),
    removeTwinWorkspace: vi.fn(async () => {}),
    twinWorkspaceChanged: vi.fn(async () => false),
    createTwin: vi.fn(async ({ sessionId, setup }) => { models.set(sessionId, setup.model); }),
    switchModel: vi.fn(async () => true),
    sendMessage: vi.fn(async () => {}),
    sendFirstMessage: vi.fn(async (sessionId: string, prompt: string) => { events.set(sessionId, answeredTurn(prompt, "Twin reply.")); }),
    readEvents: async (sessionId) => (events.has(sessionId) ? { kind: "ok", events: events.get(sessionId)!, malformedLines: 0 } : { kind: "missing" }),
    isBusy: () => false,
    hasPendingInput: () => false,
    abort: vi.fn(async () => {}),
    askJudge: vi.fn(async ({ model, prompt }: { model: string; prompt: string }) => judgeFor[model]?.(prompt)),
    copilotHome: "/unused",
    now: () => clock.now,
    random: () => queue.shift() ?? 0.5,
    logger: { log: () => {}, warn: () => {} },
  };
  return { db, store, events, models, deps, clock, judgeFor, service: createModelComparisonService(deps) };
}

describe("model comparison service", () => {
  it("runs the first message once on the other arm, then has two third-family judges decide by arm", async () => {
    // The user's chat runs on A.
    const { store, events, models, deps, clock, service } = setup([0.25]);
    const preparation = await service.prepare();
    expect(preparation).toMatchObject({ mainArm: "a", main: { model: "gpt-6" } });
    service.register(MAIN, preparation!, { taskId: "task-1", playbook: "research" });
    models.set(MAIN, "gpt-6");
    events.set(MAIN, answeredTurn("Compare the two plans", "Main reply."));

    service.onFirstMessage(MAIN, "Compare the two plans", undefined, undefined, "accepted");
    service.onFirstMessage(MAIN, "Compare the two plans", undefined, undefined, "accepted");
    await vi.waitFor(() => expect(store.getBySession(MAIN)?.status).toBe("running"));
    expect(deps.createTwin).toHaveBeenCalledTimes(1);
    const twinId = store.getBySession(MAIN)!.twinSessionId!;
    expect(isComparisonTwinSessionId(twinId)).toBe(true);
    expect(deps.createTwin).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "task-1", playbook: "research", cwd: `/work/${twinId}/app`, setup: { model: "claude-9", reasoningEffort: "high", contextTier: "default" },
    }));
    expect(deps.sendFirstMessage).toHaveBeenCalledWith(twinId, "Compare the two plans", undefined, undefined);
    expect(service.sourceSessionId(twinId)).toBe(MAIN);

    await service.tick();
    // Each judge scores both orders.
    expect(vi.mocked(deps.askJudge).mock.calls.map(([call]) => call.model).sort()).toEqual(["gemini-5", "gemini-5", "grok-3", "grok-3"]);
    const record = store.getBySession(MAIN)!;
    expect(record.status).toBe("judged");
    expect(record.judgement).toMatchObject({ verdict: "b", judgesAsked: 2, judgesCounted: 2 });
    // Hidden from both chats until the user votes, with no hint that would lead the vote.
    expect(service.view(MAIN)?.revealed).toBeUndefined();
    expect(service.view(MAIN)?.suggestedKeep).toBeUndefined();
    // X is always the chat the user started, from whichever chat they vote.
    expect(service.vote(record.id, twinId, "y")).toMatchObject({
      side: "y",
      vote: "y",
      revealed: { x: { model: "gpt-6" }, y: { model: "claude-9" }, judge: { verdict: "y" } },
    });
    // Combining once on Y's model switches X first, so the winner writes the merge and carries on.
    expect(service.view(MAIN)).toMatchObject({ suggestedKeep: "y" });
    expect(await service.combine(record.id, "y")).toMatchObject({ side: "x", combinedKeep: "y", combinable: false, taskId: "task-1" });
    expect(deps.switchModel).toHaveBeenCalledWith(MAIN, { model: "claude-9", reasoningEffort: "high", contextTier: "default" });
    expect(deps.sendMessage).toHaveBeenCalledWith(MAIN, expect.stringContaining("Twin reply."));
    expect(await service.combine(record.id, "x")).toBeUndefined();
    expect(deps.sendMessage).toHaveBeenCalledTimes(1);
    expect((await service.report()).arms).toEqual([
      expect.objectContaining({ arm: "a", decided: 1, wins: 0 }),
      expect.objectContaining({ arm: "b", decided: 1, wins: 1, userWins: 1 }),
    ]);
    // The twin's worktree stays a day after the verdict, so both chats' changes can be compared.
    await service.tick();
    expect(deps.removeTwinWorkspace).not.toHaveBeenCalled();
    clock.now += 25 * 60 * 60_000;
    await service.tick();
    expect(deps.removeTwinWorkspace).toHaveBeenCalledWith({ repo: "/repo", worktree: `/work/${twinId}` });
    expect(events.get(twinId)).toBeDefined();
  });

  it("does not compare a pair whose first turn was steered, and fails a start a restart cut off", async () => {
    const { store, events, service } = setup([0.25]);
    service.register(MAIN, (await service.prepare())!, {});
    service.onFirstMessage(MAIN, "Do it", undefined, undefined, "accepted");
    await vi.waitFor(() => expect(store.getBySession(MAIN)?.status).toBe("running"));
    events.set(MAIN, [user("Do it", 0), say("", 1, true), toolStart(2), user("Actually, wait", 3)]);
    await service.tick();
    expect(store.getBySession(MAIN)).toMatchObject({ status: "incomplete" });

    const other = "22222222-3333-4444-8555-666666666666";
    const prepared = (await service.prepare())!;
    service.register(other, prepared, {});
    store.claimPrompt(other, "c4ec2b1d-0000-4000-8000-000000000000", at(0));
    await service.tick();
    expect(store.getBySession(other)).toMatchObject({ status: "failed" });
    // Its twin never got the message, so there is nothing to vote on or count.
    expect(service.view(other)).toMatchObject({ votable: false });
    expect(service.vote(store.getBySession(other)!.id, other, "x")).toBeUndefined();
    expect((await service.report()).arms.every((arm) => arm.decided === 0)).toBe(true);
  });

  async function judgedPair(randoms: number[], tweak?: (judgeFor: Record<string, (prompt: string) => string>) => void) {
    const context = setup(randoms);
    tweak?.(context.judgeFor);
    context.service.register(MAIN, (await context.service.prepare())!, {});
    context.events.set(MAIN, answeredTurn("Plan it", "Main reply."));
    context.service.onFirstMessage(MAIN, "Plan it", undefined, undefined, "accepted");
    await vi.waitFor(() => expect(context.store.getBySession(MAIN)?.status).toBe("running"));
    await context.service.tick();
    return context;
  }

  it.each([
    ["one judge picks by position", () => JSON.stringify({ scores: { "1": SCORES, "2": SCORES }, winner: "1", reason: "First." }), "split", 2],
    ["one judge never answers in a usable shape", () => "no verdict", "b", 1],
    ["one judge throws in one order", (prompt: string) => {
      if (prompt.indexOf("Main reply.") < prompt.indexOf("=== Response 2 ===")) throw new Error("helper died");
      return judgeFavouring("Twin reply.")(prompt);
    }, "b", 1],
  ])("counts only judges with both orders back, and splits on any disagreement: %s", async (_name, grok, verdict, counted) => {
    const { store } = await judgedPair([0.25], (judgeFor) => { judgeFor["grok-3"] = grok; });
    expect(store.getBySession(MAIN)?.judgement).toMatchObject({ verdict, judgesAsked: 2, judgesCounted: counted });
  });

  it("re-judges judged pairs in place, keeping the vote and the cleanup clock, and keeps a pair whose log is gone", async () => {
    const { store, events, judgeFor, service, deps } = await judgedPair([0.25]);
    const record = store.getBySession(MAIN)!;
    service.vote(record.id, MAIN, "x");
    const before = store.get(record.id)!;
    judgeFor["gemini-5"] = judgeFavouring("Main reply.");
    judgeFor["grok-3"] = judgeFavouring("Main reply.");

    expect(service.rejudge()).toMatchObject({ running: true, total: 1 });
    // A second request joins the running batch instead of paying for it twice.
    expect(service.rejudge()).toMatchObject({ running: true, total: 1 });
    await vi.waitFor(async () => expect((await service.report()).rejudge).toMatchObject({ running: false, done: 1, skipped: 0 }));
    const after = store.get(record.id)!;
    expect(after.judgement).toMatchObject({ verdict: "a" });
    expect(after).toMatchObject({ status: "judged", userVote: "a", updatedAt: before.updatedAt });
    expect((await service.report()).agreement).toEqual([
      { model: "gemini-5", votes: 1, agreed: 1 },
      { model: "grok-3", votes: 1, agreed: 1 },
    ]);

    events.delete(after.twinSessionId!);
    const calls = vi.mocked(deps.askJudge).mock.calls.length;
    service.rejudge();
    await vi.waitFor(async () => expect((await service.report()).rejudge).toMatchObject({ running: false, done: 0, skipped: 1 }));
    expect(vi.mocked(deps.askJudge).mock.calls.length).toBe(calls);
    expect(store.get(record.id)?.judgement).toMatchObject({ verdict: "a" });
  });

  it("reads a single judge's verdict from before panels as one run", async () => {
    const { db, store, service } = await judgedPair([0.25]);
    const legacy = { model: "gpt-5", otherFamily: false, winner: "a", scores: { a: SCORES, b: SCORES }, reason: "Old." };
    db.prepare("UPDATE model_comparisons SET judgementJson = ?").run(JSON.stringify(legacy));
    const record = store.getBySession(MAIN)!;
    expect(record.judgement).toEqual({ verdict: "a", judgesAsked: 1, judgesCounted: 1, runs: [legacy] });
    service.vote(record.id, MAIN, "tie");
    expect(service.view(MAIN)?.revealed?.judge).toEqual({
      verdict: "x", judgesAsked: 1, judgesCounted: 1, runs: [{ model: "gpt-5", winner: "x", reason: "Old." }],
    });
  });
});
