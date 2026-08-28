import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import express from "express";
import request from "./test-http.js";
import { advanceTimersAndSettle } from "./helpers.js";

type ExistsSyncPath = Parameters<typeof import("node:fs").existsSync>[0];
type WriteFileSyncArgs = Parameters<typeof import("node:fs").writeFileSync>;
type ReadFileSyncPath = Parameters<typeof import("node:fs").readFileSync>[0];
type UnlinkSyncPath = Parameters<typeof import("node:fs").unlinkSync>[0];
type MkdirSyncArgs = Parameters<typeof import("node:fs").mkdirSync>;
type RenameSyncArgs = Parameters<typeof import("node:fs").renameSync>;
type RmSyncArgs = Parameters<typeof import("node:fs").rmSync>;
type StatSyncPath = Parameters<typeof import("node:fs").statSync>[0];
type MockSpawnOptions = { cwd?: string; env?: NodeJS.ProcessEnv; shell?: boolean; windowsHide?: boolean };
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
    });

    return child;
  });
});
const triggerRestartPendingMock = vi.fn();
const clearRestartPendingMock = vi.fn();
const isRestartPendingMock = vi.hoisted(() => vi.fn(() => false));
const dependencySyncHashMock = vi.fn<(path: string) => string>(() => "same-hash");
const readInstalledDependencyHashMock = vi.fn<(dataDir: string) => string | undefined>(() => undefined);
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
const lstatSyncOverrideMock = vi.hoisted(() => vi.fn<(path: unknown) => { isSymbolicLink(): boolean } | undefined>());
const writeFileSyncCallMock = vi.hoisted(() => vi.fn<(...args: WriteFileSyncArgs) => void>());
const renameSyncCallMock = vi.hoisted(() => vi.fn<(...args: RenameSyncArgs) => void>());
const readFileSyncOverrideMock = vi.hoisted(() => vi.fn<(path: ReadFileSyncPath) => string | undefined>());
const unlinkSyncCallMock = vi.hoisted(() => vi.fn<(path: UnlinkSyncPath) => void>());
const rmSyncCallMock = vi.hoisted(() => vi.fn<(...args: RmSyncArgs) => void>());
const preparePatchedPackagesForInstallMock = vi.fn(() => ({
  packages: [],
  discard: vi.fn(),
  restore: vi.fn(),
}));
const createDirectoryLinkMock = vi.fn(() => ({ ok: true, output: "" }));
const removeDirectoryLinkMock = vi.fn(() => ({ ok: true, output: "" }));
const captureProcessIdentityMock = vi.fn(async (pid: number) => ({
  pid,
  startMarker: `start-${pid}`,
}));
const terminateProcessTreeMock = vi.fn(async (root: { pid: number; startMarker: string }) => ({
  ok: true,
  status: "terminated",
  root,
}));
const buildPublicUrlMock = vi.fn(() => undefined);

function isDataFilePath(path: string, filename: string): boolean {
  return basename(path) === filename && basename(dirname(path)) === "data";
}

function isRestartSignalTempPath(path: string): boolean {
  const filename = basename(path);
  return basename(dirname(path)) === "data"
    && filename.startsWith(".restart.signal.")
    && filename.endsWith(".tmp");
}

function hasRestartSignalWriteAttempt(): boolean {
  return writeFileSyncCallMock.mock.calls.some(([file]) => isRestartSignalTempPath(String(file)));
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
});

vi.mock("../session-manager.js", () => ({
  triggerRestartPending: triggerRestartPendingMock,
  clearRestartPending: clearRestartPendingMock,
  isRestartPending: isRestartPendingMock,
}));

// The restart-signal write/rollback pair now lives in restart-inflight.ts, which
// imports the controller directly rather than through the session-manager
// re-export, so the mock has to be applied at the source module too.
vi.mock("../restart-controller.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../restart-controller.js")>(),
  beginRestartPending: () => {
    triggerRestartPendingMock();
    return { requestId: "restart-request-test", waitingSessions: 0 };
  },
  triggerRestartPending: triggerRestartPendingMock,
  clearRestartPending: clearRestartPendingMock,
  isRestartPending: isRestartPendingMock,
}));

vi.mock("../dependency-sync.js", () => ({
  dependencySyncHash: dependencySyncHashMock,
  DEPENDENCY_SYNC_GIT_PATHSPEC: "package.json",
  preparePatchedPackagesForInstall: preparePatchedPackagesForInstallMock,
  readInstalledDependencyHash: readInstalledDependencyHashMock,
}));

vi.mock("../release-slots.js", () => ({
  prepareReleaseSlot: prepareReleaseSlotMock,
}));

vi.mock("../platform.js", () => ({
  PROCESS_TREE_TERMINATION_BUDGET_MS: 25_000,
  createDirectoryLink: createDirectoryLinkMock,
  removeDirectoryLink: removeDirectoryLinkMock,
  captureProcessIdentity: captureProcessIdentityMock,
  terminateProcessTree: terminateProcessTreeMock,
}));

vi.mock("../public-url.js", () => ({
  buildPublicUrl: buildPublicUrlMock,
}));

vi.mock("../config.js", () => ({
  config: { web: { port: 3333 } },
}));

const stagingLogMock = vi.hoisted(() => vi.fn<(msg: string) => void>());
vi.mock("../staging-log.js", () => ({
  log: stagingLogMock,
}));

// Paths for which the mocked node:fs rmSync should fail, simulating EPERM/EBUSY
// (e.g. a Windows file lock) after retries are exhausted. Used to exercise
// staging preview data-removal failure handling.
const rmSyncThrowDirs = vi.hoisted(() => new Set<string>());

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

    CREATE TABLE copilot_usage_sessions (
      sessionId TEXT PRIMARY KEY,
      parserVersion INTEGER NOT NULL,
      fingerprintJson TEXT NOT NULL,
      resultJson TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    INSERT INTO copilot_usage_sessions (
      sessionId, parserVersion, fingerprintJson, resultJson, updatedAt
    ) VALUES (
      'production-session',
      1,
      '{"events":{"state":"missing"},"modelState":{"state":"missing"}}',
      '{"hasEvents":false,"included":false,"includedUsageAts":[],"skippedAt":null,"modelRows":[],"totals":{}}',
      '2026-01-01T00:00:00.000Z'
    );

    CREATE TABLE copilot_usage_scan_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      completedAt TEXT
    );
    INSERT INTO copilot_usage_scan_state (id, completedAt)
    VALUES (1, '2026-01-01T00:00:00.000Z');

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
  "npm run check:pr",
  "npm run preview:smoke",
] as const;
const DEPLOY_SMOKE_COMMAND = "npm run preview:smoke";
const DEPLOY_STASH_SHA = "cafebabecafebabecafebabecafebabecafebabe";
const STASH_LIST_COMMAND = 'git --no-pager stash list --format="%H %gs"';

function isStashListCommand(cmd: string): boolean {
  return cmd === STASH_LIST_COMMAND;
}

function isStashPushCommand(cmd: string): boolean {
  return cmd.startsWith('git stash push --include-untracked -m "bridge-deploy-');
}

/** The unique marker the deploy stashes production changes under. */
function stashMarkerOf(cmd: string): string {
  return cmd.slice(cmd.indexOf('"') + 1, cmd.lastIndexOf('"'));
}

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

type StagingToolsModule = Awaited<ReturnType<typeof loadStagingToolsModule>>;

function createStagingPreviewTestApp(mod: StagingToolsModule) {
  const app = express();
  mod.registerExpressApp(app);

  app.use("/staging/:prefix/api", (req, res, next) => {
    const router = mod.getStagingRouter(req.params.prefix);
    if (router) {
      router(req, res, next);
    } else {
      next();
    }
  });

  app.use("/staging/:prefix", (req, res) => {
    const distDir = mod.getActivePreviews().get(req.params.prefix);
    if (!distDir || !existsSync(distDir)) {
      return res.status(404).send("Staging preview not found.");
    }
    express.static(distDir)(req, res, () => {
      res.sendFile(join(distDir, "index.html"));
    });
  });

  return app;
}

beforeEach(() => {
  // Validation log writes are intercepted through the node:fs mock above, but the
  // retention sweep they trigger uses node:fs/promises. Point every writer and
  // sweep at a temp directory so no test can touch the real validation log dir.
  vi.stubEnv(
    "BRIDGE_VALIDATION_LOG_DIR",
    join(createTempDir("bridge-staging-validation-"), "data", "validation-logs"),
  );
});

afterEach(() => {
  rmSyncThrowDirs.clear();
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
  readInstalledDependencyHashMock.mockReset();
  readInstalledDependencyHashMock.mockReturnValue(undefined);
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
  lstatSyncOverrideMock.mockReset();
  buildPublicUrlMock.mockReset();
  buildPublicUrlMock.mockReturnValue(undefined);
  execSyncMock.mockReset();
  execSyncMock.mockReturnValue("");
  spawnMock.mockReset();
  captureProcessIdentityMock.mockClear();
  terminateProcessTreeMock.mockClear();
  writeFileSyncCallMock.mockReset();
  readFileSyncOverrideMock.mockReset();
  unlinkSyncCallMock.mockReset();
  rmSyncCallMock.mockReset();
  renameSyncCallMock.mockReset();
  stagingLogMock.mockReset();
  vi.resetModules();
});

