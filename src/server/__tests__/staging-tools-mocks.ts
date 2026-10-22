// Mock state shared by the staging-tools test files. Each test file registers it with its own vi.mock
// calls (see the top of staging-tools.test.ts). This module is loaded before those mocks exist, so it
// must not statically import node:fs, node:child_process or any other module the test files mock.
import { vi } from "vitest";
import { basename, dirname, join } from "node:path";

type ExistsSyncPath = Parameters<typeof import("node:fs").existsSync>[0];
type WriteFileSyncArgs = Parameters<typeof import("node:fs").writeFileSync>;
type ReadFileSyncPath = Parameters<typeof import("node:fs").readFileSync>[0];
type UnlinkSyncPath = Parameters<typeof import("node:fs").unlinkSync>[0];
type MkdirSyncArgs = Parameters<typeof import("node:fs").mkdirSync>;
type RenameSyncArgs = Parameters<typeof import("node:fs").renameSync>;
type RmSyncArgs = Parameters<typeof import("node:fs").rmSync>;
type StatSyncPath = Parameters<typeof import("node:fs").statSync>[0];
export type MockSpawnOptions = { cwd?: string; env?: NodeJS.ProcessEnv; shell?: boolean; windowsHide?: boolean };

export const execSyncMock = vi.fn<
  (cmd: string, options?: { cwd?: string; timeout?: number; encoding?: string; env?: NodeJS.ProcessEnv }) => string
>(() => "");
export const spawnMock = (() => {
  type Listener = (...args: any[]) => void;

  return vi.fn((
    cmd: string,
    argsOrOptions?: readonly string[] | MockSpawnOptions,
    maybeOptions?: MockSpawnOptions,
  ) => {
    const args = Array.isArray(argsOrOptions) ? argsOrOptions : undefined;
    const options = Array.isArray(argsOrOptions) ? maybeOptions : argsOrOptions as MockSpawnOptions | undefined;
    const renderedCommand = args ? [cmd, ...args].join(" ") : cmd;
    const listeners = new Map<string, Listener[]>();
    const stdoutListeners: Listener[] = [];
    const stderrListeners: Listener[] = [];
    const child = {
      pid: 12345,
      kill: vi.fn(),
      stdout: {
        on(event: string, listener: Listener) {
          if (event === "data") stdoutListeners.push(listener);
          return this;
        },
      },
      stderr: {
        on(event: string, listener: Listener) {
          if (event === "data") stderrListeners.push(listener);
          return this;
        },
      },
      on(event: string, listener: Listener) {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
        // A real child reports its result on a later event-loop turn, after the caller has
        // subscribed. Process creation is asynchronous, so the mock waits for that subscription.
        if (event === "close") queueMicrotask(finish);
        return child;
      },
    };
    const emit = (event: string, ...args: unknown[]) => {
      for (const listener of listeners.get(event) ?? []) {
        listener(...args);
      }
    };
    const emitOutput = (outputListeners: Listener[], value: unknown) => {
      if (value === undefined || value === null || value === "") return;
      for (const listener of outputListeners) {
        listener(value);
      }
    };

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      try {
        const output = execSyncMock(renderedCommand, {
          cwd: options?.cwd,
          encoding: "utf-8",
          env: options?.env,
        });
        emitOutput(stdoutListeners, output);
        emit("close", 0, null);
      } catch (error) {
        const failure = error as { stderr?: unknown; stdout?: unknown; status?: number; signal?: NodeJS.Signals };
        emitOutput(stdoutListeners, failure.stdout);
        emitOutput(stderrListeners, failure.stderr);
        emit("close", typeof failure.status === "number" ? failure.status : 1, failure.signal ?? null);
      }
    };

    return child;
  });
})();
export const requestRestartMock = vi.fn();
export const dependencySyncHashMock = vi.fn<(path: string) => string>(() => "same-hash");
export const prepareReleaseSlotMock = vi.fn(async (options: {
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
}));
export const existsSyncOverrideMock = vi.fn<(path: ExistsSyncPath) => boolean | undefined>();
export const lstatSyncOverrideMock = vi.fn<
  (path: unknown) => { isSymbolicLink(): boolean; isDirectory(): boolean } | undefined
