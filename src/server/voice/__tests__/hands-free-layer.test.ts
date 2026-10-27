import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamEvent } from "../../event-bus.js";
import { fallbackSummary, HandsFreeLayer, toFullSpeech, verbatimSpeech, type ChatDelivery, type ReadbackPreference } from "../hands-free-layer.js";
import type { AgentSpeech, AgentTurnInput } from "../voice-conversation.js";
import type { HandsFreeRouteContext, HandsFreeRouteDecision } from "../hands-free-model.js";

const SESSION_ID = "chat-1";
const LONG_REPLY = "I fixed the archive race.\n\n| Check | Result |\n|---|---|\n| server | pass |\n\n```ts\nconst x = 1;\n```\n\nShould I deploy it?";

class FakeBus {
  complete = false;
  listeners = new Set<(event: StreamEvent) => void>();
  constructor(readonly runId: string, private readonly snapshot: Partial<StreamEvent> = {}) {}
  subscribe(listener: (event: StreamEvent) => void) {
    listener({ type: "snapshot", runId: this.runId, ...this.snapshot });
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: StreamEvent) {
    for (const listener of [...this.listeners]) listener(event);
    if (["done", "error", "aborted"].includes(event.type)) this.complete = true;
  }
}

function harness() {
  let busy = false;
  let bus: FakeBus | undefined;
  const statusListeners = new Set<(event: { type: string; sessionId?: string }) => void>();
  const said: AgentSpeech[] = [];
  const dropped: string[] = [];
  let preference: ReadbackPreference | undefined;
  const route = vi.fn(async (_context: HandsFreeRouteContext): Promise<HandsFreeRouteDecision | undefined> => ({ action: "send", text: "Check the Tether task." }));
  const model = {
    warm: vi.fn(),
    route,
    speak: vi.fn(async () => "I fixed the archive race. I can read you the whole thing. Should I deploy it?" as string | undefined),
    progress: vi.fn(async () => "It's running the tests." as string | undefined),
    announce: vi.fn(async () => undefined),
  };
  const chat = {
    isBusy: () => busy,
    getBus: () => bus,
    deliver: vi.fn(async (): Promise<ChatDelivery> => "started"),
    abort: vi.fn(async () => true),
    title: async () => "Car task",
    warm: async () => undefined,
  };
  const layer = new HandsFreeLayer({
    sessionId: SESSION_ID,
    chat,
    model,
    subscribeStatus: (listener) => {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    preference: { get: () => preference, set: (value) => { preference = value; } },
  });
  layer.bindOutput({
    say: (item) => {
      said.push(item);
      item.onSpoken?.();
    },
    drop: (predicate) => {
      for (const item of said) if (predicate(item)) dropped.push(item.key);
    },
  });
  /** The chat starts a run, the way session-runner does: the bus is reset, then busy is announced. */
  const announceBusy = () => {
    for (const listener of statusListeners) listener({ type: "session:busy", sessionId: SESSION_ID });
  };
  const startRun = (runId = "run-1", snapshot: Partial<StreamEvent> = {}) => {
    bus = new FakeBus(runId, snapshot);
    busy = true;
    announceBusy();
    return bus;
  };
  const endRun = (event: StreamEvent) => {
    busy = false;
    bus!.emit(event);
  };
  /** One turn through the layer; resolves with what it said and how it ended. */
  const turn = (input: AgentTurnInput) => new Promise<{ spoken: string; handled?: string; started: boolean }>((resolve) => {
    let spoken = "";
    let started = false;
    layer.startTurn(input, {
      onStarted: () => { started = true; },
      onDelta: (text) => { spoken += text; },
      onDone: ({ handled }) => resolve({ spoken, ...(handled ? { handled } : {}), started }),
    });
  });
  return { layer, chat, model, route, said, dropped, startRun, announceBusy, endRun, turn, getPreference: () => preference };
}

describe("HandsFreeLayer", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }));
  afterEach(() => vi.useRealTimers());

  it("sends what was meant for the chat as it was said, fixing only recognition, and acknowledges it", async () => {
    const h = harness();
    await h.layer.warm();
    await expect(h.turn({ kind: "user", text: "check the tether task" })).resolves.toEqual({ spoken: "On it.", handled: "sent", started: true });
    expect(h.chat.deliver).toHaveBeenCalledWith("Check the Tether task.", undefined);
    expect(h.route).toHaveBeenCalledWith(expect.objectContaining({ chatTitle: "Car task", state: "idle", transcript: "check the tether task" }));

    // While the chat works the words steer it; without a decision they still go to the chat.
    h.startRun();
    h.chat.deliver.mockResolvedValueOnce("steered");
    h.route.mockResolvedValueOnce(undefined);
    await expect(h.turn({ kind: "user", text: "also make it blue" })).resolves.toMatchObject({ spoken: "Got it, I'll pass that on." });
    expect(h.chat.deliver).toHaveBeenLastCalledWith("also make it blue", undefined);
  });

  it("keeps what wasn't meant for the chat out of it", async () => {
    const h = harness();
    h.route.mockResolvedValueOnce({ action: "ignore", text: "" });
    await expect(h.turn({ kind: "user", text: "uh huh, I'll be there at six" })).resolves.toEqual({ spoken: "", handled: "not_sent", started: false });
    expect(h.chat.deliver).not.toHaveBeenCalled();
  });

  it("answers how the work is going from what it has done, without telling the chat", async () => {
    const h = harness();
    await h.layer.warm();
    const bus = h.startRun("run-1", { liveTools: [{ toolCallId: "t0", name: "view", args: { path: "a.ts" }, completedAt: "x", success: true }] });
    bus.emit({ type: "tool_start", toolCallId: "t1", name: "bash", args: { command: "npm test" } });
    bus.emit({ type: "tool_done", toolCallId: "t1", success: true, result: "12 passed" });
    await expect(h.turn({ kind: "command", command: "progress", text: "how's it going?" })).resolves.toMatchObject({ spoken: "It's running the tests.", handled: "progress" });
    expect(h.model.progress).toHaveBeenCalledWith({ elapsedSeconds: expect.any(Number), steps: ["view (path: a.ts) -> done", "bash (command: npm test) -> 12 passed"] });
    expect(h.chat.deliver).not.toHaveBeenCalled();
  });

  it("reads a short plain reply word for word and summarizes a long one, offering the rest", async () => {
    const h = harness();
    await h.layer.warm();
    h.startRun("run-1");
    h.endRun({ type: "done", content: "Done. I set the reminder for Tuesday at nine." });
    expect(h.said.at(-1)).toMatchObject({ key: "end:run-1", kind: "readback", text: "Done. I set the reminder for Tuesday at nine." });
    expect(h.model.speak).not.toHaveBeenCalled();

    h.startRun("run-2");
    h.endRun({ type: "done", content: LONG_REPLY });
    await vi.waitFor(() => expect(h.said.at(-1)).toMatchObject({ key: "end:run-2", offer: true }));

    // Asking for it in full while the summary is still being written: the summary is not said after it.
    let finishSummary!: (text: string) => void;
    h.model.speak.mockImplementationOnce(() => new Promise((resolve) => { finishSummary = resolve; }));
    h.startRun("run-2b");
    h.endRun({ type: "done", content: LONG_REPLY });
    await h.turn({ kind: "command", command: "full", text: "read me the whole thing" });
    finishSummary("A summary.");
    await vi.advanceTimersByTimeAsync(10);
    expect(h.said.some((item) => item.key === "end:run-2b")).toBe(false);

    // "Yes" to the offer reads it all, and long replies in this chat are read in full from then on.
    h.route.mockResolvedValueOnce({ action: "full", text: "" });
    const full = await h.turn({ kind: "user", text: "yes please" });
    expect(full.spoken).toBe(toFullSpeech(LONG_REPLY));
    expect(h.getPreference()).toBe("full");
    h.startRun("run-3");
    h.endRun({ type: "done", content: LONG_REPLY });
    await vi.waitFor(() => expect(h.said.at(-1)).toMatchObject({ key: "end:run-3", text: toFullSpeech(LONG_REPLY) }));
  });

  it("says when a run fails or stops, and nothing more for one it stopped itself", async () => {
    const h = harness();
    await h.layer.warm();
    h.startRun("run-1");
    h.endRun({ type: "error", message: "Rate limited" });
    expect(h.said.at(-1)!.text).toBe("It ran into an error: Rate limited");
    // The runtime's "no response" after steering is an empty turn, not a failure: the work goes on.
    h.startRun("run-1b");
    h.endRun({ type: "error", message: "No response was returned. Send your message again to retry." });
    expect(h.said.some((item) => item.key === "end:run-1b")).toBe(false);

    h.startRun("run-2");
    await expect(h.turn({ kind: "command", command: "cancel", text: "cancel that" })).resolves.toMatchObject({ spoken: "Stopped." });
    expect(h.chat.abort).toHaveBeenCalledTimes(1);
    const before = h.said.length;
    h.endRun({ type: "aborted" });
    expect(h.said).toHaveLength(before);
  });

  it("never stops a newer run than the one the user meant", async () => {
    const h = harness();
    await h.layer.warm();
    h.startRun("run-1");
    let decide!: (decision: HandsFreeRouteDecision) => void;
    h.route.mockImplementationOnce(() => new Promise((resolve) => { decide = resolve; }));
    const pending = h.turn({ kind: "user", text: "never mind, don't do that" });
    h.endRun({ type: "done", content: "Done." });
    h.startRun("run-2");
    decide({ action: "stop", text: "" });
    await expect(pending).resolves.toMatchObject({ spoken: "It had already finished." });

    // Nothing was running when the user spoke; a run that started since is left alone too.
    h.endRun({ type: "done", content: "Done." });
    h.route.mockImplementationOnce(() => new Promise((resolve) => { decide = resolve; }));
    const late = h.turn({ kind: "user", text: "never mind, don't do that" });
    h.startRun("run-3");
    decide({ action: "stop", text: "" });
    await expect(late).resolves.toMatchObject({ spoken: "There's nothing running to stop." });
    expect(h.chat.abort).not.toHaveBeenCalled();
  });

  it("says how a long run is going on its own, and drops that line once the run ends", async () => {
    const h = harness();
    await h.layer.warm();
    const bus = h.startRun("run-1");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.said.at(-1)).toMatchObject({ key: "progress:run-1", text: "It's still getting started." });
    bus.emit({ type: "intent", content: "Running the tests" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.said.at(-1)).toMatchObject({ key: "progress:run-1", text: "It's running the tests." });
    expect(h.said.at(-1)!.valid?.()).toBe(true);
    h.endRun({ type: "done", content: "" });
    expect(h.dropped).toContain("progress:run-1");
    expect(h.said.find((item) => item.key === "progress:run-1")!.valid?.()).toBe(false);
  });

  it("follows each run once, including one already under way when hands-free starts", async () => {
    const h = harness();
    const bus = h.startRun("run-1");
    await h.layer.warm();
    // The busy event comes again for the same run when a stalled run resumes.
    h.announceBusy();
    h.announceBusy();
    expect(bus.listeners.size).toBe(1);
    h.endRun({ type: "done", content: "Done." });
    expect(h.said.filter((item) => item.key === "end:run-1")).toHaveLength(1);
  });

  it("keeps the words of a turn cut short before it reached the chat for the turn that continues it", async () => {
    const h = harness();
    let decide!: (decision: HandsFreeRouteDecision) => void;
    h.route.mockImplementationOnce(() => new Promise((resolve) => { decide = resolve; }));
    const handle = h.layer.startTurn({ kind: "user", text: "check the tether" }, { onDelta: () => undefined, onDone: () => undefined });
    await handle.abort();
    decide({ action: "send", text: "Check the Tether." });
    // The continuation is cut short too: both earlier parts carry over.
    h.route.mockImplementationOnce(() => new Promise(() => undefined));
    await h.layer.startTurn({ kind: "continuation", text: "task" }, { onDelta: () => undefined, onDone: () => undefined }).abort();
    h.route.mockImplementationOnce(async (context) => ({ action: "send", text: context.transcript }));
    await h.turn({ kind: "continuation", text: "please" });
    expect(h.chat.deliver).toHaveBeenCalledTimes(1);
    expect(h.chat.deliver).toHaveBeenCalledWith("check the tether task please", undefined);
  });

  it("points to a question on screen instead of sending past it", async () => {
    const h = harness();
    await h.layer.warm();
    const bus = h.startRun("run-1");
    bus.emit({ type: "user_input_requested", question: "Which branch?" });
    expect(h.said.at(-1)).toMatchObject({ key: "question:run-1", text: "There's a question for you on screen: Which branch?" });
    await expect(h.turn({ kind: "user", text: "use main" })).resolves.toMatchObject({ handled: "not_sent" });
    expect(h.chat.deliver).not.toHaveBeenCalled();
    bus.emit({ type: "user_input_answered" });
    await expect(h.turn({ kind: "user", text: "use main" })).resolves.toMatchObject({ handled: "sent" });

    // A question asked before hands-free started is known from the run's snapshot.
    const later = harness();
    const bus2 = later.startRun("run-2", {
      pendingUserInputs: [{ requestId: "q1", question: "Which branch?" }],
      pendingElicitations: [{ requestId: "q2", message: "Sign in to continue." }],
    });
    await later.layer.warm();
    expect(later.said.at(-1)).toMatchObject({ key: "question:run-2" });
    // Answering one leaves the other waiting.
    bus2.emit({ type: "user_input_answered", requestId: "q1" });
    await expect(later.turn({ kind: "user", text: "use main" })).resolves.toMatchObject({ handled: "not_sent" });
  });
});

describe("reply speech", () => {
  it("reads only short plain prose word for word", () => {
    expect(verbatimSpeech("Done. I set the **reminder** for Tuesday.")).toBe("Done. I set the reminder for Tuesday.");
    expect(verbatimSpeech("Three options:\n\n- one\n- two")).toBeUndefined();
    expect(verbatimSpeech(`${"word ".repeat(70)}.`)).toBeUndefined();
  });

  it("reads everything in full except code and tables, and summarizes without a model from the first sentences", () => {
    expect(toFullSpeech("## Result\nI fixed it.\n\n- [Tests](bridge://x) pass\n- Deploy ready\n\n```ts\nx\n```\n| a |\n|---|"))
      .toBe("Result. I fixed it. Tests pass. Deploy ready. There's code on screen. There's a table on screen.");
    expect(fallbackSummary("I fixed it. The tests pass. Then a third sentence.\n\n- a list")).toBe("I fixed it. The tests pass. The rest is on screen.");
  });
});
