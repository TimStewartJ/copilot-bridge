import { describe, expect, it, vi } from "vitest";
import { setupTestDb } from "./helpers.js";
import {
  createModelComparisonService,
  createModelComparisonStore,
  parseJudgeReply,
  readFirstTurn,
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

const SETTINGS: AppSettings = {
  modelPresets: { preset1: { model: "gemini-5" }, preset2: { model: "gpt-6" }, preset3: { model: "claude-9", reasoningEffort: "high" } },
  modelAbTest: { enabled: true, a: { tier: "preset2" }, b: { tier: "preset3" }, startedAt: "2026-03-02T08:00:00.000Z" },
} as AppSettings;
const SCORES = { outcome: 3, correctness: 3, efficiency: 3, clarity: 3 };
const MAIN = "11111111-2222-4333-8444-555555555555";

function setup(randoms: number[]) {
  const store = createModelComparisonStore(setupTestDb());
  const events = new Map<string, unknown[]>();
  const models = new Map<string, string>();
  const queue = [...randoms];
  const clock = { now: Date.parse("2026-03-02T10:00:00.000Z") };
  const deps: ModelComparisonDeps = {
    store,
    getSettings: () => SETTINGS,
    listModels: async () => undefined,
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
    askJudge: vi.fn(async () => JSON.stringify({ scores: { "1": SCORES, "2": SCORES }, winner: "1", reason: "Finished the job." })),
    copilotHome: "/unused",
    now: () => clock.now,
    random: () => queue.shift() ?? 0.5,
    logger: { log: () => {}, warn: () => {} },
  };
  return { store, events, models, deps, clock, service: createModelComparisonService(deps) };
}

describe("model comparison service", () => {
  it("runs the first message once on the other arm, then has a third-family judge decide by arm", async () => {
    // First random: the user's chat runs on A. Second: the judge sees the twin as Response 1.
    const { store, events, models, deps, clock, service } = setup([0.25, 0.75]);
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
    expect(deps.askJudge).toHaveBeenCalledWith(expect.objectContaining({ model: "gemini-5" }));
    const record = store.getBySession(MAIN)!;
    expect(record.status).toBe("judged");
    expect(record.judgement).toMatchObject({ winner: "b", otherFamily: true });
    // Hidden from both chats until the user votes.
    expect(service.view(MAIN)?.revealed).toBeUndefined();
    // X is always the chat the user started, from whichever chat they vote.
    expect(service.vote(record.id, twinId, "y")).toMatchObject({
      side: "y",
      vote: "y",
      revealed: { x: { model: "gpt-6" }, y: { model: "claude-9" }, judge: { winner: "y" } },
    });
    // Combining once on Y's model switches X first, so the winner writes the merge and carries on.
    expect(service.view(MAIN)).toMatchObject({ suggestedKeep: "y" });
    expect(await service.combine(record.id, "y")).toMatchObject({ side: "x", combinedKeep: "y", combinable: false, taskId: "task-1" });
    expect(deps.switchModel).toHaveBeenCalledWith(MAIN, { model: "claude-9", reasoningEffort: "high", contextTier: "default" });
    expect(deps.sendMessage).toHaveBeenCalledWith(MAIN, expect.stringContaining("Twin reply."));
    expect(await service.combine(record.id, "x")).toBeUndefined();
    expect(deps.sendMessage).toHaveBeenCalledTimes(1);
    expect(service.report().arms).toEqual([
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
    expect(service.report().arms.every((arm) => arm.decided === 0)).toBe(true);
  });
});
