import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import request from "./test-http.js";
import { advanceTimersAndSettle } from "./helpers.js";
import {
  PREVIEW_GATE_COMMAND,
  PREVIEW_VALIDATION_COMMANDS,
  createProductionDataDir,
  createStagingPreviewTestApp,
  createTempDir,
  loadStagingTools,
  loadStagingToolsModule,
  publishTestPreviewGeneration,
  removedTrees,
  successfulCommandOutput,
  toolInvocation,
  useStagingToolsTestEnvironment,
} from "./staging-tools-harness.js";
import {
  captureProcessIdentityMock,
  createDirectoryLinkMock,
  dependencySyncHashMock,
  execSyncMock,
  existsSyncOverrideMock,
  isStagingValidationStampPath,
  isValidationLogPath,
  lstatSyncOverrideMock,
  preparePatchedPackagesForInstallMock,
  readFileSyncOverrideMock,
  removeDirectoryLinkMock,
  renameSyncCallMock,
  rmSyncThrowDirs,
  spawnMock,
  stagingLogMock,
  terminateProcessTreeMock,
  writeFileSyncCallMock,
} from "./staging-tools-mocks.js";

// Each staging-tools test file registers the shared mocks itself; vi.mock only applies to the file it is in.
const mocks = await vi.hoisted(() => import("./staging-tools-mocks.js"));
vi.mock("@github/copilot-sdk", () => mocks.copilotSdkModule);
vi.mock("node:child_process", async (importOriginal) => mocks.mockChildProcess(await importOriginal()));
vi.mock("node:fs", async (importOriginal) => mocks.mockNodeFs(await importOriginal()));
vi.mock("../restart-signal.js", async (importOriginal) => mocks.mockRestartSignal(await importOriginal()));
vi.mock("../dependency-sync.js", () => mocks.dependencySyncModule);
vi.mock("../release-slots.js", () => mocks.releaseSlotsModule);
vi.mock("../platform.js", () => mocks.platformModule);
vi.mock("../public-url.js", () => mocks.publicUrlModule);
vi.mock("../config.js", () => mocks.configModule);
vi.mock("../staging-log.js", () => mocks.stagingLogModule);

