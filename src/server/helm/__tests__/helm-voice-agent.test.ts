import { describe, expect, it, vi } from "vitest";
import type { StreamEvent } from "../../event-bus.js";
import type { StartWorkOptions } from "../../session-runner.js";
import type { AgentTurnListener } from "../../voice/voice-conversation.js";
import { HelmVoiceAgent } from "../helm-voice-agent.js";

const SESSION_ID = "11111111-2222-4333-8444-555555555555";

function createHarness(options: { busy?: boolean; snapshot?: () => Promise<string | undefined>; reasoningEffort?: () => string | undefined } = {}) {
  const listeners = new Set<(event: StreamEvent) => void>();
  let busy = options.busy ?? false;
  const sessionManager = {
    startWork: vi.fn((_sessionId: string, _prompt: string, _attachments?: undefined, _options?: StartWorkOptions) => {
      busy = true;
    }),
    abortSession: vi.fn(async () => {
      busy = false;
      for (const listener of [...listeners]) listener({ type: "aborted" });
      return true;
    }),
    isSessionBusy: vi.fn(() => busy),
    warmSession: vi.fn(async () => undefined),
  };
  const agent = new HelmVoiceAgent({
    sessionId: SESSION_ID,
    sessionManager,
    getBus: () => ({
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    }),
    snapshot: options.snapshot ?? (async () => "nothing waiting on you; nothing running; no unread replies"),
    timeZone: "UTC",
    ...(options.reasoningEffort ? { resolveReasoningEffort: options.reasoningEffort } : {}),
    busyWaitMs: 20,
    pollMs: 1,
  });
  const emit = (event: StreamEvent) => {
    if (event.type === "done" || event.type === "error" || event.type === "aborted") busy = false;
    for (const listener of [...listeners]) listener(event);
  };
  return { agent, sessionManager, emit, listeners };
}

function createListener() {
  const events: string[] = [];
  let resolveDone!: (result: { aborted: boolean; error?: string }) => void;
  const done = new Promise<{ aborted: boolean; error?: string }>((resolve) => {
    resolveDone = resolve;
  });
  const listener: AgentTurnListener = {
    onDelta: (text) => events.push(`delta:${text}`),
    onMessageEnd: () => events.push("message-end"),
    onToolStart: ({ name }) => events.push(`tool-start:${name}`),
    onToolEnd: ({ name, success }) => events.push(`tool-end:${name}:${success}`),
    onDone: (result) => {
      events.push(`done:${result.aborted}:${result.error ?? ""}`);
      resolveDone(result);
    },
  };
  return { listener, events, done };
}

