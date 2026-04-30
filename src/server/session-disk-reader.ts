import { homedir } from "node:os";
import { join } from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";
import {
  getLastVisibleActivityAt,
  transformEventsToMessages,
  type TransformedEntry,
} from "./event-transform.js";
import type { EventBusRegistry } from "./event-bus.js";
import type { SessionMetaStore } from "./session-meta-store.js";

export interface SessionDiskReaderDeps {
  copilotHome?: string;
  sessionMetaStore?: SessionMetaStore;
  eventBusRegistry: Pick<EventBusRegistry, "getBus">;
  parseWorkspaceSummary(content: string): string | undefined;
  resolveEffectiveSessionCwdFromWorkspaceYaml(sessionId: string, content: string): string | undefined;
  recordSpan(name: string, duration: number, sessionId?: string, metadata?: Record<string, unknown>): void;
  persistLastVisibleActivityAt(sessionId: string, lastVisibleActivityAt?: string): void;
}

export interface ReadMessagesFromDiskResult {
  messages: TransformedEntry[];
  total: number;
  hasMore: boolean;
}

/**
 * Fast session listing — reads workspace.yaml from disk instead of SDK RPC.
 * ~170ms for 4000+ sessions vs ~2500ms for SDK listSessions.
 * Async to avoid blocking the event loop during filesystem I/O.
 */
export async function listSessionsFromDisk(
  deps: SessionDiskReaderDeps,
  options: { includeArchived?: boolean } = {},
): Promise<any[]> {
  const t0 = Date.now();
  const copilotHome = deps.copilotHome ?? join(homedir(), ".copilot");
  const sessionStateDir = join(copilotHome, "session-state");

  let entries: any[];
  try {
    entries = await readdir(sessionStateDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = entries.filter((d: any) => d.isDirectory()).map((d: any) => d.name);
  const includeArchived = options.includeArchived ?? true;
  const meta = deps.sessionMetaStore?.listMeta() ?? {};

  const sessionPromises = dirs.map(async (dirName) => {
    const sessionMeta = meta[dirName];
    if (!includeArchived && sessionMeta?.archived) return null;
    const yamlPath = join(sessionStateDir, dirName, "workspace.yaml");
    try {
      const content = await readFile(yamlPath, "utf-8");
      const session: any = { sessionId: dirName };
      const summary = deps.parseWorkspaceSummary(content);
      if (summary) session.summary = summary;
      const effectiveCwd = deps.resolveEffectiveSessionCwdFromWorkspaceYaml(dirName, content);

      for (const line of content.split(/\r?\n/)) {
        if (line.startsWith("created_at:")) session.startTime = line.slice(12).trim();
      }
      if (effectiveCwd) session.context = { cwd: effectiveCwd };
      // Keep the list path cheap: use persisted visible activity, never parse events.jsonl here.
      const eventsPath = join(sessionStateDir, dirName, "events.jsonl");
      try {
        const st = await stat(eventsPath);
        session.eventLogSizeBytes = st.size;
        session.lastVisibleActivityAt = sessionMeta?.lastVisibleActivityAt;
        session.modifiedTime = session.lastVisibleActivityAt ?? session.startTime ?? st.mtime.toISOString();
      } catch {
        session.eventLogSizeBytes = 0;
        try {
          const st = await stat(yamlPath);
          session.modifiedTime = session.startTime ?? st.mtime.toISOString();
        } catch {}
      }
      session.intentText = deps.eventBusRegistry.getBus(dirName)?.getIntentText() ?? null;
      return session;
    } catch { return null; }
  });

  const results = await Promise.all(sessionPromises);
  const sessions = results.filter((s): s is any => s !== null);

  // Sort by most recent visible activity first
  sessions.sort((a, b) => (b.modifiedTime ?? "").localeCompare(a.modifiedTime ?? ""));

  deps.recordSpan("session.listFromDisk", Date.now() - t0, undefined, { count: sessions.length, includeArchived });
  return sessions;
}

/**
 * Read messages directly from events.jsonl on disk — no SDK resume needed.
 * Returns messages instantly for the fast-load path.
 * Async to avoid blocking the event loop.
 */
export async function readMessagesFromDisk(
  deps: SessionDiskReaderDeps,
  sessionId: string,
  opts?: { limit?: number; before?: number },
): Promise<ReadMessagesFromDiskResult> {
  const t0 = Date.now();
  const copilotHome = deps.copilotHome ?? join(homedir(), ".copilot");
  const eventsPath = join(copilotHome, "session-state", sessionId, "events.jsonl");

  let raw: string;
  try {
    raw = await readFile(eventsPath, "utf-8");
  } catch {
    return { messages: [], total: 0, hasMore: false };
  }

  const events: any[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch { /* skip malformed lines */ }
  }

  const messages = transformEventsToMessages(events, sessionId);
  deps.persistLastVisibleActivityAt(sessionId, getLastVisibleActivityAt(events, sessionId));
  const duration = Date.now() - t0;
  deps.recordSpan("session.readFromDisk", duration, sessionId, {
    eventCount: events.length,
    messageCount: messages.length,
  });

  const total = messages.length;
  if (opts?.limit != null && opts.limit > 0) {
    const end = opts.before != null ? opts.before : total;
    const start = Math.max(0, end - opts.limit);
    const sliced = messages.slice(start, end);
    return { messages: sliced, total, hasMore: start > 0 };
  }
  return { messages, total, hasMore: false };
}
