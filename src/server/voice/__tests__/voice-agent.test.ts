import { describe, expect, it, vi } from "vitest";
import type { AgentSession, AgentSessionEventHandler } from "../../agent-backend/types.js";
import { makeTestDir } from "../../__tests__/helpers.js";
import {
  composeVoicePrompt,
  isVoiceAgentSessionId,
  createVoiceAgentSessionId,
  selectVoiceAgentModel,
  VoiceAgent,
} from "../voice-agent.js";
import type { AgentTurnListener } from "../voice-conversation.js";

function fakeSession() {
  let handler: AgentSessionEventHandler | undefined;
  const sent: string[] = [];
  const session = {
    sessionId: createVoiceAgentSessionId(),
    send: vi.fn(async ({ prompt }: { prompt: string }) => {
      sent.push(prompt);
      return "message-id";
    }),
    abort: vi.fn(async () => {
      queueMicrotask(() => handler?.({ type: "session.idle", data: {} }));
    }),
    disconnect: vi.fn(async () => undefined),
    on: (next: AgentSessionEventHandler) => {
      handler = next;
      return () => {
        handler = undefined;
      };
    },
  } as unknown as AgentSession;
  return { session, sent, emit: (type: string, data: Record<string, unknown> = {}) => handler?.({ type, data }) };
}

function listener() {
  const events: string[] = [];
  const done = vi.fn();
  const turnListener: AgentTurnListener = {
    onDelta: (text) => events.push(`delta:${text}`),
    onToolStart: ({ name }) => events.push(`tool:${name}`),
    onToolEnd: ({ name, success }) => events.push(`tool_end:${name}:${success}`),
    onDone: done,
  };
  return { events, done, turnListener };
}

describe("voice agent prompts", () => {
  it("composes spoken turns with context lines", () => {
    expect(composeVoicePrompt({ kind: "user", text: "what's new?" }, { snapshot: "nothing running", timeZone: "UTC" }))
      .toBe("[Bridge now: nothing running]\nwhat's new?");
    expect(composeVoicePrompt({ kind: "continuation", text: "about computers" }, { timeZone: "UTC" }))
      .toContain("kept talking");
    expect(composeVoicePrompt({ kind: "interrupted", text: "stop", interruptedSpeech: "The Tellus session" }, { timeZone: "UTC" }))
      .toContain('while you were saying: "The Tellus session"');
    expect(composeVoicePrompt({ kind: "greeting", text: "" }, { timeZone: "UTC", now: new Date("2026-09-17T06:00:00Z") }))
      .toContain("It's Thursday 6:00 AM");
  });

  it("prefers cheap fast models with low reasoning effort", () => {
    const models = [
      { id: "claude-opus-5", supportedReasoningEfforts: ["low", "high"] },
      { id: "gpt-5.6-luna", supportedReasoningEfforts: ["none", "low", "medium"] },
    ] as any[];
    expect(selectVoiceAgentModel(models)).toEqual({ model: "gpt-5.6-luna", reasoningEffort: "none" });
    expect(selectVoiceAgentModel(models, "claude-opus-5")).toEqual({ model: "claude-opus-5", reasoningEffort: "low" });
    expect(isVoiceAgentSessionId(createVoiceAgentSessionId())).toBe(true);
    expect(isVoiceAgentSessionId("a1b2c3d4-0000-4000-8000-000000000000")).toBe(false);
  });
});

describe("VoiceAgent", () => {
  it("streams deltas and tool events for a turn, then completes on idle", async () => {
    const fake = fakeSession();
    const createVoiceAgentSession = vi.fn(async (config: Record<string, unknown>) => {
      expect(config).toMatchObject({ model: "gpt-5.6-luna", reasoningEffort: "low", enableSessionStore: false, mcpServers: {} });
      expect(String(config.configDirectory)).toContain("voice-agent");
      return fake.session;
    });
    const agent = new VoiceAgent({
      factory: { createVoiceAgentSession, listModels: async () => [{ id: "gpt-5.6-luna", supportedReasoningEfforts: ["low"] }] as any },
      tools: [],
      stateDir: makeTestDir("voice-agent"),
      snapshot: async () => "nothing running",
      timeZone: "UTC",
    });
    const { events, done, turnListener } = listener();
    agent.startTurn({ kind: "user", text: "what's new?" }, turnListener);
    await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
    expect(fake.sent[0]).toBe("[Bridge now: nothing running]\nwhat's new?");
    fake.emit("assistant.message_delta", { deltaContent: "Two things. " });
    fake.emit("tool.execution_start", { toolCallId: "t1", toolName: "bridge_overview" });
    fake.emit("tool.execution_complete", { toolCallId: "t1", toolName: "bridge_overview", success: true });
    fake.emit("assistant.message_delta", { deltaContent: "Hidden", parentToolCallId: "sub" });
    fake.emit("session.idle");
    await vi.waitFor(() => expect(done).toHaveBeenCalledWith({ aborted: false }));
    expect(events).toEqual(["delta:Two things. ", "tool:bridge_overview", "tool_end:bridge_overview:true"]);

    // The unchanged snapshot is not repeated on the next turn.
    agent.startTurn({ kind: "user", text: "thanks" }, listener().turnListener);
    await vi.waitFor(() => expect(fake.sent).toHaveLength(2));
    expect(fake.sent[1]).toBe("thanks");
    await agent.dispose();
    expect(fake.session.disconnect).toHaveBeenCalled();
  });

  it("aborts an in-flight turn before sending the next one", async () => {
    const fake = fakeSession();
    const agent = new VoiceAgent({
      factory: { createVoiceAgentSession: async () => fake.session, listModels: async () => [] },
      tools: [],
      stateDir: makeTestDir("voice-agent-abort"),
      timeZone: "UTC",
    });
    const first = listener();
    const handle = agent.startTurn({ kind: "user", text: "tell me a joke" }, first.turnListener);
    await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
    const second = listener();
    const abort = handle.abort();
    agent.startTurn({ kind: "continuation", text: "about computers" }, second.turnListener);
    await abort;
    expect(first.done).toHaveBeenCalledWith({ aborted: true });
    await vi.waitFor(() => expect(fake.sent).toHaveLength(2));
    expect(fake.sent[1]).toContain("about computers");
    await agent.dispose();
  });

  it("recreates the session once when a send fails", async () => {
    const broken = fakeSession();
    (broken.session.send as any).mockRejectedValueOnce(new Error("Backend disconnected"));
    const healthy = fakeSession();
    const createVoiceAgentSession = vi.fn()
      .mockResolvedValueOnce(broken.session)
      .mockResolvedValueOnce(healthy.session);
    const agent = new VoiceAgent({
      factory: { createVoiceAgentSession, listModels: async () => [] },
      tools: [],
      stateDir: makeTestDir("voice-agent-retry"),
      timeZone: "UTC",
    });
    agent.startTurn({ kind: "user", text: "hello" }, listener().turnListener);
    await vi.waitFor(() => expect(healthy.sent).toEqual(["hello"]));
    expect(createVoiceAgentSession).toHaveBeenCalledTimes(2);
    await agent.dispose();
  });
});
