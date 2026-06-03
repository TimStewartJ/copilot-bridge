import { afterEach, describe, expect, it, vi } from "vitest";
import { basename, dirname, join } from "node:path";
import { openMemoryDatabase } from "../db.js";
import { createEventBusRegistry } from "../event-bus.js";
import { createGlobalBus } from "../global-bus.js";
import { createSessionTitlesStore } from "../session-titles.js";
import { toolFailure } from "../tool-results.js";
import { createManagementJobStore } from "../management-job-store.js";
import { makeTestDir } from "./helpers.js";

type ExistsSyncPath = Parameters<typeof import("node:fs").existsSync>[0];
type WriteFileSyncArgs = Parameters<typeof import("node:fs").writeFileSync>;
type ReadFileSyncPath = Parameters<typeof import("node:fs").readFileSync>[0];
type UnlinkSyncPath = Parameters<typeof import("node:fs").unlinkSync>[0];

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
  const dataDir = join(makeTestDir("self-update-management-jobs"), "data");
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
    runtimePaths: { dataDir, docsDir: join(dataDir, "docs"), env: process.env },
    managementJobStore: createManagementJobStore(db, { dataDir }),
  } as any;
}

async function loadTestModules() {
  vi.resetModules();
  const sessionMod = await import("../session-manager.js");
  const restartControllerMod = await import("../restart-controller.js");
  const selfAdminMod = await import("../tools/self-admin-tools.js");
  return {
    ...sessionMod,
    ...restartControllerMod,
    createSelfAdminToolDefinitions: selfAdminMod.createSelfAdminToolDefinitions,
  };
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
  it("enqueues a durable management job without running git in the tool handler", async () => {
    existsSyncOverrideMock.mockImplementation((path) => {
      if (isDataFilePath(String(path), "restart.signal")) return false;
      return undefined;
    });

    const mod = await loadTestModules();
    const tool = mod.createSelfAdminToolDefinitions(createToolContext()).find((candidate) => candidate.name === "self_update");
    if (!tool) throw new Error("self_update tool not found");

    const result = await tool.handler({}, {
      sessionId: "session-1",
      toolCallId: "tool-1",
      toolName: "self_update",
      arguments: {},
    } as any) as { success: boolean; jobId: string; status: string; message: string; terminal: boolean; toolNextAction: string; content: Array<{ text: string }> };

    expect(result.success).toBe(true);
    expect(result.status).toBe("queued");
    expect(result.jobId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.message).toContain("management job");
    expect(result.message).toContain("defer_create");
    expect(result.message).toContain("Do not call management_job_status synchronously just to poll.");
    expect(result.message).toContain("restart cutover is not blocked");
    expect(result.terminal).toBe(true);
    expect(result.toolNextAction).toBe("respond_or_defer");
    expect(result.content[0].text).toContain('"nextAction":"respond_or_defer"');
    expect(execSyncMock).not.toHaveBeenCalled();
    expect(prepareReleaseSlotMock).not.toHaveBeenCalled();
    expect(writeFileSyncCallMock.mock.calls.some(([file]) => isDataFilePath(String(file), "restart.signal"))).toBe(false);
  });

  it("rejects duplicate active deploy/update management jobs", async () => {
    existsSyncOverrideMock.mockImplementation((path) => {
      if (isDataFilePath(String(path), "restart.signal")) return false;
      return undefined;
    });

    const mod = await loadTestModules();
    const ctx = createToolContext();
    const tool = mod.createSelfAdminToolDefinitions(ctx).find((candidate) => candidate.name === "self_update");
    if (!tool) throw new Error("self_update tool not found");

    await tool.handler({}, {
      sessionId: "session-1",
      toolCallId: "tool-1",
      toolName: "self_update",
      arguments: {},
    } as any);
    const duplicate = await tool.handler({}, {
      sessionId: "session-1",
      toolCallId: "tool-2",
      toolName: "self_update",
      arguments: {},
    } as any) as any;

    expect(duplicate).toMatchObject({ resultType: "failure" });
    expect(duplicate.textResultForLlm).toContain("already active");
  });

  it("normalizes direct restart-pending failures", async () => {
    existsSyncOverrideMock.mockImplementation((path) => {
      if (isDataFilePath(String(path), "restart.signal")) return true;
      return undefined;
    });

    const mod = await loadTestModules();
    const tool = mod.createSelfAdminToolDefinitions(createToolContext()).find((candidate) => candidate.name === "self_update");
    if (!tool) throw new Error("self_update tool not found");

    await expect(tool.handler({}, {
      sessionId: "session-1",
      toolCallId: "tool-1",
      toolName: "self_update",
      arguments: {},
    } as any)).resolves.toEqual(
      toolFailure("A restart is already pending. Wait for it to complete before updating."),
    );
  });

  it("rejects when restart is already pending via restart state", async () => {
    existsSyncOverrideMock.mockImplementation(() => undefined);

    const mod = await loadTestModules();
    mod.triggerRestartPending();

    const tool = mod.createSelfAdminToolDefinitions(createToolContext()).find((candidate) => candidate.name === "self_update");
    if (!tool) throw new Error("self_update tool not found");

    await expect(tool.handler({}, {
      sessionId: "session-1",
      toolCallId: "tool-1",
      toolName: "self_update",
      arguments: {},
    } as any)).resolves.toEqual(
      toolFailure("A restart is already pending. Wait for it to complete before updating."),
    );

    mod.clearRestartPending();
  });

});

describe("self_restart", () => {
  it("rejects when restart is already pending", async () => {
    existsSyncOverrideMock.mockImplementation(() => undefined);

    const mod = await loadTestModules();
    mod.triggerRestartPending();

    const tool = mod.createSelfAdminToolDefinitions(createToolContext()).find((candidate) => candidate.name === "self_restart");
    if (!tool) throw new Error("self_restart tool not found");

    await expect(tool.handler({}, {
      sessionId: "session-1",
      toolCallId: "tool-1",
      toolName: "self_restart",
      arguments: {},
    } as any)).resolves.toEqual(
      toolFailure("A restart is already pending. Wait for it to complete before restarting."),
    );

    mod.clearRestartPending();
  });

  it("queues restart state before writing the signal file", async () => {
    existsSyncOverrideMock.mockImplementation(() => undefined);

    const callOrder: string[] = [];

    const mod = await loadTestModules();

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

    const tool = mod.createSelfAdminToolDefinitions(createToolContext()).find((candidate) => candidate.name === "self_restart");
    if (!tool) throw new Error("self_restart tool not found");

    const result = await tool.handler({}, {
      sessionId: "session-1",
      toolCallId: "tool-1",
      toolName: "self_restart",
      arguments: {},
    } as any) as { success: boolean };

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

    const mod = await loadTestModules();
    const tool = mod.createSelfAdminToolDefinitions(createToolContext()).find((candidate) => candidate.name === "self_restart");
    if (!tool) throw new Error("self_restart tool not found");

    const result = await tool.handler({}, {
      sessionId: "session-1",
      toolCallId: "tool-1",
      toolName: "self_restart",
      arguments: {},
    } as any) as any;

    expect(result).toMatchObject({ resultType: "failure" });
    expect(result.textResultForLlm).toContain("Restart signal could not be written.");
    expect(mod.isRestartPending()).toBe(false);
    expect(unlinkSyncCallMock.mock.calls.some(([file]) => isDataFilePath(String(file), "restart.signal"))).toBe(true);
  });
});
