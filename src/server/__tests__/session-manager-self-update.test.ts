import { afterEach, describe, expect, it, vi } from "vitest";
import { basename, dirname } from "node:path";
import { openMemoryDatabase } from "../db.js";
import { createEventBusRegistry } from "../event-bus.js";
import { createGlobalBus } from "../global-bus.js";
import { createSessionTitlesStore } from "../session-titles.js";
import { toolFailure } from "../tool-results.js";

type ExistsSyncPath = Parameters<typeof import("node:fs").existsSync>[0];
type WriteFileSyncArgs = Parameters<typeof import("node:fs").writeFileSync>;
type ReadFileSyncPath = Parameters<typeof import("node:fs").readFileSync>[0];
type UnlinkSyncPath = Parameters<typeof import("node:fs").unlinkSync>[0];
type ToolInvocation = {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
};

const execSyncMock = vi.hoisted(() => vi.fn<(cmd: string) => string>(() => ""));
const prepareReleaseSlotMock = vi.hoisted(() => vi.fn(async (options: {
  dataDir: string;
  commitSha: string;
  source: string;
  validationMode: "deploy" | "operational";
}) => ({
  ok: true as const,
  manifest: {
    version: 1,
    id: "release-slot-1",
    root: `${options.dataDir}/release-slots/release-slot-1`,
    commitSha: options.commitSha,
    source: options.source,
    dependencyHash: "same-hash",
    createdAt: "2026-05-18T20:00:00.000Z",
    validationMode: options.validationMode,
  },
})));
const existsSyncOverrideMock = vi.hoisted(() => vi.fn<(path: ExistsSyncPath) => boolean | undefined>());
const writeFileSyncCallMock = vi.hoisted(() => vi.fn<(...args: WriteFileSyncArgs) => void>());
const readFileSyncOverrideMock = vi.hoisted(() => vi.fn<(path: ReadFileSyncPath) => string | undefined>());
const unlinkSyncCallMock = vi.hoisted(() => vi.fn<(path: UnlinkSyncPath) => void>());

function isDataFilePath(path: string, filename: string): boolean {
  return basename(path) === filename && basename(dirname(path)) === "data";
}

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execSync: execSyncMock,
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (path: Parameters<typeof actual.existsSync>[0]) => {
      const override = existsSyncOverrideMock(path);
      return typeof override === "boolean" ? override : actual.existsSync(path);
    },
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      writeFileSyncCallMock(...args);
    },
    readFileSync: (path: Parameters<typeof actual.readFileSync>[0], ...args: unknown[]) => {
      const override = readFileSyncOverrideMock(path);
      if (typeof override === "string") return override;
      return actual.readFileSync(path, ...(args as []));
    },
    unlinkSync: (path: Parameters<typeof actual.unlinkSync>[0]) => {
      unlinkSyncCallMock(path);
    },
  };
});

vi.mock("../release-slots.js", () => ({
  prepareReleaseSlot: prepareReleaseSlotMock,
}));

function createToolContext() {
  const db = openMemoryDatabase();
  return {
    taskStore: { findTaskBySessionId: () => undefined } as any,
    taskGroupStore: {} as any,
    scheduleStore: {} as any,
    settingsStore: undefined,
    sessionMetaStore: {} as any,
    sessionTitles: createSessionTitlesStore(db),
    readStateStore: {} as any,
    checklistStore: {} as any,
    tagStore: undefined,
    telemetryStore: undefined,
    docsStore: undefined,
    docsIndex: undefined,
    globalBus: createGlobalBus(),
    eventBusRegistry: createEventBusRegistry(),
    sessionManager: { evictAllCachedSessions() {} } as any,
  } as any;
}

async function loadSessionManagerModule() {
  vi.resetModules();
  return import("../session-manager.js");
}

afterEach(async () => {
  execSyncMock.mockReset();
  prepareReleaseSlotMock.mockClear();
  existsSyncOverrideMock.mockReset();
  writeFileSyncCallMock.mockReset();
  readFileSyncOverrideMock.mockReset();
  unlinkSyncCallMock.mockReset();
  vi.restoreAllMocks();
  vi.resetModules();
  try {
    const mod = await import("../session-manager.js");
    mod.clearRestartPending();
  } catch {}
});

