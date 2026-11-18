// A comparison twin's own Git worktree, so the two agents never edit the same files.
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { runGit } from "./git-command.js";

const WORKTREE_TIMEOUT_MS = 120_000;

export interface TwinWorkspace {
  /** Where the twin starts: the same subfolder of its worktree as the user's chat is in. */
  cwd: string;
  repo: string;
  worktree: string;
}

/** A detached worktree of the folder's repository at HEAD, or undefined when it is not in Git. */
export async function createTwinWorkspace(cwd: string | undefined, worktree: string): Promise<TwinWorkspace | undefined> {
  if (!cwd) return undefined;
  const top = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
  const prefix = await runGit(cwd, ["rev-parse", "--show-prefix"]);
  if (!top.ok || !top.output || !prefix.ok) return undefined;
  const repo = resolve(top.output);
  await mkdir(dirname(worktree), { recursive: true });
  const added = await runGit(repo, ["worktree", "add", "--detach", worktree, "HEAD"], WORKTREE_TIMEOUT_MS);
  if (!added.ok) throw new Error(`Couldn't make a worktree for the second chat: ${added.error}`);
  const subfolder = prefix.output.replace(/[\\/]+$/, "");
  return { cwd: subfolder ? join(worktree, subfolder) : worktree, repo, worktree };
}

export async function removeTwinWorkspace(repo: string, worktree: string): Promise<void> {
  const removed = await runGit(repo, ["worktree", "remove", "--force", worktree], WORKTREE_TIMEOUT_MS);
  if (!removed.ok) throw new Error(removed.error);
}
