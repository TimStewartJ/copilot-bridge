import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBridgeTools, SessionManager } from "../session-manager.js";
import { toolFailure } from "../tool-results.js";
import { setupTestDb, createTestBus } from "./helpers.js";
import { createEventBusRegistry } from "../event-bus.js";
import { createSessionTitlesStore } from "../session-titles.js";

describe("SessionManager self-renaming", () => {
  let db: ReturnType<typeof setupTestDb>;
  let eventBusRegistry: ReturnType<typeof createEventBusRegistry>;
  let sessionTitles: ReturnType<typeof createSessionTitlesStore>;
  let globalBus: ReturnType<typeof createTestBus>;

  beforeEach(() => {
    db = setupTestDb();
    eventBusRegistry = createEventBusRegistry();
    sessionTitles = createSessionTitlesStore(db);
    globalBus = createTestBus();
  });

  function createManager(opts: { copilotHome?: string } = {}) {
    return new SessionManager({
      tools: [],
      globalBus,
      eventBusRegistry,
      sessionTitles,
      taskStore: { findTaskBySessionId: () => undefined } as any,
      config: { sessionMcpServers: {} },
      copilotHome: opts.copilotHome,
    });
  }

  function getRenameTool() {
    const tool = createBridgeTools({
      taskStore: { findTaskBySessionId: () => undefined } as any,
      taskGroupStore: {} as any,
      scheduleStore: {} as any,
      settingsStore: undefined,
      sessionMetaStore: {} as any,
      sessionTitles,
      readStateStore: {} as any,
      checklistStore: {} as any,
      tagStore: undefined,
      telemetryStore: undefined,
      docsStore: undefined,
      docsIndex: undefined,
      globalBus,
      eventBusRegistry,
      sessionManager: { evictAllCachedSessions() {} } as any,
    } as any).find((candidate) => candidate.name === "session_rename");

    if (!tool) throw new Error("session_rename tool not found");
    return tool;
  }

  it("defaults session_rename to the invoking session and emits title updates", async () => {
    const renameTool = getRenameTool();
    const sessionBus = eventBusRegistry.getOrCreateBus("session-1");
    const busEvents: any[] = [];
    const globalEvents: any[] = [];

    sessionBus.subscribe((event) => {
      if (event.type !== "snapshot") busEvents.push(event);
    });
    globalBus.subscribe((event) => globalEvents.push(event));

    const result = await renameTool.handler(
      { title: "Project sync follow-up" },
      { sessionId: "session-1", toolCallId: "tool-1", toolName: "session_rename", arguments: { title: "Project sync follow-up" } },
    );

    expect(result).toMatchObject({
      success: true,
      sessionId: "session-1",
      message: 'Session renamed to "Project sync follow-up"',
    });
    expect(sessionTitles.getTitle("session-1")).toBe("Project sync follow-up");
    expect(busEvents).toContainEqual({ type: "title_changed", title: "Project sync follow-up" });
    expect(globalEvents).toContainEqual({
      type: "session:title",
      sessionId: "session-1",
      title: "Project sync follow-up",
    });
  });

  it("respects an explicit target session id", async () => {
    const renameTool = getRenameTool();
    const callerBus = eventBusRegistry.getOrCreateBus("caller-session");
    const targetBus = eventBusRegistry.getOrCreateBus("target-session");
    const callerEvents: any[] = [];
    const targetEvents: any[] = [];

    callerBus.subscribe((event) => {
      if (event.type !== "snapshot") callerEvents.push(event);
    });
    targetBus.subscribe((event) => {
      if (event.type !== "snapshot") targetEvents.push(event);
    });

    await renameTool.handler(
      { sessionId: "target-session", title: "Renamed elsewhere" },
      { sessionId: "caller-session", toolCallId: "tool-2", toolName: "session_rename", arguments: { sessionId: "target-session", title: "Renamed elsewhere" } },
    );

    expect(sessionTitles.getTitle("caller-session")).toBeUndefined();
    expect(sessionTitles.getTitle("target-session")).toBe("Renamed elsewhere");
    expect(callerEvents).toEqual([]);
    expect(targetEvents).toContainEqual({ type: "title_changed", title: "Renamed elsewhere" });
  });

  it("rejects prompt-like rename attempts", async () => {
    const renameTool = getRenameTool();

    for (const title of [
      "Generate a concise 3-6 word title for this conversation.",
      "Reply with ONLY the title text — no quotes, no punctuation unless it's part of a name.",
      "If this session does not already have a concise title, after your first substantive response call `session_rename` with a concise 3-6 word title for the current session. Do this silently without mentioning it to the user.",
    ]) {
      const result = await renameTool.handler(
        { title },
        { sessionId: "session-echo", toolCallId: "tool-3", toolName: "session_rename", arguments: {} },
      );

      expect(result).toEqual(toolFailure("Title looks like echoed prompt text"));
    }
    expect(sessionTitles.getTitle("session-echo")).toBeUndefined();
  });

  it("allows ordinary titles that happen to include prompt-adjacent words", async () => {
    const renameTool = getRenameTool();

    const result = await renameTool.handler(
      { title: "Generate a concise changelog for release" },
      { sessionId: "session-real", toolCallId: "tool-4", toolName: "session_rename", arguments: {} },
    );

    expect(result).toMatchObject({ success: true, sessionId: "session-real" });
    expect(sessionTitles.getTitle("session-real")).toBe("Generate a concise changelog for release");
  });

  it("adds self-rename guidance only for sessions without a stored title", () => {
    const manager = createManager() as any;

    const newSessionConfig = manager.buildSessionConfig();
    const untitledResumeConfig = manager.buildSessionConfig({ sessionId: "untitled-session" });
    sessionTitles.setTitle("titled-session", "Already named");
    const titledResumeConfig = manager.buildSessionConfig({ sessionId: "titled-session" });

    expect(newSessionConfig.systemMessage.content).toContain("call `session_rename`");
    expect(untitledResumeConfig.systemMessage.content).toContain("call `session_rename`");
    expect(titledResumeConfig.systemMessage.content ?? "").not.toContain("call `session_rename`");
  });

  it("does not prompt or overwrite a concise existing workspace summary", async () => {
    const copilotHome = mkdtempSync(join(tmpdir(), "bridge-title-home-"));
    const sessionDir = join(copilotHome, "session-state", "session-existing");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "workspace.yaml"),
      "created_at: 2026-04-16T21:00:00.000Z\nsummary: Existing concise title\n",
    );

    const manager = createManager({ copilotHome }) as any;
    const config = manager.buildSessionConfig({ sessionId: "session-existing" });

    expect(config.systemMessage.content ?? "").not.toContain("call `session_rename`");

    const bus = eventBusRegistry.getOrCreateBus("session-existing");
    const busEvents: any[] = [];
    const globalEvents: any[] = [];
    const handlers: Array<(event: any) => void> = [];

    bus.subscribe((event) => {
      if (event.type !== "snapshot") busEvents.push(event);
    });
    globalBus.subscribe((event) => globalEvents.push(event));

    const session = {
      on(handler: (event: any) => void) {
        handlers.push(handler);
        return () => {};
      },
      send: vi.fn(async () => {
        setTimeout(() => {
          for (const handler of handlers) {
            handler({ type: "assistant.message", timestamp: "2026-04-16T21:00:00.000Z", data: { content: "Done." } });
            handler({ type: "session.idle", timestamp: "2026-04-16T21:00:01.000Z", data: {} });
          }
        }, 0);
      }),
    };

    manager.client = {} as any;
    manager.sessionObjects.set("session-existing", session);

    await manager._doWork("session-existing", "help me improve session titles", bus);

    expect(sessionTitles.getTitle("session-existing")).toBeUndefined();
    expect(busEvents).not.toContainEqual({ type: "title_changed", title: "Existing concise title" });
    expect(globalEvents).not.toContainEqual(
      expect.objectContaining({ type: "session:title", sessionId: "session-existing" }),
    );
  });

  it("does not mistake the raw first prompt summary for an existing title", async () => {
    const prompt = "請不要使用任何工具，用兩句話說明為什麼要先檢查 staging preview 再部署。";
    const copilotHome = mkdtempSync(join(tmpdir(), "bridge-title-home-"));
    const sessionDir = join(copilotHome, "session-state", "session-prompt-summary");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "workspace.yaml"),
      `created_at: 2026-04-16T21:00:00.000Z\nsummary: ${prompt}\n`,
    );
    writeFileSync(
      join(sessionDir, "events.jsonl"),
      `${JSON.stringify({ type: "user.message", timestamp: "2026-04-16T21:00:00.000Z", data: { content: prompt } })}\n`,
    );

    const manager = createManager({ copilotHome }) as any;
    const config = manager.buildSessionConfig({ sessionId: "session-prompt-summary" });
    expect(config.systemMessage.content ?? "").toContain("call `session_rename`");

    const bus = eventBusRegistry.getOrCreateBus("session-prompt-summary");
    const handlers: Array<(event: any) => void> = [];
    const session = {
      on(handler: (event: any) => void) {
        handlers.push(handler);
        return () => {};
      },
      send: vi.fn(async () => {
        setTimeout(() => {
          for (const handler of handlers) {
            handler({ type: "assistant.message", timestamp: "2026-04-16T21:00:00.000Z", data: { content: "已完成。" } });
            handler({ type: "session.idle", timestamp: "2026-04-16T21:00:01.000Z", data: {} });
          }
        }, 0);
      }),
    };

    manager.client = {} as any;
    manager.sessionObjects.set("session-prompt-summary", session);

    await manager._doWork("session-prompt-summary", prompt, bus);

    expect(sessionTitles.getTitle("session-prompt-summary")).toBe(
      "請不要使用任何工具 用兩句話說明為什麼要先檢查 staging preview 再部署",
    );
  });

  it("does not mistake a truncated first prompt summary for an existing title", async () => {
    const summary = "Copilot Bridge Post Incident Report Fix Brief";
    const prompt = `${summary} with owner updates, impact, mitigations, and rollback notes for each issue.`;
    const copilotHome = mkdtempSync(join(tmpdir(), "bridge-title-home-"));
    const sessionDir = join(copilotHome, "session-state", "session-prompt-prefix");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "workspace.yaml"),
      `created_at: 2026-04-16T21:00:00.000Z\nsummary: ${summary}\n`,
    );
    writeFileSync(
      join(sessionDir, "events.jsonl"),
      `${JSON.stringify({ type: "user.message", timestamp: "2026-04-16T21:00:00.000Z", data: { content: prompt } })}\n`,
    );

    const manager = createManager({ copilotHome }) as any;
    const config = manager.buildSessionConfig({ sessionId: "session-prompt-prefix" });
    expect(config.systemMessage.content ?? "").toContain("call `session_rename`");

    const bus = eventBusRegistry.getOrCreateBus("session-prompt-prefix");
    const handlers: Array<(event: any) => void> = [];
    const session = {
      on(handler: (event: any) => void) {
        handlers.push(handler);
        return () => {};
      },
      send: vi.fn(async () => {
        setTimeout(() => {
          for (const handler of handlers) {
            handler({ type: "assistant.message", timestamp: "2026-04-16T21:00:00.000Z", data: { content: "Done." } });
            handler({ type: "session.idle", timestamp: "2026-04-16T21:00:01.000Z", data: {} });
          }
        }, 0);
      }),
    };

    manager.client = {} as any;
    manager.sessionObjects.set("session-prompt-prefix", session);

    await manager._doWork("session-prompt-prefix", prompt, bus);

    expect(sessionTitles.getTitle("session-prompt-prefix")).toBe(
      "Copilot Bridge Post Incident Report Fix",
    );
  });

  it("does not mistake a block-summary prompt echo for an existing title", async () => {
    const copilotHome = mkdtempSync(join(tmpdir(), "bridge-title-home-"));
    const sessionDir = join(copilotHome, "session-state", "session-block-summary");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "workspace.yaml"),
      [
        "created_at: 2026-04-16T21:00:00.000Z",
        "summary: |-",
        "  Provide a morning briefing with:",
        "",
        "  - weather",
        "  - top tasks",
        "  - blockers",
        "",
      ].join("\n"),
    );

    const manager = createManager({ copilotHome }) as any;
    const config = manager.buildSessionConfig({ sessionId: "session-block-summary" });

    expect(config.systemMessage.content ?? "").toContain("call `session_rename`");
  });

  it("ignores terminal events emitted during subscription until send begins", async () => {
    const manager = createManager() as any;
    const bus = eventBusRegistry.getOrCreateBus("session-sync-subscribe");
    const busEvents: any[] = [];
    const handlers: Array<(event: any) => void> = [];
    const send = vi.fn(async () => {
      setTimeout(() => {
        for (const handler of handlers) {
          handler({ type: "assistant.message", timestamp: "2026-04-16T21:00:00.000Z", data: { content: "Done." } });
          handler({ type: "session.idle", timestamp: "2026-04-16T21:00:01.000Z", data: {} });
        }
      }, 0);
    });

    bus.subscribe((event) => {
      if (event.type !== "snapshot") busEvents.push(event);
    });

    const session = {
      on(handler: (event: any) => void) {
        handler({ type: "session.idle", timestamp: "2026-04-16T20:59:59.000Z", data: {} });
        handlers.push(handler);
        return () => {};
      },
      send,
    };

    manager.client = {} as any;
    manager.sessionObjects.set("session-sync-subscribe", session);

    await expect(manager._doWork("session-sync-subscribe", "help me improve session titles", bus)).resolves.toBeUndefined();

    expect(send).toHaveBeenCalledTimes(1);
    expect(busEvents.filter((event) => event.type === "done")).toMatchObject([{ type: "done", content: "Done." }]);
    expect(sessionTitles.getTitle("session-sync-subscribe")).toBe("Improve session titles");
  });

  it("stores a prompt-derived fallback title when the session does not rename itself", async () => {
    const manager = createManager() as any;
    const bus = eventBusRegistry.getOrCreateBus("session-fallback");
    const sessionBusEvents: any[] = [];
    const globalEvents: any[] = [];
    const handlers: Array<(event: any) => void> = [];

    bus.subscribe((event) => {
      if (event.type !== "snapshot") sessionBusEvents.push(event);
    });
    globalBus.subscribe((event) => globalEvents.push(event));

    const session = {
      on(handler: (event: any) => void) {
        handlers.push(handler);
        return () => {};
      },
      send: vi.fn(async () => {
        setTimeout(() => {
          for (const handler of handlers) {
            handler({ type: "assistant.message", timestamp: "2026-04-16T21:00:00.000Z", data: { content: "Done." } });
            handler({ type: "session.idle", timestamp: "2026-04-16T21:00:01.000Z", data: {} });
          }
        }, 0);
      }),
    };

    manager.client = {} as any;
    manager.sessionObjects.set("session-fallback", session);

    await manager._doWork("session-fallback", "help me improve session titles", bus);

    expect(sessionTitles.getTitle("session-fallback")).toBe("Improve session titles");
    expect(sessionBusEvents).toContainEqual({ type: "title_changed", title: "Improve session titles" });
    expect(globalEvents).toContainEqual({
      type: "session:title",
      sessionId: "session-fallback",
      title: "Improve session titles",
    });
  });

  it("keeps legitimate fallback titles that start with generate a concise", async () => {
    const manager = createManager() as any;
    const bus = eventBusRegistry.getOrCreateBus("session-fallback-generate-concise");
    const handlers: Array<(event: any) => void> = [];

    const session = {
      on(handler: (event: any) => void) {
        handlers.push(handler);
        return () => {};
      },
      send: vi.fn(async () => {
        setTimeout(() => {
          for (const handler of handlers) {
            handler({ type: "assistant.message", timestamp: "2026-04-16T21:00:00.000Z", data: { content: "Done." } });
            handler({ type: "session.idle", timestamp: "2026-04-16T21:00:01.000Z", data: {} });
          }
        }, 0);
      }),
    };

    manager.client = {} as any;
    manager.sessionObjects.set("session-fallback-generate-concise", session);

    await manager._doWork(
      "session-fallback-generate-concise",
      "Generate a concise changelog for release notes and deployment steps",
      bus,
    );

    expect(sessionTitles.getTitle("session-fallback-generate-concise")).toBe(
      "Generate a concise changelog for release",
    );
  });

  it("stores a prompt-derived fallback title for non-English prompts", async () => {
    const manager = createManager() as any;
    const bus = eventBusRegistry.getOrCreateBus("session-fallback-i18n");
    const handlers: Array<(event: any) => void> = [];

    const session = {
      on(handler: (event: any) => void) {
        handlers.push(handler);
        return () => {};
      },
      send: vi.fn(async () => {
        setTimeout(() => {
          for (const handler of handlers) {
            handler({ type: "assistant.message", timestamp: "2026-04-16T21:00:00.000Z", data: { content: "Готово." } });
            handler({ type: "session.idle", timestamp: "2026-04-16T21:00:01.000Z", data: {} });
          }
        }, 0);
      }),
    };

    manager.client = {} as any;
    manager.sessionObjects.set("session-fallback-i18n", session);

    await manager._doWork("session-fallback-i18n", "исправь падение при запуске", bus);

    expect(sessionTitles.getTitle("session-fallback-i18n")).toBe("Исправь падение при запуске");
  });
});
