import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ensureNeutralWorkspaceDir,
  findEnclosingGitRoot,
  getNeutralAwareAvailability,
  isImplicitHostCwd,
  isNeutralWorkspaceCwd,
  prepareNeutralWorkspaceDir,
} from "../neutral-workspace.js";
import { createDirectoryLink } from "../platform.js";
import { makeTestDir, makeTestRuntimePaths } from "./helpers.js";

function makeGitRepo(prefix: string): string {
  const repo = makeTestDir(prefix);
  mkdirSync(join(repo, ".git"));
  return repo;
}

function silentLog() {
  return { warn: vi.fn(), error: vi.fn() };
}

describe("neutral workspace helpers", () => {
  it("treats only the Bridge host directories and release slots as implicit recorded cwds", () => {
    const runtimePaths = makeTestRuntimePaths("neutral-implicit");
    const hostRoot = makeTestDir("neutral-host-root");
    const slot = join(runtimePaths.dataDir, "release-slots", "slot-a");
    const project = makeTestDir("neutral-project");

    expect(isImplicitHostCwd(hostRoot, runtimePaths, [hostRoot])).toBe(true);
    expect(isImplicitHostCwd(slot, runtimePaths, [hostRoot])).toBe(true);
    expect(isImplicitHostCwd(join(hostRoot, "child"), runtimePaths, [hostRoot])).toBe(false);
    expect(isImplicitHostCwd(project, runtimePaths, [hostRoot])).toBe(false);
    expect(isImplicitHostCwd(undefined, runtimePaths, [hostRoot])).toBe(false);
  });

  it("recognises the neutral workspace path", () => {
    const runtimePaths = makeTestRuntimePaths("neutral-identity");

    expect(isNeutralWorkspaceCwd(runtimePaths.workspaceDir, runtimePaths)).toBe(true);
    expect(isNeutralWorkspaceCwd(runtimePaths.dataDir, runtimePaths)).toBe(false);
    expect(isNeutralWorkspaceCwd(runtimePaths.workspaceDir, undefined)).toBe(false);
  });

  it("treats the neutral workspace as available and recreates it when missing", () => {
    const runtimePaths = makeTestRuntimePaths("neutral-aware");
    rmSync(runtimePaths.workspaceDir!, { recursive: true, force: true });

    expect(getNeutralAwareAvailability(runtimePaths.workspaceDir, runtimePaths))
      .toEqual({ cwd: runtimePaths.workspaceDir, available: true, clearStalePin: false });
    expect(existsSync(runtimePaths.workspaceDir!)).toBe(true);
    expect(getNeutralAwareAvailability(join(runtimePaths.dataDir, "missing"), runtimePaths))
      .toMatchObject({ available: false, clearStalePin: true });
  });

  it("recreates a neutral workspace that disappeared after startup", () => {
    const runtimePaths = makeTestRuntimePaths("neutral-recreate");
    rmSync(runtimePaths.workspaceDir!, { recursive: true, force: true });

    expect(ensureNeutralWorkspaceDir(runtimePaths)).toBe(runtimePaths.workspaceDir);
    expect(existsSync(runtimePaths.workspaceDir!)).toBe(true);
  });

  it("finds the enclosing git root and nothing outside a repository", async () => {
    const repo = makeGitRepo("neutral-git-root");
    const nested = join(repo, "a", "b");
    mkdirSync(nested, { recursive: true });

    await expect(findEnclosingGitRoot(nested)).resolves.toBeTruthy();
    await expect(findEnclosingGitRoot(makeTestDir("neutral-no-git"))).resolves.toBeUndefined();
  });
});

describe("prepareNeutralWorkspaceDir", () => {
  it("keeps a configured workspace that is outside every git work tree", async () => {
    const workspaceDir = join(makeTestDir("neutral-safe"), "workspace");
    const runtimePaths = makeTestRuntimePaths("neutral-safe-paths", { workspaceDir });
    const log = silentLog();

    await expect(prepareNeutralWorkspaceDir(runtimePaths, { fallbackDirs: [], log })).resolves.toBe(workspaceDir);
    expect(runtimePaths.workspaceDir).toBe(workspaceDir);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("rejects a configured workspace inside a repository and uses the next candidate", async () => {
    const inRepo = join(makeGitRepo("neutral-in-repo"), "data", "workspace");
    const fallback = join(makeTestDir("neutral-fallback"), "workspace");
    const runtimePaths = makeTestRuntimePaths("neutral-in-repo-paths", { workspaceDir: inRepo });
    const log = silentLog();

    await expect(prepareNeutralWorkspaceDir(runtimePaths, { fallbackDirs: [fallback], log })).resolves.toBe(fallback);
    expect(runtimePaths.workspaceDir).toBe(fallback);
    expect(runtimePaths.env.BRIDGE_WORKSPACE_DIR).toBe(fallback);
    expect(existsSync(fallback)).toBe(true);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("inside the git work tree"));
  });

  it("fails startup when every candidate is inside a repository", async () => {
    const repo = makeGitRepo("neutral-all-in-repo");
    const runtimePaths = makeTestRuntimePaths("neutral-all-in-repo-paths", { workspaceDir: join(repo, "a") });

    await expect(prepareNeutralWorkspaceDir(runtimePaths, { fallbackDirs: [join(repo, "b")], log: silentLog() }))
      .rejects.toThrow("No Bridge workspace candidate is outside a git work tree");
  });

  it("rejects a workspace that links into a repository", async () => {
    const repoTarget = join(makeGitRepo("neutral-link-target"), "workspace");
    mkdirSync(repoTarget, { recursive: true });
    const linkPath = join(makeTestDir("neutral-link"), "workspace");
    const link = createDirectoryLink(linkPath, repoTarget, process.cwd());
    expect(link.ok, link.output).toBe(true);
    const fallback = join(makeTestDir("neutral-link-fallback"), "workspace");
    const runtimePaths = makeTestRuntimePaths("neutral-link-paths", { workspaceDir: linkPath });

    await expect(prepareNeutralWorkspaceDir(runtimePaths, { fallbackDirs: [fallback], log: silentLog() }))
      .resolves.toBe(fallback);
  });
});
