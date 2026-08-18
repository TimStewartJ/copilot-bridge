import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createSessionNameAutogenerator } from "../session-name-autogen.js";
import { buildSessionNameHelperBaseConfig } from "../session-name-rpc.js";
import type { WorkspaceSessionNameMetadata } from "../session-workspace-yaml.js";

describe("session name autogenerator", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function createHarness(metadata: WorkspaceSessionNameMetadata | undefined) {
    const copilotHome = mkdtempSync(join(tmpdir(), "bridge-session-autogen-"));
    tempDirs.push(copilotHome);
    const setSessionName = vi.fn(async () => {});
    const generateSessionName = vi.fn(async () => "Concise Session Title");
    const createSession = vi.fn(async () => ({
      sendAndWait: vi.fn(async () => ({ data: { content: "<session-title>Concise Session Title</session-title>" } })),
      disconnect: vi.fn(),
    }));
    const generator = createSessionNameAutogenerator({
      listModels: async () => [{ id: "gpt-5-mini", billing: { multiplier: 0 } }] as any,
      createSession,
      deleteSession: vi.fn(async () => {}),
      getCopilotHome: () => copilotHome,
      getSessionName: vi.fn(async () => metadata?.effectiveName),
      getSessionNameMetadata: () => metadata,
      setSessionName,
    });
    (generator as any).generateSessionName = generateSessionName;
    return { generator, createSession, setSessionName, generateSessionName };
  }

  it("replaces prompt-derived workspace names that are not user named", async () => {
    const { generator, setSessionName } = createHarness({
      name: "Long original prompt that should be replaceable",
      effectiveName: "Long original prompt that should be replaceable",
      userNamed: false,
    });

    await (generator as any).generateAndSetMissingSessionName("session-1", { userMessages: ["Please fix this complicated issue"] });

    expect(setSessionName).toHaveBeenCalledWith("session-1", "Concise Session Title", { session: undefined });
  });

  it("skips explicit user-named workspace titles", async () => {
    const { generator, createSession, setSessionName } = createHarness({
      name: "Manual title",
      effectiveName: "Manual title",
      userNamed: true,
    });

    await (generator as any).generateAndSetMissingSessionName("session-1", { userMessages: ["Please fix this complicated issue"] });

    expect(createSession).not.toHaveBeenCalled();
    expect(setSessionName).not.toHaveBeenCalled();
  });

  it("does not treat live first-turn provisional SDK names as explicit titles", async () => {
    const { generator, setSessionName, generateSessionName } = createHarness(undefined);
    const rpcNameGet = vi.fn(async () => ({ name: "Please investigate a tricky production bug" }));
    const session = {
      getName: rpcNameGet,
      getEvents: vi.fn(async () => [
        { type: "user.message", data: { content: "Please investigate a tricky production bug" } },
      ]),
    };

    await (generator as any).generateAndSetMissingSessionName("session-1", {
      session,
      userMessages: ["Please investigate a tricky production bug"],
    });

    expect(rpcNameGet).not.toHaveBeenCalled();
    expect(generateSessionName).toHaveBeenCalledWith(["Please investigate a tricky production bug"]);
    expect(setSessionName).toHaveBeenCalledWith("session-1", "Concise Session Title", { session });
  });

  it("uses session history when a delayed live trigger includes only a follow-up", async () => {
    const { generator, generateSessionName } = createHarness(undefined);
    const session = {
      getEvents: vi.fn(async () => [
        { type: "user.message", data: { content: "Investigate why deployment restarts wedge the bridge" } },
        { type: "assistant.message", data: { content: "I found the restart issue." } },
        { type: "user.message", data: { content: "Can you show the exact diff?" } },
      ]),
    };

    await (generator as any).generateAndSetMissingSessionName("session-1", {
      session,
      userMessages: ["Can you show the exact diff?"],
    });

    expect(generateSessionName).toHaveBeenCalledWith([
      "Investigate why deployment restarts wedge the bridge",
      "Can you show the exact diff?",
    ]);
  });

  it("replaces a provisional fork title using only the first new user message", async () => {
    const { generator, generateSessionName, setSessionName } = createHarness({
      name: "Fork of Original session",
      effectiveName: "Fork of Original session",
      userNamed: true,
    });
    const session = {
      getName: vi.fn(async () => ({ name: "Fork of Original session" })),
      getEvents: vi.fn(async () => [
        { type: "user.message", data: { content: "Copied history should not title the fork" } },
      ]),
    };

    await (generator as any).generateAndSetMissingSessionName("session-1", {
      session,
      userMessages: ["Investigate the new failure mode"],
      includeHistory: false,
      replaceExistingName: "Fork of Original session",
    });

    expect(session.getEvents).not.toHaveBeenCalled();
    expect(generateSessionName).toHaveBeenCalledWith(["Investigate the new failure mode"]);
    expect(setSessionName).toHaveBeenCalledWith("session-1", "Concise Session Title", { session });
  });

  it("does not overwrite a manual rename that wins while a fork title is generating", async () => {
    const { generator, setSessionName } = createHarness({
      name: "Fork of Original session",
      effectiveName: "Fork of Original session",
      userNamed: true,
    });
    const getName = vi.fn()
      .mockResolvedValueOnce({ name: "Fork of Original session" })
      .mockResolvedValueOnce({ name: "Manual fork title" });
    const session = {
      getName,
      getEvents: vi.fn(),
    };

    await (generator as any).generateAndSetMissingSessionName("session-1", {
      session,
      userMessages: ["Investigate the new failure mode"],
      includeHistory: false,
      replaceExistingName: "Fork of Original session",
    });

    expect(getName).toHaveBeenCalledTimes(2);
    expect(setSessionName).not.toHaveBeenCalled();
  });

  it("captures and replaces an inherited fork title when no seeded title is known", async () => {
    const { generator, generateSessionName, setSessionName } = createHarness({
      name: "Original session",
      effectiveName: "Original session",
      userNamed: true,
    });
    const session = {
      getName: vi.fn(async () => ({ name: "Original session" })),
      getEvents: vi.fn(),
    };

    await (generator as any).generateAndSetMissingSessionName("session-1", {
      session,
      userMessages: ["Investigate the new failure mode"],
      includeHistory: false,
      replaceExistingName: true,
    });

    expect(generateSessionName).toHaveBeenCalledWith(["Investigate the new failure mode"]);
    expect(setSessionName).toHaveBeenCalledWith("session-1", "Concise Session Title", { session });
  });

  it("bypasses the retry throttle for a pending fork replacement", async () => {
    const { generator, generateSessionName, setSessionName } = createHarness({
      name: "Fork of Original session",
      effectiveName: "Fork of Original session",
      userNamed: true,
    });
    const session = {
      getName: vi.fn(async () => ({ name: "Fork of Original session" })),
    };
    (generator as any).generationLastAttempt.set("session-1", Date.now());

    generator.maybeAutoNameSession("session-1", {
      session,
      userMessages: ["Investigate the new failure mode"],
      includeHistory: false,
      replaceExistingName: "Fork of Original session",
    });

    await vi.waitFor(() => expect(setSessionName).toHaveBeenCalled());
    expect(generateSessionName).toHaveBeenCalledWith(["Investigate the new failure mode"]);
  });

  it("queues a pending fork replacement behind an in-flight warm rename", async () => {
    let metadata: WorkspaceSessionNameMetadata | undefined;
    let resolveWarmGeneration!: (value: string) => void;
    const warmGeneration = new Promise<string>((resolve) => {
      resolveWarmGeneration = resolve;
    });
    const generateSessionName = vi.fn()
      .mockImplementationOnce(() => warmGeneration)
      .mockResolvedValueOnce("First New Fork Message");
    const setSessionName = vi.fn(async () => {});
    const generator = createSessionNameAutogenerator({
      listModels: async () => [{ id: "gpt-5-mini", billing: { multiplier: 0 } }] as any,
      createSession: vi.fn(),
      deleteSession: vi.fn(async () => {}),
      getCopilotHome: () => "",
      getSessionName: vi.fn(async () => metadata?.effectiveName),
      getSessionNameMetadata: () => metadata,
      setSessionName,
    });
    (generator as any).generateSessionName = generateSessionName;
    const session = {
      getName: vi.fn(async () => ({ name: metadata?.effectiveName ?? "" })),
    };

    generator.maybeAutoNameSession("session-1", {
      userMessages: ["Copied fork history"],
    });
    await vi.waitFor(() => expect(generateSessionName).toHaveBeenCalledTimes(1));

    metadata = {
      name: "Fork of Original session",
      effectiveName: "Fork of Original session",
      userNamed: true,
    };
    generator.maybeAutoNameSession("session-1", {
      session,
      userMessages: ["Investigate the new failure mode"],
      includeHistory: false,
      replaceExistingName: "Fork of Original session",
    });
    resolveWarmGeneration("Copied History Title");

    await vi.waitFor(() => expect(setSessionName).toHaveBeenCalledTimes(1));
    expect(generateSessionName).toHaveBeenNthCalledWith(2, ["Investigate the new failure mode"]);
    expect(setSessionName).toHaveBeenCalledWith("session-1", "First New Fork Message", { session });
  });

  it("excludes sub-agent instructions from title generation history", async () => {
    const { generator, generateSessionName } = createHarness(undefined);
    const session = {
      getEvents: vi.fn(async () => [
        { type: "user.message", data: { content: "Investigate the deployment restart" } },
        {
          type: "user.message",
          agentId: "agent-1",
          data: { content: "Inspect every launcher file" },
        },
        { type: "user.message", data: { content: "Show me the fix" } },
      ]),
    };

    await (generator as any).generateAndSetMissingSessionName("session-1", {
      session,
      userMessages: ["Show me the fix"],
    });

    expect(generateSessionName).toHaveBeenCalledWith([
      "Investigate the deployment restart",
      "Show me the fix",
    ]);
  });

  it("still skips existing SDK names for warm or no-message checks", async () => {
    const { generator, setSessionName, generateSessionName } = createHarness(undefined);
    const session = {
      getName: vi.fn(async () => ({ name: "Manual live title" })),
      getEvents: vi.fn(async () => [
        { type: "user.message", data: { content: "Please fix this complicated issue" } },
      ]),
    };

    await (generator as any).generateAndSetMissingSessionName("session-1", { session });

    expect(session.getName).toHaveBeenCalled();
    expect(session.getEvents).not.toHaveBeenCalled();
    expect(generateSessionName).not.toHaveBeenCalled();
    expect(setSessionName).not.toHaveBeenCalled();
  });

  it("rechecks before writing so generated titles do not clobber manual renames", async () => {
    const copilotHome = mkdtempSync(join(tmpdir(), "bridge-session-autogen-"));
    tempDirs.push(copilotHome);
    const metadataSequence: Array<WorkspaceSessionNameMetadata | undefined> = [
      {
        name: "Long original prompt",
        effectiveName: "Long original prompt",
        userNamed: false,
      },
      {
        name: "Manual title",
        effectiveName: "Manual title",
        userNamed: true,
      },
    ];
    const setSessionName = vi.fn(async () => {});
    const generator = createSessionNameAutogenerator({
      listModels: async () => [{ id: "gpt-5-mini", billing: { multiplier: 0 } }] as any,
      createSession: vi.fn(async () => ({
        sendAndWait: vi.fn(async () => ({ data: { content: "<session-title>Concise Session Title</session-title>" } })),
        disconnect: vi.fn(),
      })),
      deleteSession: vi.fn(async () => {}),
      getCopilotHome: () => copilotHome,
      getSessionName: vi.fn(async () => undefined),
      getSessionNameMetadata: () => metadataSequence.shift(),
      setSessionName,
    });
    (generator as any).generateSessionName = vi.fn(async () => "Concise Session Title");

    await (generator as any).generateAndSetMissingSessionName("session-1", { userMessages: ["Please fix this complicated issue"] });

    expect(setSessionName).not.toHaveBeenCalled();
  });

  it("records a no-message skip when a resumed session cannot provide history", async () => {
    const copilotHome = mkdtempSync(join(tmpdir(), "bridge-session-autogen-"));
    tempDirs.push(copilotHome);
    const recordSpan = vi.fn();
    const setSessionName = vi.fn(async () => {});
    const generator = createSessionNameAutogenerator({
      listModels: async () => [{ id: "gpt-5-mini", billing: { multiplier: 0 } }] as any,
      createSession: vi.fn(async () => ({
        sendAndWait: vi.fn(async () => ({ data: { content: "<session-title>Concise Session Title</session-title>" } })),
        disconnect: vi.fn(),
      })),
      deleteSession: vi.fn(async () => {}),
      getCopilotHome: () => copilotHome,
      getSessionName: vi.fn(async () => undefined),
      getSessionNameMetadata: () => ({
        name: "Long original prompt",
        effectiveName: "Long original prompt",
        userNamed: false,
      }),
      setSessionName,
      recordSpan,
    });
    (generator as any).generateSessionName = vi.fn(async () => "Concise Session Title");

    await (generator as any).generateAndSetMissingSessionName("session-1", { session: {} });

    expect(setSessionName).not.toHaveBeenCalled();
    expect(recordSpan).toHaveBeenCalledWith(
      "session.name.autogen",
      expect.any(Number),
      "session-1",
      { result: "skipped_no_messages", reason: "session_events_unavailable" },
    );
  });

  it("records a no-title skip instead of creating a helper for unconfigured policy models", async () => {
    const copilotHome = mkdtempSync(join(tmpdir(), "bridge-session-autogen-"));
    tempDirs.push(copilotHome);
    const createSession = vi.fn(async () => ({
      sendAndWait: vi.fn(async () => ({ data: { content: "<session-title>Concise Session Title</session-title>" } })),
      disconnect: vi.fn(),
    }));
    const recordSpan = vi.fn();
    const setSessionName = vi.fn(async () => {});
    const generator = createSessionNameAutogenerator({
      listModels: async () => [
        { id: "gpt-5-mini", policy: { state: "unconfigured" }, billing: { multiplier: 0 } },
        { id: "claude-haiku-4.5", policy: { state: "disabled" }, billing: { multiplier: 0 } },
      ] as any,
      createSession,
      deleteSession: vi.fn(async () => {}),
      getCopilotHome: () => copilotHome,
      getSessionName: vi.fn(async () => undefined),
      getSessionNameMetadata: () => ({
        name: "Long original prompt",
        effectiveName: "Long original prompt",
        userNamed: false,
      }),
      setSessionName,
      recordSpan,
    });

    await (generator as any).generateAndSetMissingSessionName("session-1", { userMessages: ["Please fix this complicated issue"] });

    expect(createSession).not.toHaveBeenCalled();
    expect(setSessionName).not.toHaveBeenCalled();
    expect(recordSpan).toHaveBeenCalledWith(
      "session.name.autogen",
      expect.any(Number),
      "session-1",
      { result: "skipped_no_title" },
    );
  });

  it("creates the title helper session with the shared session-name helper base config", async () => {
    const copilotHome = mkdtempSync(join(tmpdir(), "bridge-session-autogen-"));
    tempDirs.push(copilotHome);
    const createSession = vi.fn(async () => ({
      sendAndWait: vi.fn(async () => ({ data: { content: "<session-title>Concise Session Title</session-title>" } })),
      disconnect: vi.fn(),
    }));
    const generator = createSessionNameAutogenerator({
      listModels: async () => [{ id: "gpt-5-mini", billing: { multiplier: 0 } }] as any,
      createSession,
      deleteSession: vi.fn(async () => {}),
      getCopilotHome: () => copilotHome,
      getSessionName: vi.fn(async () => undefined),
      getSessionNameMetadata: () => undefined,
      setSessionName: vi.fn(async () => {}),
    });

    await (generator as any).generateSessionName(["Please fix this complicated issue"]);

    expect(createSession).toHaveBeenCalledTimes(1);
    const config = (createSession.mock.calls[0] as unknown as [Record<string, unknown>])[0];

    const base = buildSessionNameHelperBaseConfig();
    for (const [key, value] of Object.entries(base)) {
      expect(config[key]).toEqual(value);
    }

    expect(config).not.toHaveProperty("tools");
    expect(config).not.toHaveProperty("excludedTools");
    expect(config.availableTools).toEqual([]);
    for (const [key, value] of Object.entries(config)) {
      if (!/tool/i.test(key)) continue;
      if (Array.isArray(value)) expect(value).not.toContain("*");
      else if (typeof value === "string") expect(value).not.toBe("*");
    }

    expect(config.clientName).toBe("Copilot Bridge Title Helper");
    expect(config.model).toBe("gpt-5-mini");
    expect(config.infiniteSessions).toEqual({ enabled: false });
    expect(config.enableSessionTelemetry).toBe(false);
    expect(config.enableSessionStore).toBe(false);
    expect((config.systemMessage as { mode?: string } | undefined)?.mode).toBe("replace");
    expect(typeof config.sessionId).toBe("string");

    expect(config).not.toHaveProperty("suppressResumeEvent");
    expect(config).not.toHaveProperty("continuePendingWork");
  });

  it("removes legacy session-store rows after helper persistence completes", async () => {
    const copilotHome = mkdtempSync(join(tmpdir(), "bridge-session-autogen-"));
    tempDirs.push(copilotHome);
    const dbPath = join(copilotHome, "session-store.db");
    const setupDb = new DatabaseSync(dbPath);
    setupDb.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY);
      CREATE TABLE turns (session_id TEXT, content TEXT);
    `);
    setupDb.close();

    let helperSessionId = "";
    let disconnectFinished = false;
    const disconnect = vi.fn(async () => {
      const db = new DatabaseSync(dbPath);
      try {
        db.prepare("INSERT INTO sessions (id) VALUES (?)").run(helperSessionId);
        db.prepare("INSERT INTO turns (session_id, content) VALUES (?, ?)").run(helperSessionId, "title prompt");
      } finally {
        db.close();
      }
      disconnectFinished = true;
    });
    const deleteSession = vi.fn(async (sessionId: string) => {
      expect(disconnectFinished).toBe(true);
      expect(sessionId).toBe(helperSessionId);
    });
    const createSession = vi.fn(async (config: Record<string, unknown>) => {
      helperSessionId = String(config.sessionId);
      return {
        sendAndWait: vi.fn(async () => ({ data: { content: "<session-title>Concise Session Title</session-title>" } })),
        disconnect,
      };
    });
    const generator = createSessionNameAutogenerator({
      listModels: async () => [{ id: "gpt-5-mini", billing: { multiplier: 0 } }] as any,
      createSession,
      deleteSession,
      getCopilotHome: () => copilotHome,
      getSessionName: vi.fn(async () => undefined),
      getSessionNameMetadata: () => undefined,
      setSessionName: vi.fn(async () => {}),
    });

    await (generator as any).generateSessionName(["Please fix this complicated issue"]);

    expect(disconnect).toHaveBeenCalledOnce();
    expect(deleteSession).toHaveBeenCalledOnce();
    const readDb = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(readDb.prepare("SELECT count(*) AS count FROM sessions WHERE id = ?").get(helperSessionId)).toEqual({ count: 0 });
      expect(readDb.prepare("SELECT count(*) AS count FROM turns WHERE session_id = ?").get(helperSessionId)).toEqual({ count: 0 });
    } finally {
      readDb.close();
    }
  });
});
