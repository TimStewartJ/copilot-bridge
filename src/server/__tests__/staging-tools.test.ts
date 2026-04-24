import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

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

const execSyncMock = vi.hoisted(() => vi.fn<(cmd: string, options?: { cwd?: string }) => string>(() => ""));
const triggerRestartPendingMock = vi.fn();
const isRestartPendingMock = vi.hoisted(() => vi.fn(() => false));
const dependencySyncHashMock = vi.fn(() => "same-hash");
const existsSyncOverrideMock = vi.hoisted(() => vi.fn<(path: ExistsSyncPath) => boolean | undefined>());
const writeFileSyncCallMock = vi.hoisted(() => vi.fn<(...args: WriteFileSyncArgs) => void>());
const readFileSyncOverrideMock = vi.hoisted(() => vi.fn<(path: ReadFileSyncPath) => string | undefined>());
const unlinkSyncCallMock = vi.hoisted(() => vi.fn<(path: UnlinkSyncPath) => void>());
const preparePatchedPackagesForInstallMock = vi.fn(() => ({
  packages: [],
  discard: vi.fn(),
  restore: vi.fn(),
}));
const createDirectoryLinkMock = vi.fn(() => ({ ok: true, output: "" }));
const removeDirectoryLinkMock = vi.fn(() => ({ ok: true, output: "" }));
const buildPublicUrlMock = vi.fn(() => undefined);
const STAGING_DIST_PARENT = join(process.cwd(), "dist", "staging");
const stagingDistParentExistedAtStart = existsSync(STAGING_DIST_PARENT);
const originalDemoMode = process.env.BRIDGE_DEMO_MODE;

function isDataFilePath(path: string, filename: string): boolean {
  return basename(path) === filename && basename(dirname(path)) === "data";
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
      const [path] = args;
      const normalized = String(path);
      if (
        isDataFilePath(normalized, "pre-deploy-sha")
        || isDataFilePath(normalized, "restart.signal")
        || isDataFilePath(normalized, "deps-hash")
      ) {
        return;
      }
      return actual.writeFileSync(...args);
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
  };
});

vi.mock("../session-manager.js", () => ({
  triggerRestartPending: triggerRestartPendingMock,
  isRestartPending: isRestartPendingMock,
}));

vi.mock("../dependency-sync.js", () => ({
  dependencySyncHash: dependencySyncHashMock,
  DEPENDENCY_SYNC_GIT_PATHSPEC: "package.json",
  preparePatchedPackagesForInstall: preparePatchedPackagesForInstallMock,
}));

