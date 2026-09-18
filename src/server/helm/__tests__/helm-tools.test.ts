import { describe, expect, it, vi } from "vitest";
import type { AppContext } from "../../app-context.js";
import {
  boundToolResult,
  buildBridgeSnapshotLine,
  countBridgeSessions,
  createHelmToolDefinitions,
  formatAgo,
  HELM_TOOL_NAMES,
  isHelmBridgeToolName,
  resolveSession,
  type HelmBridgeFacade,
  type HelmSessionSummary,
  type HelmToolRuntime,
} from "../helm-tools.js";

const now = Date.parse("2026-09-17T06:00:00.000Z");

function session(overrides: Partial<HelmSessionSummary>): HelmSessionSummary {
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

const sessions: HelmSessionSummary[] = [
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

function createFacade(): HelmBridgeFacade & { sent: Array<[string, string]>; marked: string[][]; archived: Array<[string[], boolean]> } {
  const sent: Array<[string, string]> = [];
  const marked: string[][] = [];
  const archived: Array<[string[], boolean]> = [];
  return {
    sent,
    marked,
    archived,
    listSessions: async (options) => (options?.includeArchived ? sessions : sessions.filter((entry) => !entry.archived)),
    markRead: (ids) => marked.push(ids),
    setArchived: (ids, value) => archived.push([ids, value]),
    sendMessage: async (sessionId, prompt) => {
      sent.push([sessionId, prompt]);
      return "started";
    },
    createSession: async () => ({ sessionId: "eeeeeeee-5555-4000-8000-000000000005" }),
  };
}

const HELM_SESSION_ID = "99999999-9999-4000-8000-000000000009";

function createRuntime(handsFreeActive = false) {
  const requestHandsFree = vi.fn();
  const runtime = {
    watchSession: vi.fn(),
    getHandsFreeHooks: vi.fn(() => (handsFreeActive ? { requestHandsFree } : undefined)),
  } satisfies HelmToolRuntime;
  return { runtime, requestHandsFree };
}

function tool(ctx: AppContext, facade: HelmBridgeFacade, name: string, runtime: HelmToolRuntime = createRuntime().runtime) {
  const definition = createHelmToolDefinitions(ctx, facade, runtime).find((candidate) => candidate.name === name);
  if (!definition) throw new Error(`missing tool ${name}`);
  return { run: (args: Record<string, unknown>) => definition.handler(args, { sessionId: HELM_SESSION_ID }) as Promise<any>, runtime };
}

describe("resolveSession", () => {
  it("matches ids, refs, links, and spoken titles", () => {
    expect(resolveSession(sessions, "aaaaaaaa").ok).toBe(true);
    const byLink = resolveSession(sessions, "bridge://session/bbbbbbbb");
    expect(byLink.ok && byLink.session.title).toBe("Focus protection preview");
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

describe("Helm tools", () => {
  it("defines every Helm tool", () => {
    const { ctx } = createContext();
    const names = createHelmToolDefinitions(ctx, createFacade(), createRuntime().runtime).map((definition) => definition.name);
    expect(names).toEqual([...HELM_TOOL_NAMES]);
  });

  it("summarizes Bridge state without archived sessions and links what it names", async () => {
    const { ctx } = createContext();
    const result = await tool(ctx, createFacade(), "bridge_overview").run({});
    expect(result.counts).toEqual({ waitingOnYou: 1, running: 1, unread: 1, activeTasks: 1 });
    expect(result.waitingOnYou[0]).toMatchObject({ title: "Deploy check", questions: ["Deploy now?"], link: "bridge://session/cccccccc-3333-4000-8000-000000000003" });
    expect(result.unreadReplies[0]).toMatchObject({
      title: "Tellus worldgen transition fix",
      task: "Tellus Expeditions",
      taskLink: "bridge://task/task-1",
    });
    expect(result.activeTasks[0]).toMatchObject({ title: "Tellus Expeditions", nextAction: "Review biome blend", link: "bridge://task/task-1" });
  });

  it("shows each task's last activity the way the task rail does, most recently active first", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    try {
      const { ctx } = createContext();
      const task = (id: string, title: string, updatedAt: string, extra: Record<string, unknown> = {}) =>
        ({ id, title, status: "active", muted: false, priority: 0, updatedAt, ...extra });
      (ctx.taskStore as { listTasks(): unknown }).listTasks = () => [
        task("task-2", "Circles Journaling App", "2026-09-17T05:00:00.000Z"),
        // Its own last edit is the oldest, but its session replied three minutes ago.
        task("task-1", "Tellus Expeditions", "2026-09-16T00:00:00.000Z", { nextAction: "Review biome blend" }),
        task("task-3", "Muted task", "2026-09-17T05:59:00.000Z", { muted: true }),
        task("task-4", "Archived task", "2026-09-17T05:59:30.000Z", { status: "archived" }),
        ...Array.from({ length: 8 }, (_, index) => task(`old-${index}`, `Older task ${index}`, `2026-09-0${index + 1}T00:00:00.000Z`)),
      ];
      const result = await tool(ctx, createFacade(), "bridge_overview").run({});
      expect(result.activeTasks.slice(0, 3).map((entry: any) => [entry.title, entry.lastActivity])).toEqual([
        ["Tellus Expeditions", "3m ago"],
        ["Circles Journaling App", "1h ago"],
        ["Older task 7", "9d ago"],
      ]);
      // Eight are listed; the count says how many there really are, so a partial list is never mistaken for all of them.
      expect(result.activeTasks).toHaveLength(8);
      expect(result.counts.activeTasks).toBe(10);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lists archived sessions only when asked", async () => {
    const { ctx } = createContext();
    const recent = await tool(ctx, createFacade(), "list_sessions").run({});
    expect(recent.sessions.map((entry: any) => entry.title)).not.toContain("Old archived chat");
    const archived = await tool(ctx, createFacade(), "list_sessions").run({ filter: "archived" });
    expect(archived.sessions).toEqual([expect.objectContaining({ title: "Old archived chat", archived: true })]);
  });

  it("reads a reply and marks it read", async () => {
    const { ctx } = createContext();
    const facade = createFacade();
    const result = await tool(ctx, facade, "read_session").run({ session: "tellus", history: 5 });
    expect(result.latestReply).toBe("Fixed the quantization bug and added tests.");
    expect(result.recentMessages).toEqual([
      { role: "user", content: "Fix the transition bands" },
      { role: "assistant", content: "Fixed the quantization bug and added tests." },
    ]);
    expect(facade.marked).toEqual([["aaaaaaaa-1111-4000-8000-000000000001"]]);
  });

  it("sends to a session and watches it", async () => {
    const { ctx } = createContext();
    const facade = createFacade();
    const { run, runtime } = tool(ctx, facade, "send_to_session");
    const result = await run({ session: "focus protection", message: "Also run the client tests" });
    expect(result).toMatchObject({ success: true, session: "Focus protection preview", link: "bridge://session/bbbbbbbb-2222-4000-8000-000000000002" });
    expect(facade.sent).toEqual([["bbbbbbbb-2222-4000-8000-000000000002", "Also run the client tests"]]);
    expect(runtime.watchSession).toHaveBeenCalledWith(HELM_SESSION_ID, "bbbbbbbb-2222-4000-8000-000000000002");
  });

  it("starts a session with a prompt", async () => {
    const { ctx } = createContext();
    const facade = createFacade();
    const result = await tool(ctx, facade, "start_session").run({ prompt: "Investigate the flaky test", taskId: "task-1", model: "claude-opus-5" });
    expect(result).toMatchObject({ success: true, ref: "eeeeeeee", link: "bridge://session/eeeeeeee-5555-4000-8000-000000000005", task: "Tellus Expeditions", model: "claude-opus-5" });
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

  it("archives idle sessions and refuses ones that are still working", async () => {
    const { ctx } = createContext();
    const facade = createFacade();
    const archived = await tool(ctx, facade, "archive_sessions").run({ sessions: ["tellus"] });
    expect(archived).toMatchObject({ success: true, archived: true, sessions: ["Tellus worldgen transition fix"] });
    expect(facade.archived).toEqual([[["aaaaaaaa-1111-4000-8000-000000000001"], true]]);
    const running = await tool(ctx, facade, "archive_sessions").run({ sessions: ["focus protection"] });
    expect(running.resultType).toBe("failure");
    const restored = await tool(ctx, facade, "archive_sessions").run({ sessions: ["old archived"], archived: false });
    expect(restored).toMatchObject({ success: true, archived: false });
  });

  it("controls hands-free only while it is active", async () => {
    const { ctx } = createContext();
    const inactive = await tool(ctx, createFacade(), "hands_free").run({ action: "sleep" });
    expect(inactive.resultType).toBe("failure");
    const { runtime, requestHandsFree } = createRuntime(true);
    const active = await tool(ctx, createFacade(), "hands_free", runtime).run({ action: "end" });
    expect(active).toEqual({ success: true });
    expect(runtime.getHandsFreeHooks).toHaveBeenCalledWith(HELM_SESSION_ID);
    expect(requestHandsFree).toHaveBeenCalledWith("end");
  });

  it("reuses Bridge management tools but nothing that does real work", () => {
    for (const name of [
      "task_list", "task_update", "task_group_create", "task_link_pr", "action_add", "decision_save", "decision_promote", "alert_list", "alert_save",
      "event_save", "schedule_create", "docs_write", "docs_db_query", "focus_protection_current", "focus_history_list", "focus_quiet_concerns_list",
      "session_rename", "publish_visual", "tag_list",
    ]) {
      expect(isHelmBridgeToolName(name), name).toBe(true);
    }
    for (const name of ["staging_deploy", "self_restart", "browser_exec", "computer_click", "defer_create", "checklist_add", "feed_save", "report_intent", "git_worktree_release"]) {
      expect(isHelmBridgeToolName(name), name).toBe(false);
    }
  });

  it("leaves producer governance and backup administration to ordinary sessions", () => {
    for (const name of [
      "focus_authority_save", "focus_authority_revoke", "focus_authority_list", "focus_coverage_save", "focus_coverage_delete", "focus_audit_save",
      "focus_episode_get", "focus_quality_metrics", "focus_digest_mark_viewed", "docs_snapshot_create", "docs_snapshot_restore", "docs_db_create", "docs_db_delete",
    ]) {
      expect(isHelmBridgeToolName(name), name).toBe(false);
    }
  });

  it("bounds long reused tool results", () => {
    const bounded = boundToolResult({ notes: "x".repeat(5_000), items: Array.from({ length: 70 }, (_, index) => index) }) as { notes: string; items: unknown[] };
    expect(bounded.notes.endsWith("… (truncated)")).toBe(true);
    expect(bounded.items).toHaveLength(61);
    expect(bounded.items.at(-1)).toBe("… 10 more");
  });
});

describe("buildBridgeSnapshotLine", () => {
  it("describes waiting, running and unread sessions compactly", () => {
    expect(buildBridgeSnapshotLine(sessions, now)).toBe(
      '1 waiting on you: "Deploy check"; 1 running: "Focus protection preview"; 1 unread: "Tellus worldgen transition fix" (3m ago)',
    );
    expect(buildBridgeSnapshotLine([], now)).toBe("nothing waiting on you; nothing running; no unread replies");
  });

  it("counts the same groups for the hands-free status pills", () => {
    expect(countBridgeSessions(sessions)).toEqual({ waiting: 1, running: 1, unread: 1 });
  });
});
