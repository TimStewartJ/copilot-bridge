import { describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  IMAGE_BUDGET_COMPACTION_INSTRUCTIONS,
  IMAGE_PAUSE_CONTINUE_PROMPT,
  ImageBudgetController,
  readImageBudgetFromEvents,
  type FinishOutcome,
  type ImageBudgetHost,
  type ImageBudgetSession,
} from "../image-budget.js";
import { imageCompactAtBytes } from "../../shared/image-budget.js";
import { makeTestDir } from "./helpers.js";

const MB = 1_000_000;

function images(id: string, mb: number, extra: Record<string, unknown> = {}) {
  return {
    type: "tool.execution_complete", id, ...extra,
    data: { toolCallId: id, result: { binaryResultsForLlm: [{ type: "image", data: "A".repeat(mb * MB) }] } },
  };
}
const start = (id: string, extra: Record<string, unknown> = {}) => ({ type: "tool.execution_start", ...extra, data: { toolCallId: id } });
const event = (type: string, data: Record<string, unknown> = {}) => ({ type, data });

async function flush() {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** A fake host and session; `running` is whether a turn is in progress. */
function setUp(options: {
  model?: string;
  replayBytes?: number;
  running?: "none" | "stoppable" | "keep";
  compact?: () => Promise<unknown>;
  tasks?: Array<{ kind: string; status: string }>;
  settings?: Parameters<typeof imageCompactAtBytes>[1];
} = {}) {
  const dir = makeTestDir("image-budget");
  const eventsPath = join(dir, "events.jsonl");
  const lines = [
    ...(options.model === undefined ? [event("session.start", { selectedModel: "claude-opus-5.5" })] : options.model ? [event("session.start", { selectedModel: options.model })] : []),
    ...(options.replayBytes ? [{ type: "tool.execution_complete", id: "old", data: { result: { binaryResultsForLlm: [{ type: "image", byteLength: (options.replayBytes * 3) / 4 }] } } }] : []),
  ];
  writeFileSync(eventsPath, lines.map((line) => JSON.stringify(line)).join("\n"));

  const steps: string[] = [];
  let running = options.running ?? "stoppable";
  const listeners = new Set<(event: any) => void>();
  const emit = (e: unknown) => { for (const listener of [...listeners]) listener(e); };
  const session = {
    getCurrentModel: vi.fn(async () => ({ modelId: "claude-sonnet-5" })),
    getActivity: vi.fn(async () => ({ processing: false })),
    listTasks: vi.fn(async () => ({ tasks: (options.tasks ?? []) as any[] })),
    on: vi.fn((listener: (event: any) => void) => { listeners.add(listener); return () => listeners.delete(listener); }),
    compactHistory: vi.fn(async (_opts?: unknown) => {
      steps.push("compact");
      const result = options.compact ? await options.compact() : { success: true };
      // The runtime reports the stopped turn's idle only once the compaction is done.
      if (running === "none") setImmediate(() => emit({ type: "session.idle", data: {} }));
      return result as any;
    }),
  } satisfies ImageBudgetSession;
  const finishes: FinishOutcome[] = [];
  const host: ImageBudgetHost = {
    getSettings: () => options.settings,
    getEventsPath: () => eventsPath,
    hold: vi.fn(() => { steps.push("hold"); return true; }),
    runningTurn: vi.fn(() => running),
    stopTurn: vi.fn(async () => { steps.push("stop"); running = "none"; }),
    finish: vi.fn((_id, _session, outcome) => { steps.push("finish"); finishes.push(outcome); }),
    recordSpan: vi.fn(),
  };
  const controller = new ImageBudgetController(host);
  controller.attach("s1", session);
  const view = (id: string, mb: number) => {
    controller.observe("s1", session, start(id));
    controller.observe("s1", session, images(id, mb));
  };
  // The history file is read asynchronously when tracking starts.
  const ready = () => vi.waitFor(() => expect((controller as any).entries.get("s1")?.loading).toBe(false));
  return { controller, session, host, steps, finishes, view, emit, ready, setRunning: (value: typeof running) => { running = value; } };
}

describe("image budget settings", () => {
  it("defaults to claude-* at 30 MB, compacting at 20 MB, and can be turned off", () => {
    expect(imageCompactAtBytes("claude-opus-5.5", undefined)).toBe(20 * MB);
    expect(imageCompactAtBytes("Claude-Sonnet-5", undefined)).toBe(20 * MB);
    expect(imageCompactAtBytes("gpt-5.5", undefined)).toBeUndefined();
    expect(imageCompactAtBytes("claude-opus-5", { enabled: false })).toBeUndefined();
    expect(imageCompactAtBytes("gpt-5.4", { ceilingsMb: { "gpt-5.*": 45 } })).toBe(30 * MB);
  });
});

describe("readImageBudgetFromEvents", () => {
  it("counts main-agent images from the log, subtracts compactions, and settles an unfinished one", async () => {
    const eventsPath = join(makeTestDir("image-budget-replay"), "events.jsonl");
    const persisted = (id: string, bytes: number, extra: Record<string, unknown> = {}) =>
      ({ type: "tool.execution_complete", id, ...extra, data: { result: { binaryResultsForLlm: [{ type: "image", byteLength: bytes }] } } });
    const lines = [
      { id: "e1", ...event("session.start", { selectedModel: "claude-opus-5.5" }) },
      persisted("e2", 3 * MB),
      { type: "session.binary_asset", id: "e3", data: { data: "skipped" } },
      { id: "e4", ...event("session.compaction_start") },
      persisted("e5", 300),
      { id: "e6", ...event("session.compaction_complete", { success: true }) },
      persisted("e7", 3 * MB, { agentId: "sub" }),
      { type: "user.message", id: "e8", data: { attachments: [{ type: "blob", byteLength: 3 }, { type: "file" }] } },
      { id: "e10", ...event("session.compaction_start") },
    ];
    writeFileSync(eventsPath, `${lines.map((line) => JSON.stringify(line)).join("\r\n")}\r\n{broken`);
    const replay = await readImageBudgetFromEvents(eventsPath);
    expect(replay.state).toEqual({ bytes: 404, compactionsInFlight: 0, bytesAtCompactionStart: undefined, model: "claude-opus-5.5" });
    expect(replay.eventIds.has("e7")).toBe(false);
    expect((await readImageBudgetFromEvents(join(makeTestDir("image-budget-missing"), "events.jsonl"))).state.bytes).toBe(0);
  });
});

describe("ImageBudgetController", () => {
  it("pauses a Claude turn at the tool boundary that reaches 20 MB: stop, compact, wait for the late idle, continue", async () => {
    const { controller, session, steps, finishes, view, ready } = setUp();
    await ready();
    view("a", 19);
    await flush();
    expect(steps).toEqual([]);
    view("b", 1);
    await flush();
    expect(steps).toEqual(["hold", "stop", "compact", "finish"]);
    expect(session.compactHistory).toHaveBeenCalledWith({ customInstructions: IMAGE_BUDGET_COMPACTION_INSTRUCTIONS });
    expect(finishes).toEqual([{ stopped: true, continuation: { prompt: IMAGE_PAUSE_CONTINUE_PROMPT } }]);
  });

  it("waits for parallel main-agent tools and ignores sub-agent tools", async () => {
    const { controller, session, steps, ready } = setUp({ replayBytes: 19 * MB });
    await ready();
    controller.observe("s1", session, start("p1"));
    controller.observe("s1", session, start("p2"));
    controller.observe("s1", session, images("p1", 2));
    controller.observe("s1", session, images("child", 5, { agentId: "sub" }));
    controller.observe("s1", session, { ...images("nested", 5), data: { ...images("nested", 5).data, parentToolCallId: "p2" } });
    await flush();
    expect(steps).toEqual([]);
    controller.observe("s1", session, images("p2", 0));
    await flush();
    expect(steps[0]).toBe("hold");
  });

  it("compacts an idle chat without stopping or continuing, including after a turn without tools", async () => {
    const { controller, session, steps, finishes, setRunning, ready } = setUp({ running: "stoppable" });
    await ready();
    controller.observe("s1", session, { type: "user.message", id: "u", data: { attachments: [{ type: "blob", data: "A".repeat(21 * MB) }] } });
    await flush();
    expect(steps).toEqual([]);
    setRunning("none");
    controller.sessionIdle("s1");
    await flush();
    expect(steps).toEqual(["hold", "compact", "finish"]);
    expect(finishes).toEqual([{ stopped: false }]);
  });

  it("leaves other models, a disabled budget, quiet or Helm turns, and background agents alone", async () => {
    for (const setup of [
      { model: "gpt-5.5" },
      { settings: { enabled: false } },
      { running: "keep" as const },
      { tasks: [{ kind: "agent", status: "running" }] },
    ]) {
      const { steps, view, ready } = setUp(setup);
      await ready();
      view("a", 25);
      await flush();
      expect(steps).toEqual([]);
    }
  });

  it("does not continue after the user stops the chat during the pause", async () => {
    let controllerRef: ImageBudgetController | undefined;
    const { controller, steps, finishes, view, ready } = setUp({
      compact: async () => { controllerRef!.cancelPause("s1"); return { success: true }; },
    });
    controllerRef = controller;
    await ready();
    view("a", 21);
    await flush();
    expect(steps).toEqual(["hold", "stop", "compact", "finish"]);
    expect(finishes).toEqual([{ stopped: true }]);
  });

  it("sees the user's Stop from the moment a pause begins, before it holds the chat", async () => {
    let controllerRef: ImageBudgetController | undefined;
    const { controller, session, host, steps, view, ready } = setUp();
    controllerRef = controller;
    session.listTasks.mockImplementation(async () => {
      expect(controllerRef!.isPausing("s1")).toBe(true);
      controllerRef!.cancelPause("s1");
      return { tasks: [] };
    });
    await ready();
    view("a", 21);
    await flush();
    expect(steps).toEqual([]);
    expect(host.finish).not.toHaveBeenCalled();
    expect(controller.isPausing("s1")).toBe(false);
  });

  it("treats the runtime's own compaction as a summary and still waits for the stopped turn's idle", async () => {
    const { finishes, view, ready, emit, steps } = setUp({
      compact: async () => { throw new Error("Compaction already in progress."); },
    });
    await ready();
    view("a", 21);
    await flush();
    expect(steps).toEqual(["hold", "stop", "compact"]);
    expect(finishes).toEqual([]);
    emit({ type: "session.idle", data: {} });
    await flush();
    expect(finishes).toEqual([{ stopped: true, continuation: { prompt: IMAGE_PAUSE_CONTINUE_PROMPT } }]);
  });

  it("continues with a different notice when compaction fails, and flags a stop that never settled", async () => {
    const failed = setUp({ compact: async () => ({ success: false }) });
    await failed.ready();
    failed.view("a", 21);
    await flush();
    expect(failed.finishes[0]?.continuation?.prompt).toMatch(/summary failed/);

    const stuck = setUp();
    stuck.session.getActivity.mockImplementation(async () => { throw new Error("gone"); });
    (stuck.host.stopTurn as any).mockImplementation(async () => { throw new Error("abort failed"); });
    await stuck.ready();
    stuck.view("a", 21);
    await flush();
    expect(stuck.session.compactHistory).not.toHaveBeenCalled();
    expect(stuck.finishes).toEqual([{ stopped: true, attention: true }]);
  });

  it("retries a skip at once, waits 2 MB after an attempt, and stops after two failures", async () => {
    const { controller, session, host, view, ready } = setUp({ compact: async () => ({ success: false }) });
    await ready();
    (host.hold as any).mockReturnValueOnce(false);
    view("a", 20);
    await flush();
    expect(session.compactHistory).not.toHaveBeenCalled();
    view("b", 0.5);
    await flush();
    expect(session.compactHistory).toHaveBeenCalledTimes(1);
    view("c", 1);
    await flush();
    expect(session.compactHistory).toHaveBeenCalledTimes(1);
    view("d", 1);
    await flush();
    expect(session.compactHistory).toHaveBeenCalledTimes(2);
    view("e", 5);
    controller.reload("s1");
    await flush();
    view("f", 5);
    await flush();
    expect(session.compactHistory).toHaveBeenCalledTimes(2);
  });

  it("follows model switches and asks the runtime for a new chat's model once it has images", async () => {
    const switched = setUp({ model: "gpt-5.5", replayBytes: 25 * MB, running: "none" });
    await switched.ready();
    expect(switched.steps).toEqual([]);
    switched.controller.observe("s1", switched.session, event("session.model_change", { newModel: "claude-opus-5" }));
    await flush();
    expect(switched.steps).toEqual(["hold", "compact", "finish"]);

    const fresh = setUp({ model: "" });
    await fresh.ready();
    expect(fresh.session.getCurrentModel).not.toHaveBeenCalled();
    fresh.view("a", 21);
    await flush();
    expect(fresh.session.getCurrentModel).toHaveBeenCalledTimes(1);
    expect(fresh.steps[0]).toBe("hold");
  });

  it("applies events that arrived during the replay once, and ignores other handles", async () => {
    const { controller, session, steps, ready } = setUp({ replayBytes: 15 * MB });
    controller.observe("s1", session, images("old", 15));
    controller.observe("s1", session, images("new", 3));
    await ready();
    expect(steps).toEqual([]);
    controller.observe("s1", {}, images("other-handle", 30));
    controller.observe("s1", session, images("more", 2));
    await flush();
    expect(steps[0]).toBe("hold");
  });
});