vi.mock("../platform.js", () => ({
  createDirectoryLink: createDirectoryLinkMock,
  removeDirectoryLink: removeDirectoryLinkMock,
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
  `);
  db.close();

  const docsDir = join(dataDir, "docs");
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(join(docsDir, "note.md"), "# docs");
  return dataDir;
}

async function loadStagingToolsModule() {
  vi.resetModules();
  return import("../staging-tools.js");
}

async function loadStagingTools() {
  const mod = await loadStagingToolsModule();
  return Object.fromEntries(mod.STAGING_TOOLS.map((tool: any) => [tool.name, tool])) as Record<string, any>;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  if (!stagingDistParentExistedAtStart) {
    rmSync(STAGING_DIST_PARENT, { recursive: true, force: true });
  }
  triggerRestartPendingMock.mockReset();
  isRestartPendingMock.mockReset();
  isRestartPendingMock.mockReturnValue(false);
  dependencySyncHashMock.mockReset();
  dependencySyncHashMock.mockReturnValue("same-hash");
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
  writeFileSyncCallMock.mockReset();
  readFileSyncOverrideMock.mockReset();
  unlinkSyncCallMock.mockReset();
  process.env.BRIDGE_DEMO_MODE = originalDemoMode;
  vi.resetModules();
});

describe("staging tools", () => {
  it("skips staging artifact management in demo mode", async () => {
    process.env.BRIDGE_DEMO_MODE = "true";
    const mod = await loadStagingToolsModule();
    expect(mod.shouldManageStagingArtifacts()).toBe(false);
  });

  it("manages staging artifacts normally outside demo mode", async () => {
    delete process.env.BRIDGE_DEMO_MODE;
    const mod = await loadStagingToolsModule();
    expect(mod.shouldManageStagingArtifacts()).toBe(true);
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
    } finally {
      stagingDb.close();
    }

    expect(existsSync(join(seededDataDir, "docs", "note.md"))).toBe(true);
  });

  it("falls back to legacy JSON state when production bridge.db is missing", async () => {
    const mod = await loadStagingToolsModule();
    const productionDataDir = createTempDir("bridge-stage-missing-db-");
    const stagingDir = createTempDir("bridge-stage-staging-");
    const stagingDataDir = join(stagingDir, "data");

    mkdirSync(stagingDataDir, { recursive: true });
    writeFileSync(join(stagingDataDir, "bridge.db"), "stale");
    writeFileSync(join(stagingDataDir, "bridge.db-wal"), "stale");
    writeFileSync(join(stagingDataDir, "bridge.db-shm"), "stale");
    writeFileSync(join(productionDataDir, "tasks.json"), JSON.stringify([{ id: "task-1", title: "Legacy task" }]));
    writeFileSync(join(productionDataDir, "schedules.json"), JSON.stringify([
      { id: "sched-1", name: "Legacy schedule", enabled: true, type: "cron", cron: "0 9 * * 1" },
    ]));

    const seededDataDir = mod.__testing.seedStagingData(stagingDir, { productionDataDir });
    expect(existsSync(join(seededDataDir, "tasks.json"))).toBe(true);
    expect(existsSync(join(seededDataDir, "bridge.db"))).toBe(false);
    expect(existsSync(join(seededDataDir, "bridge.db-wal"))).toBe(false);
    expect(existsSync(join(seededDataDir, "bridge.db-shm"))).toBe(false);
    expect(JSON.parse(readFileSync(join(seededDataDir, "schedules.json"), "utf-8"))).toEqual([
      { id: "sched-1", name: "Legacy schedule", enabled: false, type: "cron", cron: "0 9 * * 1" },
    ]);
  });

  it("fails explicitly when neither production bridge.db nor legacy JSON state exists", async () => {
    const mod = await loadStagingToolsModule();
    const productionDataDir = createTempDir("bridge-stage-missing-db-");
    const stagingDir = createTempDir("bridge-stage-staging-");

    expect(() =>
      mod.__testing.seedStagingData(stagingDir, { productionDataDir }),
    ).toThrow(/Production SQLite database not found/);
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

    expect(mod.__testing.listStagingBranchPrefixes()).toBeNull();
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
    const restoreBackend = vi.fn();
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
      restoreBackend,
      pruneGitWorktrees,
      log,
    });

    expect(removeWorktree).not.toHaveBeenCalled();
    expect(pruneGitWorktrees).not.toHaveBeenCalled();
    expect(restoreBackend).not.toHaveBeenCalled();
    expect(existsSync(stagingDir)).toBe(true);
    expect(existsSync(distDir)).toBe(true);
    expect(previewMap.get(prefix)).toBe(distDir);
    expect(log).toHaveBeenCalledWith(
      "Skipping orphan staging prune because the staging branch snapshot is unavailable",
    );
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
      if (cmd === "git rev-parse HEAD") return "1111111111111111111111111111111111111111\n";
      if (cmd === 'git merge "staging/preview-deploy" --no-edit') return "";
      if (cmd === 'git diff "1111111111111111111111111111111111111111" HEAD --name-only -- package.json package-lock.json patches') {
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
    expect(dependencySyncHashMock).not.toHaveBeenCalled();
    const commands = execSyncMock.mock.calls.map(([cmd]) => String(cmd));
    expect(commands).not.toContain("npm install --no-audit --no-fund --include=dev");
    expect(commands.some((cmd) => cmd.startsWith("git diff "))).toBe(true);
    expect(writeFileSyncCallMock.mock.calls.some(([file]) => isDataFilePath(String(file), "pre-deploy-sha"))).toBe(true);
    expect(writeFileSyncCallMock.mock.calls.some(([file]) => isDataFilePath(String(file), "deps-hash"))).toBe(false);
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
    );

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
      if (cmd === "npm run test:xplat-audit && npx vitest run --coverage") {
        const error = new Error("tests failed") as Error & { stderr: string };
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
      sessionLog: expect.stringContaining("Command: npm run test:xplat-audit && npx vitest run --coverage"),
      toolTelemetry: {
        command: "npm run test:xplat-audit && npx vitest run --coverage",
        cwd: stagingDir,
        stagingDir,
      },
    });
    expect(result.textResultForLlm).toContain("Staging preview validation failed.");
    expect(result.textResultForLlm).toContain("The staged changes did not pass the preview validation run.");
    expect(result.textResultForLlm).toContain("1 failed");
    expect(result).not.toHaveProperty("error");
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
});
