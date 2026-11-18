import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeTestDir } from "./helpers.js";
import { runGit } from "../git-command.js";
import { createTwinWorkspace, removeTwinWorkspace, twinWorkspaceChanged } from "../comparison-workspace.js";

async function git(cwd: string, args: string[]): Promise<void> {
  const result = await runGit(cwd, args, 30_000);
  if (!result.ok) throw new Error(result.error);
}

describe("comparison twin workspace", () => {
  it("checks the repository out at HEAD for the twin, in the same subfolder, and removes it", async () => {
    const repo = makeTestDir("twin-repo");
    mkdirSync(join(repo, "app"));
    writeFileSync(join(repo, "app", "index.txt"), "hello");
    await git(repo, ["init", "-q"]);
    await git(repo, ["-c", "user.email=user@example.com", "-c", "user.name=Example", "add", "."]);
    await git(repo, ["-c", "user.email=user@example.com", "-c", "user.name=Example", "commit", "-q", "-m", "init"]);
    const worktree = join(makeTestDir("twin-worktrees"), "twin-1");

    const workspace = await createTwinWorkspace(join(repo, "app"), worktree);
    expect(workspace?.cwd).toBe(join(worktree, "app"));
    expect(existsSync(join(worktree, "app", "index.txt"))).toBe(true);
    expect(await twinWorkspaceChanged(worktree)).toBe(false);
    writeFileSync(join(worktree, "app", "index.txt"), "changed");
    expect(await twinWorkspaceChanged(worktree)).toBe(true);

    await removeTwinWorkspace(workspace!.repo, workspace!.worktree);
    expect(existsSync(worktree)).toBe(false);
  });

  it("gives no workspace for a folder outside Git", async () => {
    expect(await createTwinWorkspace(makeTestDir("twin-plain"), join(makeTestDir("twin-out"), "twin-2"))).toBeUndefined();
  });
});