>();
export const writeFileSyncCallMock = vi.fn<(...args: WriteFileSyncArgs) => void>();
export const renameSyncCallMock = vi.fn<(...args: RenameSyncArgs) => void>();
export const readFileSyncOverrideMock = vi.fn<(path: ReadFileSyncPath) => string | undefined>();
export const unlinkSyncCallMock = vi.fn<(path: UnlinkSyncPath) => void>();
export const rmSyncCallMock = vi.fn<(...args: RmSyncArgs) => void>();
export const preparePatchedPackagesForInstallMock = vi.fn(() => ({
  packages: [],
  discard: vi.fn(),
  restore: vi.fn(),
}));
export const createDirectoryLinkMock = vi.fn(() => ({ ok: true, output: "" }));
export const removeDirectoryLinkMock = vi.fn(() => ({ ok: true, output: "" }));
export const captureProcessIdentityMock = vi.fn<
  (pid: number) => Promise<{ pid: number; startMarker: string } | null>
>(async (pid: number) => ({
  pid,
  startMarker: `start-${pid}`,
}));
export const terminateProcessTreeMock = vi.fn(async (root: { pid: number; startMarker: string }) => ({
  ok: true,
  status: "terminated",
  root,
}));
export const buildPublicUrlMock = vi.fn(() => undefined);

export function isDataFilePath(path: string, filename: string): boolean {
  return basename(path) === filename && basename(dirname(path)) === "data";
}

export function isRestartSignalTempPath(path: string): boolean {
  const filename = basename(path);
  return basename(dirname(path)) === "data"
    && filename.startsWith(".restart.signal.")
    && filename.endsWith(".tmp");
}

export function hasRestartSignalWriteAttempt(): boolean {
  return writeFileSyncCallMock.mock.calls.some(([file]) => isRestartSignalTempPath(String(file)));
}

export function isValidationLogPath(path: string): boolean {
  const parts = path.split(/[/\\]/);
  return parts.includes("data") && parts.includes("validation-logs");
}

export function isDeployValidationStampPath(path: string): boolean {
  return path.split(/[/\\]/).some((part) => part.startsWith("deploy-validation-stamp.json"));
}

export function isStagingValidationStampPath(path: string): boolean {
  return path.split(/[/\\]/).includes("staging-validation-stamps");
}

export function isStagingDependencyHashPath(path: string): boolean {
  return basename(path) === ".bridge-deps-hash";
}

export function mockDataFilePresence(
  { restartSignal = false, restartInProgress = false, preDeploySha = false }: { restartSignal?: boolean; restartInProgress?: boolean; preDeploySha?: boolean } = {},
) {
  existsSyncOverrideMock.mockImplementation((path) => {
    const normalized = String(path);
    if (isDataFilePath(normalized, "restart.signal")) return restartSignal;
    if (isDataFilePath(normalized, "restart-in-progress.json")) return restartInProgress;
    if (isDataFilePath(normalized, "pre-deploy-sha")) return preDeploySha;
    return undefined;
  });
}

mockDataFilePresence();

// Paths for which the mocked node:fs rmSync should fail, simulating EPERM/EBUSY
// (e.g. a Windows file lock) after retries are exhausted. Used to exercise
// staging preview data-removal failure handling.
export const rmSyncThrowDirs = new Set<string>();
export const stagingLogMock = vi.fn<(msg: string) => void>();

export const copilotSdkModule = {
  defineTool: (name: string, config: Record<string, unknown>) => ({ name, ...config }),
};
export const dependencySyncModule = {
  dependencySyncHash: dependencySyncHashMock,
  preparePatchedPackagesForInstall: preparePatchedPackagesForInstallMock,
};
export const releaseSlotsModule = { prepareReleaseSlot: prepareReleaseSlotMock };
export const platformModule = {
  PROCESS_TREE_TERMINATION_BUDGET_MS: 25_000,
  createDirectoryLink: createDirectoryLinkMock,
  removeDirectoryLink: removeDirectoryLinkMock,
  captureProcessIdentity: captureProcessIdentityMock,
  terminateProcessTree: terminateProcessTreeMock,
};
export const publicUrlModule = { buildPublicUrl: buildPublicUrlMock };
export const configModule = { config: { web: { port: 3333 } } };
export const stagingLogModule = { log: stagingLogMock };