describe("self_update", () => {
  it("queues restart-only dependency sync when pulled changes touch dependency inputs", async () => {
    const oldSha = "1111111111111111111111111111111111111111";
    const newSha = "2222222222222222222222222222222222222222";
    let headReads = 0;

    existsSyncOverrideMock.mockImplementation((path) => {
      const normalized = String(path);
      if (isDataFilePath(normalized, "restart.signal")) return false;
      if (isDataFilePath(normalized, "pre-deploy-sha")) return false;
      return undefined;
    });

    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd === "git rev-parse --abbrev-ref HEAD") return "main\n";
      if (cmd === "git pull --rebase origin main") return "Updating 1111111..2222222\n";
      if (cmd === "git rev-parse --short HEAD") return "22222222\n";
      if (cmd === "git rev-parse HEAD") {
        headReads += 1;
        return `${headReads === 1 ? oldSha : newSha}\n`;
      }
      if (cmd === `git diff "${oldSha}" HEAD --name-only -- package.json package-lock.json patches`) {
        return "package-lock.json\n";
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const mod = await loadSessionManagerModule();
    const tool = mod.createBridgeTools(createToolContext()).find((candidate) => candidate.name === "self_update");
    if (!tool) throw new Error("self_update tool not found");

    const result = await tool.handler({}, {
      sessionId: "session-1",
      toolCallId: "tool-1",
      toolName: "self_update",
      arguments: {},
    } satisfies ToolInvocation) as {
      success: boolean;
      previousSha: string;
      newSha: string;
      message: string;
    };
    const commands = execSyncMock.mock.calls.map(([cmd]) => cmd);
    const writtenPaths = writeFileSyncCallMock.mock.calls.map(([file]) => String(file));

    expect(result).toMatchObject({
      success: true,
      previousSha: "11111111",
      newSha: "22222222",
    });
    expect(result.message).toContain("Restart queued; the launcher will swap to the prepared release slot");
    expect(result.message).toContain("Dependency inputs changed — the inactive release slot has its own dependency install.");
    expect(commands).not.toContain("npm install --no-audit --no-fund --include=dev");
    expect(writtenPaths.some((file) => isDataFilePath(file, "pre-deploy-sha"))).toBe(true);
    expect(writtenPaths.some((file) => isDataFilePath(file, "restart.signal"))).toBe(true);
    expect(writtenPaths.some((file) => isDataFilePath(file, "deps-hash"))).toBe(false);

    mod.clearRestartPending();
  });

  it("clears restart state when self_update cannot write the restart signal", async () => {
    const oldSha = "1111111111111111111111111111111111111111";
    const newSha = "2222222222222222222222222222222222222222";
    let headReads = 0;

    existsSyncOverrideMock.mockImplementation((path) => {
      const normalized = String(path);
      if (isDataFilePath(normalized, "restart.signal")) return false;
      if (isDataFilePath(normalized, "pre-deploy-sha")) return false;
      return undefined;
    });
    writeFileSyncCallMock.mockImplementation((...args: WriteFileSyncArgs) => {
      if (isDataFilePath(String(args[0]), "restart.signal")) {
        throw new Error("disk full");
      }
    });

    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd === "git rev-parse --abbrev-ref HEAD") return "main\n";
      if (cmd === "git pull --rebase origin main") return "Updating 1111111..2222222\n";
      if (cmd === "git rev-parse --short HEAD") return "22222222\n";
      if (cmd === "git rev-parse HEAD") {
        headReads += 1;
        return `${headReads === 1 ? oldSha : newSha}\n`;
      }
      if (cmd === `git diff "${oldSha}" HEAD --name-only -- package.json package-lock.json patches`) return "";
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const mod = await loadSessionManagerModule();
    const tool = mod.createBridgeTools(createToolContext()).find((candidate) => candidate.name === "self_update");
    if (!tool) throw new Error("self_update tool not found");

    const result = await tool.handler({}, {
      sessionId: "session-1",
      toolCallId: "tool-1",
      toolName: "self_update",
      arguments: {},
    } satisfies ToolInvocation) as any;

    expect(result).toMatchObject({ resultType: "failure" });
    expect(result.textResultForLlm).toContain("Updated code but restart signal could not be written.");
    expect(mod.isRestartPending()).toBe(false);
    expect(unlinkSyncCallMock.mock.calls.some(([file]) => isDataFilePath(String(file), "restart.signal"))).toBe(true);
  });

  it("preserves an existing rollback checkpoint when pulling new commits", async () => {
    const oldSha = "1111111111111111111111111111111111111111";
    const newSha = "2222222222222222222222222222222222222222";
    let headReads = 0;

    existsSyncOverrideMock.mockImplementation((path) => {
      const normalized = String(path);
      if (isDataFilePath(normalized, "restart.signal")) return false;
      if (isDataFilePath(normalized, "pre-deploy-sha")) return true;
      return undefined;
    });
    readFileSyncOverrideMock.mockImplementation((path) =>
      isDataFilePath(String(path), "pre-deploy-sha") ? "preserved-checkpoint\n" : undefined,
    );

    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd === "git rev-parse --abbrev-ref HEAD") return "main\n";
      if (cmd === "git pull --rebase origin main") return "Updating 1111111..2222222\n";
      if (cmd === "git rev-parse --short HEAD") return "22222222\n";
      if (cmd === "git rev-parse HEAD") {
        headReads += 1;
        return `${headReads === 1 ? oldSha : newSha}\n`;
      }
      if (cmd === `git diff "${oldSha}" HEAD --name-only -- package.json package-lock.json patches`) return "";
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const mod = await loadSessionManagerModule();
    const tool = mod.createBridgeTools(createToolContext()).find((candidate) => candidate.name === "self_update");
    if (!tool) throw new Error("self_update tool not found");

    await tool.handler({}, {
      sessionId: "session-1",
      toolCallId: "tool-1",
      toolName: "self_update",
      arguments: {},
    } satisfies ToolInvocation);

    expect(
      writeFileSyncCallMock.mock.calls.some(([file]) => isDataFilePath(String(file), "pre-deploy-sha")),
    ).toBe(false);
    expect(
      writeFileSyncCallMock.mock.calls.some(([file]) => isDataFilePath(String(file), "restart.signal")),
    ).toBe(true);

    mod.clearRestartPending();
  });

  it("cleans up a rollback checkpoint created by a failed pull", async () => {
    const oldSha = "1111111111111111111111111111111111111111";

    existsSyncOverrideMock.mockImplementation((path) => {
      const normalized = String(path);
      if (isDataFilePath(normalized, "restart.signal")) return false;
      if (isDataFilePath(normalized, "pre-deploy-sha")) return false;
      return undefined;
    });

    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd === "git rev-parse --abbrev-ref HEAD") return "main\n";
      if (cmd === "git rev-parse HEAD") return `${oldSha}\n`;
      if (cmd === "git pull --rebase origin main") throw new Error("pull failed");
      if (cmd === "git rebase --abort") return "";
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const mod = await loadSessionManagerModule();
    const tool = mod.createBridgeTools(createToolContext()).find((candidate) => candidate.name === "self_update");
    if (!tool) throw new Error("self_update tool not found");

    const result = await tool.handler({}, {
      sessionId: "session-1",
      toolCallId: "tool-1",
      toolName: "self_update",
      arguments: {},
    } satisfies ToolInvocation) as any;

    expect(result).toMatchObject({ resultType: "failure" });
    expect(result.textResultForLlm).toContain("Git pull failed — likely due to merge conflicts or network issues.");
    expect(result.textResultForLlm).toContain("pull failed");
    expect(
      writeFileSyncCallMock.mock.calls.some(([file]) => isDataFilePath(String(file), "pre-deploy-sha")),
    ).toBe(true);
    expect(
      unlinkSyncCallMock.mock.calls.some(([file]) => isDataFilePath(String(file), "pre-deploy-sha")),
    ).toBe(true);
  });

  it("keeps a preserved rollback checkpoint when pull fails", async () => {
    const oldSha = "1111111111111111111111111111111111111111";

    existsSyncOverrideMock.mockImplementation((path) => {
      const normalized = String(path);
      if (isDataFilePath(normalized, "restart.signal")) return false;
      if (isDataFilePath(normalized, "pre-deploy-sha")) return true;
      return undefined;
    });
    readFileSyncOverrideMock.mockImplementation((path) =>
      isDataFilePath(String(path), "pre-deploy-sha") ? "preserved-checkpoint\n" : undefined,
    );

    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd === "git rev-parse --abbrev-ref HEAD") return "main\n";
      if (cmd === "git rev-parse HEAD") return `${oldSha}\n`;
      if (cmd === "git pull --rebase origin main") throw new Error("pull failed");
      if (cmd === "git rebase --abort") return "";
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const mod = await loadSessionManagerModule();
    const tool = mod.createBridgeTools(createToolContext()).find((candidate) => candidate.name === "self_update");
    if (!tool) throw new Error("self_update tool not found");

    const result = await tool.handler({}, {
      sessionId: "session-1",
      toolCallId: "tool-1",
      toolName: "self_update",
      arguments: {},
    } satisfies ToolInvocation) as any;

    expect(result).toMatchObject({ resultType: "failure" });
    expect(result.textResultForLlm).toContain("Git pull failed — likely due to merge conflicts or network issues.");
    expect(result.textResultForLlm).toContain("pull failed");
    expect(
      writeFileSyncCallMock.mock.calls.some(([file]) => isDataFilePath(String(file), "pre-deploy-sha")),
    ).toBe(false);
    expect(
      unlinkSyncCallMock.mock.calls.some(([file]) => isDataFilePath(String(file), "pre-deploy-sha")),
    ).toBe(false);
  });

  it("only removes a rollback checkpoint on no-op updates when the current operation created it", async () => {
    const oldSha = "1111111111111111111111111111111111111111";

    existsSyncOverrideMock.mockImplementation((path) => {
      const normalized = String(path);
      if (isDataFilePath(normalized, "restart.signal")) return false;
      if (isDataFilePath(normalized, "pre-deploy-sha")) return false;
      return undefined;
    });

    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd === "git rev-parse --abbrev-ref HEAD") return "main\n";
      if (cmd === "git pull --rebase origin main") return "Already up to date.\n";
      if (cmd === "git rev-parse --short HEAD") return "11111111\n";
      if (cmd === "git rev-parse HEAD") return `${oldSha}\n`;
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const mod = await loadSessionManagerModule();
    const tool = mod.createBridgeTools(createToolContext()).find((candidate) => candidate.name === "self_update");
    if (!tool) throw new Error("self_update tool not found");

    await tool.handler({}, {
      sessionId: "session-1",
      toolCallId: "tool-1",
      toolName: "self_update",
      arguments: {},
    } satisfies ToolInvocation);

    expect(
      writeFileSyncCallMock.mock.calls.some(([file]) => isDataFilePath(String(file), "pre-deploy-sha")),
    ).toBe(true);
    expect(
      unlinkSyncCallMock.mock.calls.some(([file]) => isDataFilePath(String(file), "pre-deploy-sha")),
    ).toBe(true);
  });

  it("does not remove a preserved rollback checkpoint on no-op updates", async () => {
    const oldSha = "1111111111111111111111111111111111111111";

    existsSyncOverrideMock.mockImplementation((path) => {
      const normalized = String(path);
      if (isDataFilePath(normalized, "restart.signal")) return false;
      if (isDataFilePath(normalized, "pre-deploy-sha")) return true;
      return undefined;
    });
    readFileSyncOverrideMock.mockImplementation((path) =>
      isDataFilePath(String(path), "pre-deploy-sha") ? "preserved-checkpoint\n" : undefined,
    );

    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd === "git rev-parse --abbrev-ref HEAD") return "main\n";
      if (cmd === "git pull --rebase origin main") return "Already up to date.\n";
      if (cmd === "git rev-parse --short HEAD") return "11111111\n";
      if (cmd === "git rev-parse HEAD") return `${oldSha}\n`;
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const mod = await loadSessionManagerModule();
    const tool = mod.createBridgeTools(createToolContext()).find((candidate) => candidate.name === "self_update");
    if (!tool) throw new Error("self_update tool not found");

    await tool.handler({}, {
      sessionId: "session-1",
      toolCallId: "tool-1",
      toolName: "self_update",
      arguments: {},
    } satisfies ToolInvocation);

    expect(
      writeFileSyncCallMock.mock.calls.some(([file]) => isDataFilePath(String(file), "pre-deploy-sha")),
    ).toBe(false);
    expect(
      unlinkSyncCallMock.mock.calls.some(([file]) => isDataFilePath(String(file), "pre-deploy-sha")),
    ).toBe(false);
  });

  it("normalizes direct restart-pending failures", async () => {
    existsSyncOverrideMock.mockImplementation((path) => {
      if (isDataFilePath(String(path), "restart.signal")) return true;
      return undefined;
    });

    const mod = await loadSessionManagerModule();
    const tool = mod.createBridgeTools(createToolContext()).find((candidate) => candidate.name === "self_update");
    if (!tool) throw new Error("self_update tool not found");

    await expect(tool.handler({}, {
      sessionId: "session-1",
      toolCallId: "tool-1",
      toolName: "self_update",
      arguments: {},
    } satisfies ToolInvocation)).resolves.toEqual(
      toolFailure("A restart is already pending. Wait for it to complete before updating."),
    );
  });

  it("rejects when restart is already pending via restart state", async () => {
    existsSyncOverrideMock.mockImplementation(() => undefined);

    const mod = await loadSessionManagerModule();
    mod.triggerRestartPending();

    const tool = mod.createBridgeTools(createToolContext()).find((candidate) => candidate.name === "self_update");
    if (!tool) throw new Error("self_update tool not found");

    await expect(tool.handler({}, {
      sessionId: "session-1",
      toolCallId: "tool-1",
      toolName: "self_update",
      arguments: {},
    } satisfies ToolInvocation)).resolves.toEqual(
      toolFailure("A restart is already pending. Wait for it to complete before updating."),
    );

    mod.clearRestartPending();
  });

});