useStagingToolsTestEnvironment();

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

  it("creates staging worktrees without linking production dependencies", async () => {
    execSyncMock.mockImplementation((command: string) => (
      command === "git rev-parse --abbrev-ref HEAD"
        ? "master\n"
        : successfulCommandOutput(command)
    ));
    // Worktrees go beside the control root. Pin it so this test cannot touch the real checkout's parent.
    const sandbox = createTempDir("bridge-stage-init-");
    vi.stubEnv("BRIDGE_CONTROL_ROOT", join(sandbox, "production"));
    const tools = await loadStagingTools();

    const result = await tools.staging_init.handler(
      {},
      toolInvocation("staging_init", { sessionId: "session-init", toolCallId: "tool-init" }),
    ) as any;

    expect(result).toMatchObject({
      success: true,
      message: expect.stringContaining("Dependencies are isolated per worktree"),
    });
    expect(result.stagingDir.startsWith(join(sandbox, "bridge-staging"))).toBe(true);
    // `git worktree add` creates missing parents itself; with git mocked, nothing else may.
    expect(existsSync(join(sandbox, "bridge-staging"))).toBe(false);
    expect(createDirectoryLinkMock).not.toHaveBeenCalled();
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

    await mod.removePreviewData(dataDir);

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
    expect(spawnConfig.env.BRIDGE_STAGING_MODEL).toBe("gpt-6-luna");
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
      expect(settings.model).toBe("gpt-6-luna");
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

  it("starts a preview without production's search index", async () => {
    const mod = await loadStagingToolsModule();
    const productionDataDir = createProductionDataDir();
    const stagingDir = createTempDir("bridge-stage-staging-");
    const indexedMessages = (db: DatabaseSync) =>
      (db.prepare("SELECT COUNT(*) AS count FROM search_chat_messages").get() as { count: number }).count;
    const productionDb = new DatabaseSync(join(productionDataDir, "bridge.db"));
    try {
      productionDb.exec(`
        CREATE TABLE search_indexed_sessions (
          sessionId TEXT PRIMARY KEY, size INTEGER NOT NULL, mtimeMs REAL NOT NULL,
          ctimeMs REAL NOT NULL DEFAULT -1, digest TEXT NOT NULL, indexedAt TEXT NOT NULL
        );
        INSERT INTO search_indexed_sessions VALUES ('production-session', 10, 1, 1, 'digest', '2026-01-01T00:00:00.000Z');
        CREATE VIRTUAL TABLE search_chat_titles USING fts5(sessionId UNINDEXED, title);
        INSERT INTO search_chat_titles(sessionId, title) VALUES ('production-session', 'Production chat');
        CREATE VIRTUAL TABLE search_chat_messages USING fts5(
          sessionId UNINDEXED, sourceEventId UNINDEXED, role UNINDEXED, timestamp UNINDEXED, content
        );
        INSERT INTO search_chat_messages(sessionId, sourceEventId, role, timestamp, content)
        VALUES ('production-session', 'event-1', 'user', NULL, 'production text');
      `);
    } finally {
      productionDb.close();
    }

    const seededDataDir = mod.__testing.seedStagingData(stagingDir, { productionDataDir });

    const stagingDb = new DatabaseSync(join(seededDataDir, "bridge.db"));
    try {
      expect(stagingDb.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'search!_%' ESCAPE '!'").all()).toEqual([]);
    } finally {
      stagingDb.close();
    }
    const productionAfter = new DatabaseSync(join(productionDataDir, "bridge.db"));
    try {
      expect(indexedMessages(productionAfter)).toBe(1);
    } finally {
      productionAfter.close();
    }
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
      expect(settings1, "missing row").toEqual({ model: "gpt-6-luna" });
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
      expect(settings2, "malformed JSON").toEqual({ model: "gpt-6-luna" });
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

  it("restores the atomically published generation on server startup", async () => {
    vi.stubEnv("BRIDGE_STAGING_BACKEND_STARTUP_RESTORE_LIMIT", "0");
    const mod = await loadStagingToolsModule();
    const stagingParent = createTempDir("bridge-stage-parent-");
    const previewParent = createTempDir("bridge-stage-preview-root-");
    const prefix = "preview-generated";
    const stagingDir = join(stagingParent, prefix);
    const previewMap = new Map<string, string>();
    mkdirSync(stagingDir, { recursive: true });
    const retired = publishTestPreviewGeneration(
      mod,
      stagingDir,
      "generation-retired",
      "<!doctype html><p>retired</p>",
      previewParent,
    );
    const target = publishTestPreviewGeneration(
      mod,
      stagingDir,
      "generation-startup",
      "<!doctype html><p>generated</p>",
      previewParent,
    );

    await mod.__testing.pruneOrphanedWorktreesImpl({
      stagingParent,
      stagingPreviewParents: [previewParent],
      activePreviewMap: previewMap,
      expressApp: {} as any,
      listBranchPrefixes: () => new Set([prefix]),
      pruneGitWorktrees: vi.fn(),
    });

    expect(previewMap.get(prefix)).toBe(target.outDir);
    expect(mod.getStagingRouter(prefix)).toEqual(expect.any(Function));
    expect(existsSync(dirname(retired.outDir))).toBe(false);
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

  it("deletes orphaned worktrees, leaves other directories alone, and one locked orphan does not hide the rest", async () => {
    vi.stubEnv("BRIDGE_STAGING_BACKEND_STARTUP_RESTORE_LIMIT", "0");
    const mod = await loadStagingToolsModule();
    const stagingParent = createTempDir("bridge-stage-parent-");
    const previewParent = createTempDir("bridge-stage-preview-root-");
    const lockedOrphan = join(stagingParent, "aaa-locked-orphan");
    const orphan = join(stagingParent, "bbb-orphan");
    const activeDir = join(stagingParent, "ccc-active");
    const notAWorktree = join(stagingParent, "ddd-someone-elses-folder");
    for (const dir of [lockedOrphan, orphan, activeDir, notAWorktree]) mkdirSync(join(dir, "src"), { recursive: true });
    for (const dir of [lockedOrphan, orphan, activeDir]) writeFileSync(join(dir, ".git"), "gitdir: elsewhere\n");
    const preview = publishTestPreviewGeneration(mod, activeDir, "generation-one", "<!doctype html>", previewParent);
    rmSyncThrowDirs.add(lockedOrphan);
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd === "git worktree prune" || cmd === "git --no-pager status --porcelain"
        || cmd.startsWith("git branch --list ")) return "";
      throw new Error(`Unexpected command: ${cmd}`);
    });

    await mod.__testing.pruneOrphanedWorktreesImpl({
      stagingParent,
      stagingPreviewParents: [previewParent],
      activePreviewMap: new Map<string, string>(),
      expressApp: null,
      listBranchPrefixes: () => new Set(["ccc-active"]),
    });

    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(lockedOrphan)).toBe(true);
    expect(existsSync(join(notAWorktree, "src"))).toBe(true);
    expect(removedTrees()).not.toContain(notAWorktree);
    expect(stagingLogMock).toHaveBeenCalledWith(expect.stringContaining("could not remove orphaned staging worktree aaa-locked-orphan"));
    // Entries after the locked one are still seen as active, so their previews are not pruned as orphans.
    expect(mod.__testing.readActivePreviewTarget(preview.prefix, previewParent)).not.toBeNull();
  });

  it("removes empty orphan directories once without failed Git commands or validation logs", async () => {
    const mod = await loadStagingToolsModule();
    const stagingParent = createTempDir("bridge-stage-parent-");
    const emptyDir = join(stagingParent, "empty-orphan");
    mkdirSync(emptyDir);
    const log = vi.fn();
    const options = {
      stagingParent, stagingPreviewParents: [], expressApp: null,
      listBranchPrefixes: () => new Set<string>(), log,
    };
    execSyncMock.mockImplementation((cmd) => {
      if (cmd.startsWith("git branch --list ") || cmd === "git worktree prune") return "";
      throw new Error(`Unexpected cleanup command: ${cmd}`);
    });

    await mod.__testing.pruneOrphanedWorktreesImpl(options);
    expect(existsSync(emptyDir)).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("1 orphan worktree dir(s) removed"));
    log.mockClear();
    execSyncMock.mockClear();
    await mod.__testing.pruneOrphanedWorktreesImpl(options);
    expect(log).not.toHaveBeenCalled();
    expect(execSyncMock.mock.calls.map(([cmd]) => cmd)).toEqual(["git worktree prune"]);
    expect(writeFileSyncCallMock.mock.calls.filter(([path]) => isValidationLogPath(String(path)))).toEqual([]);
  });

  it.each(["dirty", "unreadable", "active", "pending", "new-branch", "nonempty", "no-op"] as const)(
    "retains %s orphans and their previews without sending them through stale pruning",
    async (condition) => {
      vi.stubEnv("BRIDGE_STAGING_STALE_ARTIFACT_MAX_AGE_MS", "1");
      vi.stubEnv("BRIDGE_STAGING_STALE_ARTIFACT_KEEP_RECENT", "0");
      vi.stubEnv("BRIDGE_STAGING_STALE_ARTIFACT_RECENT_GRACE_MS", "1");
      const mod = await loadStagingToolsModule();
      const backend = await import("../staging-backend-manager.js");
      const active = vi.spyOn(backend, "hasActiveStagingBackend").mockReturnValue(condition === "active");
      const pending = vi.spyOn(backend, "hasPendingStagingBackendStart").mockReturnValue(condition === "pending");
      const stagingParent = createTempDir("bridge-stage-parent-");
      const previewParent = createTempDir("bridge-stage-preview-root-");
      const prefix = "retained";
      const stagingDir = join(stagingParent, prefix);
      mkdirSync(stagingDir);
      if (["dirty", "unreadable", "no-op"].includes(condition)) writeFileSync(join(stagingDir, ".git"), "gitdir: elsewhere\n");
      if (condition === "nonempty") writeFileSync(join(stagingDir, "notes.txt"), "keep");
      const preview = publishTestPreviewGeneration(mod, stagingDir, "generation-one", "<!doctype html>", previewParent);
      const oldDate = new Date("2020-01-01T00:00:00Z");
      utimesSync(stagingDir, oldDate, oldDate);
      const removeWorktree = vi.fn();
      const log = vi.fn();
      execSyncMock.mockImplementation((cmd) => {
        if (cmd.startsWith("git branch --list ")) return condition === "new-branch" ? `staging/${prefix}\n` : "";
        if (cmd === "git --no-pager status --porcelain") {
          if (condition === "unreadable") throw Object.assign(new Error("broken checkout"), { stderr: "fatal: invalid git directory" });
          return condition === "dirty" ? " M notes.txt\n" : "";
        }
        return "";
      });
      try {
        await mod.__testing.pruneOrphanedWorktreesImpl({
          stagingParent, stagingPreviewParents: [previewParent], expressApp: null,
          listBranchPrefixes: () => new Set<string>(), removeWorktree, log,
        });
        expect(existsSync(stagingDir)).toBe(true);
        expect(mod.__testing.readActivePreviewTarget(preview.prefix, previewParent)).not.toBeNull();
        expect(removeWorktree).toHaveBeenCalledTimes(condition === "no-op" ? 1 : 0);
        expect(log).not.toHaveBeenCalledWith(expect.stringContaining("1 orphan worktree dir(s) removed"));
        expect(log).not.toHaveBeenCalledWith(expect.stringContaining("stale staging worktree(s)"));
      } finally {
        active.mockRestore();
        pending.mockRestore();
      }
    },
  );

  it.each(["missing", "present", "prune-failure", "query-failure", "delete-failure"] as const)(
    "checks Git cleanup outcomes for a %s branch",
    async (condition) => {
      const mod = await loadStagingToolsModule();
      const stagingDir = createTempDir("bridge-stage-cleanup-");
      const branch = `staging/${basename(stagingDir)}`;
      execSyncMock.mockImplementation((cmd) => {
        if (cmd === "git worktree prune" && condition === "prune-failure"
          || cmd.startsWith("git branch --list ") && condition === "query-failure"
          || cmd.startsWith("git branch -D ") && condition === "delete-failure") {
          throw Object.assign(new Error("git failed"), { stderr: "fatal: permission denied" });
        }
        if (cmd.startsWith("git branch --list ")) return condition === "missing" ? "" : `${branch}\n`;
        return "";
      });
      const cleanup = mod.cleanupCompletedStagingDeploy(stagingDir);
      if (condition.endsWith("failure")) await expect(cleanup).rejects.toThrow("permission denied");
      else await cleanup;
      expect(existsSync(stagingDir)).toBe(false);
      const deletes = spawnMock.mock.calls.filter(([, args]) => Array.isArray(args) && args[0] === "branch" && args[1] === "-D");
      expect(deletes).toHaveLength(["present", "delete-failure"].includes(condition) ? 1 : 0);
      if (condition === "missing") {
        expect(writeFileSyncCallMock.mock.calls.filter(([path]) => isValidationLogPath(String(path)))).toEqual([]);
      }
    },
  );

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
    const removeWorktree = vi.fn((dir: string) => rmSync(dir, { recursive: true, force: true }));
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
      toolInvocation("staging_preview"),
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
      toolInvocation("staging_preview"),
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
      toolInvocation("staging_preview"),
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
      toolInvocation("staging_preview"),
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
      return successfulCommandOutput(cmd);
    });
    const tools = await loadStagingTools();
    const stagingDir = createTempDir("bridge-stage-preview-stamp-");
    const prefix = basename(stagingDir);

    await tools.staging_preview.handler(
      { stagingDir },
      toolInvocation("staging_preview"),
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
      toolInvocation("staging_preview"),
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
    const seedPreviewData = vi.fn<
      (target: string, options?: { dataDir?: string }) => void
    >((target, options) => {
      mkdirSync(options!.dataDir!, { recursive: true });
      writeFileSync(join(options!.dataDir!, "bridge.db"), "seeded");
      mkdirSync(join(options!.dataDir!, "docs"), { recursive: true });
    });
    const logs: string[] = [];
    const generationId = "generation-seed";

    const result = await mod.runStagingPreviewJob(
      { stagingDir, validate: false },
      {
        startBackend: false,
        registerInProcess: false,
        previewGenerationId: generationId,
        seedPreviewData,
        log: (message) => logs.push(message),
      },
    );

    expect(seedPreviewData).toHaveBeenCalledOnce();
    expect(seedPreviewData).toHaveBeenCalledWith(stagingDir, {
      dataDir: join(
        mod.__testing.getStagingPreviewParent(),
        ".generations",
        basename(stagingDir),
        generationId,
        "data",
      ),
    });
    expect(result).toMatchObject({ success: true });
    expect(logs).toContain("Preparing isolated staging data snapshot...");
    expect(logs).toContain("Isolated staging data snapshot ready.");
    expect(logs.at(-1)).toContain("Staging preview ready at");
  });

  it("builds and seeds a new generation without touching the existing preview database", async () => {
    const mod = await loadStagingToolsModule();
    const stagingDir = createTempDir("bridge-stage-preview-generation-");
    const dataDir = join(stagingDir, "data");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "bridge.db"), "existing preview database");
    const generationId = "generation-next";
    const seedPreviewData = vi.fn<
      (target: string, options?: { dataDir?: string }) => void
    >((_target, options) => {
      mkdirSync(options!.dataDir!, { recursive: true });
      writeFileSync(join(options!.dataDir!, "bridge.db"), "new preview database");
    });
    const logs: string[] = [];

    const result = await mod.runStagingPreviewJob(
      { stagingDir, validate: false },
      {
        startBackend: false,
        registerInProcess: false,
        previewGenerationId: generationId,
        seedPreviewData,
        log: (message) => logs.push(message),
      },
    );

    expect(result).toMatchObject({ success: true });
    expect(execSyncMock.mock.calls.some(([command]) =>
      String(command).startsWith("npx vite build --base"))).toBe(true);
    const target = mod.__testing.readActivePreviewTarget(basename(stagingDir));
    expect(target).toMatchObject({ generationId });
    expect(target?.dataDir).not.toBe(dataDir);
    expect(readFileSync(join(dataDir, "bridge.db"), "utf8")).toBe("existing preview database");
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

  it("keeps the published generation unchanged when replacement data preparation fails", async () => {
    const mod = await loadStagingToolsModule();
    const stagingDir = createTempDir("bridge-stage-preview-generation-failure-");
    const previous = publishTestPreviewGeneration(
      mod,
      stagingDir,
      "generation-current",
      "<!doctype html><p>current</p>",
    );

    const result = await mod.runStagingPreviewJob(
      { stagingDir, validate: false },
      {
        startBackend: false,
        registerInProcess: false,
        previewGenerationId: "generation-failed",
        seedPreviewData: () => {
          throw new Error("snapshot failed");
        },
      },
    );

    expect(result).toMatchObject({ resultType: "failure" });
    expect(mod.__testing.readActivePreviewTarget(previous.prefix)).toMatchObject({
      generationId: "generation-current",
      outDir: previous.outDir,
    });
    const failed = mod.__testing.createPreviewGenerationTarget(
      stagingDir,
      "generation-failed",
    );
    expect(existsSync(dirname(failed.outDir))).toBe(false);
  });

  it("builds previews under the configured runtime preview root", async () => {
    const previewParent = createTempDir("bridge-stage-preview-root-");
    const tools = await loadStagingTools({ previewParent });
    const stagingDir = createTempDir("bridge-stage-preview-rooted-");
    const prefix = basename(stagingDir);

    await tools.staging_preview.handler(
      { stagingDir, validate: false },
      toolInvocation("staging_preview"),
    );

    const commands = execSyncMock.mock.calls.map(([cmd]) => String(cmd));
    expect(commands.some((command) =>
      command.startsWith(`npx vite build --base "/staging/${prefix}/" --outDir "`)
      && command.includes(join(previewParent, ".generations", prefix))
      && command.endsWith(`${join("client")}" --emptyOutDir`))).toBe(true);
  });
});