describe("staging tools", () => {
  it("manages staging artifacts based on distribution mode and release slot configuration", async () => {
    // Development mode: always manages artifacts
    vi.stubEnv("BRIDGE_DISTRIBUTION_MODE", "development");
    const mod1 = await loadStagingToolsModule();
    expect(mod1.shouldManageStagingArtifacts(), "development mode").toBe(true);

    // Release mode without any source-managed overrides: skips
    vi.stubEnv("BRIDGE_DISTRIBUTION_MODE", "release");
    vi.stubEnv("BRIDGE_ACTIVE_RELEASE_ROOT", undefined);
    vi.stubEnv("BRIDGE_CONTROL_DISTRIBUTION_MODE", undefined);
    const mod2 = await loadStagingToolsModule();
    expect(mod2.shouldManageStagingArtifacts(), "release mode").toBe(false);

    // Source-managed release-slot server (control mode = development): manages
    vi.stubEnv("BRIDGE_DISTRIBUTION_MODE", "release");
    vi.stubEnv("BRIDGE_CONTROL_DISTRIBUTION_MODE", "development");
    const mod3 = await loadStagingToolsModule();
    expect(mod3.shouldManageStagingArtifacts(), "source-managed release-slot").toBe(true);
  });

  it("builds and parses staging preview prefixes", async () => {
    const mod = await loadStagingToolsModule();
    const stagingDir = join(tmpdir(), "bridge-staging", "abc12345");
    expect(mod.buildPreviewPrefix(stagingDir)).toBe("abc12345");
    expect(mod.parsePreviewPrefix("abc12345")).toBe("abc12345");
  });

  it("keeps staging previews unambiguous when worktree names contain suffix-like text", async () => {
    const mod = await loadStagingToolsModule();
    const activeWorktrees = new Set(["foo-preview", "foo"]);
    expect(mod.parsePreviewPrefix("foo-preview", activeWorktrees)).toBe("foo-preview");
  });

  it("returns null for orphaned preview prefixes when active worktrees are known", async () => {
    const mod = await loadStagingToolsModule();
    const activeWorktrees = new Set(["abc12345"]);
    expect(mod.parsePreviewPrefix("missing", activeWorktrees)).toBeNull();
  });

  it("rejects unsafe staging preview prefixes", async () => {
    const mod = await loadStagingToolsModule();
    expect(mod.parsePreviewPrefix("..")).toBeNull();
    expect(mod.parsePreviewPrefix(".hidden")).toBeNull();
    expect(mod.parsePreviewPrefix("bad..prefix")).toBeNull();
    expect(mod.parsePreviewPrefix("bad.")).toBeNull();
  });

  it("preserves deploy validation logs while clearing preview runtime data", async () => {
    const mod = await import("../staging-preview-shared.js");
    const dataDir = createTempDir("bridge-preview-data-");
    const logDir = join(dataDir, "validation-logs");
    const docsDir = join(dataDir, "docs");
    mkdirSync(logDir, { recursive: true });
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(logDir, "deploy.log"), "keep");
    writeFileSync(join(dataDir, "bridge.db"), "runtime-db");
    writeFileSync(join(docsDir, "index.md"), "# Runtime docs");

    mod.removePreviewData(dataDir);

    expect(readFileSync(join(logDir, "deploy.log"), "utf-8")).toBe("keep");
    expect(existsSync(join(dataDir, "bridge.db"))).toBe(false);
    expect(existsSync(docsDir)).toBe(false);
  });

  it("launches staging backends through a single opaque staged entrypoint", async () => {
    const mod = await loadStagingToolsModule();
    const stagingDir = createTempDir("bridge-stage-child-entrypoint-");

    const runtimePaths = {
      distributionMode: "release" as const,
      workspaceDir: join(stagingDir, "workspace"),
      dataDir: join(stagingDir, "data"),
      docsDir: join(stagingDir, "docs"),
      copilotHome: join(stagingDir, ".copilot"),
      env: {
        BRIDGE_DISTRIBUTION_MODE: "release",
        BRIDGE_ACTIVE_RELEASE_ROOT: join(stagingDir, "release-slot"),
      },
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
    expect(spawnConfig.env.BRIDGE_DISTRIBUTION_MODE).toBe("development");
    expect(spawnConfig.env.BRIDGE_CONTROL_DISTRIBUTION_MODE).toBe("development");
    expect(spawnConfig.env.BRIDGE_ACTIVE_RELEASE_ROOT).toBeUndefined();
    expect(spawnConfig.env.BRIDGE_ENV_FILE).toBe(join(stagingDir, ".env"));
    expect(spawnConfig.args.join("\n")).not.toContain("task-store.ts");
  });

  it("keeps staged backend child processes in source distribution mode under a release-slot parent", async () => {
    vi.stubEnv("BRIDGE_DISTRIBUTION_MODE", "release");
    vi.stubEnv("BRIDGE_CONTROL_DISTRIBUTION_MODE", "release");
    vi.stubEnv("BRIDGE_CONTROL_ROOT", join(tmpdir(), "bridge-release-control"));
    vi.stubEnv("BRIDGE_ACTIVE_RELEASE_ROOT", join(tmpdir(), "bridge-release-slot"));
    const mod = await loadStagingToolsModule();
    const productionDataDir = createProductionDataDir();
    const stagingDir = createTempDir("bridge-stage-child-source-mode-");

    const seededDataDir = mod.__testing.seedStagingData(stagingDir, { productionDataDir });
    const runtimePaths = mod.__testing.getExistingPreviewRuntime(stagingDir);
    const spawnConfig = mod.__testing.buildStagingBackendSpawnConfig(
      stagingDir,
      runtimePaths!,
      "/staging/source-mode/api",
      { tsxLoader: "file:///tmp/tsx-loader.mjs" },
    );

    expect(runtimePaths).not.toBeNull();
    expect(runtimePaths!.dataDir).toBe(seededDataDir);
    expect(runtimePaths!.distributionMode).toBe("development");
    expect(runtimePaths!.env.BRIDGE_DISTRIBUTION_MODE).toBe("development");
    expect(spawnConfig.env.BRIDGE_DISTRIBUTION_MODE).toBe("development");
    expect(spawnConfig.env.BRIDGE_CONTROL_DISTRIBUTION_MODE).toBe("development");
    expect(spawnConfig.env.BRIDGE_CONTROL_ROOT).toBe(stagingDir);
    expect(spawnConfig.env.BRIDGE_DATA_DIR).toBe(join(stagingDir, "data"));
    expect(spawnConfig.env.BRIDGE_DOCS_DIR).toBe(join(stagingDir, "data", "docs"));
    expect(spawnConfig.env.COPILOT_HOME).toBe(join(stagingDir, "data", ".copilot"));
    expect("BRIDGE_ACTIVE_RELEASE_ROOT" in spawnConfig.env).toBe(false);
  });

  it("can isolate staged runtime data from the worktree for preview smoke validation", async () => {
    const previewDataDir = join(createTempDir("bridge-stage-preview-data-"), "runtime");
    vi.stubEnv("BRIDGE_STAGING_PREVIEW_DATA_DIR", previewDataDir);
    const mod = await loadStagingToolsModule();
    const productionDataDir = createProductionDataDir();
    const stagingDir = createTempDir("bridge-stage-runtime-override-");

    const seededDataDir = mod.__testing.seedStagingData(stagingDir, { productionDataDir });
    const runtimePaths = mod.__testing.getExistingPreviewRuntime(stagingDir);

    expect(seededDataDir).toBe(previewDataDir);
    expect(runtimePaths?.dataDir).toBe(previewDataDir);
    expect(existsSync(join(previewDataDir, "bridge.db"))).toBe(true);
    expect(existsSync(join(stagingDir, "data", "bridge.db"))).toBe(false);
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
      const usageSessions = stagingDb.prepare("SELECT COUNT(*) AS count FROM copilot_usage_sessions").get() as { count: number };
      expect(usageSessions.count).toBe(0);
      const usageScanState = stagingDb.prepare("SELECT COUNT(*) AS count FROM copilot_usage_scan_state").get() as { count: number };
      expect(usageScanState.count).toBe(0);
      const settingsRow = stagingDb.prepare("SELECT value FROM settings WHERE key = 'app'").get() as { value: string };
      const settings = JSON.parse(settingsRow.value) as Record<string, unknown>;
      expect(settings.model).toBe("claude-haiku-4.5");
      expect("reasoningEffort" in settings).toBe(false);
      expect(settings.theme).toBe("dark");
      expect(settings.customInstructions).toBe("keep me");
    } finally {
      stagingDb.close();
    }

    const productionDb = new DatabaseSync(join(productionDataDir, "bridge.db"));
    try {
      const productionUsageSessions = productionDb.prepare("SELECT COUNT(*) AS count FROM copilot_usage_sessions").get() as { count: number };
      expect(productionUsageSessions.count).toBe(1);
      const productionUsageScanState = productionDb.prepare("SELECT COUNT(*) AS count FROM copilot_usage_scan_state").get() as { count: number };
      expect(productionUsageScanState.count).toBe(1);
    } finally {
      productionDb.close();
    }

    expect(existsSync(join(seededDataDir, "docs", "note.md"))).toBe(true);
  });

  it("inserts or replaces staging model settings when the production app settings row is missing or malformed", async () => {
    const mod = await loadStagingToolsModule();

    // Missing row: inserts default model settings
    const productionDataDir1 = createProductionDataDir();
    const productionDb1 = new DatabaseSync(join(productionDataDir1, "bridge.db"));
    try {
      productionDb1.exec("DELETE FROM settings WHERE key = 'app'");
    } finally {
      productionDb1.close();
    }
    const stagingDir1 = createTempDir("bridge-stage-staging-");

    const seededDataDir1 = mod.__testing.seedStagingData(stagingDir1, { productionDataDir: productionDataDir1 });
    const stagingDb1 = new DatabaseSync(join(seededDataDir1, "bridge.db"));
    try {
      const settingsRow1 = stagingDb1.prepare("SELECT value FROM settings WHERE key = 'app'").get() as { value: string };
      const settings1 = JSON.parse(settingsRow1.value) as Record<string, unknown>;
      expect(settings1, "missing row").toEqual({ model: "claude-haiku-4.5" });
    } finally {
      stagingDb1.close();
    }

    // Malformed JSON: replaces with default model settings
    const productionDataDir2 = createProductionDataDir();
    const productionDb2 = new DatabaseSync(join(productionDataDir2, "bridge.db"));
    try {
      productionDb2.prepare("UPDATE settings SET value = ? WHERE key = 'app'").run("not-json");
    } finally {
      productionDb2.close();
    }
    const stagingDir2 = createTempDir("bridge-stage-staging-");

    const seededDataDir2 = mod.__testing.seedStagingData(stagingDir2, { productionDataDir: productionDataDir2 });
    const stagingDb2 = new DatabaseSync(join(seededDataDir2, "bridge.db"));
    try {
      const settingsRow2 = stagingDb2.prepare("SELECT value FROM settings WHERE key = 'app'").get() as { value: string };
      const settings2 = JSON.parse(settingsRow2.value) as Record<string, unknown>;
      expect(settings2, "malformed JSON").toEqual({ model: "claude-haiku-4.5" });
    } finally {
      stagingDb2.close();
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
      if (isRestartSignalTempPath(String(args[0]))) {
        throw new Error("disk full");
      }
    });

    expect(() => mod.__testing.writeRestartSignalOrRollback(signalFile)).toThrow(/disk full/);
    expect(triggerRestartPendingMock).toHaveBeenCalledTimes(1);
    expect(clearRestartPendingMock).toHaveBeenCalledTimes(1);
    expect(
      rmSyncCallMock.mock.calls.some(([file]) => isRestartSignalTempPath(String(file))),
    ).toBe(true);
    expect(
      unlinkSyncCallMock.mock.calls.some(([file]) => isDataFilePath(String(file), "restart.signal")),
    ).toBe(false);
    expect(triggerRestartPendingMock.mock.invocationCallOrder[0]).toBeLessThan(
      writeFileSyncCallMock.mock.invocationCallOrder[0],
    );
    expect(writeFileSyncCallMock.mock.invocationCallOrder[0]).toBeLessThan(
      rmSyncCallMock.mock.invocationCallOrder[0],
    );
    expect(rmSyncCallMock.mock.invocationCallOrder[0]).toBeLessThan(
      clearRestartPendingMock.mock.invocationCallOrder[0],
    );
  });

  it("retries startup restore once and returns a non-destructive failure result when the retry still fails", async () => {
    const mod = await loadStagingToolsModule();

    // Succeeds on the second attempt
    const initializeBackend1 = vi.fn()
      .mockRejectedValueOnce(new Error("corrupt staged db"))
      .mockResolvedValueOnce(undefined);
    const log1 = vi.fn();
    const stagingDir1 = createTempDir("bridge-stage-preview-");

    const result1 = await mod.__testing.restoreStagingBackendWithRetry("preview-123", stagingDir1, {
      initializeBackend: initializeBackend1,
      log: log1,
    });

    expect(result1).toEqual({ restored: true, attempts: 2 });
    expect(initializeBackend1).toHaveBeenCalledTimes(2);
    expect(log1).toHaveBeenCalledWith(
      "Failed to restore staged backend for preview-123 on attempt 1/2: corrupt staged db",
    );

    // Still fails on the retry
    const initializeBackend2 = vi.fn().mockRejectedValue(new Error("still broken"));
    const log2 = vi.fn();
    const stagingDir2 = createTempDir("bridge-stage-preview-");

    const result2 = await mod.__testing.restoreStagingBackendWithRetry("preview-123", stagingDir2, {
      initializeBackend: initializeBackend2,
      log: log2,
    });

    expect(result2).toEqual({ restored: false, attempts: 2, error: "still broken" });
    expect(initializeBackend2).toHaveBeenCalledTimes(2);
    expect(log2).toHaveBeenCalledTimes(1);
    expect(log2).toHaveBeenCalledWith(
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

  it("serves startup-discovered previews while prune is still waiting on branch discovery", async () => {
    vi.stubEnv("BRIDGE_STAGING_BACKEND_STARTUP_RESTORE_LIMIT", "0");
    const mod = await loadStagingToolsModule();
    const stagingParent = createTempDir("bridge-stage-parent-");
    const previewParent = createTempDir("bridge-stage-preview-root-");
    const prefix = "preview-slow-prune";
    const distDir = join(previewParent, prefix);
    const pruneGitWorktrees = vi.fn();
    let resolveBranches!: (value: Set<string>) => void;
    const branchSnapshot = new Promise<Set<string>>((resolve) => {
      resolveBranches = resolve;
    });

    mkdirSync(join(stagingParent, prefix), { recursive: true });
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, "index.html"), "<!doctype html><p>restored preview</p>");

    const app = createStagingPreviewTestApp(mod);
    expect(mod.registerExistingPreviewsFromDisk({
      stagingParent,
      stagingPreviewParents: [previewParent],
    })).toBe(1);
    expect(mod.getStagingRouter(prefix)).toEqual(expect.any(Function));

    const prunePromise = mod.__testing.pruneOrphanedWorktreesImpl({
      stagingParent,
      stagingPreviewParents: [previewParent],
      listBranchPrefixes: () => branchSnapshot,
      pruneGitWorktrees,
    });

    try {
      const response = await request(app).get(`/staging/${prefix}/`);
      expect(response.status).toBe(200);
      expect(response.text).toContain("restored preview");
      expect(pruneGitWorktrees).not.toHaveBeenCalled();
    } finally {
      resolveBranches(new Set([prefix]));
      await prunePromise;
    }
  });

  it("removes startup-discovered preview registrations when prune later finds them orphaned", async () => {
    vi.stubEnv("BRIDGE_STAGING_BACKEND_STARTUP_RESTORE_LIMIT", "0");
    const mod = await loadStagingToolsModule();
    const stagingParent = createTempDir("bridge-stage-parent-");
    const previewParent = createTempDir("bridge-stage-preview-root-");
    const prefix = "preview-orphan";
    const distDir = join(previewParent, prefix);

    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, "index.html"), "<!doctype html><p>orphan preview</p>");

    createStagingPreviewTestApp(mod);
    expect(mod.registerExistingPreviewsFromDisk({
      stagingParent,
      stagingPreviewParents: [previewParent],
    })).toBe(1);
    expect(mod.getActivePreviews().get(prefix)).toBe(distDir);
    expect(mod.getStagingRouter(prefix)).toEqual(expect.any(Function));

    await mod.__testing.pruneOrphanedWorktreesImpl({
      stagingParent,
      stagingPreviewParents: [previewParent],
      listBranchPrefixes: () => new Set(),
      pruneGitWorktrees: vi.fn(),
    });

    expect(existsSync(distDir)).toBe(false);
    expect(mod.getActivePreviews().has(prefix)).toBe(false);
    expect(mod.getStagingRouter(prefix)).toBeUndefined();
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
    const deployTool = mod.STAGING_TOOLS.find((tool: { name: string }) => tool.name === "staging_deploy") as any;
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
      if (isStashListCommand(cmd)) return "";
      if (isStashPushCommand(cmd)) return "No local changes to save\n";
      if (cmd === "git pull --rebase origin main") return "Already up to date.\n";
      if (cmd === "git rebase main" && cwd === stagingDir) return "";
      if (DEPLOY_VALIDATION_COMMANDS.includes(cmd as (typeof DEPLOY_VALIDATION_COMMANDS)[number])) return "";
      if (cmd === "git rev-parse HEAD") return "1111111111111111111111111111111111111111\n";
      if (cmd === 'git merge "staging/preview-deploy" --no-edit') return "";
      if (cmd === 'git diff "1111111111111111111111111111111111111111" HEAD --name-only -- package.json') {
        return "package-lock.json\n";
      }
      if (cmd === "git rev-parse --short HEAD") return "1111111\n";
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
      commitSha: "1111111",
    });
    expect(triggerRestartPendingMock).toHaveBeenCalledTimes(1);
    expect(preparePatchedPackagesForInstallMock).not.toHaveBeenCalled();
    expect(dependencySyncHashMock).toHaveBeenCalledTimes(3);
    const commands = execSyncMock.mock.calls.map(([cmd]) => String(cmd));
    expect(commands).not.toContain("npm install --no-audit --no-fund --include=dev");
    expect(commands.some((cmd) => cmd.startsWith("git diff "))).toBe(true);
    expect(spawnMock).toHaveBeenCalledWith(
      "git",
      ["pull", "--rebase", "origin", "main"],
      expect.objectContaining({ shell: false }),
    );
    expect(writeFileSyncCallMock.mock.calls.some(([file]) => isDataFilePath(String(file), "pre-deploy-sha"))).toBe(true);
    expect(renameSyncCallMock.mock.calls.some(([, file]) => isDeployValidationStampPath(String(file)))).toBe(true);
    expect(writeFileSyncCallMock.mock.calls.some(([file]) => isDataFilePath(String(file), "deps-hash"))).toBe(false);
  });

  it("uses a matching preview validation stamp to run smoke-only deploy validation", async () => {
    const mod = await loadStagingToolsModule();
    const deployTool = mod.STAGING_TOOLS.find((tool: { name: string }) => tool.name === "staging_deploy") as any;
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
      if (isDataFilePath(normalized, "restart-in-progress.json")) return false;
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
      if (isStashListCommand(cmd)) return "";
      if (isStashPushCommand(cmd)) return "No local changes to save\n";
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
      if (cmd === "git rev-parse --short HEAD") return "1111111\n";
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
      commitSha: "1111111",
    });
    const commands = execSyncMock.mock.calls.map(([cmd]) => String(cmd));
    expect(commands).toContain(DEPLOY_SMOKE_COMMAND);
    expect(commands).not.toContain("npm run check:deploy");
    expect(renameSyncCallMock.mock.calls.some(([, file]) => isDeployValidationStampPath(String(file)))).toBe(true);
    const deployStampWrite = writeFileSyncCallMock.mock.calls.find(([file]) => isDeployValidationStampPath(String(file)));
    expect(String(deployStampWrite?.[1])).toContain('"command": "npm run check:deploy"');
  });

  it("unstashes and blocks merge when the prepared release candidate differs from the validated commit", async () => {
    const mod = await loadStagingToolsModule();
    const deployTool = mod.STAGING_TOOLS.find((tool: { name: string }) => tool.name === "staging_deploy") as any;
    if (!deployTool) throw new Error("staging_deploy tool not found");

    const stagingParent = createTempDir("bridge-stage-parent-");
    const stagingDir = join(stagingParent, "preview-deploy");
    const validatedSha = "1111111111111111111111111111111111111111";
    const releaseCandidateSha = "2222222222222222222222222222222222222222";
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(join(stagingDir, ".gitignore"), "node_modules\n");
    mockDataFilePresence();
    prepareReleaseSlotMock.mockImplementationOnce(async (options) => ({
      ok: true as const,
      manifest: {
        version: 1,
        id: "release-slot-mismatched",
        root: join(options.dataDir, "release-slots", "release-slot-mismatched"),
        commitSha: releaseCandidateSha,
        source: options.source,
        dependencyHash: "same-hash",
        createdAt: "2026-05-18T20:00:00.000Z",
        validationMode: options.validationMode,
      },
    }));

    let stashMarker = "";
    execSyncMock.mockImplementation((cmd: string, options?: { cwd?: string }) => {
      const cwd = options?.cwd;
      if (cmd === "git add -A") return "";
      if (cmd === "git --no-pager status --porcelain") return "";
      if (cmd === "git rev-parse --abbrev-ref HEAD") return "main\n";
      if (cmd === "git log main..staging/preview-deploy --oneline") return "abc123 deploy commit\n";
      if (isStashListCommand(cmd)) return stashMarker ? `${DEPLOY_STASH_SHA} On main: ${stashMarker}\n` : "";
      if (isStashPushCommand(cmd)) {
        stashMarker = stashMarkerOf(cmd);
        return `Saved working directory and index state On main: ${stashMarker}\n`;
      }
      if (cmd === "git pull --rebase origin main") return "Already up to date.\n";
      if (cmd === "git rebase main" && cwd === stagingDir) return "";
      if (DEPLOY_VALIDATION_COMMANDS.includes(cmd as (typeof DEPLOY_VALIDATION_COMMANDS)[number])) return "";
      if (cmd === "git rev-parse HEAD" && cwd === stagingDir) return `${validatedSha}\n`;
      if (cmd === "git stash pop") return "";
      throw new Error(`Unexpected command: ${cmd} (cwd: ${cwd ?? "unknown"})`);
    });

    const result = await deployTool.handler(
      { stagingDir, message: "Deploy mismatched release candidate" },
      {
        sessionId: "session-1",
        toolCallId: "tool-1",
        toolName: "staging_deploy",
        arguments: {},
      } satisfies ToolInvocation,
    ) as any;

    expect(result).toMatchObject({ resultType: "failure" });
    expect(result.textResultForLlm).toContain("Release candidate does not match the validated staging commit.");
    expect(result.textResultForLlm).toContain(validatedSha);
    expect(result.textResultForLlm).toContain(releaseCandidateSha);
    expect(result.textResultForLlm).toContain("Production was not merged and restart signaling was blocked.");
    expect(result.textResultForLlm).toContain("staging worktree is still intact for retry-after-fix");
    expect(result.toolTelemetry).toEqual({
      bridge: {
        stagingDir,
        branch: "staging/preview-deploy",
        prodBranch: "main",
        validatedCommitSha: validatedSha,
        releaseCandidateSha,
      },
    });
    expect(prepareReleaseSlotMock).toHaveBeenCalledTimes(1);
    expect(prepareReleaseSlotMock).toHaveBeenCalledWith(expect.objectContaining({ commitSha: validatedSha }));

    const commands = execSyncMock.mock.calls.map(([cmd]) => String(cmd));
    const stashIndex = commands.findIndex(isStashPushCommand);
    const unstashIndex = commands.indexOf("git stash pop");
    expect(stashIndex).toBeGreaterThan(-1);
    expect(unstashIndex).toBeGreaterThan(stashIndex);
    expect(execSyncMock.mock.calls[unstashIndex]?.[1]?.cwd).toBe(execSyncMock.mock.calls[stashIndex]?.[1]?.cwd);
    const headReads = execSyncMock.mock.calls.filter(([cmd]) => String(cmd) === "git rev-parse HEAD");
    expect(headReads).toHaveLength(1);
    expect(headReads[0]?.[1]?.cwd).toBe(stagingDir);
    expect(commands).not.toContain('git merge "staging/preview-deploy" --no-edit');
    expect(commands).not.toContain("git push origin main");
    expect(commands).not.toContain(`git worktree remove "${stagingDir}" --force`);
    expect(commands).not.toContain('git branch -D "staging/preview-deploy"');
    expect(commands).not.toContain("git worktree prune");
    expect(triggerRestartPendingMock).not.toHaveBeenCalled();
    expect(hasRestartSignalWriteAttempt()).toBe(false);
    expect(writeFileSyncCallMock.mock.calls.some(([file]) => isDataFilePath(String(file), "pre-deploy-sha"))).toBe(false);
    expect(renameSyncCallMock.mock.calls.some(([, file]) => isDeployValidationStampPath(String(file)))).toBe(false);
    expect(existsSync(stagingDir)).toBe(true);
    expect(readFileSync(join(stagingDir, ".gitignore"), "utf-8")).toBe("node_modules\n");
  });

  it("fails the deploy when staging the worktree changes fails", async () => {
    const mod = await loadStagingToolsModule();
    const deployTool = mod.STAGING_TOOLS.find((tool: { name: string }) => tool.name === "staging_deploy") as any;
    if (!deployTool) throw new Error("staging_deploy tool not found");

    const stagingParent = createTempDir("bridge-stage-parent-");
    const stagingDir = join(stagingParent, "preview-deploy");
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(join(stagingDir, ".gitignore"), "node_modules\n");
    mockDataFilePresence();

    execSyncMock.mockImplementation((cmd: string, options?: { cwd?: string }) => {
      const cwd = options?.cwd;
      if (cmd === "git add -A") {
        const error = new Error("git add failed") as Error & { stderr: string };
        error.stderr = "fatal: Unable to create '.git/index.lock': File exists.\n";
        throw error;
      }
      throw new Error(`Unexpected command: ${cmd} (cwd: ${cwd ?? "unknown"})`);
    });

    const result = await deployTool.handler(
      { stagingDir, message: "Deploy with a broken index" },
      {
        sessionId: "session-1",
        toolCallId: "tool-1",
        toolName: "staging_deploy",
        arguments: {},
      } satisfies ToolInvocation,
    ) as any;

    expect(result).toMatchObject({
      resultType: "failure",
      sessionLog: expect.stringContaining("Command: git add -A"),
      toolTelemetry: {
        bridge: {
          command: "git add -A",
          cwd: stagingDir,
          stagingDir,
          branch: "staging/preview-deploy",
        },
      },
    });
    expect(result.textResultForLlm).toContain("Failed to stage staging worktree changes for the deploy commit.");
    expect(result.textResultForLlm).toContain("index.lock");
    const commands = execSyncMock.mock.calls.map(([cmd]) => String(cmd));
    expect(commands).toEqual(["git add -A"]);
    expect(writeFileSyncCallMock.mock.calls.some(([file]) => basename(String(file)) === ".commit-msg")).toBe(false);
    expect(triggerRestartPendingMock).not.toHaveBeenCalled();
  });

  it("fails the deploy when the staging worktree status cannot be read", async () => {
    const mod = await loadStagingToolsModule();
    const deployTool = mod.STAGING_TOOLS.find((tool: { name: string }) => tool.name === "staging_deploy") as any;
    if (!deployTool) throw new Error("staging_deploy tool not found");

    const stagingParent = createTempDir("bridge-stage-parent-");
    const stagingDir = join(stagingParent, "preview-deploy");
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(join(stagingDir, ".gitignore"), "node_modules\n");
    mockDataFilePresence();

    execSyncMock.mockImplementation((cmd: string, options?: { cwd?: string }) => {
      const cwd = options?.cwd;
      if (cmd === "git add -A") return "";
      if (cmd === "git --no-pager status --porcelain") {
        const error = new Error("git status failed") as Error & { stderr: string };
        error.stderr = "fatal: not a git repository\n";
        throw error;
      }
      throw new Error(`Unexpected command: ${cmd} (cwd: ${cwd ?? "unknown"})`);
    });

    const result = await deployTool.handler(
      { stagingDir, message: "Deploy with an unreadable status" },
      {
        sessionId: "session-1",
        toolCallId: "tool-1",
        toolName: "staging_deploy",
        arguments: {},
      } satisfies ToolInvocation,
    ) as any;

    expect(result).toMatchObject({
      resultType: "failure",
      sessionLog: expect.stringContaining("Command: git --no-pager status --porcelain"),
      toolTelemetry: {
        bridge: {
          command: "git --no-pager status --porcelain",
          cwd: stagingDir,
          stagingDir,
          branch: "staging/preview-deploy",
        },
      },
    });
    expect(result.textResultForLlm).toContain("Failed to read the staging worktree status.");
    expect(result.textResultForLlm).toContain("not a git repository");
    const commands = execSyncMock.mock.calls.map(([cmd]) => String(cmd));
    expect(commands).toEqual(["git add -A", "git --no-pager status --porcelain"]);
    expect(writeFileSyncCallMock.mock.calls.some(([file]) => basename(String(file)) === ".commit-msg")).toBe(false);
    expect(triggerRestartPendingMock).not.toHaveBeenCalled();
  });

  it("stops the deploy when stashing uncommitted production changes fails", async () => {
    const mod = await loadStagingToolsModule();
    const deployTool = mod.STAGING_TOOLS.find((tool: { name: string }) => tool.name === "staging_deploy") as any;
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
      if (isStashListCommand(cmd)) return "";
      if (isStashPushCommand(cmd)) {
        const error = new Error("git stash failed") as Error & { stderr: string };
        error.stderr = "error: cannot save the current index state\n";
        throw error;
      }
      throw new Error(`Unexpected command: ${cmd} (cwd: ${cwd ?? "unknown"})`);
    });

    const result = await deployTool.handler(
      { stagingDir, message: "Deploy with an unstashable production tree" },
      {
        sessionId: "session-1",
        toolCallId: "tool-1",
        toolName: "staging_deploy",
        arguments: {},
      } satisfies ToolInvocation,
    ) as any;

    expect(result).toMatchObject({
      resultType: "failure",
      sessionLog: expect.stringContaining("Command: git stash push --include-untracked -m "),
    });
    expect(result.textResultForLlm).toContain("Failed to stash uncommitted production changes.");
    expect(result.textResultForLlm).toContain("cannot save the current index state");
    expect(result.stashRestoreFailed).toBeUndefined();
    const commands = execSyncMock.mock.calls.map(([cmd]) => String(cmd));
    expect(commands).not.toContain("git stash pop");
    expect(commands).not.toContain("git pull --rebase origin main");
    expect(commands).not.toContain("git rebase main");
    expect(commands).not.toContain('git merge "staging/preview-deploy" --no-edit');
    expect(commands).not.toContain("git push origin main");
    expect(triggerRestartPendingMock).not.toHaveBeenCalled();
  });

  it("warns that production changes are still stashed when the post-deploy stash pop fails", async () => {
    const mod = await loadStagingToolsModule();
    const deployTool = mod.STAGING_TOOLS.find((tool: { name: string }) => tool.name === "staging_deploy") as any;
    if (!deployTool) throw new Error("staging_deploy tool not found");

    const stagingParent = createTempDir("bridge-stage-parent-");
    const stagingDir = join(stagingParent, "preview-deploy");
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(join(stagingDir, ".gitignore"), "node_modules\n");
    mockDataFilePresence();

    let stashMarker = "";
    execSyncMock.mockImplementation((cmd: string, options?: { cwd?: string }) => {
      const cwd = options?.cwd;
      if (cmd === "git add -A") return "";
      if (cmd === "git --no-pager status --porcelain") return "";
      if (cmd === "git rev-parse --abbrev-ref HEAD") return "main\n";
      if (cmd === "git log main..staging/preview-deploy --oneline") return "abc123 deploy commit\n";
      if (isStashListCommand(cmd)) return stashMarker ? `${DEPLOY_STASH_SHA} On main: ${stashMarker}\n` : "";
      if (isStashPushCommand(cmd)) {
        stashMarker = stashMarkerOf(cmd);
        return `Saved working directory and index state On main: ${stashMarker}\n`;
      }
      if (cmd === "git stash pop") {
        const error = new Error("git stash pop failed") as Error & { stderr: string };
        error.stderr = "CONFLICT (content): Merge conflict in src/server/api-router.ts\n";
        throw error;
      }
      if (cmd === "git pull --rebase origin main") return "Already up to date.\n";
      if (cmd === "git rebase main" && cwd === stagingDir) return "";
      if (DEPLOY_VALIDATION_COMMANDS.includes(cmd as (typeof DEPLOY_VALIDATION_COMMANDS)[number])) return "";
      if (cmd === "git rev-parse HEAD") return "1111111111111111111111111111111111111111\n";
      if (cmd === 'git merge "staging/preview-deploy" --no-edit') return "";
      if (cmd === 'git diff "1111111111111111111111111111111111111111" HEAD --name-only -- package.json') return "";
      if (cmd === "git rev-parse --short HEAD") return "1111111\n";
      if (cmd === "git push origin main") return "";
      if (cmd === `git worktree remove "${stagingDir}" --force`) return "";
      if (cmd === 'git branch -D "staging/preview-deploy"') return "";
      if (cmd === "git worktree prune") return "";
      throw new Error(`Unexpected command: ${cmd} (cwd: ${cwd ?? "unknown"})`);
    });

    const result = await deployTool.handler(
      { stagingDir, message: "Deploy with a conflicting production stash" },
      {
        sessionId: "session-1",
        toolCallId: "tool-1",
        toolName: "staging_deploy",
        arguments: {},
      } satisfies ToolInvocation,
    ) as any;

    expect(result).toMatchObject({
      success: true,
      commitSha: "1111111",
      stashRestoreFailed: true,
    });
    expect(result.stashRecoveryWarning).toContain("still saved in git stash");
    expect(result.stashRecoveryWarning).toContain("git stash list");
    expect(result.stashRecoveryWarning).toContain("git stash pop");
    expect(result.stashRecoveryWarning).toContain("Merge conflict in src/server/api-router.ts");
    expect(result.message).toContain("still saved in git stash");
    expect(result.content?.[0]?.text).toContain("still saved in git stash");
    expect(result.content?.[0]?.text).toContain("git stash list");
    expect(result.summary).toContain("could not be restored automatically");
    expect(stagingLogMock.mock.calls.map(([msg]) => String(msg))).not.toContain("Restored stashed production changes");
    const commands = execSyncMock.mock.calls.map(([cmd]) => String(cmd));
    expect(commands.filter((cmd) => cmd === "git stash pop")).toHaveLength(1);
    expect(triggerRestartPendingMock).toHaveBeenCalledTimes(1);
  });

  it("warns about the stranded production stash on deploy failure paths", async () => {
    const mod = await loadStagingToolsModule();
    const deployTool = mod.STAGING_TOOLS.find((tool: { name: string }) => tool.name === "staging_deploy") as any;
    if (!deployTool) throw new Error("staging_deploy tool not found");

    const stagingParent = createTempDir("bridge-stage-parent-");
    const stagingDir = join(stagingParent, "preview-deploy");
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(join(stagingDir, ".gitignore"), "node_modules\n");
    mockDataFilePresence();

    let stashMarker = "";
    execSyncMock.mockImplementation((cmd: string, options?: { cwd?: string }) => {
      const cwd = options?.cwd;
      if (cmd === "git add -A") return "";
      if (cmd === "git --no-pager status --porcelain") return "";
      if (cmd === "git rev-parse --abbrev-ref HEAD") return "main\n";
      if (cmd === "git log main..staging/preview-deploy --oneline") return "abc123 deploy commit\n";
      if (isStashListCommand(cmd)) return stashMarker ? `${DEPLOY_STASH_SHA} On main: ${stashMarker}\n` : "";
      if (isStashPushCommand(cmd)) {
        stashMarker = stashMarkerOf(cmd);
        return `Saved working directory and index state On main: ${stashMarker}\n`;
      }
      if (cmd === "git stash pop") {
        const error = new Error("git stash pop failed") as Error & { stderr: string };
        error.stderr = "CONFLICT (content): Merge conflict in src/server/db.ts\n";
        throw error;
      }
      if (cmd === "git pull --rebase origin main") return "Already up to date.\n";
      if (cmd === "git rebase main" && cwd === stagingDir) return "";
      if (cmd === "npm run check:pr") {
        const error = new Error("deploy gate failed") as Error & { stderr: string };
        error.stderr = "deploy gate exploded\n";
        throw error;
      }
      if (DEPLOY_VALIDATION_COMMANDS.includes(cmd as (typeof DEPLOY_VALIDATION_COMMANDS)[number])) return "";
      throw new Error(`Unexpected command: ${cmd} (cwd: ${cwd ?? "unknown"})`);
    });

    const result = await deployTool.handler(
      { stagingDir, message: "Deploy that fails validation" },
      {
        sessionId: "session-1",
        toolCallId: "tool-1",
        toolName: "staging_deploy",
        arguments: {},
      } satisfies ToolInvocation,
    ) as any;

    expect(result).toMatchObject({ resultType: "failure", stashRestoreFailed: true });
    expect(result.textResultForLlm).toContain("Staging deploy validation failed.");
    expect(result.textResultForLlm).toContain("still saved in git stash");
    expect(result.sessionLog).toContain("still saved in git stash");
    const commands = execSyncMock.mock.calls.map(([cmd]) => String(cmd));
    expect(commands.filter((cmd) => cmd === "git stash pop")).toHaveLength(1);
    expect(triggerRestartPendingMock).not.toHaveBeenCalled();
  });

  it("leaves production changes stashed when the post-push reset also fails", async () => {
    const mod = await loadStagingToolsModule();
    const deployTool = mod.STAGING_TOOLS.find((tool: { name: string }) => tool.name === "staging_deploy") as any;
    if (!deployTool) throw new Error("staging_deploy tool not found");

    const stagingParent = createTempDir("bridge-stage-parent-");
    const stagingDir = join(stagingParent, "preview-deploy");
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(join(stagingDir, ".gitignore"), "node_modules\n");
    mockDataFilePresence();

    let stashMarker = "";
    execSyncMock.mockImplementation((cmd: string, options?: { cwd?: string }) => {
      const cwd = options?.cwd;
      if (cmd === "git add -A") return "";
      if (cmd === "git --no-pager status --porcelain") return "";
      if (cmd === "git rev-parse --abbrev-ref HEAD") return "main\n";
      if (cmd === "git log main..staging/preview-deploy --oneline") return "abc123 deploy commit\n";
      if (isStashListCommand(cmd)) return stashMarker ? `${DEPLOY_STASH_SHA} On main: ${stashMarker}\n` : "";
      if (isStashPushCommand(cmd)) {
        stashMarker = stashMarkerOf(cmd);
        return `Saved working directory and index state On main: ${stashMarker}\n`;
      }
      if (cmd === "git pull --rebase origin main") return "Already up to date.\n";
      if (cmd === "git rebase main" && cwd === stagingDir) return "";
      if (DEPLOY_VALIDATION_COMMANDS.includes(cmd as (typeof DEPLOY_VALIDATION_COMMANDS)[number])) return "";
      if (cmd === "git rev-parse HEAD") return "1111111111111111111111111111111111111111\n";
      if (cmd === 'git merge "staging/preview-deploy" --no-edit') return "";
      if (cmd === 'git diff "1111111111111111111111111111111111111111" HEAD --name-only -- package.json') return "";
      if (cmd === "git rev-parse --short HEAD") return "1111111\n";
      if (cmd === "git push origin main") {
        const error = new Error("push failed") as Error & { stderr: string };
        error.stderr = "push rejected\n";
        throw error;
      }
      if (cmd === "git reset --hard 1111111111111111111111111111111111111111") {
        const error = new Error("reset failed") as Error & { stderr: string };
        error.stderr = "fatal: Unable to write new index file\n";
        throw error;
      }
      throw new Error(`Unexpected command: ${cmd} (cwd: ${cwd ?? "unknown"})`);
    });

    const result = await deployTool.handler(
      { stagingDir, message: "Deploy that cannot be reverted" },
      {
        sessionId: "session-1",
        toolCallId: "tool-1",
        toolName: "staging_deploy",
        arguments: {},
      } satisfies ToolInvocation,
    ) as any;

    expect(result).toMatchObject({ resultType: "failure" });
    expect(result.stashRestoreFailed).toBeUndefined();
    expect(result.textResultForLlm).toContain("Push to origin failed and production reset failed.");
    expect(result.textResultForLlm).toContain(`Your uncommitted production changes are stashed as '${stashMarker}'`);
    expect(result.textResultForLlm).toContain("restore them only after recovering the checkout");
    const commands = execSyncMock.mock.calls.map(([cmd]) => String(cmd));
    expect(commands).not.toContain("git stash pop");
    expect(triggerRestartPendingMock).not.toHaveBeenCalled();
  });

  it("leaves the deploy stash in place when another stash entry lands on top", async () => {
    const mod = await loadStagingToolsModule();
    const deployTool = mod.STAGING_TOOLS.find((tool: { name: string }) => tool.name === "staging_deploy") as any;
    if (!deployTool) throw new Error("staging_deploy tool not found");

    const stagingParent = createTempDir("bridge-stage-parent-");
    const stagingDir = join(stagingParent, "preview-deploy");
    const concurrentStashSha = "0123456789012345678901234567890123456789";
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(join(stagingDir, ".gitignore"), "node_modules\n");
    mockDataFilePresence();

    let stashMarker = "";
    let stashListCalls = 0;
    execSyncMock.mockImplementation((cmd: string, options?: { cwd?: string }) => {
      const cwd = options?.cwd;
      if (cmd === "git add -A") return "";
      if (cmd === "git --no-pager status --porcelain") return "";
      if (cmd === "git rev-parse --abbrev-ref HEAD") return "main\n";
      if (cmd === "git log main..staging/preview-deploy --oneline") return "abc123 deploy commit\n";
      if (isStashListCommand(cmd)) {
        stashListCalls += 1;
        // Someone else stashes in the production checkout during the deploy
        // window, so this deploy's entry is no longer on top by restore time.
        return stashListCalls === 1
          ? `${DEPLOY_STASH_SHA} On main: ${stashMarker}\n`
          : `${concurrentStashSha} On main: someone else\n${DEPLOY_STASH_SHA} On main: ${stashMarker}\n`;
      }
      if (isStashPushCommand(cmd)) {
        stashMarker = stashMarkerOf(cmd);
        return `Saved working directory and index state On main: ${stashMarker}\n`;
      }
      if (cmd === "git pull --rebase origin main") return "Already up to date.\n";
      if (cmd === "git rebase main" && cwd === stagingDir) return "";
      if (DEPLOY_VALIDATION_COMMANDS.includes(cmd as (typeof DEPLOY_VALIDATION_COMMANDS)[number])) return "";
      if (cmd === "git rev-parse HEAD") return "1111111111111111111111111111111111111111\n";
      if (cmd === 'git merge "staging/preview-deploy" --no-edit') return "";
      if (cmd === 'git diff "1111111111111111111111111111111111111111" HEAD --name-only -- package.json') return "";
      if (cmd === "git rev-parse --short HEAD") return "1111111\n";
      if (cmd === "git push origin main") return "";
      if (cmd === `git worktree remove "${stagingDir}" --force`) return "";
      if (cmd === 'git branch -D "staging/preview-deploy"') return "";
      if (cmd === "git worktree prune") return "";
      throw new Error(`Unexpected command: ${cmd} (cwd: ${cwd ?? "unknown"})`);
    });

    const result = await deployTool.handler(
      { stagingDir, message: "Deploy racing a concurrent stash" },
      {
        sessionId: "session-1",
        toolCallId: "tool-1",
        toolName: "staging_deploy",
        arguments: {},
      } satisfies ToolInvocation,
    ) as any;

    expect(result).toMatchObject({ success: true, commitSha: "1111111", stashRestoreFailed: true });
    expect(result.stashRecoveryWarning).toContain(DEPLOY_STASH_SHA);
    expect(result.stashRecoveryWarning).toContain("no longer the entry");
    expect(result.stashRecoveryWarning).toContain(concurrentStashSha);
    expect(result.content?.[0]?.text).toContain("still saved in git stash");
    const commands = execSyncMock.mock.calls.map(([cmd]) => String(cmd));
    expect(commands).not.toContain("git stash pop");
    expect(triggerRestartPendingMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the deploy stash untouched when the stash list cannot be read after stashing", async () => {
    const mod = await loadStagingToolsModule();
    const deployTool = mod.STAGING_TOOLS.find((tool: { name: string }) => tool.name === "staging_deploy") as any;
    if (!deployTool) throw new Error("staging_deploy tool not found");

    const stagingParent = createTempDir("bridge-stage-parent-");
    const stagingDir = join(stagingParent, "preview-deploy");
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(join(stagingDir, ".gitignore"), "node_modules\n");
    mockDataFilePresence();

    let stashMarker = "";
    execSyncMock.mockImplementation((cmd: string, options?: { cwd?: string }) => {
      const cwd = options?.cwd;
      if (cmd === "git add -A") return "";
      if (cmd === "git --no-pager status --porcelain") return "";
      if (cmd === "git rev-parse --abbrev-ref HEAD") return "main\n";
      if (cmd === "git log main..staging/preview-deploy --oneline") return "abc123 deploy commit\n";
      if (isStashListCommand(cmd)) {
        const error = new Error("git stash list failed") as Error & { stderr: string };
        error.stderr = "fatal: bad object refs/stash\n";
        throw error;
      }
      if (isStashPushCommand(cmd)) {
        stashMarker = stashMarkerOf(cmd);
        return `Saved working directory and index state On main: ${stashMarker}\n`;
      }
      if (cmd === "git pull --rebase origin main") return "Already up to date.\n";
      if (cmd === "git rebase main" && cwd === stagingDir) return "";
      if (cmd === "npm run check:pr") {
        const error = new Error("deploy gate failed") as Error & { stderr: string };
        error.stderr = "deploy gate exploded\n";
        throw error;
      }
      if (DEPLOY_VALIDATION_COMMANDS.includes(cmd as (typeof DEPLOY_VALIDATION_COMMANDS)[number])) return "";
      throw new Error(`Unexpected command: ${cmd} (cwd: ${cwd ?? "unknown"})`);
    });

    const result = await deployTool.handler(
      { stagingDir, message: "Deploy with an unreadable stash list" },
      {
        sessionId: "session-1",
        toolCallId: "tool-1",
        toolName: "staging_deploy",
        arguments: {},
      } satisfies ToolInvocation,
    ) as any;

    expect(result).toMatchObject({ resultType: "failure", stashRestoreFailed: true });
    expect(result.textResultForLlm).toContain("Staging deploy validation failed.");
    expect(result.stashRecoveryWarning).toContain("could not be read after stashing");
    expect(result.stashRecoveryWarning).toContain(stashMarker);
    expect(result.stashRecoveryWarning).toContain("bad object refs/stash");
    const commands = execSyncMock.mock.calls.map(([cmd]) => String(cmd));
    expect(commands).not.toContain("git stash pop");
    expect(triggerRestartPendingMock).not.toHaveBeenCalled();
  });

  it("reports the stranded stash when the stash list read throws after stashing", async () => {
    const mod = await loadStagingToolsModule();
    const deployTool = mod.STAGING_TOOLS.find((tool: { name: string }) => tool.name === "staging_deploy") as any;
    if (!deployTool) throw new Error("staging_deploy tool not found");

    const stagingParent = createTempDir("bridge-stage-parent-");
    const stagingDir = join(stagingParent, "preview-deploy");
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(join(stagingDir, ".gitignore"), "node_modules\n");
    mockDataFilePresence();
    // The command runner itself blows up (not a non-zero exit) right after the
    // stash was created, so the deploy never learns what it stashed.
    stagingLogMock.mockImplementation((message: string) => {
      if (String(message).includes(`$ ${STASH_LIST_COMMAND}`)) throw new Error("log sink exploded");
    });

    let stashMarker = "";
    execSyncMock.mockImplementation((cmd: string, options?: { cwd?: string }) => {
      const cwd = options?.cwd;
      if (cmd === "git add -A") return "";
      if (cmd === "git --no-pager status --porcelain") return "";
      if (cmd === "git rev-parse --abbrev-ref HEAD") return "main\n";
      if (cmd === "git log main..staging/preview-deploy --oneline") return "abc123 deploy commit\n";
      if (isStashPushCommand(cmd)) {
        stashMarker = stashMarkerOf(cmd);
        return `Saved working directory and index state On main: ${stashMarker}\n`;
      }
      throw new Error(`Unexpected command: ${cmd} (cwd: ${cwd ?? "unknown"})`);
    });

    await expect(deployTool.handler(
      { stagingDir, message: "Deploy whose stash list read throws" },
      {
        sessionId: "session-1",
        toolCallId: "tool-1",
        toolName: "staging_deploy",
        arguments: {},
      } satisfies ToolInvocation,
    )).rejects.toThrow(/log sink exploded[\s\S]*may be stashed under the message/);

    expect(stashMarker).not.toBe("");
    const commands = execSyncMock.mock.calls.map(([cmd]) => String(cmd));
    expect(commands).not.toContain("git stash pop");
    expect(triggerRestartPendingMock).not.toHaveBeenCalled();
  });

  it("surfaces the stranded stash when the deploy throws after stashing production", async () => {
    const mod = await loadStagingToolsModule();
    const deployTool = mod.STAGING_TOOLS.find((tool: { name: string }) => tool.name === "staging_deploy") as any;
    if (!deployTool) throw new Error("staging_deploy tool not found");

    const stagingParent = createTempDir("bridge-stage-parent-");
    const stagingDir = join(stagingParent, "preview-deploy");
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(join(stagingDir, ".gitignore"), "node_modules\n");
    mockDataFilePresence();
    prepareReleaseSlotMock.mockImplementationOnce(async () => {
      throw new Error("release slot exploded");
    });

    let stashMarker = "";
    execSyncMock.mockImplementation((cmd: string, options?: { cwd?: string }) => {
      const cwd = options?.cwd;
      if (cmd === "git add -A") return "";
      if (cmd === "git --no-pager status --porcelain") return "";
      if (cmd === "git rev-parse --abbrev-ref HEAD") return "main\n";
      if (cmd === "git log main..staging/preview-deploy --oneline") return "abc123 deploy commit\n";
      if (isStashListCommand(cmd)) return stashMarker ? `${DEPLOY_STASH_SHA} On main: ${stashMarker}\n` : "";
      if (isStashPushCommand(cmd)) {
        stashMarker = stashMarkerOf(cmd);
        return `Saved working directory and index state On main: ${stashMarker}\n`;
      }
      if (cmd === "git stash pop") {
        const error = new Error("git stash pop failed") as Error & { stderr: string };
        error.stderr = "CONFLICT (content): Merge conflict in src/server/db.ts\n";
        throw error;
      }
      if (cmd === "git pull --rebase origin main") return "Already up to date.\n";
      if (cmd === "git rebase main" && cwd === stagingDir) return "";
      if (DEPLOY_VALIDATION_COMMANDS.includes(cmd as (typeof DEPLOY_VALIDATION_COMMANDS)[number])) return "";
      if (cmd === "git rev-parse HEAD") return "1111111111111111111111111111111111111111\n";
      throw new Error(`Unexpected command: ${cmd} (cwd: ${cwd ?? "unknown"})`);
    });

    await expect(deployTool.handler(
      { stagingDir, message: "Deploy that throws mid-flight" },
      {
        sessionId: "session-1",
        toolCallId: "tool-1",
        toolName: "staging_deploy",
        arguments: {},
      } satisfies ToolInvocation,
    )).rejects.toThrow(/release slot exploded[\s\S]*still saved in git stash/);

    const commands = execSyncMock.mock.calls.map(([cmd]) => String(cmd));
    expect(commands.filter((cmd) => cmd === "git stash pop")).toHaveLength(1);
    expect(triggerRestartPendingMock).not.toHaveBeenCalled();
  });

  it("keeps a completed deploy successful when restoring the stash throws", async () => {
    const mod = await loadStagingToolsModule();
    const deployTool = mod.STAGING_TOOLS.find((tool: { name: string }) => tool.name === "staging_deploy") as any;
    if (!deployTool) throw new Error("staging_deploy tool not found");

    const stagingParent = createTempDir("bridge-stage-parent-");
    const stagingDir = join(stagingParent, "preview-deploy");
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(join(stagingDir, ".gitignore"), "node_modules\n");
    mockDataFilePresence();
    // The restore command runner itself blows up (e.g. spawn failure), which is
    // the only way left for the stash restore to throw.
    const defaultSpawn = spawnMock.getMockImplementation();
    spawnMock.mockImplementation((cmd: string, options?: any) => {
      if (cmd === "git stash pop") throw new Error("spawn exploded");
      return defaultSpawn!(cmd, options);
    });

    let stashMarker = "";
    execSyncMock.mockImplementation((cmd: string, options?: { cwd?: string }) => {
      const cwd = options?.cwd;
      if (cmd === "git add -A") return "";
      if (cmd === "git --no-pager status --porcelain") return "";
      if (cmd === "git rev-parse --abbrev-ref HEAD") return "main\n";
      if (cmd === "git log main..staging/preview-deploy --oneline") return "abc123 deploy commit\n";
      if (isStashListCommand(cmd)) return stashMarker ? `${DEPLOY_STASH_SHA} On main: ${stashMarker}\n` : "";
      if (isStashPushCommand(cmd)) {
        stashMarker = stashMarkerOf(cmd);
        return `Saved working directory and index state On main: ${stashMarker}\n`;
      }
      if (cmd === "git pull --rebase origin main") return "Already up to date.\n";
      if (cmd === "git rebase main" && cwd === stagingDir) return "";
      if (DEPLOY_VALIDATION_COMMANDS.includes(cmd as (typeof DEPLOY_VALIDATION_COMMANDS)[number])) return "";
      if (cmd === "git rev-parse HEAD") return "1111111111111111111111111111111111111111\n";
      if (cmd === 'git merge "staging/preview-deploy" --no-edit') return "";
      if (cmd === 'git diff "1111111111111111111111111111111111111111" HEAD --name-only -- package.json') return "";
      if (cmd === "git rev-parse --short HEAD") return "1111111\n";
      if (cmd === "git push origin main") return "";
      if (cmd === `git worktree remove "${stagingDir}" --force`) return "";
      if (cmd === 'git branch -D "staging/preview-deploy"') return "";
      if (cmd === "git worktree prune") return "";
      throw new Error(`Unexpected command: ${cmd} (cwd: ${cwd ?? "unknown"})`);
    });

    const result = await deployTool.handler(
      { stagingDir, message: "Deploy whose stash restore throws" },
      {
        sessionId: "session-1",
        toolCallId: "tool-1",
        toolName: "staging_deploy",
        arguments: {},
      } satisfies ToolInvocation,
    ) as any;

    expect(result).toMatchObject({ success: true, commitSha: "1111111", stashRestoreFailed: true });
    expect(result.stashRecoveryWarning).toContain("threw an unexpected error");
    expect(result.stashRecoveryWarning).toContain("spawn exploded");
    expect(result.content?.[0]?.text).toContain("still saved in git stash");
    expect(triggerRestartPendingMock).toHaveBeenCalledTimes(1);
  });

  it("resets production and blocks push when the merged commit differs from the validated candidate", async () => {
    const mod = await loadStagingToolsModule();
    const deployTool = mod.STAGING_TOOLS.find((tool: { name: string }) => tool.name === "staging_deploy") as any;
    if (!deployTool) throw new Error("staging_deploy tool not found");

    const stagingParent = createTempDir("bridge-stage-parent-");
    const stagingDir = join(stagingParent, "preview-deploy");
    const preDeploySha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const validatedSha = "1111111111111111111111111111111111111111";
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(join(stagingDir, ".gitignore"), "node_modules\n");
    mockDataFilePresence();

    execSyncMock.mockImplementation((cmd: string, options?: { cwd?: string }) => {
      const cwd = options?.cwd;
      if (cmd === "git add -A") return "";
      if (cmd === "git --no-pager status --porcelain") return "";
      if (cmd === "git rev-parse --abbrev-ref HEAD") return "main\n";
      if (cmd === "git log main..staging/preview-deploy --oneline") return "abc123 deploy commit\n";
      if (isStashListCommand(cmd)) return "";
      if (isStashPushCommand(cmd)) return "No local changes to save\n";
      if (cmd === "git pull --rebase origin main") return "Already up to date.\n";
      if (cmd === "git rebase main" && cwd === stagingDir) return "";
      if (DEPLOY_VALIDATION_COMMANDS.includes(cmd as (typeof DEPLOY_VALIDATION_COMMANDS)[number])) return "";
      if (cmd === "git rev-parse HEAD" && cwd === stagingDir) return `${validatedSha}\n`;
      if (cmd === "git rev-parse HEAD") return `${preDeploySha}\n`;
      if (cmd === 'git merge "staging/preview-deploy" --no-edit') return "";
      if (cmd === "git rev-parse --short HEAD") return "2222222\n";
      if (cmd === `git reset --hard ${preDeploySha}`) return "";
      throw new Error(`Unexpected command: ${cmd} (cwd: ${cwd ?? "unknown"})`);
    });

    const result = await deployTool.handler(
      { stagingDir, message: "Deploy raced commit" },
      {
        sessionId: "session-1",
        toolCallId: "tool-1",
        toolName: "staging_deploy",
        arguments: {},
      } satisfies ToolInvocation,
    ) as any;

    expect(result).toMatchObject({ resultType: "failure" });
    expect(result.textResultForLlm).toContain("Production commit changed after validation; restart blocked.");
    expect(result.textResultForLlm).toContain(`reset to ${preDeploySha}`);
    const commands = execSyncMock.mock.calls.map(([cmd]) => String(cmd));
    expect(commands).toContain(`git reset --hard ${preDeploySha}`);
    expect(commands).not.toContain("git push origin main");
    expect(triggerRestartPendingMock).not.toHaveBeenCalled();
    expect(hasRestartSignalWriteAttempt()).toBe(false);
  });

  it("blocks restart if pushed production HEAD differs from the validated release candidate", async () => {
    const mod = await loadStagingToolsModule();
    const deployTool = mod.STAGING_TOOLS.find((tool: { name: string }) => tool.name === "staging_deploy") as any;
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
      if (isStashListCommand(cmd)) return "";
      if (isStashPushCommand(cmd)) return "No local changes to save\n";
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
      if (cmd === "git rev-parse --short HEAD") return "1111111\n";
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
    ) as any;

    expect(result).toMatchObject({ resultType: "failure" });
    expect(result.textResultForLlm).toContain("Pushed production commit does not match the validated release candidate.");
    expect(result.textResultForLlm).toContain("Restart signaling was blocked");
    expect(renameSyncCallMock.mock.calls.some(([, file]) => isDeployValidationStampPath(String(file)))).toBe(false);
    expect(triggerRestartPendingMock).not.toHaveBeenCalled();
    expect(hasRestartSignalWriteAttempt()).toBe(false);
    expect(execSyncMock.mock.calls.map(([cmd]) => String(cmd))).not.toContain(`git worktree remove "${stagingDir}" --force`);
  });

  it("blocks restart when deploy validation fails on the rebased staging tree", async () => {
    const mod = await loadStagingToolsModule();
    const deployTool = mod.STAGING_TOOLS.find((tool: { name: string }) => tool.name === "staging_deploy") as any;
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
      if (isStashListCommand(cmd)) return "";
      if (isStashPushCommand(cmd)) return "No local changes to save\n";
      if (cmd === "git pull --rebase origin main") return "Already up to date.\n";
      if (cmd === "git rebase main" && cwd === stagingDir) return "";
      if (cmd === "npm run check:pr") {
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
      sessionLog: expect.stringContaining("Command: npm run check:pr"),
      toolTelemetry: {
        bridge: {
          command: "npm run check:pr",
          cwd: stagingDir,
          stagingDir,
          prodBranch: "main",
          validationLogPath: expect.stringContaining("validation-logs"),
        },
      },
    });
    expect(result.textResultForLlm).toContain("Staging deploy validation failed.");
    expect(result.textResultForLlm).toContain("deploy validation gate");
    expect(result.textResultForLlm).toContain("retry-after-fix");
    expect(result.textResultForLlm).toContain("deploy gate exploded");
    expect(writeFileSyncCallMock.mock.calls.some(([file]) => isDataFilePath(String(file), "pre-deploy-sha"))).toBe(false);
    expect(hasRestartSignalWriteAttempt()).toBe(false);
    expect(triggerRestartPendingMock).not.toHaveBeenCalled();
    expect(execSyncMock.mock.calls.map(([cmd]) => String(cmd))).not.toContain('git merge "staging/preview-deploy" --no-edit');
  });

  it("blocks restart when pushing the merged production branch fails", async () => {
    const mod = await loadStagingToolsModule();
    const deployTool = mod.STAGING_TOOLS.find((tool: { name: string }) => tool.name === "staging_deploy") as any;
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
      if (isStashListCommand(cmd)) return "";
      if (isStashPushCommand(cmd)) return "No local changes to save\n";
      if (cmd === "git pull --rebase origin main") return "Already up to date.\n";
      if (cmd === "git rebase main" && cwd === stagingDir) return "";
      if (DEPLOY_VALIDATION_COMMANDS.includes(cmd as (typeof DEPLOY_VALIDATION_COMMANDS)[number])) return "";
      if (cmd === "git rev-parse HEAD") return "1111111111111111111111111111111111111111\n";
      if (cmd === 'git merge "staging/preview-deploy" --no-edit') return "";
      if (cmd === 'git diff "1111111111111111111111111111111111111111" HEAD --name-only -- package.json') return "";
      if (cmd === "git rev-parse --short HEAD") return "1111111\n";
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
        bridge: {
          command: "git push origin main",
          stagingDir,
          prodBranch: "main",
          commitSha: "1111111",
          revertedTo: "1111111111111111111111111111111111111111",
          validationLogPath: expect.stringContaining("validation-logs"),
        },
      },
    });
    expect(result.textResultForLlm).toContain("Push to origin failed; production merge reverted and restart blocked.");
    expect(result.textResultForLlm).toContain("reset back to 1111111111111111111111111111111111111111");
    expect(result.textResultForLlm).toContain("push rejected 2");
    expect(pushAttempts).toBe(2);
    expect(triggerRestartPendingMock).not.toHaveBeenCalled();
    expect(hasRestartSignalWriteAttempt()).toBe(false);
    expect(writeFileSyncCallMock.mock.calls.some(([file]) => isDataFilePath(String(file), "pre-deploy-sha"))).toBe(true);
    expect(unlinkSyncCallMock.mock.calls.some(([file]) => isDataFilePath(String(file), "pre-deploy-sha"))).toBe(true);
    expect(execSyncMock.mock.calls.map(([cmd]) => String(cmd))).toContain("git reset --hard 1111111111111111111111111111111111111111");
    expect(execSyncMock.mock.calls.map(([cmd]) => String(cmd))).not.toContain(`git worktree remove "${stagingDir}" --force`);
  });

  it("does not rebase the validated production commit after a push rejection", async () => {
    const mod = await loadStagingToolsModule();
    const deployTool = mod.STAGING_TOOLS.find((tool: { name: string }) => tool.name === "staging_deploy") as any;
    if (!deployTool) throw new Error("staging_deploy tool not found");

    const stagingParent = createTempDir("bridge-stage-parent-");
    const stagingDir = join(stagingParent, "preview-deploy");
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(join(stagingDir, ".gitignore"), "node_modules\n");
    mockDataFilePresence();

    let pullAttempts = 0;
    let pushAttempts = 0;
    execSyncMock.mockImplementation((cmd: string, options?: { cwd?: string }) => {
      const cwd = options?.cwd;
      if (cmd === "git add -A") return "";
      if (cmd === "git --no-pager status --porcelain") return "";
      if (cmd === "git rev-parse --abbrev-ref HEAD") return "main\n";
      if (cmd === "git log main..staging/preview-deploy --oneline") return "abc123 deploy commit\n";
      if (isStashListCommand(cmd)) return "";
      if (isStashPushCommand(cmd)) return "No local changes to save\n";
      if (cmd === "git pull --rebase origin main") {
        pullAttempts += 1;
        return "Already up to date.\n";
      }
      if (cmd === "git rebase main" && cwd === stagingDir) return "";
      if (DEPLOY_VALIDATION_COMMANDS.includes(cmd as (typeof DEPLOY_VALIDATION_COMMANDS)[number])) return "";
      if (cmd === "git rev-parse HEAD") return "1111111111111111111111111111111111111111\n";
      if (cmd === 'git merge "staging/preview-deploy" --no-edit') return "";
      if (cmd === 'git diff "1111111111111111111111111111111111111111" HEAD --name-only -- package.json') return "";
      if (cmd === "git rev-parse --short HEAD") return "1111111\n";
      if (cmd === "git push origin main") {
        pushAttempts += 1;
        const error = new Error("push failed") as Error & { stderr: string };
        error.stderr = "push rejected\n";
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

    expect(result).toMatchObject({ resultType: "failure" });
    expect(triggerRestartPendingMock).not.toHaveBeenCalled();
    const commands = execSyncMock.mock.calls.map(([cmd]) => String(cmd));
    const resetIndex = commands.indexOf("git reset --hard 1111111111111111111111111111111111111111");
    expect(pullAttempts).toBe(1);
    expect(pushAttempts).toBe(2);
    expect(commands).not.toContain("git rebase --abort");
    expect(resetIndex).toBeGreaterThan(-1);
    expect(commands).not.toContain(`git worktree remove "${stagingDir}" --force`);
  });

  it("rejects staging_deploy when a restart is already in flight (signal file present)", async () => {
    mockDataFilePresence({ restartSignal: true });

    const mod = await loadStagingToolsModule();
    const deployTool = mod.STAGING_TOOLS.find((tool: { name: string }) => tool.name === "staging_deploy") as any;
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
      terminal?: boolean;
      toolNextAction?: string;
      retryable?: boolean;
      isError?: boolean;
      content?: Array<{ type: string; text: string }>;
    };

    expect(result.resultType).toBe("failure");
    expect(result.textResultForLlm).toContain("A restart is already pending");
    expect(result.textResultForLlm).not.toContain("Wait for it to complete");
    expect(result.terminal).toBe(true);
    expect(result.toolNextAction).toBe("respond");
    expect(result.retryable).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain('"nextAction":"respond"');
    expect(result.content?.[0]?.text).toContain("end your turn");
    expect(triggerRestartPendingMock).not.toHaveBeenCalled();
    expect(hasRestartSignalWriteAttempt()).toBe(false);
  });

  it("preserves an existing rollback checkpoint during deploy", async () => {
    const mod = await loadStagingToolsModule();
    const deployTool = mod.STAGING_TOOLS.find((tool: { name: string }) => tool.name === "staging_deploy") as any;
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
      if (isStashListCommand(cmd)) return "";
      if (isStashPushCommand(cmd)) return "No local changes to save\n";
      if (cmd === "git pull --rebase origin main") return "Already up to date.\n";
      if (cmd === "git rebase main" && cwd === stagingDir) return "";
      if (DEPLOY_VALIDATION_COMMANDS.includes(cmd as (typeof DEPLOY_VALIDATION_COMMANDS)[number])) return "";
      if (cmd === "git rev-parse HEAD") return "1111111111111111111111111111111111111111\n";
      if (cmd === 'git merge "staging/preview-deploy" --no-edit') return "";
      if (cmd === 'git diff "1111111111111111111111111111111111111111" HEAD --name-only -- package.json') return "";
      if (cmd === "git rev-parse --short HEAD") return "1111111\n";
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
    const deployTool = mod.STAGING_TOOLS.find((tool: { name: string }) => tool.name === "staging_deploy") as any;
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
      if (isStashListCommand(cmd)) return "";
      if (isStashPushCommand(cmd)) return "No local changes to save\n";
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
        bridge: {
          command: "npm run check:pr",
          cwd: stagingDir,
          stagingDir,
        },
      },
    });
    expect(result.textResultForLlm).toContain("Staging preview validation failed.");
    expect(result.textResultForLlm).toContain("The staged changes did not pass the preview validation gate.");
    expect(result.textResultForLlm).toContain("1 failed");
    expect(result.textResultForLlm).toContain("Full command output:");
    expect(result.textResultForLlm).not.toContain("Command exited with code 1.");
    expect(result).not.toHaveProperty("error");
  });

  it("surfaces validation log write errors in staging command telemetry", async () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd === "npm run check:pr") {
        const error = new Error("PR gate failed") as Error & { stderr: string };
        error.stderr = "validation failed\n";
        throw error;
      }
      return "";
    });
    writeFileSyncCallMock.mockImplementation((file) => {
      if (isValidationLogPath(String(file))) {
        throw new Error("disk full");
      }
    });

    const tools = await loadStagingTools();
    const stagingDir = createTempDir("bridge-stage-preview-log-error-");
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
        bridge: {
          command: "npm run check:pr",
          cwd: stagingDir,
          stagingDir,
          validationLogWriteError: "disk full",
        },
      },
    });
    expect(result.toolTelemetry.bridge).not.toHaveProperty("validationLogPath");
    expect(result.textResultForLlm).toContain("Unable to write full command output: disk full");
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
        bridge: {
          command: "npm run check:pr",
          cwd: stagingDir,
          stagingDir,
        },
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
        bridge: {
          command: "npm install --no-audit --no-fund --include=dev",
          cwd: stagingDir,
          stagingDir,
        },
      },
    });
    expect(result.textResultForLlm).toContain("Staging dependency install failed.");
    expect(result.textResultForLlm).toContain("Fix the staging worktree dependencies and retry.");
    expect(result.textResultForLlm).toContain("npm ERR! install exploded");
    expect(createDirectoryLinkMock).not.toHaveBeenCalled();
    expect(execSyncMock.mock.calls.map(([cmd]) => String(cmd))).not.toContain("npm run test:xplat-audit");
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

  it("prepares isolated data before a lazy staging preview is reported ready", async () => {
    const mod = await loadStagingToolsModule();
    const stagingDir = createTempDir("bridge-stage-preview-seed-");
    const seedPreviewData = vi.fn<(target: string) => void>();
    const logs: string[] = [];

    const result = await mod.runStagingPreviewJob(
      { stagingDir, validate: false },
      {
        startBackend: false,
        registerInProcess: false,
        seedPreviewData,
        log: (message) => logs.push(message),
      },
    );

    expect(seedPreviewData).toHaveBeenCalledOnce();
    expect(seedPreviewData).toHaveBeenCalledWith(stagingDir);
    expect(result).toMatchObject({ success: true });
    expect(logs).toContain("Preparing isolated staging data snapshot...");
    expect(logs).toContain("Isolated staging data snapshot ready.");
    expect(logs.at(-1)).toContain("Staging preview ready at");
  });

  it("fails a lazy staging preview when isolated data preparation fails", async () => {
    const mod = await loadStagingToolsModule();
    const stagingDir = createTempDir("bridge-stage-preview-seed-failure-");
    const logs: string[] = [];

    const result = await mod.runStagingPreviewJob(
      { stagingDir, validate: false },
      {
        startBackend: false,
        registerInProcess: false,
        seedPreviewData: () => {
          throw new Error("snapshot failed");
        },
        log: (message) => logs.push(message),
      },
    );

    expect(result).toMatchObject({
      resultType: "failure",
      toolTelemetry: {
        bridge: {
          stagingDir,
          previewPath: `/staging/${basename(stagingDir)}/`,
        },
      },
    });
    expect(result.textResultForLlm).toContain("Staging preview data preparation failed.");
    expect(result.textResultForLlm).toContain("snapshot failed");
    expect(logs.some((message) => message.startsWith("Staging preview ready at"))).toBe(false);
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
      if (isStashListCommand(cmd)) return "";
      if (isStashPushCommand(cmd)) return "No local changes to save\n";
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
        bridge: {
          command: "git rebase main",
          cwd: stagingDir,
          stagingDir,
          prodBranch: "main",
        },
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
    const deployTool = mod.STAGING_TOOLS.find((tool: { name: string }) => tool.name === "staging_deploy") as any;
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
      if (isStashListCommand(cmd)) return "";
      if (isStashPushCommand(cmd)) return "No local changes to save\n";
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
    for (const [, argsOrOptions, maybeOptions] of deployValidationSpawnCalls) {
      const options = (Array.isArray(argsOrOptions) ? maybeOptions : argsOrOptions) as MockSpawnOptions | undefined;
      expectIsolatedValidationEnv(options?.env);
    }

    // pre-deploy-sha checkpoint must be written before the atomic restart-signal temp
    const writtenPaths = writeFileSyncCallMock.mock.calls.map(([file]) => String(file));
    const checkpointWriteIndex = writtenPaths.findIndex((p) => isDataFilePath(p, "pre-deploy-sha"));
    const signalWriteIndex = writtenPaths.findIndex((p) => isRestartSignalTempPath(p));
    expect(checkpointWriteIndex, "pre-deploy-sha must be written").toBeGreaterThan(-1);
    expect(signalWriteIndex, "restart signal temp must be written").toBeGreaterThan(-1);
    expect(checkpointWriteIndex).toBeLessThan(signalWriteIndex);
    expect(triggerRestartPendingMock.mock.invocationCallOrder[0]).toBeLessThan(
      writeFileSyncCallMock.mock.invocationCallOrder[signalWriteIndex],
    );
  });
});