describe("self_restart", () => {
  it("rejects when restart is already pending", async () => {
    existsSyncOverrideMock.mockImplementation(() => undefined);

    const mod = await loadSessionManagerModule();
    mod.triggerRestartPending();

    const tool = mod.createBridgeTools(createToolContext()).find((candidate) => candidate.name === "self_restart");
    if (!tool) throw new Error("self_restart tool not found");

    await expect(tool.handler({}, {
      sessionId: "session-1",
      toolCallId: "tool-1",
      toolName: "self_restart",
      arguments: {},
    } satisfies ToolInvocation)).resolves.toEqual(
      toolFailure("A restart is already pending. Wait for it to complete before restarting."),
    );

    mod.clearRestartPending();
  });

  it("queues restart state before writing the signal file", async () => {
    existsSyncOverrideMock.mockImplementation(() => undefined);

    const callOrder: string[] = [];

    const mod = await loadSessionManagerModule();

    const originalTrigger = mod.triggerRestartPending;
    vi.spyOn(mod, "triggerRestartPending").mockImplementation(() => {
      callOrder.push("triggerRestartPending");
      return originalTrigger();
    });

    writeFileSyncCallMock.mockImplementation((...args: WriteFileSyncArgs) => {
      const path = String(args[0]);
      if (isDataFilePath(path, "restart.signal")) {
        callOrder.push("writeSignalFile");
      }
    });

    const tool = mod.createBridgeTools(createToolContext()).find((candidate) => candidate.name === "self_restart");
    if (!tool) throw new Error("self_restart tool not found");

    const result = await tool.handler({}, {
      sessionId: "session-1",
      toolCallId: "tool-1",
      toolName: "self_restart",
      arguments: {},
    } satisfies ToolInvocation) as { success: boolean };

    expect(result.success).toBe(true);
    expect(callOrder.indexOf("triggerRestartPending")).toBeLessThan(callOrder.indexOf("writeSignalFile"));

    mod.clearRestartPending();
  });

  it("clears restart state when self_restart cannot write the restart signal", async () => {
    existsSyncOverrideMock.mockImplementation(() => undefined);
    writeFileSyncCallMock.mockImplementation((...args: WriteFileSyncArgs) => {
      if (isDataFilePath(String(args[0]), "restart.signal")) {
        throw new Error("disk full");
      }
    });

    const mod = await loadSessionManagerModule();
    const tool = mod.createBridgeTools(createToolContext()).find((candidate) => candidate.name === "self_restart");
    if (!tool) throw new Error("self_restart tool not found");

    const result = await tool.handler({}, {
      sessionId: "session-1",
      toolCallId: "tool-1",
      toolName: "self_restart",
      arguments: {},
    } satisfies ToolInvocation) as any;

    expect(result).toMatchObject({ resultType: "failure" });
    expect(result.textResultForLlm).toContain("Restart signal could not be written.");
    expect(mod.isRestartPending()).toBe(false);
    expect(unlinkSyncCallMock.mock.calls.some(([file]) => isDataFilePath(String(file), "restart.signal"))).toBe(true);
  });
});