describe("staging preview cleanup hardening", () => {
  it("retries process identity capture when a new staging child is not visible in the first snapshot", async () => {
    const mod = await loadStagingToolsModule();
    const child = {
      pid: 12345,
      exitCode: null,
      signalCode: null,
    } as unknown as import("node:child_process").ChildProcess;
    captureProcessIdentityMock.mockReset();
    captureProcessIdentityMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ pid: 12345, startMarker: "start-12345" });

    await expect(
      mod.__testing.backendManager.captureStagingBackendIdentity(child, {
        timeoutMs: 1_000,
        retryDelayMs: 1,
      }),
    ).resolves.toEqual({ pid: 12345, startMarker: "start-12345" });

    expect(captureProcessIdentityMock).toHaveBeenCalledTimes(2);
    expect(stagingLogMock).toHaveBeenCalledWith(
      "Captured staging backend creation identity for PID 12345 after 2 attempts",
    );
  });

  it("recaptures a missing startup identity before terminating the staging child", async () => {
    const mod = await loadStagingToolsModule();
    const stdout = { destroyed: false };
    const stderr = { destroyed: false };
    const stdin = { destroyed: false };
    const child = {
      pid: 23456,
      exitCode: null as number | null,
      signalCode: null,
      connected: true,
      stdout,
      stderr,
      stdin,
      off: vi.fn(),
      once: vi.fn(),
    } as unknown as import("node:child_process").ChildProcess;
    const identity = { pid: 23456, startMarker: "start-23456" };
    captureProcessIdentityMock.mockReset();
    captureProcessIdentityMock.mockResolvedValueOnce(identity);
    terminateProcessTreeMock.mockImplementationOnce(async (root) => {
      expect(root).toEqual(identity);
      Object.assign(child, { exitCode: 0, connected: false });
      stdout.destroyed = true;
      stderr.destroyed = true;
      stdin.destroyed = true;
      return {
        ok: true,
        status: "terminated",
        root,
      };
    });

    await expect(
      mod.__testing.backendManager.stopStagingBackendChild(child, Promise.resolve(null)),
    ).resolves.toBeUndefined();

    expect(captureProcessIdentityMock).toHaveBeenCalledWith(
      23456,
      expect.objectContaining({ expiresAtUnixMs: expect.any(Number) }),
    );
    expect(terminateProcessTreeMock).toHaveBeenCalledWith(
      identity,
      expect.objectContaining({ expiresAtUnixMs: expect.any(Number) }),
    );
    expect(stagingLogMock).toHaveBeenCalledWith(
      "Recapturing staging backend creation identity for PID 23456 before termination",
    );
  });

  it("treats a child that exits during identity recapture as already stopped", async () => {
    const mod = await loadStagingToolsModule();
    const stdout = { destroyed: false };
    const stderr = { destroyed: false };
    const stdin = { destroyed: false };
    const child = {
      pid: 34567,
      exitCode: null as number | null,
      signalCode: null,
      connected: true,
      stdout,
      stderr,
      stdin,
      off: vi.fn(),
      once: vi.fn(),
    } as unknown as import("node:child_process").ChildProcess;
    captureProcessIdentityMock.mockReset();
    captureProcessIdentityMock.mockImplementationOnce(async () => {
      Object.assign(child, { exitCode: 0, connected: false });
      stdout.destroyed = true;
      stderr.destroyed = true;
      stdin.destroyed = true;
      return null;
    });

    await expect(
      mod.__testing.backendManager.stopStagingBackendChild(child, Promise.resolve(null)),
    ).resolves.toBeUndefined();

    expect(terminateProcessTreeMock).not.toHaveBeenCalled();
  });

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
    logPath?: string;
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
      logPath: join(dirname(stagingDir), "management-jobs", "logs", "preview-job-1.log"),
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
      const target = publishTestPreviewGeneration(
        mod,
        stagingDir,
        fake.job.id,
        "<!doctype html><p>runner built preview</p>",
      );
      fake.complete("succeeded");

      await advanceTimersAndSettle(50, () => controller!.settle());

      expect(mod.getActivePreviews().get(prefix)).toBe(target.outDir);
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

  it("activates a new generation and removes the retired runtime data", async () => {
    vi.stubEnv("BRIDGE_DISTRIBUTION_MODE", "development");
    vi.stubEnv("BRIDGE_STAGING_BACKEND_STARTUP_RESTORE_LIMIT", "0");
    const previewParent = createTempDir("bridge-stage-preview-root-");
    const mod = await loadStagingToolsModule({ previewParent });
    mod.__testing.resetActivePreviews();
    mod.__testing.backendManager.resetBackendState();

    const stagingParent = createTempDir("bridge-stage-parent-");
    const prefix = "preview-rebuilt";
    const stagingDir = join(stagingParent, prefix);
    mkdirSync(stagingDir, { recursive: true });
    const previous = publishTestPreviewGeneration(
      mod,
      stagingDir,
      "generation-old",
      "<!doctype html><p>old</p>",
    );

    createStagingPreviewTestApp(mod);
    mod.registerExistingPreviewsFromDisk({ stagingParent, stagingPreviewParents: [previewParent] });
    mod.__testing.backendManager.seedPreviewDataDir(prefix, previous.dataDir!);
    expect(mod.__testing.backendManager.ensureLazyRouter(prefix)).toBe(true);
    expect(mod.__testing.backendManager.hasRestorableTarget(prefix)).toBe(true);

    const fake = createFakeJobStore(makePreviewJob(stagingDir));
    const next = publishTestPreviewGeneration(
      mod,
      stagingDir,
      fake.job.id,
      "<!doctype html><p>rebuilt</p>",
    );

    vi.useFakeTimers();
    try {
      const controller = mod.startStagingPreviewDiscovery({ store: fake.store, pollIntervalMs: 50 });
      controller!.watchJob(fake.job);
      fake.complete("succeeded");
      await advanceTimersAndSettle(50, () => controller!.settle());

      expect(mod.__testing.backendManager.hasLazyRouter(prefix)).toBe(false);
      expect(mod.__testing.backendManager.hasPreviewDataDir(prefix)).toBe(false);
      expect(existsSync(previous.dataDir!)).toBe(false);

      expect(mod.__testing.backendManager.hasRestorableTarget(prefix)).toBe(true);
      expect(mod.getActivePreviews().get(prefix)).toBe(next.outDir);
      expect(mod.getStagingRouter(prefix)).toEqual(expect.any(Function));
      expect(vi.getTimerCount()).toBe(0);
      controller!.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the new generation active when retired data cleanup fails", async () => {
    vi.stubEnv("BRIDGE_DISTRIBUTION_MODE", "development");
    vi.stubEnv("BRIDGE_STAGING_BACKEND_STARTUP_RESTORE_LIMIT", "0");
    const previewParent = createTempDir("bridge-stage-preview-root-");
    const mod = await loadStagingToolsModule({ previewParent });
    mod.__testing.resetActivePreviews();
    mod.__testing.backendManager.resetBackendState();

    const stagingParent = createTempDir("bridge-stage-parent-");
    const prefix = "preview-retired-data-cleanup";
    const stagingDir = join(stagingParent, prefix);
    mkdirSync(stagingDir, { recursive: true });
    const previous = publishTestPreviewGeneration(
      mod,
      stagingDir,
      "generation-old",
      "<!doctype html><p>old</p>",
    );

    createStagingPreviewTestApp(mod);
    mod.registerExistingPreviewsFromDisk({ stagingParent, stagingPreviewParents: [previewParent] });
    mod.__testing.backendManager.seedPreviewDataDir(prefix, previous.dataDir!);
    rmSyncThrowDirs.add(previous.dataDir!);

    const fake = createFakeJobStore(makePreviewJob(stagingDir));
    const next = publishTestPreviewGeneration(
      mod,
      stagingDir,
      fake.job.id,
      "<!doctype html><p>new</p>",
    );

    vi.useFakeTimers();
    try {
      const controller = mod.startStagingPreviewDiscovery({ store: fake.store, pollIntervalMs: 50 });
      controller!.watchJob(fake.job);
      fake.complete("succeeded");
      await advanceTimersAndSettle(50, () => controller!.settle());

      expect(mod.getActivePreviews().get(prefix)).toBe(next.outDir);
      expect(mod.__testing.backendManager.hasRestorableTarget(prefix)).toBe(true);
      expect(mod.__testing.backendManager.hasPreviewDataDir(prefix)).toBe(false);
      expect(stagingLogMock).toHaveBeenCalledWith(
        expect.stringContaining(`failed to remove retired preview data for ${prefix}`),
      );
      controller!.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the current generation live until the replacement is complete", async () => {
    vi.stubEnv("BRIDGE_DISTRIBUTION_MODE", "development");
    vi.stubEnv("BRIDGE_STAGING_BACKEND_STARTUP_RESTORE_LIMIT", "0");
    const previewParent = createTempDir("bridge-stage-preview-root-");
    const mod = await loadStagingToolsModule({ previewParent });
    mod.__testing.resetActivePreviews();
    mod.__testing.backendManager.resetBackendState();

    const stagingParent = createTempDir("bridge-stage-parent-");
    const prefix = "preview-rebuild-coordinated";
    const stagingDir = join(stagingParent, prefix);
    mkdirSync(stagingDir, { recursive: true });
    const previous = publishTestPreviewGeneration(
      mod,
      stagingDir,
      "generation-old",
      "<!doctype html><p>old preview</p>",
    );

    createStagingPreviewTestApp(mod);
    mod.registerExistingPreviewsFromDisk({ stagingParent, stagingPreviewParents: [previewParent] });
    const fake = createFakeJobStore(makePreviewJob(stagingDir));

    vi.useFakeTimers();
    try {
      const controller = mod.startStagingPreviewDiscovery({ store: fake.store, pollIntervalMs: 50 });
      controller!.watchJob(fake.job);

      fake.complete("running");
      await advanceTimersAndSettle(50, () => controller!.settle());

      expect(mod.getActivePreviews().get(prefix)).toBe(previous.outDir);
      expect(mod.__testing.backendManager.isSwitching(prefix)).toBe(false);
      expect(mod.__testing.backendManager.hasRestorableTarget(prefix)).toBe(true);

      const next = publishTestPreviewGeneration(
        mod,
        stagingDir,
        fake.job.id,
        "<!doctype html><p>rebuilt preview</p>",
      );
      fake.complete("succeeded");
      await advanceTimersAndSettle(50, () => controller!.settle());

      expect(mod.__testing.backendManager.isSwitching(prefix)).toBe(false);
      expect(mod.__testing.backendManager.hasRestorableTarget(prefix)).toBe(true);
      expect(mod.getActivePreviews().get(prefix)).toBe(next.outDir);
      expect(existsSync(dirname(previous.outDir))).toBe(false);
      controller!.stop();
    } finally {
      vi.useRealTimers();
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

      const target = publishTestPreviewGeneration(
        mod,
        stagingDir,
        job.id,
        "<!doctype html><p>cross process preview</p>",
      );
      runnerStore.succeed(job.id, { previewPath: `/staging/${prefix}/` });

      await advanceTimersAndSettle(50, () => controller!.settle());

      expect(mod.getActivePreviews().get(prefix)).toBe(target.outDir);
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
    lstatSyncOverrideMock.mockImplementation((path) =>
      String(path) === join(stagingDir1, "node_modules")
        ? { isSymbolicLink: () => true, isDirectory: () => false }
        : undefined);
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
    let legacyLinkPresent = true;
    lstatSyncOverrideMock.mockImplementation((path) =>
      legacyLinkPresent && String(path) === join(stagingDir2, "node_modules")
        ? { isSymbolicLink: () => true, isDirectory: () => false }
        : undefined);
    removeDirectoryLinkMock.mockImplementation(() => {
      legacyLinkPresent = false;
      return { ok: true, output: "" };
    });

    const runCommand2 = vi.fn(async () => {
      mkdirSync(join(stagingDir2, "node_modules"), { recursive: true });
      return { ok: true, output: "installed" };
    });
    const writeLog2 = vi.fn();

    const result2 = await mod.ensureStagingDeps(stagingDir2, { runCommand: runCommand2, log: writeLog2 });

    expect(result2, "proceed: should succeed").toMatchObject({ ok: true });
    expect(runCommand2, "proceed: npm should run once").toHaveBeenCalledTimes(1);
    expect(writeLog2, "proceed: should log symlink removal").toHaveBeenCalledWith(
      "Removed legacy staging node_modules link before isolated install",
    );
    expect(writeFileSyncCallMock).toHaveBeenCalledWith(
      join(stagingDir2, "node_modules", ".bridge-deps-hash"),
      "staged\n",
    );
  });

  it("removes a dangling legacy node_modules link before installing locally", async () => {
    const mod = await loadStagingToolsModule();
    const stagingDir = createTempDir("bridge-stage-deps-dangling-");
    let legacyLinkPresent = true;
    dependencySyncHashMock.mockReturnValue("staged");
    existsSyncOverrideMock.mockImplementation((path) =>
      String(path) === join(stagingDir, "node_modules") ? false : undefined);
    lstatSyncOverrideMock.mockImplementation((path) =>
      legacyLinkPresent && String(path) === join(stagingDir, "node_modules")
        ? { isSymbolicLink: () => true, isDirectory: () => false }
        : undefined);
    removeDirectoryLinkMock.mockImplementation(() => {
      legacyLinkPresent = false;
      return { ok: true, output: "" };
    });
    const runCommand = vi.fn(async () => {
      mkdirSync(join(stagingDir, "node_modules"), { recursive: true });
      return { ok: true, output: "installed" };
    });

    const result = await mod.ensureStagingDeps(stagingDir, { runCommand, log: vi.fn() });

    expect(result).toEqual({ ok: true });
    expect(removeDirectoryLinkMock).toHaveBeenCalledWith(join(stagingDir, "node_modules"), expect.any(String));
    expect(runCommand).toHaveBeenCalledOnce();
  });

  it("installs missing dependencies locally", async () => {
    const mod = await loadStagingToolsModule();
    const stagingDir = createTempDir("bridge-stage-deps-local-");
    lstatSyncOverrideMock.mockImplementation(() => undefined);
    const runCommand = vi.fn(async () => {
      mkdirSync(join(stagingDir, "node_modules"), { recursive: true });
      return { ok: true, output: "installed" };
    });
    const writeLog = vi.fn();

    await expect(mod.ensureStagingDeps(stagingDir, { runCommand, log: writeLog })).resolves.toEqual({ ok: true });

    expect(runCommand).toHaveBeenCalledOnce();
    expect(removeDirectoryLinkMock).not.toHaveBeenCalled();
    expect(writeLog).toHaveBeenCalledWith("Staging dependencies are missing — installing them locally...");
  });

  it("reuses an isolated dependency tree while its local hash matches", async () => {
    const mod = await loadStagingToolsModule();
    const stagingDir = createTempDir("bridge-stage-deps-existing-");
    const stagingModules = join(stagingDir, "node_modules");
    mkdirSync(stagingModules, { recursive: true });
    writeFileSync(join(stagingModules, ".bridge-deps-hash"), "same-hash\n");
    lstatSyncOverrideMock.mockImplementation(() => undefined);
    readFileSyncOverrideMock.mockImplementation(() => undefined);
    const runCommand = vi.fn(async () => ({ ok: true, output: "installed" }));

    await expect(mod.ensureStagingDeps(stagingDir, { runCommand, log: vi.fn() })).resolves.toEqual({ ok: true });

    expect(runCommand).not.toHaveBeenCalled();
    expect(removeDirectoryLinkMock).not.toHaveBeenCalled();
  });

  it("reinstalls an isolated dependency tree when its local hash is stale", async () => {
    const mod = await loadStagingToolsModule();
    const stagingDir = createTempDir("bridge-stage-deps-stale-");
    const stagingModules = join(stagingDir, "node_modules");
    mkdirSync(stagingModules, { recursive: true });
    writeFileSync(join(stagingModules, ".bridge-deps-hash"), "old-hash\n");
    lstatSyncOverrideMock.mockImplementation(() => undefined);
    readFileSyncOverrideMock.mockImplementation(() => undefined);
    dependencySyncHashMock.mockReturnValue("new-hash");
    const runCommand = vi.fn(async () => ({ ok: true, output: "installed" }));
    const writeLog = vi.fn();

    await expect(mod.ensureStagingDeps(stagingDir, { runCommand, log: writeLog })).resolves.toEqual({ ok: true });

    expect(runCommand).toHaveBeenCalledOnce();
    expect(removeDirectoryLinkMock).not.toHaveBeenCalled();
    expect(writeLog).toHaveBeenCalledWith(
      "Staging dependencies are stale or unverified — running an isolated incremental install...",
    );
    expect(readFileSync(join(stagingModules, ".bridge-deps-hash"), "utf8")).toBe("new-hash\n");
  });

  it("removes a stale dependency marker before an install and retries after failure", async () => {
    const mod = await loadStagingToolsModule();
    const stagingDir = createTempDir("bridge-stage-deps-retry-");
    const stagingModules = join(stagingDir, "node_modules");
    const markerPath = join(stagingModules, ".bridge-deps-hash");
    mkdirSync(stagingModules, { recursive: true });
    writeFileSync(markerPath, "old-hash\n");
    lstatSyncOverrideMock.mockImplementation(() => undefined);
    readFileSyncOverrideMock.mockImplementation(() => undefined);
    dependencySyncHashMock.mockReturnValue("new-hash");

    const failedInstall = vi.fn(async () => ({ ok: false, output: "install failed" }));
    await expect(mod.ensureStagingDeps(stagingDir, { runCommand: failedInstall, log: vi.fn() }))
      .resolves.toMatchObject({ ok: false });
    expect(existsSync(markerPath)).toBe(false);

    const successfulInstall = vi.fn(async () => ({ ok: true, output: "installed" }));
    await expect(mod.ensureStagingDeps(stagingDir, { runCommand: successfulInstall, log: vi.fn() }))
      .resolves.toEqual({ ok: true });
    expect(successfulInstall).toHaveBeenCalledOnce();
    expect(readFileSync(markerPath, "utf8")).toBe("new-hash\n");
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