describe("staging preview cleanup hardening", () => {
  it("clears in-memory preview data dir state even when removePreviewData throws", async () => {
    const mod = await loadStagingToolsModule();
    mod.__testing.backendManager.resetBackendState();

    const prefix = "preview-data-throws";
    const dataDir = createTempDir("bridge-preview-data-throw-");
    mod.__testing.backendManager.seedPreviewDataDir(prefix, dataDir);
    rmSyncThrowDirs.add(dataDir);

    await expect(
      mod.__testing.cleanupStagingBackendResources(prefix, { removeData: true }),
    ).resolves.toBeUndefined();

    // The in-memory entry is cleared even though the on-disk removal failed.
    expect(mod.__testing.backendManager.hasPreviewDataDir(prefix)).toBe(false);
    // The data dir still exists because rmSync threw — removal was attempted.
    expect(existsSync(dataDir)).toBe(true);
    expect(stagingLogMock).toHaveBeenCalledWith(
      expect.stringContaining(`failed to remove preview data for ${prefix}`),
    );
  });

  it("keeps cleaning later previews when one preview's data removal throws or backend cleanup throws", async () => {
    // Data removal throws: loop continues to next preview
    const mod1 = await loadStagingToolsModule();
    mod1.__testing.backendManager.resetBackendState();
    mod1.__testing.resetActivePreviews();

    const failingPrefix1 = "preview-fails";
    const followingPrefix1 = "preview-follows";
    const failingDist1 = join(createTempDir("bridge-preview-dist-fail-"), "missing-dist");
    const followingDist1 = join(createTempDir("bridge-preview-dist-follow-"), "missing-dist");
    const failingDataDir1 = createTempDir("bridge-preview-data-fail-");
    const followingDataDir1 = createTempDir("bridge-preview-data-follow-");

    mod1.__testing.seedActivePreview(failingPrefix1, failingDist1);
    mod1.__testing.seedActivePreview(followingPrefix1, followingDist1);
    mod1.__testing.backendManager.seedPreviewDataDir(failingPrefix1, failingDataDir1);
    mod1.__testing.backendManager.seedPreviewDataDir(followingPrefix1, followingDataDir1);
    rmSyncThrowDirs.add(failingDataDir1);

    const writeLog1 = vi.fn<(msg: string) => void>();
    await expect(mod1.__testing.cleanupMissingRegisteredPreviews(writeLog1)).resolves.toBeUndefined();

    expect(mod1.__testing.backendManager.hasPreviewDataDir(failingPrefix1)).toBe(false);
    expect(mod1.__testing.hasActivePreview(failingPrefix1)).toBe(false);
    expect(existsSync(failingDataDir1)).toBe(true);
    expect(mod1.__testing.backendManager.hasPreviewDataDir(followingPrefix1)).toBe(false);
    expect(mod1.__testing.hasActivePreview(followingPrefix1)).toBe(false);
    expect(existsSync(followingDataDir1)).toBe(false);
    expect(stagingLogMock).toHaveBeenCalledWith(
      expect.stringContaining(`failed to remove preview data for ${failingPrefix1}`),
    );

    // Backend cleanup throws: loop continues and marks active preview as gone
    const mod2 = await loadStagingToolsModule();
    mod2.__testing.backendManager.resetBackendState();
    mod2.__testing.resetActivePreviews();

    const backendMod = await import("../staging-backend-manager.js");
    const failingPrefix2 = "preview-cleanup-throws";
    const followingPrefix2 = "preview-cleanup-ok";
    const failingDist2 = join(createTempDir("bridge-preview-dist-cleanup-fail-"), "missing-dist");
    const followingDist2 = join(createTempDir("bridge-preview-dist-cleanup-ok-"), "missing-dist");

    mod2.__testing.seedActivePreview(failingPrefix2, failingDist2);
    mod2.__testing.seedActivePreview(followingPrefix2, followingDist2);

    const cleanupSpy = vi
      .spyOn(backendMod, "cleanupStagingBackendResources")
      .mockImplementation(async (prefix: string) => {
        if (prefix === failingPrefix2) throw new Error("teardown failed");
      });

    const writeLog2 = vi.fn<(msg: string) => void>();

    try {
      await expect(mod2.__testing.cleanupMissingRegisteredPreviews(writeLog2)).resolves.toBeUndefined();

      expect(cleanupSpy).toHaveBeenCalledWith(failingPrefix2);
      expect(cleanupSpy).toHaveBeenCalledWith(followingPrefix2);
      expect(mod2.__testing.hasActivePreview(failingPrefix2)).toBe(false);
      expect(mod2.__testing.hasActivePreview(followingPrefix2)).toBe(false);
      expect(writeLog2).toHaveBeenCalledWith(
        expect.stringContaining(`cleanup for disappeared staging preview ${failingPrefix2} failed`),
      );
    } finally {
      cleanupSpy.mockRestore();
    }
  });
});

