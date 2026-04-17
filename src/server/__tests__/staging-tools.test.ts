import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execSyncMock = vi.hoisted(() => vi.fn(() => ""));
const triggerRestartPendingMock = vi.fn();
const dependencySyncHashMock = vi.fn(() => "same-hash");
const preparePatchedPackagesForInstallMock = vi.fn(() => ({
  packages: [],
  discard: vi.fn(),
  restore: vi.fn(),
}));
const createDirectoryLinkMock = vi.fn(() => ({ ok: true, output: "" }));
const removeDirectoryLinkMock = vi.fn(() => ({ ok: true, output: "" }));
const buildPublicUrlMock = vi.fn(() => undefined);

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

vi.mock("../session-manager.js", () => ({
  triggerRestartPending: triggerRestartPendingMock,
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

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  triggerRestartPendingMock.mockReset();
  dependencySyncHashMock.mockReset();
  dependencySyncHashMock.mockReturnValue("same-hash");
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
  vi.resetModules();
});

describe("staging tools", () => {
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

  it("fails explicitly when production bridge.db is missing instead of falling back to JSON", async () => {
    const mod = await loadStagingToolsModule();
    const productionDataDir = createTempDir("bridge-stage-missing-db-");
    const stagingDir = createTempDir("bridge-stage-staging-");

    writeFileSync(join(productionDataDir, "tasks.json"), "[]");
    writeFileSync(join(productionDataDir, "schedules.json"), "[]");

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

    const result = await mod.__testing.restoreStagingBackendWithRetry("preview-123", "/tmp/staging-preview", {
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

    const result = await mod.__testing.restoreStagingBackendWithRetry("preview-123", "/tmp/staging-preview", {
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
});
