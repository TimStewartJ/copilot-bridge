import { describe, expect, it, vi } from "vitest";
import type { AppContext } from "../../app-context.js";
import { buildBridgeSnapshotLine } from "../voice-gateway.js";
import {
  createVoiceToolDefinitions,
  formatAgo,
  resolveSession,
  type VoiceBridgeFacade,
  type VoiceSessionSummary,
} from "../voice-tools.js";

const now = Date.parse("2026-09-17T06:00:00.000Z");

function session(overrides: Partial<VoiceSessionSummary>): VoiceSessionSummary {
  return {
    sessionId: "00000000-0000-4000-8000-000000000000",
    title: "Untitled",
    runState: "idle",
    needsUserInput: false,
    unread: false,
    archived: false,
    linkedTaskIds: [],
    ...overrides,
  };
}

const sessions: VoiceSessionSummary[] = [
  session({ sessionId: "aaaaaaaa-1111-4000-8000-000000000001", title: "Tellus worldgen transition fix", unread: true, lastActivityAt: "2026-09-17T05:57:00.000Z", linkedTaskIds: ["task-1"] }),
  session({ sessionId: "bbbbbbbb-2222-4000-8000-000000000002", title: "Focus protection preview", runState: "busy", intentText: "Running tests" }),
  session({ sessionId: "cccccccc-3333-4000-8000-000000000003", title: "Deploy check", needsUserInput: true }),
  session({ sessionId: "dddddddd-4444-4000-8000-000000000004", title: "Old archived chat", archived: true, unread: true }),
];

function createContext() {
  const submitUserInputResponse = vi.fn(async () => ({ requestId: "req-1", answer: "Yes, deploy", wasFreeform: false, timestamp: "" }));
  const ctx = {
    taskStore: {
      getTask: (id: string) => (id === "task-1" ? { id: "task-1", title: "Tellus Expeditions" } : undefined),
      listTasks: () => [{ id: "task-1", title: "Tellus Expeditions", status: "active", muted: false, priority: 1, updatedAt: "2026-09-16T00:00:00.000Z", nextAction: "Review biome blend" }],
    },
    eventBusRegistry: {
      getBus: (id: string) => (id === "cccccccc-3333-4000-8000-000000000003"
        ? {
          getPendingInteractionIndex: () => ({
            pendingUserInputs: [{ requestId: "req-1", question: "Deploy now?", choices: ["Yes, deploy", "Not yet"], allowFreeform: false }],
            pendingElicitations: [],
          }),
          getLastAssistantSegment: () => undefined,
        }
        : undefined),
    },
    sessionManager: {
      submitUserInputResponse,
      readMessagesFromDisk: vi.fn(async () => ({
        messages: [
          { type: "message", role: "user", content: "Fix the transition bands" },
          { type: "message", role: "assistant", content: "Fixed the quantization bug and added tests." },
        ],
      })),
      abortSession: vi.fn(async () => true),
      listModels: vi.fn(async () => []),
    },
    settingsStore: { getSettings: () => ({ model: "claude-opus-5" }) },
  } as unknown as AppContext;
  return { ctx, submitUserInputResponse };
}

function createFacade(): VoiceBridgeFacade & { sent: Array<[string, string]>; marked: string[][] } {
  const sent: Array<[string, string]> = [];
  const marked: string[][] = [];
  return {
    sent,
    marked,
    listSessions: async () => sessions,
    markRead: (ids) => marked.push(ids),
    sendMessage: async (sessionId, prompt) => {
      sent.push([sessionId, prompt]);
      return "started";
    },
    createSession: async () => ({ sessionId: "eeeeeeee-5555-4000-8000-000000000005" }),
  };
}

function tool(ctx: AppContext, facade: VoiceBridgeFacade, name: string, hooks = { watchSession: vi.fn(), showCard: vi.fn(), requestVoiceMode: vi.fn() }) {
  const definition = createVoiceToolDefinitions(ctx, facade, hooks).find((candidate) => candidate.name === name);
  if (!definition) throw new Error(`missing tool ${name}`);
  return { run: (args: Record<string, unknown>) => definition.handler(args, {}) as Promise<any>, hooks };
}

describe("resolveSession", () => {
  it("matches ids, refs, and spoken titles", () => {
    expect(resolveSession(sessions, "aaaaaaaa").ok).toBe(true);
    const byTitle = resolveSession(sessions, "the tellus session");
    expect(byTitle.ok && byTitle.session.title).toBe("Tellus worldgen transition fix");
    expect(resolveSession(sessions, "deploy").ok).toBe(true);
    expect(resolveSession(sessions, "banana").ok).toBe(false);
  });

  it("reports ambiguity with candidates", () => {
    const ambiguous = resolveSession([
      session({ sessionId: "11111111-0000-4000-8000-000000000000", title: "Voice mode plan" }),
      session({ sessionId: "22222222-0000-4000-8000-000000000000", title: "Voice mode build" }),
    ], "voice mode");
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) expect(ambiguous.candidates).toHaveLength(2);
  });

  it("formats relative time", () => {
    expect(formatAgo("2026-09-17T05:57:00.000Z", now)).toBe("3m ago");
    expect(formatAgo(undefined, now)).toBeUndefined();
  });
});

