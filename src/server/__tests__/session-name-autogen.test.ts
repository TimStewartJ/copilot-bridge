import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionNameAutogenerator } from "../session-name-autogen.js";
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
      rpc: { name: { get: rpcNameGet } },
      getMessages: vi.fn(async () => [
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
      getMessages: vi.fn(async () => [
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

  it("still skips existing SDK names for warm or no-message checks", async () => {
    const { generator, setSessionName, generateSessionName } = createHarness(undefined);
    const session = {
      rpc: { name: { get: vi.fn(async () => ({ name: "Manual live title" })) } },
      getMessages: vi.fn(async () => [
        { type: "user.message", data: { content: "Please fix this complicated issue" } },
      ]),
    };

    await (generator as any).generateAndSetMissingSessionName("session-1", { session });

    expect(session.rpc.name.get).toHaveBeenCalled();
    expect(session.getMessages).not.toHaveBeenCalled();
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
      { result: "skipped_no_messages", reason: "getMessages_unavailable" },
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
});