describe("staging preview event-driven discovery", () => {
  type FakeJob = {
    id: string;
    type: "staging_preview" | "staging_deploy" | "self_update";
    status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
    input: unknown;
    createdAt: string;
    updatedAt: string;
  };

  function createFakeJobStore(job: FakeJob) {
    let current = job;
    return {
      store: {
        get: (id: string) => (id === current.id ? current as any : null),
        listActive: () =>
          (current.status === "queued" || current.status === "running" ? [current as any] : []),
      } as any,
      complete(status: FakeJob["status"] = "succeeded") {
        current = { ...current, status, updatedAt: new Date().toISOString() };
      },
      get job() {
        return current as any;
      },
    };
  }

  function makePreviewJob(stagingDir: string): FakeJob {
    const createdAt = new Date().toISOString();
    return {
      id: "preview-job-1",
      type: "staging_preview",
      status: "queued",
      input: { stagingDir, validate: true },
      createdAt,
      updatedAt: createdAt,
    };
  }

  it("serves a runner-built preview once its management job completes", async () => {
    vi.stubEnv("BRIDGE_DISTRIBUTION_MODE", "development");
    vi.stubEnv("BRIDGE_STAGING_BACKEND_STARTUP_RESTORE_LIMIT", "0");
    const previewParent = createTempDir("bridge-stage-preview-root-");
    const mod = await loadStagingToolsModule({ previewParent });
    mod.__testing.resetActivePreviews();

    const stagingParent = createTempDir("bridge-stage-parent-");
    const prefix = "preview-job-built";
    const stagingDir = join(stagingParent, prefix);
    const distDir = join(previewParent, prefix);
    mkdirSync(stagingDir, { recursive: true });

    const app = createStagingPreviewTestApp(mod);
    const fake = createFakeJobStore(makePreviewJob(stagingDir));

    vi.useFakeTimers();
    try {
      const controller = mod.startStagingPreviewDiscovery({ store: fake.store, pollIntervalMs: 50 });
      expect(controller).not.toBeNull();
      controller!.watchJob(fake.job);

      // Nothing is registered while the runner is still building.
      await advanceTimersAndSettle(50, () => controller!.settle());
      expect(mod.getActivePreviews().has(prefix)).toBe(false);

      // The runner process writes the build, then marks the job terminal.
      mkdirSync(distDir, { recursive: true });
      writeFileSync(join(distDir, "index.html"), "<!doctype html><p>runner built preview</p>");
      fake.complete("succeeded");

      await advanceTimersAndSettle(50, () => controller!.settle());

      expect(mod.getActivePreviews().get(prefix)).toBe(distDir);
      expect(mod.getStagingRouter(prefix)).toEqual(expect.any(Function));
      // Discovery is finished: no repeating timer is left behind.
      expect(controller!.watchedJobIds()).toEqual([]);
      expect(controller!.hasScheduledWork()).toBe(false);
      expect(vi.getTimerCount()).toBe(0);

      vi.useRealTimers();
      const response = await request(app).get(`/staging/${prefix}/`);
      expect(response.status).toBe(200);
      expect(response.text).toContain("runner built preview");
      controller!.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("unregisters a preview whose dist disappeared when a job completes", async () => {
    vi.stubEnv("BRIDGE_DISTRIBUTION_MODE", "development");
    const previewParent = createTempDir("bridge-stage-preview-root-");
    const mod = await loadStagingToolsModule({ previewParent });
    mod.__testing.resetActivePreviews();
    mod.__testing.backendManager.resetBackendState();

    const prefix = "preview-deployed-away";
    const distDir = join(previewParent, prefix);
    mod.__testing.seedActivePreview(prefix, distDir);
    expect(mod.__testing.hasActivePreview(prefix)).toBe(true);

    const deployJob: FakeJob = {
      id: "deploy-job-1",
      type: "staging_deploy",
      status: "running",
      input: { stagingDir: join("unused", prefix), message: "ship it" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const fake = createFakeJobStore(deployJob);

    vi.useFakeTimers();
    try {
      const controller = mod.startStagingPreviewDiscovery({ store: fake.store, pollIntervalMs: 50 });
      controller!.watchJob(fake.job);
      fake.complete("succeeded");
      await advanceTimersAndSettle(50, () => controller!.settle());

      expect(mod.__testing.hasActivePreview(prefix)).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      controller!.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops the stale staged backend when a preview is rebuilt", async () => {
    vi.stubEnv("BRIDGE_DISTRIBUTION_MODE", "development");
    vi.stubEnv("BRIDGE_STAGING_BACKEND_STARTUP_RESTORE_LIMIT", "0");
    const previewParent = createTempDir("bridge-stage-preview-root-");
    const mod = await loadStagingToolsModule({ previewParent });
    mod.__testing.resetActivePreviews();
    mod.__testing.backendManager.resetBackendState();

    const backendMod = await import("../staging-backend-manager.js");
    const stagingParent = createTempDir("bridge-stage-parent-");
    const prefix = "preview-rebuilt";
    const stagingDir = join(stagingParent, prefix);
    const distDir = join(previewParent, prefix);
    mkdirSync(stagingDir, { recursive: true });
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, "index.html"), "<!doctype html><p>rebuilt</p>");

    createStagingPreviewTestApp(mod);
    mod.registerExistingPreviewsFromDisk({ stagingParent, stagingPreviewParents: [previewParent] });
    // A staged backend is live for the previous build of this same prefix.
    mod.__testing.backendManager.seedPreviewDataDir(prefix, createTempDir("bridge-preview-data-"));
    expect(mod.__testing.backendManager.ensureLazyRouter(prefix)).toBe(true);
    expect(mod.__testing.backendManager.hasRestorableTarget(prefix)).toBe(true);

    // Spy through to the real cleanup so the invalidate → re-register cycle is
    // exercised end to end; record the state observed mid-cycle.
    const actualCleanup = backendMod.cleanupStagingBackendResources;
    const midCycleRestorable: boolean[] = [];
    const cleanupSpy = vi
      .spyOn(backendMod, "cleanupStagingBackendResources")
      .mockImplementation(async (cleanupPrefix: string, cleanupOptions?: { removeData?: boolean }) => {
        await actualCleanup(cleanupPrefix, cleanupOptions);
        midCycleRestorable.push(mod.__testing.backendManager.hasRestorableTarget(cleanupPrefix));
      });
    const fake = createFakeJobStore(makePreviewJob(stagingDir));

    vi.useFakeTimers();
    try {
      const controller = mod.startStagingPreviewDiscovery({ store: fake.store, pollIntervalMs: 50 });
      controller!.watchJob(fake.job);
      fake.complete("succeeded");
      await advanceTimersAndSettle(50, () => controller!.settle());

      // The old child process is torn down (its seeded data is preserved) so the
      // next request lazily restores a backend running the rebuilt code.
      expect(cleanupSpy).toHaveBeenCalledWith(prefix, { removeData: false });
      expect(midCycleRestorable).toEqual([false]);
      expect(mod.__testing.backendManager.hasLazyRouter(prefix)).toBe(false);
      expect(mod.__testing.backendManager.hasPreviewDataDir(prefix)).toBe(true);

      // The same discovery pass re-registers the preview from the rebuilt dist.
      expect(mod.__testing.backendManager.hasRestorableTarget(prefix)).toBe(true);
      expect(mod.getActivePreviews().get(prefix)).toBe(distDir);
      expect(mod.getStagingRouter(prefix)).toEqual(expect.any(Function));
      expect(vi.getTimerCount()).toBe(0);
      controller!.stop();
    } finally {
      vi.useRealTimers();
      cleanupSpy.mockRestore();
    }
  });

  it("serves a preview registered from a real management job committed by the runner connection", async () => {
    vi.stubEnv("BRIDGE_DISTRIBUTION_MODE", "development");
    vi.stubEnv("BRIDGE_STAGING_BACKEND_STARTUP_RESTORE_LIMIT", "0");
    const previewParent = createTempDir("bridge-stage-preview-root-");
    const mod = await loadStagingToolsModule({ previewParent });
    mod.__testing.resetActivePreviews();
    mod.__testing.backendManager.resetBackendState();

    const { openDatabase } = await import("../db.js");
    const { createManagementJobStore } = await import("../management-job-store.js");
    const jobDataDir = createTempDir("bridge-stage-jobs-");
    // Two connections to one database, exactly like the runner and the live server.
    const runnerDb = openDatabase(jobDataDir);
    const serverDb = openDatabase(jobDataDir);
    const runnerStore = createManagementJobStore(runnerDb, { dataDir: jobDataDir });
    const serverStore = createManagementJobStore(serverDb, { dataDir: jobDataDir });

    const stagingParent = createTempDir("bridge-stage-parent-");
    const prefix = "preview-cross-process";
    const stagingDir = join(stagingParent, prefix);
    const distDir = join(previewParent, prefix);
    mkdirSync(stagingDir, { recursive: true });

    const app = createStagingPreviewTestApp(mod);

    vi.useFakeTimers();
    try {
      const controller = mod.startStagingPreviewDiscovery({ store: serverStore, pollIntervalMs: 50 });
      const job = serverStore.enqueue("staging_preview", { stagingDir, validate: true });
      controller!.watchJob(job);

      // The runner claims and builds; the live server sees nothing yet.
      runnerStore.claimNext({ runnerPid: 4242 });
      await advanceTimersAndSettle(50, () => controller!.settle());
      expect(mod.getActivePreviews().has(prefix)).toBe(false);

      mkdirSync(distDir, { recursive: true });
      writeFileSync(join(distDir, "index.html"), "<!doctype html><p>cross process preview</p>");
      runnerStore.succeed(job.id, { previewPath: `/staging/${prefix}/` });

      await advanceTimersAndSettle(50, () => controller!.settle());

      expect(mod.getActivePreviews().get(prefix)).toBe(distDir);
      expect(controller!.hasScheduledWork()).toBe(false);
      expect(vi.getTimerCount()).toBe(0);

      vi.useRealTimers();
      const response = await request(app).get(`/staging/${prefix}/`);
      expect(response.status).toBe(200);
      expect(response.text).toContain("cross process preview");
      controller!.stop();
    } finally {
      vi.useRealTimers();
      runnerDb.close();
      serverDb.close();
    }
  });

  it("does not start discovery when staging artifacts are not managed", async () => {
    vi.stubEnv("BRIDGE_DISTRIBUTION_MODE", "release");
    vi.stubEnv("BRIDGE_ACTIVE_RELEASE_ROOT", undefined);
    vi.stubEnv("BRIDGE_CONTROL_DISTRIBUTION_MODE", undefined);
    const mod = await loadStagingToolsModule();
    const fake = createFakeJobStore(makePreviewJob(join("staging", "release-mode")));

    expect(mod.shouldManageStagingArtifacts()).toBe(false);
    expect(mod.startStagingPreviewDiscovery({ store: fake.store })).toBeNull();
    expect(mod.startStagingPreviewDiscovery({ store: undefined })).toBeNull();
  });

  it("reports registered previews whose built assets are gone", async () => {
    const previewParent = createTempDir("bridge-stage-preview-root-");
    const mod = await loadStagingToolsModule({ previewParent });
    mod.__testing.resetActivePreviews();

    const livePrefix = "preview-live";
    const liveDist = join(previewParent, livePrefix);
    mkdirSync(liveDist, { recursive: true });
    writeFileSync(join(liveDist, "index.html"), "<!doctype html>");
    mod.__testing.seedActivePreview(livePrefix, liveDist);
    mod.__testing.seedActivePreview("preview-gone", join(previewParent, "preview-gone"));

    expect(mod.isRegisteredStagingPreviewMissing(livePrefix)).toBe(false);
    expect(mod.isRegisteredStagingPreviewMissing("preview-gone")).toBe(true);
    // Unknown prefixes are not "missing" — they were never registered here.
    expect(mod.isRegisteredStagingPreviewMissing("preview-unknown")).toBe(false);
  });
});

describe("staging fresh-install node_modules link handling", () => {
  it("aborts the fresh install when the node_modules symlink cannot be removed and proceeds once it is removed", async () => {
    const mod = await loadStagingToolsModule();

    // Abort path: symlink removal fails
    const stagingDir1 = createTempDir("bridge-stage-deps-fail-");
    // Different hashes force the fresh-install path.
    dependencySyncHashMock.mockImplementation((path: string) => (path === stagingDir1 ? "staged" : "production"));
    existsSyncOverrideMock.mockImplementation((path) =>
      String(path) === join(stagingDir1, "node_modules") ? true : undefined);
    lstatSyncOverrideMock.mockImplementation((path) =>
      String(path) === join(stagingDir1, "node_modules") ? { isSymbolicLink: () => true } : undefined);
    removeDirectoryLinkMock.mockReturnValue({ ok: false, output: "EPERM: operation not permitted" });

    const runCommand1 = vi.fn(async () => ({ ok: true, output: "" }));
    const writeLog1 = vi.fn();

    const result1 = await mod.ensureStagingDeps(stagingDir1, { runCommand: runCommand1, log: writeLog1 });

    expect(result1, "abort: should fail").toMatchObject({ ok: false });
    expect(result1.output, "abort: should contain error").toContain("EPERM: operation not permitted");
    // Critically: npm install never runs over the still-present symlink, which
    // would resolve into production's node_modules.
    expect(runCommand1, "abort: npm should not run").not.toHaveBeenCalled();
    expect(preparePatchedPackagesForInstallMock, "abort: no patched packages").not.toHaveBeenCalled();

    // Proceed path: symlink is removed successfully
    const stagingDir2 = createTempDir("bridge-stage-deps-ok-");
    dependencySyncHashMock.mockImplementation((path: string) => (path === stagingDir2 ? "staged" : "production"));
    existsSyncOverrideMock.mockImplementation((path) =>
      String(path) === join(stagingDir2, "node_modules") ? true : undefined);
    lstatSyncOverrideMock.mockImplementation((path) =>
      String(path) === join(stagingDir2, "node_modules") ? { isSymbolicLink: () => true } : undefined);
    removeDirectoryLinkMock.mockReturnValue({ ok: true, output: "" });

    const runCommand2 = vi.fn(async () => ({ ok: true, output: "installed" }));
    const writeLog2 = vi.fn();

    const result2 = await mod.ensureStagingDeps(stagingDir2, { runCommand: runCommand2, log: writeLog2 });

    expect(result2, "proceed: should succeed").toMatchObject({ ok: true });
    expect(runCommand2, "proceed: npm should run once").toHaveBeenCalledTimes(1);
    expect(writeLog2, "proceed: should log symlink removal").toHaveBeenCalledWith("Removed node_modules symlink for fresh install");
  });

  it("keeps the production node_modules link when the launcher's recorded install matches production", async () => {
    const mod = await loadStagingToolsModule();
    const stagingDir = createTempDir("bridge-stage-deps-linked-");
    dependencySyncHashMock.mockReturnValue("same-hash");
    readInstalledDependencyHashMock.mockReturnValue("same-hash");
    const runCommand = vi.fn(async () => ({ ok: true, output: "" }));

    const result = await mod.ensureStagingDeps(stagingDir, { runCommand, log: vi.fn() });

    expect(result).toEqual({ ok: true });
    expect(runCommand).not.toHaveBeenCalled();
    expect(preparePatchedPackagesForInstallMock).not.toHaveBeenCalled();
  });

  it("installs in staging when production node_modules lag the production dependency inputs", async () => {
    const mod = await loadStagingToolsModule();
    const stagingDir = createTempDir("bridge-stage-deps-lagging-");
    // Staging matches production source, but the launcher last installed older inputs
    // (it activated a prepared release slot without rebuilding the production root).
    dependencySyncHashMock.mockReturnValue("same-hash");
    readInstalledDependencyHashMock.mockReturnValue("older-hash");
    existsSyncOverrideMock.mockImplementation((path) =>
      String(path) === join(stagingDir, "node_modules") ? true : undefined);
    lstatSyncOverrideMock.mockImplementation((path) =>
      String(path) === join(stagingDir, "node_modules") ? { isSymbolicLink: () => true } : undefined);
    removeDirectoryLinkMock.mockReturnValue({ ok: true, output: "" });
    const runCommand = vi.fn(async () => ({ ok: true, output: "installed" }));
    const writeLog = vi.fn();

    const result = await mod.ensureStagingDeps(stagingDir, { runCommand, log: writeLog });

    expect(result).toMatchObject({ ok: true });
    expect(writeLog).toHaveBeenCalledWith(
      "Production node_modules lag the production dependency inputs — installing dependencies in staging...",
    );
    expect(removeDirectoryLinkMock).toHaveBeenCalledWith(join(stagingDir, "node_modules"), expect.any(String));
    expect(runCommand).toHaveBeenCalledTimes(1);
  });
});

describe("staging seed runtime isolation", () => {
  it("aborts seeding and discards the snapshot when runtime isolation fails", async () => {
    const mod = await loadStagingToolsModule();
    const productionDataDir = createProductionDataDir();
    const stagingDir = createTempDir("bridge-stage-isolation-fail-");

    // A production database without a `schedules` table makes the required
    // isolation statement fail. Previously this was downgraded to a warning and
    // the preview started with live push subscriptions still present.
    const prodDb = new DatabaseSync(join(productionDataDir, "bridge.db"));
    try {
      prodDb.exec("DROP TABLE schedules");
    } finally {
      prodDb.close();
    }

    expect(() => mod.__testing.seedStagingData(stagingDir, { productionDataDir }))
      .toThrow(/Unable to isolate staging runtime state/);

    // The half-isolated snapshot must not be left behind for a preview to use.
    expect(existsSync(join(stagingDir, "data", "bridge.db"))).toBe(false);
  });

  it("clears push subscriptions and disables schedules atomically", async () => {
    const mod = await loadStagingToolsModule();
    const productionDataDir = createProductionDataDir();
    const stagingDir = createTempDir("bridge-stage-isolation-ok-");

    const seededDataDir = mod.__testing.seedStagingData(stagingDir, { productionDataDir });
    const stagingDb = new DatabaseSync(join(seededDataDir, "bridge.db"));
    try {
      expect(stagingDb.prepare("SELECT enabled FROM schedules").all()).toEqual([{ enabled: 0 }]);
      expect(stagingDb.prepare("SELECT COUNT(*) AS count FROM push_subscriptions").get())
        .toEqual({ count: 0 });
    } finally {
      stagingDb.close();
    }
  });
});

describe("deploy commit message", () => {
  it("writes the supplied message verbatim without adding a co-author trailer", async () => {
    const mod = await loadStagingToolsModule();
    const deployTool = mod.STAGING_TOOLS.find((tool: { name: string }) => tool.name === "staging_deploy") as any;
    if (!deployTool) throw new Error("staging_deploy tool not found");

    const stagingParent = createTempDir("bridge-stage-msg-");
    const stagingDir = join(stagingParent, "preview-msg");
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(join(stagingDir, ".gitignore"), "node_modules\n");
    mockDataFilePresence();

    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd === "git --no-pager status --porcelain") return " M src/server/staging-tools.ts\n";
      return "";
    });

    const message = "Subject line\n\nBody paragraph.\n\nCo-authored-by: Someone <someone@example.com>";
    await deployTool.handler(
      { stagingDir, message },
      {
        sessionId: "session-deploy-msg",
        toolCallId: "deploy-msg",
        toolName: "staging_deploy",
        arguments: {},
      } satisfies ToolInvocation,
    );

    const commitMsgWrite = writeFileSyncCallMock.mock.calls.find(
      ([file]) => basename(String(file)) === ".commit-msg",
    );
    expect(commitMsgWrite).toBeDefined();
    expect(String(commitMsgWrite![1])).toBe(`${message}\n`);
  });
});
