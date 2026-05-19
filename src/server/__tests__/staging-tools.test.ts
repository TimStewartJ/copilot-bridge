import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

type ExistsSyncPath = Parameters<typeof import("node:fs").existsSync>[0];
type WriteFileSyncArgs = Parameters<typeof import("node:fs").writeFileSync>;
type ReadFileSyncPath = Parameters<typeof import("node:fs").readFileSync>[0];
type UnlinkSyncPath = Parameters<typeof import("node:fs").unlinkSync>[0];
type MkdirSyncArgs = Parameters<typeof import("node:fs").mkdirSync>;
type RenameSyncArgs = Parameters<typeof import("node:fs").renameSync>;
type ToolInvocation = {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
};

const execSyncMock = vi.hoisted(() => vi.fn<
  (cmd: string, options?: { cwd?: string; timeout?: number; encoding?: string; env?: NodeJS.ProcessEnv }) => string
>(() => ""));
const spawnMock = vi.hoisted(() => {
  type Listener = (...args: any[]) => void;
  type MockSpawnOptions = { cwd?: string; env?: NodeJS.ProcessEnv; shell?: boolean; windowsHide?: boolean };

  return vi.fn((cmd: string, options?: MockSpawnOptions) => {
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

    queueMicrotask(() => {
      try {
        const output = execSyncMock(cmd, {
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
    });

    return child;
  });
});
const triggerRestartPendingMock = vi.fn();
const clearRestartPendingMock = vi.fn();
const isRestartPendingMock = vi.hoisted(() => vi.fn(() => false));
const dependencySyncHashMock = vi.fn<(path: string) => string>(() => "same-hash");
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
const renameSyncCallMock = vi.hoisted(() => vi.fn<(...args: RenameSyncArgs) => void>());
const readFileSyncOverrideMock = vi.hoisted(() => vi.fn<(path: ReadFileSyncPath) => string | undefined>());
const unlinkSyncCallMock = vi.hoisted(() => vi.fn<(path: UnlinkSyncPath) => void>());
const preparePatchedPackagesForInstallMock = vi.fn(() => ({
  packages: [],
  discard: vi.fn(),
  restore: vi.fn(),
}));
const createDirectoryLinkMock = vi.fn(() => ({ ok: true, output: "" }));
const removeDirectoryLinkMock = vi.fn(() => ({ ok: true, output: "" }));
const killProcessTreeMock = vi.fn(() => ({
  rootPid: 12345,
  processGroupId: 12345,
  descendantPids: [],
  trackedPids: [12345],
  killRequested: true,
}));
const buildPublicUrlMock = vi.fn(() => undefined);

function isDataFilePath(path: string, filename: string): boolean {
  return basename(path) === filename && basename(dirname(path)) === "data";
}

function isValidationLogPath(path: string): boolean {
  const parts = path.split(/[/\\]/);
  return parts.includes("data") && parts.includes("validation-logs");
}

function isDeployValidationStampPath(path: string): boolean {
  return path.split(/[/\\]/).some((part) => part.startsWith("deploy-validation-stamp.json"));
}

function isStagingValidationStampPath(path: string): boolean {
  return path.split(/[/\\]/).includes("staging-validation-stamps");
}

function mockDataFilePresence(
  { restartSignal = false, preDeploySha = false }: { restartSignal?: boolean; preDeploySha?: boolean } = {},
) {
  existsSyncOverrideMock.mockImplementation((path) => {
    const normalized = String(path);
    if (isDataFilePath(normalized, "restart.signal")) return restartSignal;
    if (isDataFilePath(normalized, "pre-deploy-sha")) return preDeploySha;
    return undefined;
  });
}

mockDataFilePresence();

vi.mock("@github/copilot-sdk", () => ({
  defineTool: (name: string, config: Record<string, unknown>) => ({ name, ...config }),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: spawnMock,
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
      const [path] = args;
      const normalized = String(path);
      if (
        isDataFilePath(normalized, "pre-deploy-sha")
        || isDataFilePath(normalized, "restart.signal")
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
      return actual.readFileSync(path, ...(args as []));
    },
    unlinkSync: (path: Parameters<typeof actual.unlinkSync>[0], ...args: unknown[]) => {
      unlinkSyncCallMock(path);
      if (isDataFilePath(String(path), "pre-deploy-sha")) return;
      return actual.unlinkSync(path, ...(args as []));
    },
    renameSync: (...args: RenameSyncArgs) => {
      renameSyncCallMock(...args);
      const [, target] = args;
      if (isDeployValidationStampPath(String(target)) || isStagingValidationStampPath(String(target))) return;
      return actual.renameSync(...args);
    },
  };
});

vi.mock("../session-manager.js", () => ({
  triggerRestartPending: triggerRestartPendingMock,
  clearRestartPending: clearRestartPendingMock,
  isRestartPending: isRestartPendingMock,
}));

vi.mock("../dependency-sync.js", () => ({
  dependencySyncHash: dependencySyncHashMock,
  DEPENDENCY_SYNC_GIT_PATHSPEC: "package.json",
  preparePatchedPackagesForInstall: preparePatchedPackagesForInstallMock,
}));

vi.mock("../release-slots.js", () => ({
  prepareReleaseSlot: prepareReleaseSlotMock,
}));

vi.mock("../platform.js", () => ({
  createDirectoryLink: createDirectoryLinkMock,
  removeDirectoryLink: removeDirectoryLinkMock,
  killProcessTree: killProcessTreeMock,
}));

vi.mock("../tunnel.js", () => ({
  buildPublicUrl: buildPublicUrlMock,
}));

vi.mock("../config.js", () => ({
  config: { web: { port: 3333 } },
}));

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createProductionDataDir(): string {
  const dataDir = createTempDir("bridge-stage-prod-");
  const db = new DatabaseSync(join(dataDir, "bridge.db"));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE schedules (
      id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL
    );
    INSERT INTO schedules (id, enabled) VALUES ('daily', 1);

    CREATE TABLE push_subscriptions (
      id TEXT PRIMARY KEY,
      endpoint TEXT NOT NULL UNIQUE,
      expirationTime INTEGER,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      userAgent TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      lastSeenAt TEXT NOT NULL
    );
    INSERT INTO push_subscriptions (
      id, endpoint, expirationTime, p256dh, auth, userAgent, createdAt, updatedAt, lastSeenAt
    ) VALUES (
      'sub-1',
      'https://push.example.test/send/sub-1',
      NULL,
      'p256dh',
      'auth',
      'agent',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z'
    );

    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT INTO settings (key, value) VALUES (
      'app',
      '{"model":"gpt-5.5","reasoningEffort":"xhigh","theme":"dark","customInstructions":"keep me"}'
    );

    CREATE TABLE mcp_servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      config TEXT NOT NULL,
      enabledByDefault INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE INDEX idx_mcp_servers_enabledByDefault ON mcp_servers(enabledByDefault);
  `);
  db.close();

  const docsDir = join(dataDir, "docs");
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(join(docsDir, "note.md"), "# docs");
  return dataDir;
}

const PREVIEW_VALIDATION_COMMANDS = [
  "npm run check:fast",
  "npm run check:pr",
] as const;
const PREVIEW_GATE_COMMAND = PREVIEW_VALIDATION_COMMANDS.join(" && ");

const DEPLOY_VALIDATION_COMMANDS = [
  "npm run check:deploy",
] as const;
const DEPLOY_SMOKE_COMMAND = "npm run preview:smoke";

function stagingStampJson(prefix: string, commitSha: string, dependencyHash = "same-hash"): string {
  return JSON.stringify({
    stagingPrefix: prefix,
    stagingCommitSha: commitSha,
    dependencyHash,
    gateId: "preview",
    gateVersion: 1,
    command: PREVIEW_GATE_COMMAND,
    source: "staging_preview",
    validatedAt: "2026-05-18T20:00:00.000Z",
  });
}

function expectIsolatedValidationEnv(env: NodeJS.ProcessEnv | undefined) {
  expect(env?.BRIDGE_DEMO_MODE).toBe("false");
  expect(env?.BRIDGE_DATA_DIR).toBeTruthy();
  expect(env?.BRIDGE_DOCS_DIR).toBeTruthy();
  expect(env?.COPILOT_HOME).toBeTruthy();
  expect(env).toMatchObject({
    GIT_PAGER: "cat",
    PAGER: "cat",
    TERM: "dumb",
    GIT_TERMINAL_PROMPT: "0",
  });
  expect(basename(env!.BRIDGE_DATA_DIR!)).toBe("data");
  expect(basename(env!.BRIDGE_DOCS_DIR!)).toBe("docs");
  expect(basename(env!.COPILOT_HOME!)).toBe(".copilot");
  expect(dirname(env!.BRIDGE_DATA_DIR!)).toBe(dirname(env!.BRIDGE_DOCS_DIR!));
  expect(dirname(env!.BRIDGE_DATA_DIR!)).toBe(dirname(env!.COPILOT_HOME!));
}

type LoadStagingToolsOptions = {
  previewParent?: string;
};

async function loadStagingToolsModule(options: LoadStagingToolsOptions = {}) {
  vi.resetModules();
  vi.stubEnv("BRIDGE_STAGING_PREVIEW_DIR", options.previewParent ?? createTempDir("bridge-stage-preview-root-"));
  return import("../staging-tools.js");
}

async function loadStagingTools(options: LoadStagingToolsOptions = {}) {
  const mod = await loadStagingToolsModule(options);
  return Object.fromEntries(mod.STAGING_TOOLS.map((tool: any) => [tool.name, tool])) as Record<string, any>;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
  triggerRestartPendingMock.mockReset();
  clearRestartPendingMock.mockReset();
  isRestartPendingMock.mockReset();
  isRestartPendingMock.mockReturnValue(false);
  dependencySyncHashMock.mockReset();
  dependencySyncHashMock.mockReturnValue("same-hash");
  prepareReleaseSlotMock.mockClear();
  existsSyncOverrideMock.mockReset();
  mockDataFilePresence();
  preparePatchedPackagesForInstallMock.mockReset();
  preparePatchedPackagesForInstallMock.mockReturnValue({
    packages: [],
    discard: vi.fn(),
    restore: vi.fn(),
  });
  createDirectoryLinkMock.mockReset();
  createDirectoryLinkMock.mockReturnValue({ ok: true, output: "" });
  removeDirectoryLinkMock.mockReset();
  removeDirectoryLinkMock.mockReturnValue({ ok: true, output: "" });
  buildPublicUrlMock.mockReset();
  buildPublicUrlMock.mockReturnValue(undefined);
  execSyncMock.mockReset();
  execSyncMock.mockReturnValue("");
  spawnMock.mockClear();
  killProcessTreeMock.mockReset();
  killProcessTreeMock.mockReturnValue({
    rootPid: 12345,
    processGroupId: 12345,
    descendantPids: [],
    trackedPids: [12345],
    killRequested: true,
  });
  writeFileSyncCallMock.mockReset();
  readFileSyncOverrideMock.mockReset();
  unlinkSyncCallMock.mockReset();
  renameSyncCallMock.mockReset();
  vi.resetModules();
});

describe("staging tools", () => {
  it("skips staging artifact management in demo mode", async () => {
    vi.stubEnv("BRIDGE_DEMO_MODE", "true");
    const mod = await loadStagingToolsModule();
    expect(mod.shouldManageStagingArtifacts()).toBe(false);
  });

  it("manages staging artifacts normally outside demo mode", async () => {
    vi.stubEnv("BRIDGE_DEMO_MODE", undefined);
    vi.stubEnv("BRIDGE_DISTRIBUTION_MODE", "development");
    const mod = await loadStagingToolsModule();
    expect(mod.shouldManageStagingArtifacts()).toBe(true);
  });

  it("skips staging artifact management in release mode", async () => {
    vi.stubEnv("BRIDGE_DEMO_MODE", undefined);
    vi.stubEnv("BRIDGE_DISTRIBUTION_MODE", "release");
    const mod = await loadStagingToolsModule();
    expect(mod.shouldManageStagingArtifacts()).toBe(false);
  });

  it("builds and parses demo preview prefixes", async () => {
    const mod = await loadStagingToolsModule();
    const stagingDir = join(tmpdir(), "bridge-staging", "abc12345");
    expect(mod.buildPreviewPrefix(stagingDir, "clone")).toBe("abc12345");
    expect(mod.buildPreviewPrefix(stagingDir, "demo")).toBe("abc12345-demo");
    expect(mod.parsePreviewPrefix("abc12345")).toEqual({ stagingName: "abc12345", profile: "clone" });
    expect(mod.parsePreviewPrefix("abc12345-demo")).toEqual({ stagingName: "abc12345", profile: "demo" });
  });

  it("keeps clone previews unambiguous when worktree names end with demo", async () => {
    const mod = await loadStagingToolsModule();
    const activeWorktrees = new Set(["foo-demo", "foo"]);
    expect(mod.parsePreviewPrefix("foo-demo", activeWorktrees)).toEqual({ stagingName: "foo-demo", profile: "clone" });
    expect(mod.parsePreviewPrefix("foo-demo-demo", activeWorktrees)).toEqual({ stagingName: "foo-demo", profile: "demo" });
  });

  it("returns null for orphaned preview prefixes when active worktrees are known", async () => {
    const mod = await loadStagingToolsModule();
    const activeWorktrees = new Set(["abc12345"]);
    expect(mod.parsePreviewPrefix("missing-demo", activeWorktrees)).toBeNull();
    expect(mod.parsePreviewPrefix("missing", activeWorktrees)).toBeNull();
  });

  it("launches staging backends through a single opaque staged entrypoint", async () => {
    const mod = await loadStagingToolsModule();
    const stagingDir = createTempDir("bridge-stage-child-entrypoint-");

    const runtimePaths = {
      demoMode: false,
      workspaceDir: join(stagingDir, "workspace"),
      dataDir: join(stagingDir, "data"),
      docsDir: join(stagingDir, "docs"),
      copilotHome: join(stagingDir, ".copilot"),
      env: {},
    };
    const spawnConfig = mod.__testing.buildStagingBackendSpawnConfig(
      stagingDir,
      runtimePaths,
      "/staging/test/api",
      { tsxLoader: "file:///tmp/tsx-loader.mjs" },
    );

    expect(spawnConfig.command).toBe(process.execPath);
    expect(spawnConfig.args).toEqual([
      "--import",
      "file:///tmp/tsx-loader.mjs",
      join(stagingDir, "src", "server", "staging-preview-server.ts"),
    ]);
    expect(spawnConfig.env.BRIDGE_STAGING_API_BASE_PATH).toBe("/staging/test/api");
    expect(spawnConfig.env.BRIDGE_STAGING_BACKEND_PORT).toBe("0");
    expect(spawnConfig.env.BRIDGE_STAGING_MODEL).toBe("claude-haiku-4.5");
    expect(spawnConfig.args.join("\n")).not.toContain("task-store.ts");
  });

  it("reseeds a staging SQLite database even when stale target files already exist", async () => {
    const mod = await loadStagingToolsModule();
    const productionDataDir = createProductionDataDir();
    const stagingDir = createTempDir("bridge-stage-staging-");
    const stagingDataDir = join(stagingDir, "data");

    mkdirSync(stagingDataDir, { recursive: true });
    writeFileSync(join(stagingDataDir, "bridge.db"), "stale");
    writeFileSync(join(stagingDataDir, "bridge.db-wal"), "stale");
    writeFileSync(join(stagingDataDir, "bridge.db-shm"), "stale");

    const seededDataDir = mod.__testing.seedStagingData(stagingDir, { productionDataDir });
    const stagingDb = new DatabaseSync(join(seededDataDir, "bridge.db"));
    try {
      const schedules = stagingDb.prepare("SELECT enabled FROM schedules").all() as Array<{ enabled: number }>;
      expect(schedules).toEqual([{ enabled: 0 }]);
      const pushSubscriptions = stagingDb.prepare("SELECT COUNT(*) AS count FROM push_subscriptions").get() as { count: number };
      expect(pushSubscriptions.count).toBe(0);
      const settingsRow = stagingDb.prepare("SELECT value FROM settings WHERE key = 'app'").get() as { value: string };
      const settings = JSON.parse(settingsRow.value) as Record<string, unknown>;
      expect(settings.model).toBe("claude-haiku-4.5");
      expect("reasoningEffort" in settings).toBe(false);
      expect(settings.theme).toBe("dark");
      expect(settings.customInstructions).toBe("keep me");
    } finally {
      stagingDb.close();
    }

    expect(existsSync(join(seededDataDir, "docs", "note.md"))).toBe(true);
  });

  it("inserts staging model settings when the production app settings row is missing", async () => {
    const mod = await loadStagingToolsModule();
    const productionDataDir = createProductionDataDir();
    const productionDb = new DatabaseSync(join(productionDataDir, "bridge.db"));
    try {
      productionDb.exec("DELETE FROM settings WHERE key = 'app'");
    } finally {
      productionDb.close();
    }
    const stagingDir = createTempDir("bridge-stage-staging-");

    const seededDataDir = mod.__testing.seedStagingData(stagingDir, { productionDataDir });
    const stagingDb = new DatabaseSync(join(seededDataDir, "bridge.db"));
    try {
      const settingsRow = stagingDb.prepare("SELECT value FROM settings WHERE key = 'app'").get() as { value: string };
      const settings = JSON.parse(settingsRow.value) as Record<string, unknown>;
      expect(settings).toEqual({ model: "claude-haiku-4.5" });
    } finally {
      stagingDb.close();
    }
  });

  it("replaces malformed production app settings JSON with staging model settings", async () => {
    const mod = await loadStagingToolsModule();
    const productionDataDir = createProductionDataDir();
    const productionDb = new DatabaseSync(join(productionDataDir, "bridge.db"));
    try {
      productionDb.prepare("UPDATE settings SET value = ? WHERE key = 'app'").run("not-json");
    } finally {
      productionDb.close();
    }
    const stagingDir = createTempDir("bridge-stage-staging-");

    const seededDataDir = mod.__testing.seedStagingData(stagingDir, { productionDataDir });
    const stagingDb = new DatabaseSync(join(seededDataDir, "bridge.db"));
    try {
      const settingsRow = stagingDb.prepare("SELECT value FROM settings WHERE key = 'app'").get() as { value: string };
      const settings = JSON.parse(settingsRow.value) as Record<string, unknown>;
      expect(settings).toEqual({ model: "claude-haiku-4.5" });
    } finally {
      stagingDb.close();
    }
  });

  it("fails explicitly when production bridge.db is missing", async () => {
    const mod = await loadStagingToolsModule();
    const productionDataDir = createTempDir("bridge-stage-missing-db-");
    const stagingDir = createTempDir("bridge-stage-staging-");

    expect(() =>
      mod.__testing.seedStagingData(stagingDir, { productionDataDir }),
    ).toThrow(/Production SQLite database not found/);
  });

  it("fails instead of file-copying when a safe SQLite snapshot cannot be created", async () => {
    const mod = await loadStagingToolsModule();
    const productionDataDir = createTempDir("bridge-stage-invalid-db-");
    writeFileSync(join(productionDataDir, "bridge.db"), "not a sqlite database");
    const stagingDir = createTempDir("bridge-stage-staging-");

    expect(() =>
      mod.__testing.seedStagingData(stagingDir, { productionDataDir }),
    ).toThrow(/Unable to create safe staging SQLite snapshot/);
    expect(existsSync(join(stagingDir, "data", "bridge.db"))).toBe(false);
  });

  it("clears restart state if staging restart signal write fails", async () => {
    const mod = await loadStagingToolsModule();
    const signalFile = join(createTempDir("bridge-stage-signal-"), "data", "restart.signal");

    writeFileSyncCallMock.mockImplementation((...args: WriteFileSyncArgs) => {
      if (isDataFilePath(String(args[0]), "restart.signal")) {
        throw new Error("disk full");
      }
    });

    expect(() => mod.__testing.writeRestartSignalOrRollback(signalFile)).toThrow(/disk full/);
    expect(triggerRestartPendingMock).toHaveBeenCalledTimes(1);
    expect(clearRestartPendingMock).toHaveBeenCalledTimes(1);
    expect(unlinkSyncCallMock.mock.calls.some(([file]) => isDataFilePath(String(file), "restart.signal"))).toBe(true);
    expect(triggerRestartPendingMock.mock.invocationCallOrder[0]).toBeLessThan(
      writeFileSyncCallMock.mock.invocationCallOrder[0],
    );
    expect(writeFileSyncCallMock.mock.invocationCallOrder[0]).toBeLessThan(
      clearRestartPendingMock.mock.invocationCallOrder[0],
    );
    expect(clearRestartPendingMock.mock.invocationCallOrder[0]).toBeLessThan(
      unlinkSyncCallMock.mock.invocationCallOrder[0],
    );
  });

  it("retries startup restore once after the first failure", async () => {
    const mod = await loadStagingToolsModule();
    const initializeBackend = vi.fn()
      .mockRejectedValueOnce(new Error("corrupt staged db"))
      .mockResolvedValueOnce(undefined);
    const log = vi.fn();
    const stagingDir = createTempDir("bridge-stage-preview-");

    const result = await mod.__testing.restoreStagingBackendWithRetry("preview-123", stagingDir, {
      initializeBackend,
      log,
    });

    expect(result).toEqual({ restored: true, attempts: 2 });
    expect(initializeBackend).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(
      "Failed to restore staged backend for preview-123 on attempt 1/2: corrupt staged db",
    );
  });

  it("returns a non-destructive failure result when the rebuild retry still fails", async () => {
    const mod = await loadStagingToolsModule();
    const initializeBackend = vi.fn().mockRejectedValue(new Error("still broken"));
    const log = vi.fn();
    const stagingDir = createTempDir("bridge-stage-preview-");

    const result = await mod.__testing.restoreStagingBackendWithRetry("preview-123", stagingDir, {
      initializeBackend,
      log,
    });

    expect(result).toEqual({ restored: false, attempts: 2, error: "still broken" });
    expect(initializeBackend).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      "Failed to restore staged backend for preview-123 on attempt 1/2: still broken",
    );
  });

  it("treats a failed staging branch snapshot as unavailable instead of empty", async () => {
    execSyncMock.mockImplementation(() => {
      throw new Error("git failed");
    });
    const mod = await loadStagingToolsModule();

    await expect(mod.__testing.listStagingBranchPrefixes()).resolves.toBeNull();
  });

  it("preserves staging worktrees and preview dirs when the branch snapshot fails", async () => {
    const mod = await loadStagingToolsModule();
    const stagingParent = createTempDir("bridge-stage-parent-");
    const stagingDistParent = createTempDir("bridge-stage-dist-");
    const prefix = "preview-123";
    const stagingDir = join(stagingParent, prefix);
    const distDir = join(stagingDistParent, prefix);
    const previewMap = new Map<string, string>();
    const removeWorktree = vi.fn();
    const pruneGitWorktrees = vi.fn();
    const log = vi.fn();

    mkdirSync(stagingDir, { recursive: true });
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(stagingDir, "keep.txt"), "keep");
    writeFileSync(join(distDir, "index.html"), "ok");

    await mod.__testing.pruneOrphanedWorktreesImpl({
      stagingParent,
      stagingDistParent,
      activePreviewMap: previewMap,
      expressApp: null,
      listBranchPrefixes: () => null,
      removeWorktree,
      pruneGitWorktrees,
      log,
    });

    expect(removeWorktree).not.toHaveBeenCalled();
    expect(pruneGitWorktrees).not.toHaveBeenCalled();
    expect(existsSync(stagingDir)).toBe(true);
    expect(existsSync(distDir)).toBe(true);
    expect(previewMap.get(prefix)).toBe(distDir);
    expect(log).toHaveBeenCalledWith(
      "Skipping orphan staging prune because the staging branch snapshot is unavailable",
    );
  });

  it("restores preview dirs from configured preview roots and legacy preview roots", async () => {
    const mod = await loadStagingToolsModule();
    const stagingParent = createTempDir("bridge-stage-parent-");
    const previewParent = createTempDir("bridge-stage-preview-root-");
    const legacyPreviewParent = createTempDir("bridge-stage-legacy-preview-root-");
    const primaryPrefix = "preview-primary";
    const legacyPrefix = "preview-legacy";
    const previewMap = new Map<string, string>();
    const pruneGitWorktrees = vi.fn();

    mkdirSync(join(stagingParent, primaryPrefix), { recursive: true });
    mkdirSync(join(stagingParent, legacyPrefix), { recursive: true });
    mkdirSync(join(previewParent, primaryPrefix), { recursive: true });
    mkdirSync(join(legacyPreviewParent, legacyPrefix), { recursive: true });

    await mod.__testing.pruneOrphanedWorktreesImpl({
      stagingParent,
      stagingPreviewParents: [previewParent, legacyPreviewParent],
      activePreviewMap: previewMap,
      expressApp: null,
      listBranchPrefixes: () => new Set([primaryPrefix, legacyPrefix]),
      pruneGitWorktrees,
    });

    expect(previewMap.get(primaryPrefix)).toBe(join(previewParent, primaryPrefix));
    expect(previewMap.get(legacyPrefix)).toBe(join(legacyPreviewParent, legacyPrefix));
    expect(pruneGitWorktrees).toHaveBeenCalledTimes(1);
  });

  it("registers surviving preview APIs for lazy restore without eagerly restoring all backends", async () => {
    vi.stubEnv("BRIDGE_STAGING_BACKEND_STARTUP_RESTORE_LIMIT", "0");
    const mod = await loadStagingToolsModule();
    const stagingParent = createTempDir("bridge-stage-parent-");
    const previewParent = createTempDir("bridge-stage-preview-root-");
    const prefix = "preview-lazy";
    const previewMap = new Map<string, string>();
    const pruneGitWorktrees = vi.fn();

    mkdirSync(join(stagingParent, prefix), { recursive: true });
    mkdirSync(join(previewParent, prefix), { recursive: true });

    await mod.__testing.pruneOrphanedWorktreesImpl({
      stagingParent,
      stagingPreviewParents: [previewParent],
      activePreviewMap: previewMap,
      expressApp: {} as any,
      listBranchPrefixes: () => new Set([prefix]),
      pruneGitWorktrees,
    });

    expect(previewMap.get(prefix)).toBe(join(previewParent, prefix));
    expect(mod.getStagingRouter(prefix)).toEqual(expect.any(Function));
  });

  it("prunes stale clean staging worktrees while preserving the newest active work", async () => {
    vi.stubEnv("BRIDGE_STAGING_BACKEND_STARTUP_RESTORE_LIMIT", "0");
    vi.stubEnv("BRIDGE_STAGING_STALE_ARTIFACT_MAX_AGE_MS", "1");
    vi.stubEnv("BRIDGE_STAGING_STALE_ARTIFACT_KEEP_RECENT", "1");
    vi.stubEnv("BRIDGE_STAGING_STALE_ARTIFACT_RECENT_GRACE_MS", "1");
    const mod = await loadStagingToolsModule();
    const stagingParent = createTempDir("bridge-stage-parent-");
    const oldPrefix = "preview-old";
    const newPrefix = "preview-new";
    const oldDir = join(stagingParent, oldPrefix);
    const newDir = join(stagingParent, newPrefix);
    const oldDate = new Date("2020-01-01T00:00:00.000Z");
    const newDate = new Date("2026-01-01T00:00:00.000Z");
    const removeWorktree = vi.fn();
    const pruneGitWorktrees = vi.fn();

    mkdirSync(oldDir, { recursive: true });
    mkdirSync(newDir, { recursive: true });
    utimesSync(oldDir, oldDate, oldDate);
    utimesSync(newDir, newDate, newDate);

    await mod.__testing.pruneOrphanedWorktreesImpl({
      stagingParent,
      stagingPreviewParents: [],
      activePreviewMap: new Map<string, string>(),
      expressApp: null,
      listBranchPrefixes: () => new Set([oldPrefix, newPrefix]),
      removeWorktree,
      pruneGitWorktrees,
    });

    expect(removeWorktree).toHaveBeenCalledWith(oldDir, `staging/${oldPrefix}`);
    expect(removeWorktree).not.toHaveBeenCalledWith(newDir, `staging/${newPrefix}`);
  });

  it("queues a restart for dependency-changing deploys without syncing production dependencies in-process", async () => {
    const mod = await loadStagingToolsModule();
    const deployTool = mod.STAGING_TOOLS.find((tool: { name: string }) => tool.name === "staging_deploy");
    if (!deployTool) throw new Error("staging_deploy tool not found");

    const stagingParent = createTempDir("bridge-stage-parent-");
    const stagingDir = join(stagingParent, "preview-deploy");
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(join(stagingDir, ".gitignore"), "node_modules\n");
    mockDataFilePresence();

    execSyncMock.mockImplementation((cmd: string, options?: { cwd?: string }) => {
      const cwd = options?.cwd;
      if (cmd === "git add -A") return "";
      if (cmd === "git --no-pager status --porcelain") return "";
      if (cmd === "git rev-parse --abbrev-ref HEAD") return "main\n";
      if (cmd === "git log main..staging/preview-deploy --oneline") return "abc123 deploy commit\n";
      if (cmd === "git stash --include-untracked") return "No local changes to save\n";
      if (cmd === "git pull --rebase origin main") return "Already up to date.\n";
      if (cmd === "git rebase main" && cwd === stagingDir) return "";
      if (DEPLOY_VALIDATION_COMMANDS.includes(cmd as (typeof DEPLOY_VALIDATION_COMMANDS)[number])) return "";
      if (cmd === "git rev-parse HEAD") return "1111111111111111111111111111111111111111\n";
      if (cmd === 'git merge "staging/preview-deploy" --no-edit') return "";
      if (cmd === 'git diff "1111111111111111111111111111111111111111" HEAD --name-only -- package.json') {
        return "package-lock.json\n";
      }
      if (cmd === "git rev-parse --short HEAD") return "2222222\n";
      if (cmd === "git push origin main") return "";
      if (cmd === `git worktree remove "${stagingDir}" --force`) return "";
      if (cmd === 'git branch -D "staging/preview-deploy"') return "";
      if (cmd === "git worktree prune") return "";
      throw new Error(`Unexpected command: ${cmd} (cwd: ${cwd ?? "unknown"})`);
    });

    const result = await deployTool.handler(
      {
        stagingDir,
        message: "Deploy dependency change",
      },
      {
        sessionId: "session-1",
        toolCallId: "tool-1",
        toolName: "staging_deploy",
        arguments: {},
      } satisfies ToolInvocation,
    ) as {
      success: boolean;
      commitSha: string;
    };

    expect(result).toMatchObject({
      success: true,
      commitSha: "2222222",
    });
    expect(triggerRestartPendingMock).toHaveBeenCalledTimes(1);
    expect(preparePatchedPackagesForInstallMock).not.toHaveBeenCalled();
    expect(dependencySyncHashMock).toHaveBeenCalledTimes(3);
    const commands = execSyncMock.mock.calls.map(([cmd]) => String(cmd));
    expect(commands).not.toContain("npm install --no-audit --no-fund --include=dev");
    expect(commands.some((cmd) => cmd.startsWith("git diff "))).toBe(true);
    expect(writeFileSyncCallMock.mock.calls.some(([file]) => isDataFilePath(String(file), "pre-deploy-sha"))).toBe(true);
    expect(renameSyncCallMock.mock.calls.some(([, file]) => isDeployValidationStampPath(String(file)))).toBe(true);
    expect(writeFileSyncCallMock.mock.calls.some(([file]) => isDataFilePath(String(file), "deps-hash"))).toBe(false);
  });

  it("uses a matching preview validation stamp to run smoke-only deploy validation", async () => {
    const mod = await loadStagingToolsModule();
    const deployTool = mod.STAGING_TOOLS.find((tool: { name: string }) => tool.name === "staging_deploy");
    if (!deployTool) throw new Error("staging_deploy tool not found");

    const stagingParent = createTempDir("bridge-stage-parent-");
    const stagingDir = join(stagingParent, "preview-deploy");
    const validatedSha = "1111111111111111111111111111111111111111";
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(join(stagingDir, ".gitignore"), "node_modules\n");
    mockDataFilePresence();
    let productionHeadCalls = 0;
    existsSyncOverrideMock.mockImplementation((path) => {
      const normalized = String(path);
      if (isStagingValidationStampPath(normalized)) return true;
      if (isDataFilePath(normalized, "restart.signal")) return false;
      if (isDataFilePath(normalized, "pre-deploy-sha")) return false;
      return undefined;
    });
    readFileSyncOverrideMock.mockImplementation((path) =>
      isStagingValidationStampPath(String(path))
        ? stagingStampJson("preview-deploy", validatedSha)
        : undefined,
    );

    execSyncMock.mockImplementation((cmd: string, options?: { cwd?: string }) => {
      const cwd = options?.cwd;
      if (cmd === "git add -A") return "";
      if (cmd === "git --no-pager status --porcelain") return "";
      if (cmd === "git rev-parse --abbrev-ref HEAD") return "main\n";
      if (cmd === "git log main..staging/preview-deploy --oneline") return "abc123 deploy commit\n";
      if (cmd === "git stash --include-untracked") return "No local changes to save\n";
      if (cmd === "git pull --rebase origin main") return "Already up to date.\n";
      if (cmd === "git rebase main" && cwd === stagingDir) return "";
      if (cmd === "git rev-parse HEAD" && cwd === stagingDir) return `${validatedSha}\n`;
      if (cmd === DEPLOY_SMOKE_COMMAND) return "smoke ok\n";
      if (cmd === "npm run check:deploy") throw new Error("full deploy gate should be skipped");
      if (cmd === "git rev-parse HEAD") {
        productionHeadCalls++;
        return productionHeadCalls === 1
          ? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n"
          : `${validatedSha}\n`;
      }
      if (cmd === 'git merge "staging/preview-deploy" --no-edit') return "";
      if (cmd === 'git diff "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" HEAD --name-only -- package.json') return "";
      if (cmd === "git rev-parse --short HEAD") return "2222222\n";
      if (cmd === "git push origin main") return "";
      if (cmd === `git worktree remove "${stagingDir}" --force`) return "";
      if (cmd === 'git branch -D "staging/preview-deploy"') return "";
      if (cmd === "git worktree prune") return "";
      throw new Error(`Unexpected command: ${cmd} (cwd: ${cwd ?? "unknown"})`);
    });

    const result = await deployTool.handler(
      { stagingDir, message: "Deploy with preview stamp" },
      {
        sessionId: "session-1",
        toolCallId: "tool-1",
        toolName: "staging_deploy",
        arguments: {},
      } satisfies ToolInvocation,
    ) as { success: boolean; commitSha: string };

    expect(result).toMatchObject({
      success: true,
      commitSha: "2222222",
    });
    const commands = execSyncMock.mock.calls.map(([cmd]) => String(cmd));
    expect(commands).toContain(DEPLOY_SMOKE_COMMAND);
    expect(commands).not.toContain("npm run check:deploy");
    expect(renameSyncCallMock.mock.calls.some(([, file]) => isDeployValidationStampPath(String(file)))).toBe(true);
    const deployStampWrite = writeFileSyncCallMock.mock.calls.find(([file]) => isDeployValidationStampPath(String(file)));
    expect(String(deployStampWrite?.[1])).toContain('"command": "npm run check:deploy"');
  });

  it("skips the deploy validation stamp if the pushed production HEAD differs from the validated staging commit", async () => {
    const mod = await loadStagingToolsModule();
    const deployTool = mod.STAGING_TOOLS.find((tool: { name: string }) => tool.name === "staging_deploy");
    if (!deployTool) throw new Error("staging_deploy tool not found");

    const stagingParent = createTempDir("bridge-stage-parent-");
    const stagingDir = join(stagingParent, "preview-deploy");
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(join(stagingDir, ".gitignore"), "node_modules\n");
    mockDataFilePresence();
    let productionHeadCalls = 0;

    execSyncMock.mockImplementation((cmd: string, options?: { cwd?: string }) => {
      const cwd = options?.cwd;
      if (cmd === "git add -A") return "";
      if (cmd === "git --no-pager status --porcelain") return "";
      if (cmd === "git rev-parse --abbrev-ref HEAD") return "main\n";
      if (cmd === "git log main..staging/preview-deploy --oneline") return "abc123 deploy commit\n";
      if (cmd === "git stash --include-untracked") return "No local changes to save\n";
      if (cmd === "git pull --rebase origin main") return "Already up to date.\n";
      if (cmd === "git rebase main" && cwd === stagingDir) return "";
      if (DEPLOY_VALIDATION_COMMANDS.includes(cmd as (typeof DEPLOY_VALIDATION_COMMANDS)[number])) return "";
      if (cmd === "git rev-parse HEAD" && cwd === stagingDir) return "1111111111111111111111111111111111111111\n";
      if (cmd === "git rev-parse HEAD") {
        productionHeadCalls++;
        return productionHeadCalls === 1
          ? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n"
          : "2222222222222222222222222222222222222222\n";
      }
      if (cmd === 'git merge "staging/preview-deploy" --no-edit') return "";
      if (cmd === 'git diff "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" HEAD --name-only -- package.json') return "";
      if (cmd === "git rev-parse --short HEAD") return "2222222\n";
      if (cmd === "git push origin main") return "";
      if (cmd === `git worktree remove "${stagingDir}" --force`) return "";
      if (cmd === 'git branch -D "staging/preview-deploy"') return "";
      if (cmd === "git worktree prune") return "";
      throw new Error(`Unexpected command: ${cmd} (cwd: ${cwd ?? "unknown"})`);
    });

    const result = await deployTool.handler(
      { stagingDir, message: "Deploy dependency change" },
      {
        sessionId: "session-1",
        toolCallId: "tool-1",
        toolName: "staging_deploy",
        arguments: {},
      } satisfies ToolInvocation,
    ) as {
      success: boolean;
      commitSha: string;
    };

    expect(result).toMatchObject({
      success: true,
      commitSha: "2222222",
    });
    expect(renameSyncCallMock.mock.calls.some(([, file]) => isDeployValidationStampPath(String(file)))).toBe(false);
    expect(triggerRestartPendingMock).toHaveBeenCalledTimes(1);
  });

  it("blocks restart when deploy validation fails on the rebased staging tree", async () => {
    const mod = await loadStagingToolsModule();
    const deployTool = mod.STAGING_TOOLS.find((tool: { name: string }) => tool.name === "staging_deploy");
    if (!deployTool) throw new Error("staging_deploy tool not found");

    const stagingParent = createTempDir("bridge-stage-parent-");
    const stagingDir = join(stagingParent, "preview-deploy");
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(join(stagingDir, ".gitignore"), "node_modules\n");
    mockDataFilePresence();

    execSyncMock.mockImplementation((cmd: string, options?: { cwd?: string }) => {
      const cwd = options?.cwd;
      if (cmd === "git add -A") return "";
      if (cmd === "git --no-pager status --porcelain") return "";
      if (cmd === "git rev-parse --abbrev-ref HEAD") return "main\n";
      if (cmd === "git log main..staging/preview-deploy --oneline") return "abc123 deploy commit\n";
      if (cmd === "git stash --include-untracked") return "No local changes to save\n";
      if (cmd === "git pull --rebase origin main") return "Already up to date.\n";
      if (cmd === "git rebase main" && cwd === stagingDir) return "";
      if (cmd === "npm run check:deploy") {
        const error = new Error("deploy gate failed") as Error & { stderr: string };
        error.stderr = "deploy gate exploded\n";
        throw error;
      }
      if (DEPLOY_VALIDATION_COMMANDS.includes(cmd as (typeof DEPLOY_VALIDATION_COMMANDS)[number])) return "";
      throw new Error(`Unexpected command: ${cmd} (cwd: ${cwd ?? "unknown"})`);
    });

    const result = await deployTool.handler(
      { stagingDir, message: "Deploy dependency change" },
      {
        sessionId: "session-1",
        toolCallId: "tool-1",
        toolName: "staging_deploy",
        arguments: {},
      } satisfies ToolInvocation,
    ) as any;

    expect(result).toMatchObject({
      resultType: "failure",
      sessionLog: expect.stringContaining("Command: npm run check:deploy"),
      toolTelemetry: {
        command: "npm run check:deploy",
        cwd: stagingDir,
        stagingDir,
        prodBranch: "main",
        validationLogPath: expect.stringContaining("validation-logs"),
      },
    });
    expect(result.textResultForLlm).toContain("Staging deploy validation failed.");
    expect(result.textResultForLlm).toContain("deploy validation gate");
    expect(result.textResultForLlm).toContain("retry-after-fix");
    expect(result.textResultForLlm).toContain("deploy gate exploded");
    expect(writeFileSyncCallMock.mock.calls.some(([file]) => isDataFilePath(String(file), "pre-deploy-sha"))).toBe(false);
    expect(writeFileSyncCallMock.mock.calls.some(([file]) => isDataFilePath(String(file), "restart.signal"))).toBe(false);
    expect(triggerRestartPendingMock).not.toHaveBeenCalled();
    expect(execSyncMock.mock.calls.map(([cmd]) => String(cmd))).not.toContain('git merge "staging/preview-deploy" --no-edit');
  });

  it("blocks restart when pushing the merged production branch fails", async () => {
    const mod = await loadStagingToolsModule();
    const deployTool = mod.STAGING_TOOLS.find((tool: { name: string }) => tool.name === "staging_deploy");
    if (!deployTool) throw new Error("staging_deploy tool not found");

    const stagingParent = createTempDir("bridge-stage-parent-");
    const stagingDir = join(stagingParent, "preview-deploy");
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(join(stagingDir, ".gitignore"), "node_modules\n");
    mockDataFilePresence();

    let pushAttempts = 0;
    execSyncMock.mockImplementation((cmd: string, options?: { cwd?: string }) => {
      const cwd = options?.cwd;
      if (cmd === "git add -A") return "";
      if (cmd === "git --no-pager status --porcelain") return "";
      if (cmd === "git rev-parse --abbrev-ref HEAD") return "main\n";
      if (cmd === "git log main..staging/preview-deploy --oneline") return "abc123 deploy commit\n";
      if (cmd === "git stash --include-untracked") return "No local changes to save\n";
      if (cmd === "git pull --rebase origin main") return "Already up to date.\n";
      if (cmd === "git rebase main" && cwd === stagingDir) return "";
      if (DEPLOY_VALIDATION_COMMANDS.includes(cmd as (typeof DEPLOY_VALIDATION_COMMANDS)[number])) return "";
      if (cmd === "git rev-parse HEAD") return "1111111111111111111111111111111111111111\n";
      if (cmd === 'git merge "staging/preview-deploy" --no-edit') return "";
      if (cmd === 'git diff "1111111111111111111111111111111111111111" HEAD --name-only -- package.json') return "";
      if (cmd === "git rev-parse --short HEAD") return "2222222\n";
      if (cmd === "git push origin main") {
        pushAttempts += 1;
        const error = new Error("push failed") as Error & { stderr: string };
        error.stderr = `push rejected ${pushAttempts}\n`;
        throw error;
      }
      if (cmd === "git reset --hard 1111111111111111111111111111111111111111") return "";
      throw new Error(`Unexpected command: ${cmd} (cwd: ${cwd ?? "unknown"})`);
    });

    const result = await deployTool.handler(
      { stagingDir, message: "Deploy dependency change" },
      {
        sessionId: "session-1",
        toolCallId: "tool-1",
        toolName: "staging_deploy",
        arguments: {},
      } satisfies ToolInvocation,
    ) as any;

    expect(result).toMatchObject({
      resultType: "failure",
      sessionLog: expect.stringContaining("Command: git push origin main"),
      toolTelemetry: {
        command: "git push origin main",
        stagingDir,
        prodBranch: "main",
        commitSha: "2222222",
        revertedTo: "1111111111111111111111111111111111111111",
        validationLogPath: expect.stringContaining("validation-logs"),
      },
    });
    expect(result.textResultForLlm).toContain("Push to origin failed; production merge reverted and restart blocked.");
    expect(result.textResultForLlm).toContain("reset back to 1111111111111111111111111111111111111111");
    expect(result.textResultForLlm).toContain("push rejected 2");
    expect(pushAttempts).toBe(2);
    expect(triggerRestartPendingMock).not.toHaveBeenCalled();
    expect(writeFileSyncCallMock.mock.calls.some(([file]) => isDataFilePath(String(file), "restart.signal"))).toBe(false);
    expect(writeFileSyncCallMock.mock.calls.some(([file]) => isDataFilePath(String(file), "pre-deploy-sha"))).toBe(true);
    expect(unlinkSyncCallMock.mock.calls.some(([file]) => isDataFilePath(String(file), "pre-deploy-sha"))).toBe(true);
    expect(execSyncMock.mock.calls.map(([cmd]) => String(cmd))).toContain("git reset --hard 1111111111111111111111111111111111111111");
    expect(execSyncMock.mock.calls.map(([cmd]) => String(cmd))).not.toContain(`git worktree remove "${stagingDir}" --force`);
  });

  it("aborts a failed push-retry rebase before resetting production", async () => {
    const mod = await loadStagingToolsModule();
    const deployTool = mod.STAGING_TOOLS.find((tool: { name: string }) => tool.name === "staging_deploy");
    if (!deployTool) throw new Error("staging_deploy tool not found");

    const stagingParent = createTempDir("bridge-stage-parent-");
    const stagingDir = join(stagingParent, "preview-deploy");
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(join(stagingDir, ".gitignore"), "node_modules\n");
    mockDataFilePresence();

    let pullAttempts = 0;
    execSyncMock.mockImplementation((cmd: string, options?: { cwd?: string }) => {
      const cwd = options?.cwd;
      if (cmd === "git add -A") return "";
      if (cmd === "git --no-pager status --porcelain") return "";
      if (cmd === "git rev-parse --abbrev-ref HEAD") return "main\n";
      if (cmd === "git log main..staging/preview-deploy --oneline") return "abc123 deploy commit\n";
      if (cmd === "git stash --include-untracked") return "No local changes to save\n";
      if (cmd === "git pull --rebase origin main") {
        pullAttempts += 1;
        if (pullAttempts === 1) return "Already up to date.\n";
        const error = new Error("rebase conflict") as Error & { stderr: string };
        error.stderr = "CONFLICT (content): rebase stopped\n";
        throw error;
      }
      if (cmd === "git rebase main" && cwd === stagingDir) return "";
      if (DEPLOY_VALIDATION_COMMANDS.includes(cmd as (typeof DEPLOY_VALIDATION_COMMANDS)[number])) return "";
      if (cmd === "git rev-parse HEAD") return "1111111111111111111111111111111111111111\n";
      if (cmd === 'git merge "staging/preview-deploy" --no-edit') return "";
      if (cmd === 'git diff "1111111111111111111111111111111111111111" HEAD --name-only -- package.json') return "";
      if (cmd === "git rev-parse --short HEAD") return "2222222\n";
      if (cmd === "git push origin main") {
        const error = new Error("push failed") as Error & { stderr: string };
        error.stderr = "push rejected\n";
        throw error;
      }
      if (cmd === "git rebase --abort") return "";
      if (cmd === "git reset --hard 1111111111111111111111111111111111111111") return "";
      throw new Error(`Unexpected command: ${cmd} (cwd: ${cwd ?? "unknown"})`);
    });

    const result = await deployTool.handler(
      { stagingDir, message: "Deploy dependency change" },
      {
        sessionId: "session-1",
        toolCallId: "tool-1",
        toolName: "staging_deploy",
        arguments: {},
      } satisfies ToolInvocation,
    ) as any;

    expect(result).toMatchObject({ resultType: "failure" });
    expect(triggerRestartPendingMock).not.toHaveBeenCalled();
    const commands = execSyncMock.mock.calls.map(([cmd]) => String(cmd));
    const abortIndex = commands.indexOf("git rebase --abort");
    const resetIndex = commands.indexOf("git reset --hard 1111111111111111111111111111111111111111");
    expect(abortIndex).toBeGreaterThan(-1);
    expect(resetIndex).toBeGreaterThan(abortIndex);
    expect(commands).not.toContain(`git worktree remove "${stagingDir}" --force`);
  });

  it("rejects staging_deploy when restart is already pending via restart state", async () => {
    isRestartPendingMock.mockReturnValue(true);
    mockDataFilePresence({ restartSignal: false });

    const mod = await loadStagingToolsModule();
    const deployTool = mod.STAGING_TOOLS.find((tool: { name: string }) => tool.name === "staging_deploy");
    if (!deployTool) throw new Error("staging_deploy tool not found");

    const stagingParent = createTempDir("bridge-stage-parent-");
    const stagingDir = join(stagingParent, "preview-deploy");
    mkdirSync(stagingDir, { recursive: true });

    const result = await deployTool.handler(
      { stagingDir, message: "Should be rejected" },
      {
        sessionId: "session-1",
        toolCallId: "tool-1",
        toolName: "staging_deploy",
        arguments: {},
      } satisfies ToolInvocation,
    ) as {
      resultType: string;
      textResultForLlm: string;
    };

    expect(result.resultType).toBe("failure");
    expect(result.textResultForLlm).toContain("A restart is already pending");
    expect(triggerRestartPendingMock).not.toHaveBeenCalled();
    expect(writeFileSyncCallMock.mock.calls.some(([file]) => isDataFilePath(String(file), "restart.signal"))).toBe(false);
  });

  it("preserves an existing rollback checkpoint during deploy", async () => {
    const mod = await loadStagingToolsModule();
    const deployTool = mod.STAGING_TOOLS.find((tool: { name: string }) => tool.name === "staging_deploy");
    if (!deployTool) throw new Error("staging_deploy tool not found");

    const stagingParent = createTempDir("bridge-stage-parent-");
    const stagingDir = join(stagingParent, "preview-deploy");
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(join(stagingDir, ".gitignore"), "node_modules\n");
    mockDataFilePresence({ preDeploySha: true });
    readFileSyncOverrideMock.mockImplementation((path) =>
      isDataFilePath(String(path), "pre-deploy-sha") ? "preserved-checkpoint\n" : undefined,
    );

    execSyncMock.mockImplementation((cmd: string, options?: { cwd?: string }) => {
      const cwd = options?.cwd;
      if (cmd === "git add -A") return "";
      if (cmd === "git --no-pager status --porcelain") return "";
      if (cmd === "git rev-parse --abbrev-ref HEAD") return "main\n";
      if (cmd === "git log main..staging/preview-deploy --oneline") return "abc123 deploy commit\n";
      if (cmd === "git stash --include-untracked") return "No local changes to save\n";
      if (cmd === "git pull --rebase origin main") return "Already up to date.\n";
      if (cmd === "git rebase main" && cwd === stagingDir) return "";
      if (DEPLOY_VALIDATION_COMMANDS.includes(cmd as (typeof DEPLOY_VALIDATION_COMMANDS)[number])) return "";
      if (cmd === "git rev-parse HEAD") return "1111111111111111111111111111111111111111\n";
      if (cmd === 'git merge "staging/preview-deploy" --no-edit') return "";
      if (cmd === 'git diff "1111111111111111111111111111111111111111" HEAD --name-only -- package.json') return "";
      if (cmd === "git rev-parse --short HEAD") return "2222222\n";
      if (cmd === "git push origin main") return "";
      if (cmd === `git worktree remove "${stagingDir}" --force`) return "";
      if (cmd === 'git branch -D "staging/preview-deploy"') return "";
      if (cmd === "git worktree prune") return "";
      throw new Error(`Unexpected command: ${cmd} (cwd: ${cwd ?? "unknown"})`);
    });

    await deployTool.handler(
      { stagingDir, message: "Deploy dependency change" },
      {
        sessionId: "session-1",
        toolCallId: "tool-1",
        toolName: "staging_deploy",
        arguments: {},
      } satisfies ToolInvocation,
    );

    expect(
      writeFileSyncCallMock.mock.calls.some(([file]) => isDataFilePath(String(file), "pre-deploy-sha")),
    ).toBe(false);
    expect(unlinkSyncCallMock.mock.calls.some(([file]) => isDataFilePath(String(file), "pre-deploy-sha"))).toBe(false);
  });

  it("only removes rollback checkpoints created by the current deploy attempt", async () => {
    const mod = await loadStagingToolsModule();
    const deployTool = mod.STAGING_TOOLS.find((tool: { name: string }) => tool.name === "staging_deploy");
    if (!deployTool) throw new Error("staging_deploy tool not found");

    const stagingParent = createTempDir("bridge-stage-parent-");
    const stagingDir = join(stagingParent, "preview-deploy");
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(join(stagingDir, ".gitignore"), "node_modules\n");
    mockDataFilePresence();

    execSyncMock.mockImplementation((cmd: string, options?: { cwd?: string }) => {
      const cwd = options?.cwd;
      if (cmd === "git add -A") return "";
      if (cmd === "git --no-pager status --porcelain") return "";
      if (cmd === "git rev-parse --abbrev-ref HEAD") return "main\n";
      if (cmd === "git log main..staging/preview-deploy --oneline") return "abc123 deploy commit\n";
      if (cmd === "git stash --include-untracked") return "No local changes to save\n";
      if (cmd === "git pull --rebase origin main") return "Already up to date.\n";
      if (cmd === "git rebase main" && cwd === stagingDir) return "";
      if (DEPLOY_VALIDATION_COMMANDS.includes(cmd as (typeof DEPLOY_VALIDATION_COMMANDS)[number])) return "";
      if (cmd === "git rev-parse HEAD") return "1111111111111111111111111111111111111111\n";
      if (cmd === 'git merge "staging/preview-deploy" --no-edit') throw new Error("merge failed");
      if (cmd === "git merge --abort") return "";
      throw new Error(`Unexpected command: ${cmd} (cwd: ${cwd ?? "unknown"})`);
    });

    await deployTool.handler(
      { stagingDir, message: "Deploy dependency change" },
      {
        sessionId: "session-1",
        toolCallId: "tool-1",
        toolName: "staging_deploy",
        arguments: {},
      } satisfies ToolInvocation,
    );

    expect(
      writeFileSyncCallMock.mock.calls.some(([file]) => isDataFilePath(String(file), "pre-deploy-sha")),
    ).toBe(true);
    expect(unlinkSyncCallMock.mock.calls.some(([file]) => isDataFilePath(String(file), "pre-deploy-sha"))).toBe(true);

    writeFileSyncCallMock.mockClear();
    unlinkSyncCallMock.mockClear();
    mockDataFilePresence({ preDeploySha: true });
    readFileSyncOverrideMock.mockImplementation((path) =>
      isDataFilePath(String(path), "pre-deploy-sha") ? "preserved-checkpoint\n" : undefined,
    );

    await deployTool.handler(
      { stagingDir, message: "Deploy dependency change" },
      {
        sessionId: "session-2",
        toolCallId: "tool-2",
        toolName: "staging_deploy",
        arguments: {},
      } satisfies ToolInvocation,
    );

    expect(
      writeFileSyncCallMock.mock.calls.some(([file]) => isDataFilePath(String(file), "pre-deploy-sha")),
    ).toBe(false);
    expect(unlinkSyncCallMock.mock.calls.some(([file]) => isDataFilePath(String(file), "pre-deploy-sha"))).toBe(false);
  });

  it("returns a normalized failure result when staging_init cannot create a branch", async () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd === "git rev-parse --abbrev-ref HEAD") return "main\n";
      if (cmd === "git pull --rebase origin main") return "Already up to date.\n";
      if (cmd.startsWith('git branch "staging/')) {
        const error = new Error("branch exists") as Error & { stderr: string };
        error.stderr = "fatal: a branch named staging/test already exists\n";
        throw error;
      }
      return "";
    });

    const tools = await loadStagingTools();
    const result = await tools.staging_init.handler(
      {},
      {
        sessionId: "session-1",
        toolCallId: "tool-1",
        toolName: "staging_init",
        arguments: {},
      } satisfies ToolInvocation,
    ) as any;

    expect(result).toMatchObject({
      resultType: "failure",
      sessionLog: expect.stringContaining("Command: git branch"),
      toolTelemetry: {
        command: expect.stringContaining('git branch "staging/'),
        cwd: expect.any(String),
      },
    });
    expect(result.textResultForLlm).toContain("Failed to create staging branch.");
    expect(result.textResultForLlm).toContain("Failed to create branch staging/");
    expect(result.textResultForLlm).toContain("fatal: a branch named staging/test already exists");
    expect(result).not.toHaveProperty("error");
  });

  it("returns a normalized failure result when staging_preview validation fails", async () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd === "npm run check:pr") {
        const error = new Error("PR gate failed") as Error & { stderr: string };
        error.stderr = "FAIL src/server/__tests__/staging-tools.test.ts\n1 failed\n";
        throw error;
      }
      return "";
    });

    const tools = await loadStagingTools();
    const stagingDir = createTempDir("bridge-stage-preview-");
    const result = await tools.staging_preview.handler(
      { stagingDir },
      {
        sessionId: "session-1",
        toolCallId: "tool-1",
        toolName: "staging_preview",
        arguments: {},
      } satisfies ToolInvocation,
    ) as any;

    expect(result).toMatchObject({
      resultType: "failure",
      sessionLog: expect.stringContaining("Command: npm run check:pr"),
      toolTelemetry: {
        command: "npm run check:pr",
        cwd: stagingDir,
        stagingDir,
      },
    });
    expect(result.textResultForLlm).toContain("Staging preview validation failed.");
    expect(result.textResultForLlm).toContain("The staged changes did not pass the preview validation gate.");
    expect(result.textResultForLlm).toContain("1 failed");
    expect(result.textResultForLlm).toContain("Full command output:");
    expect(result).not.toHaveProperty("error");
  });

  it("caps noisy staging command output while preserving the diagnostic tail", async () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd === "npm run check:pr") {
        const error = new Error("PR gate failed") as Error & { stderr: string };
        error.stderr = "dropped-prefix\n" + "x".repeat(1024 * 1024 + 100) + "\nkept-tail-marker\n";
        throw error;
      }
      return "";
    });

    const tools = await loadStagingTools();
    const stagingDir = createTempDir("bridge-stage-preview-noisy-");
    const result = await tools.staging_preview.handler(
      { stagingDir },
      {
        sessionId: "session-1",
        toolCallId: "tool-1",
        toolName: "staging_preview",
        arguments: {},
      } satisfies ToolInvocation,
    ) as any;

    expect(result).toMatchObject({
      resultType: "failure",
      toolTelemetry: {
        command: "npm run check:pr",
        cwd: stagingDir,
        stagingDir,
      },
    });
    expect(result.textResultForLlm).toContain("kept-tail-marker");
    expect(result.textResultForLlm).toContain("stderr truncated: kept last");
    expect(result.textResultForLlm).not.toContain("dropped-prefix");
  });

  it("fails staging_preview when dependency installation fails instead of relinking production modules", async () => {
    const tools = await loadStagingTools();
    const stagingDir = createTempDir("bridge-stage-preview-deps-");
    dependencySyncHashMock.mockImplementation((path: string) => String(path) === stagingDir ? "staging-hash" : "prod-hash");
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd === "npm install --no-audit --no-fund --include=dev") {
        const error = new Error("install failed") as Error & { stderr: string };
        error.stderr = "npm ERR! install exploded\n";
        throw error;
      }
      return "";
    });

    const result = await tools.staging_preview.handler(
      { stagingDir },
      {
        sessionId: "session-1",
        toolCallId: "tool-1",
        toolName: "staging_preview",
        arguments: {},
      } satisfies ToolInvocation,
    ) as any;

    expect(result).toMatchObject({
      resultType: "failure",
      sessionLog: expect.stringContaining("Command: npm install --no-audit --no-fund --include=dev"),
      toolTelemetry: {
        command: "npm install --no-audit --no-fund --include=dev",
        cwd: stagingDir,
        stagingDir,
      },
    });
    expect(result.textResultForLlm).toContain("Staging dependency install failed.");
    expect(result.textResultForLlm).toContain("Fix the staging worktree dependencies and retry.");
    expect(result.textResultForLlm).toContain("npm ERR! install exploded");
    expect(createDirectoryLinkMock).not.toHaveBeenCalled();
    expect(execSyncMock.mock.calls.map(([cmd]) => String(cmd))).not.toContain("npm run test:xplat-audit");
  });

  it("allows a longer timeout for staging_preview validation runs", async () => {
    const tools = await loadStagingTools();
    const stagingDir = createTempDir("bridge-stage-preview-timeout-");

    await tools.staging_preview.handler(
      { stagingDir },
      {
        sessionId: "session-1",
        toolCallId: "tool-1",
        toolName: "staging_preview",
        arguments: {},
      } satisfies ToolInvocation,
    );

    const previewValidationCalls = execSyncMock.mock.calls.filter(([cmd]) =>
      PREVIEW_VALIDATION_COMMANDS.includes(String(cmd) as (typeof PREVIEW_VALIDATION_COMMANDS)[number]),
    );

    expect(previewValidationCalls).toHaveLength(PREVIEW_VALIDATION_COMMANDS.length);
    expect(previewValidationCalls.every(([, options]) => options?.cwd === stagingDir)).toBe(true);
    const previewValidationSpawnCalls = spawnMock.mock.calls.filter(([cmd]) =>
      PREVIEW_VALIDATION_COMMANDS.includes(String(cmd) as (typeof PREVIEW_VALIDATION_COMMANDS)[number]),
    );
    expect(previewValidationSpawnCalls.every(([, options]) =>
      options?.cwd === stagingDir && options?.shell === true && options?.windowsHide === true,
    )).toBe(true);
    for (const [, options] of previewValidationSpawnCalls) {
      expectIsolatedValidationEnv(options?.env);
    }
  });

  it("writes a staging validation stamp after successful staging_preview validation", async () => {
    const commitSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd === "git rev-parse HEAD") return `${commitSha}\n`;
      return "";
    });
    const tools = await loadStagingTools();
    const stagingDir = createTempDir("bridge-stage-preview-stamp-");
    const prefix = basename(stagingDir);

    await tools.staging_preview.handler(
      { stagingDir },
      {
        sessionId: "session-1",
        toolCallId: "tool-1",
        toolName: "staging_preview",
        arguments: {},
      } satisfies ToolInvocation,
    );

    const stampWrite = writeFileSyncCallMock.mock.calls.find(([file]) =>
      isStagingValidationStampPath(String(file)),
    );
    expect(String(stampWrite?.[1])).toContain(`"stagingPrefix": "${prefix}"`);
    expect(String(stampWrite?.[1])).toContain(`"stagingCommitSha": "${commitSha}"`);
    expect(String(stampWrite?.[1])).toContain(`"command": "${PREVIEW_GATE_COMMAND}"`);
    expect(renameSyncCallMock.mock.calls.some(([, target]) =>
      isStagingValidationStampPath(String(target)),
    )).toBe(true);
  });

  it("skips staging_preview validation when validate is false", async () => {
    const tools = await loadStagingTools();
    const stagingDir = createTempDir("bridge-stage-preview-smoke-");

    await tools.staging_preview.handler(
      { stagingDir, validate: false },
      {
        sessionId: "session-1",
        toolCallId: "tool-1",
        toolName: "staging_preview",
        arguments: {},
      } satisfies ToolInvocation,
    );

    const commands = execSyncMock.mock.calls.map(([cmd]) => String(cmd));
    expect(commands.every((cmd) => !PREVIEW_VALIDATION_COMMANDS.includes(cmd as (typeof PREVIEW_VALIDATION_COMMANDS)[number]))).toBe(true);
    expect(commands.some((cmd) => cmd.startsWith("npx vite build --base"))).toBe(true);
    expect(renameSyncCallMock.mock.calls.some(([, target]) =>
      isStagingValidationStampPath(String(target)),
    )).toBe(false);
  });

  it("builds previews under the configured runtime preview root", async () => {
    const previewParent = createTempDir("bridge-stage-preview-root-");
    const tools = await loadStagingTools({ previewParent });
    const stagingDir = createTempDir("bridge-stage-preview-rooted-");
    const prefix = basename(stagingDir);

    await tools.staging_preview.handler(
      { stagingDir, validate: false },
      {
        sessionId: "session-1",
        toolCallId: "tool-1",
        toolName: "staging_preview",
        arguments: {},
      } satisfies ToolInvocation,
    );

    const commands = execSyncMock.mock.calls.map(([cmd]) => String(cmd));
    expect(commands).toContain(
      `npx vite build --base "/staging/${prefix}/" --outDir "${join(previewParent, prefix)}" --emptyOutDir`,
    );
    expect(commands.join("\n")).not.toContain(join("dist", "staging"));
  });

  it("returns a normalized failure result when staging_deploy hits a rebase conflict", async () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd === "git add -A") return "";
      if (cmd === "git --no-pager status --porcelain") return "";
      if (cmd === "git rev-parse --abbrev-ref HEAD") return "main\n";
      if (cmd.startsWith("git log main..staging/") && cmd.endsWith(" --oneline")) return "abc123 staged change\n";
      if (cmd === "git stash --include-untracked") return "No local changes to save\n";
      if (cmd === "git pull --rebase origin main") return "Already up to date.\n";
      if (cmd === "git rebase main") {
        const error = new Error("conflict") as Error & { stderr: string };
        error.stderr = "CONFLICT (content): Merge conflict in src/server/staging-tools.ts\n";
        throw error;
      }
      if (cmd === "git rebase --abort") return "";
      return "";
    });

    const tools = await loadStagingTools();
    const stagingDir = createTempDir("bridge-stage-deploy-");
    const result = await tools.staging_deploy.handler(
      {
        stagingDir,
        message: "Test deploy",
      },
      {
        sessionId: "session-1",
        toolCallId: "tool-1",
        toolName: "staging_deploy",
        arguments: {},
      } satisfies ToolInvocation,
    ) as any;

    expect(result).toMatchObject({
      resultType: "failure",
      sessionLog: expect.stringContaining("Command: git rebase main"),
      toolTelemetry: {
        command: "git rebase main",
        cwd: stagingDir,
        stagingDir,
        prodBranch: "main",
      },
    });
    expect(result.textResultForLlm).toContain("Staging branch conflicts with production.");
    expect(result.textResultForLlm).toContain("The rebase has been aborted and your staging worktree is intact.");
    expect(result.textResultForLlm).toContain("Call staging_deploy again");
    expect(result.textResultForLlm).toContain("CONFLICT (content)");
    expect(result).not.toHaveProperty("error");
  });

  it("runs deploy validation before writing the checkpoint, merging, pushing, or signaling restart", async () => {
    const mod = await loadStagingToolsModule();
    const deployTool = mod.STAGING_TOOLS.find((tool: { name: string }) => tool.name === "staging_deploy");
    if (!deployTool) throw new Error("staging_deploy tool not found");

    const stagingParent = createTempDir("bridge-stage-ordering-");
    const stagingDir = join(stagingParent, "preview-ordering");
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(join(stagingDir, ".gitignore"), "node_modules\n");
    mockDataFilePresence();

    execSyncMock.mockImplementation((cmd: string, options?: { cwd?: string }) => {
      const cwd = options?.cwd;
      if (cmd === "git add -A") return "";
      if (cmd === "git --no-pager status --porcelain") return "";
      if (cmd === "git rev-parse --abbrev-ref HEAD") return "main\n";
      if (cmd === "git log main..staging/preview-ordering --oneline") return "abc123 deploy commit\n";
      if (cmd === "git stash --include-untracked") return "No local changes to save\n";
      if (cmd === "git pull --rebase origin main") return "Already up to date.\n";
      if (cmd === "git rebase main" && cwd === stagingDir) return "";
      if (DEPLOY_VALIDATION_COMMANDS.includes(cmd as (typeof DEPLOY_VALIDATION_COMMANDS)[number])) return "";
      if (cmd === "git rev-parse HEAD") return "aaaa000000000000000000000000000000000000\n";
      if (cmd === 'git merge "staging/preview-ordering" --no-edit') return "";
      if (cmd === 'git diff "aaaa000000000000000000000000000000000000" HEAD --name-only -- package.json') return "";
      if (cmd === "git rev-parse --short HEAD") return "aaaa000\n";
      if (cmd === "git push origin main") return "";
      if (cmd === `git worktree remove "${stagingDir}" --force`) return "";
      if (cmd === 'git branch -D "staging/preview-ordering"') return "";
      if (cmd === "git worktree prune") return "";
      throw new Error(`Unexpected command: ${cmd} (cwd: ${cwd ?? "unknown"})`);
    });

    const result = await deployTool.handler(
      { stagingDir, message: "Ordering check" },
      {
        sessionId: "session-order",
        toolCallId: "tool-order",
        toolName: "staging_deploy",
        arguments: {},
      } satisfies ToolInvocation,
    ) as { success: boolean };

    expect(result.success).toBe(true);

    const commands = execSyncMock.mock.calls.map(([cmd]) => String(cmd));
    const mergeIndex = commands.indexOf('git merge "staging/preview-ordering" --no-edit');
    const pushIndex = commands.indexOf("git push origin main");
    expect(mergeIndex).toBeGreaterThan(-1);
    expect(pushIndex).toBeGreaterThan(mergeIndex);

    // Every deploy validation command must appear before the merge
    for (const validationCmd of DEPLOY_VALIDATION_COMMANDS) {
      const idx = commands.indexOf(validationCmd);
      expect(idx, `${validationCmd} must appear before git merge`).toBeGreaterThan(-1);
      expect(idx, `${validationCmd} must appear before git merge`).toBeLessThan(mergeIndex);
    }
    const deployValidationSpawnCalls = spawnMock.mock.calls.filter(([cmd]) =>
      DEPLOY_VALIDATION_COMMANDS.includes(String(cmd) as (typeof DEPLOY_VALIDATION_COMMANDS)[number]),
    );
    expect(deployValidationSpawnCalls).toHaveLength(DEPLOY_VALIDATION_COMMANDS.length);
    for (const [, options] of deployValidationSpawnCalls) {
      expectIsolatedValidationEnv(options?.env);
    }

    // pre-deploy-sha checkpoint must be written before restart.signal
    const writtenPaths = writeFileSyncCallMock.mock.calls.map(([file]) => String(file));
    const checkpointWriteIndex = writtenPaths.findIndex((p) => isDataFilePath(p, "pre-deploy-sha"));
    const signalWriteIndex = writtenPaths.findIndex((p) => isDataFilePath(p, "restart.signal"));
    expect(checkpointWriteIndex, "pre-deploy-sha must be written").toBeGreaterThan(-1);
    expect(signalWriteIndex, "restart.signal must be written").toBeGreaterThan(-1);
    expect(checkpointWriteIndex).toBeLessThan(signalWriteIndex);
    expect(triggerRestartPendingMock.mock.invocationCallOrder[0]).toBeLessThan(
      writeFileSyncCallMock.mock.invocationCallOrder[signalWriteIndex],
    );
  });
});