describe("HelmVoiceAgent", () => {
  it("sends a spoken turn through the Helm session with a clean transcript entry", async () => {
    const { agent, sessionManager, emit, listeners } = createHarness();
    const { listener, events, done } = createListener();
    agent.startTurn({ kind: "user", text: "what's new?" }, listener);
    await vi.waitFor(() => expect(sessionManager.startWork).toHaveBeenCalledTimes(1));

    const [sessionId, prompt, attachments, options] = sessionManager.startWork.mock.calls[0]!;
    expect(sessionId).toBe(SESSION_ID);
    expect(prompt).toBe("[hands-free]\n[Bridge now: nothing waiting on you; nothing running; no unread replies]\nwhat's new?");
    expect(attachments).toBeUndefined();
    expect(options).toEqual({ displayPrompt: "what's new?" });

    emit({ type: "snapshot" });
    emit({ type: "delta", content: "Let me check." });
    emit({ type: "assistant_partial", content: "Let me check." });
    emit({ type: "tool_start", toolCallId: "t1", name: "bridge_overview" });
    emit({ type: "tool_done", toolCallId: "t1", name: "bridge_overview", success: true });
    emit({ type: "delta", content: "Two replies are waiting." });
    emit({ type: "done" });

    expect(await done).toEqual({ aborted: false });
    expect(events).toEqual([
      "delta:Let me check.",
      "message-end",
      "tool-start:bridge_overview",
      "tool-end:bridge_overview:true",
      "delta:Two replies are waiting.",
      "done:false:",
    ]);
    expect(listeners.size).toBe(0);
  });

  it("keeps application-generated turns out of the transcript and only repeats a changed snapshot", async () => {
    let snapshot = "1 unread";
    const { agent, sessionManager, emit } = createHarness({ snapshot: async () => snapshot });

    const greeting = createListener();
    agent.startTurn({ kind: "greeting", text: "" }, greeting.listener);
    await vi.waitFor(() => expect(sessionManager.startWork).toHaveBeenCalledTimes(1));
    expect(sessionManager.startWork.mock.calls[0]![1]).toContain("[Bridge now: 1 unread]");
    expect(sessionManager.startWork.mock.calls[0]![3]).toEqual({ promptSource: "system" });
    emit({ type: "done" });
    await greeting.done;

    const second = createListener();
    agent.startTurn({ kind: "interrupted", text: "read it", interruptedSpeech: "Morning" }, second.listener);
    await vi.waitFor(() => expect(sessionManager.startWork).toHaveBeenCalledTimes(2));
    const secondPrompt = sessionManager.startWork.mock.calls[1]![1];
    expect(secondPrompt).not.toContain("[Bridge now:");
    expect(secondPrompt).toContain('[The user interrupted you while you were saying: "Morning"]');
    expect(sessionManager.startWork.mock.calls[1]![3]).toEqual({ displayPrompt: "read it" });
    emit({ type: "done" });
    await second.done;

    snapshot = "2 unread";
    const event = createListener();
    agent.startTurn({ kind: "event", text: 'Session "Tellus" finished.' }, event.listener);
    await vi.waitFor(() => expect(sessionManager.startWork).toHaveBeenCalledTimes(3));
    expect(sessionManager.startWork.mock.calls[2]![1]).toContain("[Bridge now: 2 unread]");
    expect(sessionManager.startWork.mock.calls[2]![3]).toEqual({ promptSource: "system" });
    emit({ type: "done" });
    await event.done;
  });

  it("asks for the spoken effort on every turn it starts, following settings changes", async () => {
    let effort = "xhigh";
    const { agent, sessionManager, emit } = createHarness({ reasoningEffort: () => effort });
    const spoken = createListener();
    agent.startTurn({ kind: "user", text: "what's new?" }, spoken.listener);
    await vi.waitFor(() => expect(sessionManager.startWork).toHaveBeenCalledTimes(1));
    expect(sessionManager.startWork.mock.calls[0]![3]).toEqual({ reasoningEffort: "xhigh", displayPrompt: "what's new?" });
    emit({ type: "done" });
    await spoken.done;

    effort = "high";
    const announced = createListener();
    agent.startTurn({ kind: "event", text: 'Session "Tellus" finished.' }, announced.listener);
    await vi.waitFor(() => expect(sessionManager.startWork).toHaveBeenCalledTimes(2));
    expect(sessionManager.startWork.mock.calls[1]![3]).toEqual({ reasoningEffort: "high", promptSource: "system" });
    emit({ type: "done" });
    await announced.done;
  });

  it("passes a typed message's identity through so the chat can reconcile it", async () => {
    const { agent, sessionManager, emit } = createHarness();
    const { listener, done } = createListener();
    agent.startTurn({ kind: "user", text: "archive the finished ones", clientMessageId: "client-7" }, listener);
    await vi.waitFor(() => expect(sessionManager.startWork).toHaveBeenCalledTimes(1));
    expect(sessionManager.startWork.mock.calls[0]![3]).toEqual({ displayPrompt: "archive the finished ones", clientMessageId: "client-7" });
    emit({ type: "done" });
    await done;
  });

  it("speaks a message that arrived whole instead of streamed", async () => {
    const { agent, sessionManager, emit } = createHarness();
    const { listener, events, done } = createListener();
    agent.startTurn({ kind: "user", text: "status?" }, listener);
    await vi.waitFor(() => expect(sessionManager.startWork).toHaveBeenCalled());
    emit({ type: "assistant_partial", content: "All quiet." });
    emit({ type: "done" });
    await done;
    expect(events).toEqual(["delta:All quiet.", "message-end", "done:false:"]);
  });

  it("aborts the running turn and starts the next one only after it settles", async () => {
    const { agent, sessionManager } = createHarness();
    const first = createListener();
    const handle = agent.startTurn({ kind: "user", text: "tell me everything" }, first.listener);
    await vi.waitFor(() => expect(sessionManager.startWork).toHaveBeenCalledTimes(1));

    const second = createListener();
    agent.startTurn({ kind: "user", text: "actually, just the unread ones" }, second.listener);
    expect(sessionManager.startWork).toHaveBeenCalledTimes(1);

    await handle.abort();
    expect(sessionManager.abortSession).toHaveBeenCalledWith(SESSION_ID);
    expect(await first.done).toEqual({ aborted: true });
    await vi.waitFor(() => expect(sessionManager.startWork).toHaveBeenCalledTimes(2));
    expect(sessionManager.startWork.mock.calls[1]![3]).toEqual({ displayPrompt: "actually, just the unread ones" });
  });

  it("stops whatever else is running on the session before a voice turn", async () => {
    const { agent, sessionManager, emit } = createHarness({ busy: true });
    const { listener, done } = createListener();
    agent.startTurn({ kind: "user", text: "hello" }, listener);
    await vi.waitFor(() => expect(sessionManager.startWork).toHaveBeenCalledTimes(1));
    expect(sessionManager.abortSession).toHaveBeenCalledTimes(1);
    emit({ type: "done" });
    expect(await done).toEqual({ aborted: false });
  });

  it("reports session errors and start failures", async () => {
    const { agent, sessionManager, emit } = createHarness();
    const failed = createListener();
    agent.startTurn({ kind: "user", text: "hi" }, failed.listener);
    await vi.waitFor(() => expect(sessionManager.startWork).toHaveBeenCalledTimes(1));
    emit({ type: "error", message: "model unavailable" });
    expect(await failed.done).toEqual({ aborted: false, error: "model unavailable" });

    sessionManager.startWork.mockImplementationOnce(() => {
      throw new Error("Bridge is restarting");
    });
    const rejected = createListener();
    agent.startTurn({ kind: "user", text: "hi again" }, rejected.listener);
    expect(await rejected.done).toEqual({ aborted: false, error: "Couldn't reach Copilot: Bridge is restarting" });
  });

  it("detaches without aborting so a reply keeps streaming into the chat", async () => {
    const { agent, sessionManager, listeners } = createHarness();
    const { listener, done } = createListener();
    const handle = agent.startTurn({ kind: "user", text: "summarize everything" }, listener);
    await vi.waitFor(() => expect(sessionManager.startWork).toHaveBeenCalledTimes(1));

    agent.detach();
    expect(await done).toEqual({ aborted: true });
    await handle.abort();
    expect(sessionManager.abortSession).not.toHaveBeenCalled();
    expect(listeners.size).toBe(0);

    const late = createListener();
    agent.startTurn({ kind: "user", text: "too late" }, late.listener);
    expect(await late.done).toEqual({ aborted: true });
    expect(sessionManager.startWork).toHaveBeenCalledTimes(1);
  });
});
