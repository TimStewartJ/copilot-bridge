// Removes task links to conversations that no longer exist anywhere.
//
// Deleting a chat through the Bridge unlinks it from its tasks. A session folder that disappears
// some other way (a lost or restored disk, a manual delete) leaves its link behind; a task then
// lists a conversation the session list never has, and the task list says its activity data is
// incomplete for good. This pass, run by session maintenance, removes such links once it is sure
// the conversation is gone: its folder is absent, the CLI's catalog does not know it, nothing in
// the Bridge is using it, and the link is old enough not to belong to a chat still being created.

import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AppContext } from "./app-context.js";
import { hasActiveDeferredWork } from "./schedule-session-retention.js";
import type { SessionLink } from "./task-store.js";

/** A link younger than this is left alone: its chat may still be on its way to disk. */
export const DANGLING_LINK_MINIMUM_AGE_MS = 60 * 60 * 1000;

export interface DanglingLinkRepairResult {
  removedLinks: number;
  goneSessionIds: string[];
  /** Why nothing was removed although links looked dangling. */
  skipped?: "session_state_unreadable" | "catalog_unavailable" | "mass_loss";
}

interface RepairSessionManager {
  listPendingSessionCreationIds?: () => string[];
  getActiveSessions?: () => string[];
  isSessionBusy?: (sessionId: string) => boolean;
  getPendingUserInputCount?: (sessionId: string) => number;
}

function isAbsentError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function folderIsAbsent(path: string): Promise<boolean> {
  try {
    await stat(path);
    return false;
  } catch (error) {
    if (isAbsentError(error)) return true;
    throw error;
  }
}

/** Sessions the Bridge is working with right now, read without awaiting so the caller can act on it at once. */
function inUseSessionIds(ctx: AppContext, sessionIds: Iterable<string>): Set<string> {
  const manager = ctx.sessionManager as unknown as RepairSessionManager;
  const pending = new Set(manager.listPendingSessionCreationIds?.() ?? []);
  const active = new Set(manager.getActiveSessions?.() ?? []);
  const jobs = [...(ctx.managementJobStore?.listActive() ?? []), ...(ctx.managementJobStore?.listDeploysAwaitingActivation() ?? [])];
  const jobOrigins = new Set(jobs.map((job) => job.originSessionId).filter((id): id is string => !!id));
  const inUse = new Set<string>();
  for (const sessionId of sessionIds) {
    if (pending.has(sessionId) || active.has(sessionId) || jobOrigins.has(sessionId)
      || manager.isSessionBusy?.(sessionId)
      || (manager.getPendingUserInputCount?.(sessionId) ?? 0) > 0
      || ctx.eventBusRegistry.hasBus(sessionId)
      || hasActiveDeferredWork(sessionId, ctx)) {
      inUse.add(sessionId);
    }
  }
  return inUse;
}

export async function repairDanglingTaskSessionLinks(
  ctx: AppContext,
  options: { minimumLinkAgeMs?: number; now?: () => number } = {},
): Promise<DanglingLinkRepairResult> {
  const minimumLinkAgeMs = options.minimumLinkAgeMs ?? DANGLING_LINK_MINIMUM_AGE_MS;
  const cutoff = (options.now ?? Date.now)() - minimumLinkAgeMs;
  const isOld = (link: SessionLink) => {
    const linkedAt = Date.parse(link.linkedAt);
    return Number.isFinite(linkedAt) && linkedAt <= cutoff;
  };
  const none: DanglingLinkRepairResult = { removedLinks: 0, goneSessionIds: [] };

  const linkedSessionIds = new Set(ctx.taskStore.listSessionLinks().map((link) => link.sessionId));
  if (linkedSessionIds.size === 0) return none;

  const sessionStateDir = join(ctx.copilotHome ?? ctx.runtimePaths?.copilotHome ?? join(homedir(), ".copilot"), "session-state");
  let present: Set<string>;
  try {
    const entries = await readdir(sessionStateDir, { withFileTypes: true });
    present = new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
  } catch (error) {
    if (!isAbsentError(error)) throw error;
    present = new Set();
  }
  // An empty or missing folder is far more likely a wrong home or an unmounted disk than every chat being gone.
  if (present.size === 0) return { ...none, skipped: "session_state_unreadable" };

  const missing = [...linkedSessionIds].filter((sessionId) => !present.has(sessionId));
  if (missing.length === 0) return none;
  // Most linked conversations missing at once looks like a wrong or half-restored home; a single loss is let through.
  if (missing.length > 1 && missing.length * 2 > linkedSessionIds.size) return { ...none, skipped: "mass_loss" };

  const catalog = ctx.cliSessionCatalog;
  if (!catalog) return { ...none, skipped: "catalog_unavailable" };
  const unknown: string[] = [];
  for (const sessionId of missing) {
    const known = await catalog.hasSession(sessionId);
    if (known === undefined) return { ...none, skipped: "catalog_unavailable" };
    if (!known) unknown.push(sessionId);
  }
  // Checked last, so a folder made or restored while the catalog was read keeps its links.
  const gone: string[] = [];
  for (const sessionId of unknown) {
    if (await folderIsAbsent(join(sessionStateDir, sessionId))) gone.push(sessionId);
  }
  if (gone.length === 0) return none;

  // From here to the removal nothing awaits, so a chat cannot be linked or start working in between.
  const goneIds = new Set(gone);
  const inUse = inUseSessionIds(ctx, goneIds);
  const links = ctx.taskStore.listSessionLinks()
    .filter((link) => goneIds.has(link.sessionId) && !inUse.has(link.sessionId) && isOld(link));
  if (links.length === 0) return none;
  ctx.taskStore.removeSessionLinks(links);
  return { removedLinks: links.length, goneSessionIds: [...new Set(links.map((link) => link.sessionId))] };
}