export function mockChildProcess(actual: typeof import("node:child_process")) {
  return { ...actual, spawn: spawnMock };
}

export async function mockNodeFs(actual: typeof import("node:fs")): Promise<Record<string, unknown>> {
  const { withTestSourceCheckout } = await import("./test-paths.js");
  const existsSync = withTestSourceCheckout(actual.existsSync);
  return {
    ...actual,
    existsSync: (path: Parameters<typeof actual.existsSync>[0]) => {
      const override = existsSyncOverrideMock(path);
      return typeof override === "boolean" ? override : existsSync(path);
    },
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      writeFileSyncCallMock(...args);
      const [path] = args;
      const normalized = String(path);
      if (
        isDataFilePath(normalized, "pre-deploy-sha")
        || isDataFilePath(normalized, "restart.signal")
        || isRestartSignalTempPath(normalized)
        || isDataFilePath(normalized, "deps-hash")
        || isValidationLogPath(normalized)
        || isDeployValidationStampPath(normalized)
        || isStagingValidationStampPath(normalized)
      ) {
        return;
      }
      return actual.writeFileSync(...args);
    },
    mkdirSync: (...args: MkdirSyncArgs) => {
      const [path] = args;
      if (isValidationLogPath(String(path)) || isStagingValidationStampPath(String(path))) {
        return undefined as ReturnType<typeof actual.mkdirSync>;
      }
      return actual.mkdirSync(...args);
    },
    readFileSync: (path: Parameters<typeof actual.readFileSync>[0], ...args: unknown[]) => {
      const override = readFileSyncOverrideMock(path);
      if (typeof override === "string") return override;
      // Keep the SDK-driven restart gate deterministic: never read the real
      // production restart-state.json from tests. Default to idle unless a test
      // explicitly overrides it.
      if (isDataFilePath(String(path), "restart-state.json")) {
        return JSON.stringify({ phase: "idle" });
      }
      return actual.readFileSync(path, ...(args as []));
    },
    lstatSync: (path: Parameters<typeof actual.lstatSync>[0], ...args: unknown[]) => {
      const override = lstatSyncOverrideMock(path);
      if (override) return override as unknown as ReturnType<typeof actual.lstatSync>;
      return actual.lstatSync(path, ...(args as []));
    },
    statSync: (path: StatSyncPath, ...args: unknown[]) => {
      const override = existsSyncOverrideMock(path);
      if (override === false) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${String(path)}'`), {
          code: "ENOENT",
        });
      }
      if (override === true) {
        return { isFile: () => true } as ReturnType<typeof actual.statSync>;
      }
      return actual.statSync(path, ...(args as []));
    },
    unlinkSync: (path: Parameters<typeof actual.unlinkSync>[0], ...args: unknown[]) => {
      unlinkSyncCallMock(path);
      if (isDataFilePath(String(path), "pre-deploy-sha")) return;
      return actual.unlinkSync(path, ...(args as []));
    },
    renameSync: (...args: RenameSyncArgs) => {
      renameSyncCallMock(...args);
      const [, target] = args;
      if (
        isDataFilePath(String(target), "restart.signal")
        || isDeployValidationStampPath(String(target))
        || isStagingValidationStampPath(String(target))
      ) return;
      return actual.renameSync(...args);
    },
    rmSync: (path: Parameters<typeof actual.rmSync>[0], ...args: unknown[]) => {
      rmSyncCallMock(path, ...(args as []));
      if (rmSyncThrowDirs.has(String(path))) {
        throw new Error(`EBUSY: resource busy or locked, rm '${String(path)}'`);
      }
      return actual.rmSync(path, ...(args as []));
    },
  };
}

export function mockRestartSignal(actual: typeof import("../restart-signal.js")) {
  return {
    ...actual,
    requestRestart: async (dataDir: string, request: Parameters<typeof actual.requestRestart>[1]) => {
      requestRestartMock(dataDir, request);
      const signal = actual.createRestartSignal({ ...request, requestId: "restart-request-test" });
      writeFileSyncCallMock(join(dataDir, ".restart.signal.test.tmp"), actual.serializeRestartSignal(signal));
      return signal;
    },
  };
}