describe("voice tools", () => {
  it("summarizes Bridge state without archived sessions", async () => {
    const { ctx } = createContext();
    const result = await tool(ctx, createFacade(), "bridge_overview").run({});
    expect(result.counts).toEqual({ waitingOnYou: 1, running: 1, unread: 1 });
    expect(result.waitingOnYou[0]).toMatchObject({ title: "Deploy check", questions: ["Deploy now?"] });
    expect(result.unreadReplies[0]).toMatchObject({ title: "Tellus worldgen transition fix", task: "Tellus Expeditions" });
    expect(result.activeTasks[0]).toMatchObject({ title: "Tellus Expeditions", nextAction: "Review biome blend" });
  });

  it("reads a reply and marks it read", async () => {
    const { ctx } = createContext();
    const facade = createFacade();
    const result = await tool(ctx, facade, "read_session").run({ session: "tellus" });
    expect(result.latestReply).toBe("Fixed the quantization bug and added tests.");
    expect(facade.marked).toEqual([["aaaaaaaa-1111-4000-8000-000000000001"]]);
  });

  it("sends to a session and watches it", async () => {
    const { ctx } = createContext();
    const facade = createFacade();
    const { run, hooks } = tool(ctx, facade, "send_to_session");
    const result = await run({ session: "focus protection", message: "Also run the client tests" });
    expect(result).toMatchObject({ success: true, session: "Focus protection preview" });
    expect(facade.sent).toEqual([["bbbbbbbb-2222-4000-8000-000000000002", "Also run the client tests"]]);
    expect(hooks.watchSession).toHaveBeenCalledWith("bbbbbbbb-2222-4000-8000-000000000002");
  });

  it("starts a session with a prompt", async () => {
    const { ctx } = createContext();
    const facade = createFacade();
    const result = await tool(ctx, facade, "start_session").run({ prompt: "Investigate the flaky test", taskId: "task-1", model: "claude-opus-5" });
    expect(result).toMatchObject({ success: true, ref: "eeeeeeee", task: "Tellus Expeditions", model: "claude-opus-5" });
    expect(facade.sent[0]).toEqual(["eeeeeeee-5555-4000-8000-000000000005", "Investigate the flaky test"]);
    const missingTask = await tool(ctx, facade, "start_session").run({ prompt: "x", taskId: "nope" });
    expect(missingTask.resultType).toBe("failure");
  });

  it("answers a waiting question with the matching choice", async () => {
    const { ctx, submitUserInputResponse } = createContext();
    const result = await tool(ctx, createFacade(), "answer_session_question").run({ session: "deploy check", answer: "yes deploy" });
    expect(result).toMatchObject({ success: true, answer: "Yes, deploy" });
    expect(submitUserInputResponse).toHaveBeenCalledWith("cccccccc-3333-4000-8000-000000000003", "req-1", { answer: "Yes, deploy", wasFreeform: false });
  });

  it("requires confirmation before stopping a session", async () => {
    const { ctx } = createContext();
    const unconfirmed = await tool(ctx, createFacade(), "stop_session").run({ session: "focus", confirmed: false });
    expect(unconfirmed.resultType).toBe("failure");
    const confirmed = await tool(ctx, createFacade(), "stop_session").run({ session: "focus", confirmed: true });
    expect(confirmed).toMatchObject({ success: true });
  });

  it("puts cards on screen with session links", async () => {
    const { ctx } = createContext();
    const { run, hooks } = tool(ctx, createFacade(), "show_on_screen");
    await run({ title: "Unread", body: "- Tellus", sessions: ["tellus"] });
    expect(hooks.showCard).toHaveBeenCalledWith({
      title: "Unread",
      body: "- Tellus",
      links: [{ label: "Tellus worldgen transition fix", path: "/sessions/aaaaaaaa-1111-4000-8000-000000000001" }],
    });
  });
});

describe("buildBridgeSnapshotLine", () => {
  it("describes waiting, running and unread sessions compactly", () => {
    expect(buildBridgeSnapshotLine(sessions, now)).toBe(
      '1 waiting on you: "Deploy check"; 1 running: "Focus protection preview"; 1 unread: "Tellus worldgen transition fix" (3m ago)',
    );
    expect(buildBridgeSnapshotLine([], now)).toBe("nothing waiting on you; nothing running; no unread replies");
  });
});
