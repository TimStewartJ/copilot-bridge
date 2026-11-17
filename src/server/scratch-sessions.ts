import { randomUUID } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import type { IncomingHttpHeaders } from "node:http";
import { join } from "node:path";
import { WEB_CLIENT_HEADER } from "../shared/web-client.js";

/** Scratch chats: REST-started by scripts, hidden from lists, deleted after a day idle. */
export const SCRATCH_SESSION_ID_PREFIX = "5c7a7c40";
export const SCRATCH_SESSION_IDLE_TTL_MS = 24 * 60 * 60 * 1000;

export function createScratchSessionId(): string {
  const uuid = randomUUID();
  return `${SCRATCH_SESSION_ID_PREFIX}${uuid.slice(SCRATCH_SESSION_ID_PREFIX.length)}`;
}

export function isScratchSessionId(sessionId: string): boolean {
  return sessionId.startsWith(`${SCRATCH_SESSION_ID_PREFIX}-`);
}

/** Script can't set Sec-Fetch-Site, so tabs that predate WEB_CLIENT_HEADER still count. */
export function isWebClientRequest(headers: IncomingHttpHeaders): boolean {
  return headers["sec-fetch-site"] !== undefined || headers[WEB_CLIENT_HEADER.toLowerCase()] !== undefined;
}

export interface ScratchSessionSweepDeps {
  copilotHome: string;
  /** Sessions with a run, a running agent or command, or a pending defer. */
  isProtected(sessionId: string): boolean;
  deleteSession(sessionId: string): Promise<void>;
  now?: () => number;
  idleTtlMs?: number;
  logger?: Pick<Console, "error">;
}

/** Deletes the scratch chats nothing has written to for idleTtlMs; returns their ids. */
export async function sweepExpiredScratchSessions(deps: ScratchSessionSweepDeps): Promise<string[]> {
  const sessionStateDir = join(deps.copilotHome, "session-state");
  const cutoff = (deps.now ?? Date.now)() - (deps.idleTtlMs ?? SCRATCH_SESSION_IDLE_TTL_MS);
  let names: string[];
  try {
    names = await readdir(sessionStateDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const deleted: string[] = [];
  for (const sessionId of names) {
    if (!isScratchSessionId(sessionId)) continue;
    try {
      const dir = join(sessionStateDir, sessionId);
      const lastWrite = await stat(join(dir, "events.jsonl")).catch(() => stat(dir));
      // Checked after the await, right before deleting: deleteSession itself refuses a busy chat.
      if (lastWrite.mtimeMs > cutoff || deps.isProtected(sessionId)) continue;
      await deps.deleteSession(sessionId);
      deleted.push(sessionId);
    } catch (error) {
      deps.logger?.error(`[scratch] Could not delete scratch chat ${sessionId}:`, error);
    }
  }
  return deleted;
}
