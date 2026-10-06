// The session list: the one owner of its build, cache, invalidation and per-response overlay.
//
// A build is the slow part: the CLI catalog, the session folders, one workspace.yaml and two
// stats per listed session. Its rows hold what only changes structurally (which sessions exist,
// their names, workspaces and files) and are kept until something structural is announced or
// they are 30 seconds old. Everything that changes while people work (run state, questions,
// archived, activity and read times, task links, schedules, deferred work) is read for each
// response, by session id, for the rows in hand. So archiving, reading or linking a chat needs
// no build, and a response never reads a whole table.
//
// The server's main thread stalls for as long as the synchronous part of a list read takes, and
// that stretches many times over when the machine is busy. Keep both the build and the overlay
// free of whole-table reads.

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AppContext } from "./app-context.js";
import { createDeferSummaryLookup } from "./defer-summary.js";
import { isDisposableDeferWorkerSessionId } from "./defer-worker.js";
import { mapWithConcurrency } from "./map-with-concurrency.js";
import { parseWorkspaceCwd } from "./session-formatting.js";
import { isDisposableTitleSessionId } from "./session-name-generator.js";
import type { SessionWorkspace } from "./session-workspace-store.js";
import { createWorkspaceAvailabilityLookup, type WorkspaceAvailabilityLookup } from "./session-workspace-availability.js";
import { parseWorkspaceYamlSessionName } from "./session-workspace-yaml.js";
import type { SessionTaskLink } from "./task-store.js";
import type { SessionRunState } from "./session-run-state-controller.js";
import { maxIsoTime } from "../shared/session-activity.js";

export type SessionListRow = Record<string, any> & { sessionId: string };

export interface SessionListStatus {
  runState: SessionRunState;
  needsUserInput: boolean;
}

export interface SessionListDeps {
  /** Run state and the other in-memory facts about one session; spread into its row. */
  getStatus(sessionId: string): SessionListStatus;
  summarizeWorkspace(sessionId: string, inputs: {
    sessionOverride: SessionWorkspace | undefined;
    recordedCwd: string | undefined;
    task: SessionTaskLink | undefined;
    getAvailability: WorkspaceAvailabilityLookup;
  }): Promise<{ source: unknown; effectiveCwd?: string }>;
}

export interface SessionList {
  /** The list as a response shows it: rows built after the last announced change, with current volatile fields. */
  read(includeArchived?: boolean): Promise<SessionListRow[]>;
  /** The two halves of `read`, for a caller that does something between them. */
  base(includeArchived?: boolean): Promise<SessionListRow[]>;
  overlay(rows: SessionListRow[], includeArchived: boolean): SessionListRow[];
  /** The given sessions as the list shows them, archived or not, without building the list. */
  readSessions(sessionIds: readonly string[]): Promise<SessionListRow[]>;
  /** Something a build reads has changed. Never builds; `kinds` defaults to both lists. */
  invalidate(reason: string, kinds?: readonly SessionListKind[]): void;
}

export type SessionListKind = "active" | "all";

/** Rows this old are still served, and replaced by one build in the background. */
const REFRESH_AFTER_MS = 30_000;
// Bounded so a build over thousands of sessions cannot flood the libuv threadpool
// and starve concurrent transcript reads.
const DETAIL_CONCURRENCY = 32;
/** Measured with 15,000 stored sessions: by-id reads cost more than whole-table reads from about 10,000 ids. */
const SCAN_TABLES_ABOVE = 8_000;

interface Slot {
  /** Counts invalidations. Rows and builds carry the count they started from. */
  seq: number;
  rows?: { seq: number; builtAt: number; rows: SessionListRow[] };
  build?: { seq: number; promise: Promise<SessionListRow[]> };
  /** The one build queued behind `build`, for readers that arrived after an invalidation. */
  next?: Promise<SessionListRow[]>;
  /**
   * Sessions a build was already started for because a response showed them without details.
   * One stays here while builds leave it without details, so it cannot ask for a build per response.
   */
  askedDetails: Set<string>;
}

export function resolveSessionSummary(
  session: { sessionId: string; summary?: string | null },
  opts: { fallbackSummary?: string } = {},
): string {
  return session.summary || opts.fallbackSummary || "Untitled session";
}

function isShown(opts: {
  includeArchived: boolean;
  archived: boolean;
  linkedTaskCount: number;
  status: SessionListStatus;
  lastActivityAt: string | undefined;
  hasSessionName: boolean;
  hasReadState: boolean;
  hasBridgeActivitySignal: boolean;
  hasDeferredWork: boolean;
}): boolean {
  if (!opts.includeArchived && opts.archived) return false;
  // A session nobody named, linked, ran, read or deferred is noise.
  return opts.archived
    || opts.linkedTaskCount > 0
    || opts.hasSessionName
    || opts.hasBridgeActivitySignal
    || (opts.hasReadState && !!opts.lastActivityAt)
    || opts.hasDeferredWork
    || opts.status.runState !== "idle"
    || opts.status.needsUserInput;
}

export function createSessionList(ctx: AppContext, deps: SessionListDeps): SessionList {
  const slots: Record<SessionListKind, Slot> = {
    active: { seq: 0, askedDetails: new Set() },
    all: { seq: 0, askedDetails: new Set() },
  };
  const sessionStateDir = join(ctx.copilotHome ?? join(homedir(), ".copilot"), "session-state");

  function recordSpan(name: string, duration: number, metadata: Record<string, unknown>): void {
    try {
      ctx.telemetryStore?.recordSpan({ name, duration, metadata, source: "server" });
    } catch { /* telemetry should never break core flow */ }
  }

  /**
   * What the overlay and the detail filter both read about a set of sessions, by id. For a very
   * long list (the one with archived chats) one scan of each table costs less than a lookup per id.
   */
  function readVolatile(sessionIds: string[]) {
    const everySession = sessionIds.length > SCAN_TABLES_ABOVE;
    return {
      meta: everySession ? ctx.sessionMetaStore.listMeta() : ctx.sessionMetaStore.listMetaFor(sessionIds),
      readState: everySession ? ctx.readStateStore.getReadState() : ctx.readStateStore.getReadStateFor(sessionIds),
      links: ctx.taskStore.listTaskLinksBySession(everySession ? undefined : sessionIds),
      getDeferSummary: createDeferSummaryLookup({
        deferredPromptStore: ctx.deferredPromptStore,
        deferLoopStore: ctx.deferLoopStore,
      }),
    };
  }

  function describe(row: SessionListRow, volatile: ReturnType<typeof readVolatile>, includeArchived: boolean) {
    const id = row.sessionId;
    const meta = volatile.meta[id];
    const status = deps.getStatus(id);
    const linked = volatile.links.get(id) ?? [];
    const lastVisibleActivityAt = meta?.lastVisibleActivityAt ?? row.lastVisibleActivityAt;
    const lastAttentionAt = meta?.lastAttentionAt ?? row.lastAttentionAt;
    const lastActivityAt = maxIsoTime(lastVisibleActivityAt, lastAttentionAt);
    const archived: boolean = meta?.archived ?? row.archived ?? false;
    const deferSummary = volatile.getDeferSummary(id);
    const shown = isShown({
      includeArchived,
      archived,
      linkedTaskCount: linked.length,
      status,
      lastActivityAt,
      hasSessionName: typeof row.summary === "string" && row.summary.trim().length > 0,
      hasReadState: !!volatile.readState[id],
      hasBridgeActivitySignal: !!meta?.lastVisibleActivityAt || !!meta?.lastAttentionAt,
      hasDeferredWork: deferSummary.count > 0,
    });
    return { meta, status, linked, lastVisibleActivityAt, lastAttentionAt, lastActivityAt, archived, deferSummary, shown };
  }

  function overlay(rows: SessionListRow[], includeArchived: boolean): SessionListRow[] {
    const volatile = readVolatile(rows.map((row) => row.sessionId));
    const scheduleEnabled = new Map<string, boolean>();
    const isScheduleEnabled = (scheduleId: string): boolean => {
      let enabled = scheduleEnabled.get(scheduleId);
      if (enabled === undefined) {
        enabled = ctx.scheduleStore.getSchedule(scheduleId)?.enabled ?? false;
        scheduleEnabled.set(scheduleId, enabled);
      }
      return enabled;
    };
    const withoutDetails: string[] = [];
    const shown = rows.flatMap((row) => {
      const current = describe(row, volatile, includeArchived);
      if (!current.shown) return [];
      if (!("workspace" in row)) withoutDetails.push(row.sessionId);
      const { meta, status, linked, lastActivityAt } = current;
      return [{
        ...row,
        summary: resolveSessionSummary(row, {
          fallbackSummary: linked.length === 1 || status.runState !== "idle" ? "New session" : undefined,
        }),
        linkedTaskIds: linked.map((task) => task.id),
        lastVisibleActivityAt: current.lastVisibleActivityAt,
        lastAttentionAt: current.lastAttentionAt,
        lastActivityAt,
        modifiedTime: lastActivityAt ?? row.modifiedTime,
        ...status,
        deferSummary: current.deferSummary,
        archived: current.archived,
        archivedAt: meta?.archivedAt ?? null,
        triggeredBy: meta?.triggeredBy,
        scheduleId: meta?.scheduleId,
        scheduleName: meta?.scheduleName,
        // Only rows built with details say whether their schedule still runs.
        ...("workspace" in row ? { scheduleEnabled: meta?.scheduleId ? isScheduleEnabled(meta.scheduleId) : undefined } : {}),
        intentText: ctx.eventBusRegistry.getBus(row.sessionId)?.getIntentText() ?? null,
      }];
    });
    shown.sort((a, b) => (b.modifiedTime ?? "").localeCompare(a.modifiedTime ?? ""));
    // A session that became visible since its list was built is shown now and gets its details
    // from one build. Rows that are not the list's own (a page of named sessions) never ask.
    const kind: SessionListKind = includeArchived ? "all" : "active";
    const slot = slots[kind];
    if (slot.rows?.rows === rows && !slot.build && withoutDetails.some((id) => !slot.askedDetails.has(id))) {
      for (const id of withoutDetails) slot.askedDetails.add(id);
      buildInBackground(kind);
    }
    return shown;
  }

  /**
   * Adds the file-backed details to the candidates a list would show today. The others stay as
   * found, so a later response can still show one that starts running, until the next build.
   */
  async function addDetails(candidates: SessionListRow[], includeArchived: boolean, usingCatalog: boolean): Promise<SessionListRow[]> {
    const ids = candidates.map((row) => row.sessionId);
    const volatile = readVolatile(ids);
    const pinnedWorkspaces = ctx.sessionWorkspaceStore?.listWorkspacesFor(ids) ?? {};
    const getAvailability = createWorkspaceAvailabilityLookup();
    const overlayStats = { durationMs: 0, readCount: 0, hitCount: 0, mismatchCount: 0, errorCount: 0 };

    const readWorkspaceYaml = async (sessionId: string): Promise<{ sessionName?: string; cwd?: string }> => {
      const start = Date.now();
      overlayStats.readCount += 1;
      try {
        const content = await readFile(join(sessionStateDir, sessionId, "workspace.yaml"), "utf-8");
        return { sessionName: parseWorkspaceYamlSessionName(content), cwd: parseWorkspaceCwd(content) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") overlayStats.errorCount += 1;
        return {};
      } finally {
        overlayStats.durationMs += Date.now() - start;
      }
    };
    const fileSize = (path: string): Promise<number | undefined> => stat(path).then((stats) => stats.size, () => undefined);

    const detailed = await mapWithConcurrency(candidates, DETAIL_CONCURRENCY, async (row) => {
      const id = row.sessionId;
      const { linked, shown } = describe(row, volatile, includeArchived);
      if (!shown) return row;

      const [workspaceYaml, planSize, eventLogSizeBytes] = await Promise.all([
        readWorkspaceYaml(id),
        fileSize(join(sessionStateDir, id, "plan.md")),
        typeof row.eventLogSizeBytes === "number"
          ? row.eventLogSizeBytes as number
          : fileSize(join(sessionStateDir, id, "events.jsonl")).then((size) => size ?? 0),
      ]);
      // The CLI's own summary can lag the name it wrote to workspace.yaml.
      let named = row;
      if (usingCatalog && workspaceYaml.sessionName) {
        overlayStats.hitCount += 1;
        const catalogSummary = typeof row.summary === "string" ? row.summary.trim() : "";
        if (catalogSummary && catalogSummary !== workspaceYaml.sessionName) overlayStats.mismatchCount += 1;
        named = { ...row, summary: workspaceYaml.sessionName };
      }
      const { source: _source, ...workspace } = await deps.summarizeWorkspace(id, {
        sessionOverride: pinnedWorkspaces[id],
        recordedCwd: workspaceYaml.cwd,
        // A session linked to several tasks has no single task workspace.
        task: linked.length === 1 ? linked[0] : undefined,
        getAvailability,
      });
      const context = { ...(row.context ?? {}), ...(workspace.effectiveCwd ? { cwd: workspace.effectiveCwd } : {}) };
      return {
        ...named,
        eventLogSizeBytes,
        context: Object.keys(context).length > 0 ? context : undefined,
        workspace,
        hasPlan: planSize !== undefined,
      };
    });
    if (usingCatalog) {
      recordSpan("session.workspaceNameOverlay", overlayStats.durationMs, {
        readCount: overlayStats.readCount,
        hitCount: overlayStats.hitCount,
        mismatchCount: overlayStats.mismatchCount,
        errorCount: overlayStats.errorCount,
        candidateCount: candidates.length,
        includeArchived,
      });
    }
    return detailed;
  }

  const isListed = (sessionId: string): boolean =>
    !isDisposableTitleSessionId(sessionId)
    && !isDisposableDeferWorkerSessionId(sessionId)
    // Helm conversations live in Helm's own history, not in the chat lists.
    && !ctx.helmStore?.isHelmSession(sessionId);

  const fromCatalogRow = (session: SessionListRow): SessionListRow =>
    ({ ...session, modifiedTime: session.modifiedTime ?? session.startTime });

  async function buildRows(includeArchived: boolean): Promise<SessionListRow[]> {
    // Ids only: the archived sessions are nearly all of them, and none of their rows is used.
    const archivedIds = includeArchived ? [] : ctx.sessionMetaStore.listArchivedSessionIds();
    const catalog = await ctx.cliSessionCatalog?.listSessions(includeArchived ? undefined : { excludeIds: archivedIds });
    const skip = new Set(archivedIds);
    for (const session of catalog ?? []) skip.add(session.sessionId);
    // The native SDK persists sessions on disk without necessarily indexing them in the CLI catalog.
    const onDisk = await ctx.sessionManager.listSessionsFromDisk({ includeArchived, skip });
    const fromCatalog = new Set(catalog?.map((session) => session.sessionId));
    const candidates = [
      ...(catalog ?? []).map(fromCatalogRow),
      ...onDisk.filter((session: SessionListRow) => !fromCatalog.has(session.sessionId)),
    ].filter((session) => isListed(session.sessionId));
    // A creation answers with the session's id before the runtime has made its folder. Until
    // then the session is a candidate as a bare row, so a response shows it once it is linked or
    // running. The creation announces its own end, which replaces the row or removes it.
    const pending = ctx.sessionManager.listPendingSessionCreationIds();
    if (pending.length > 0) {
      const found = new Set(candidates.map((session) => session.sessionId));
      const now = new Date().toISOString();
      for (const sessionId of pending) {
        if (!found.has(sessionId) && isListed(sessionId)) candidates.push({ sessionId, startTime: now, modifiedTime: now });
      }
    }
    return addDetails(candidates, includeArchived, catalog !== undefined);
  }

  async function readSessions(sessionIds: readonly string[]): Promise<SessionListRow[]> {
    const catalog = await ctx.cliSessionCatalog?.listSessions({ ids: sessionIds });
    const found = new Map<string, SessionListRow>((catalog ?? []).map((session) => [session.sessionId, fromCatalogRow(session)]));
    const onDisk = await ctx.sessionManager.readSessionsFromDisk(sessionIds.filter((sessionId) => !found.has(sessionId)));
    for (const session of onDisk) found.set(session.sessionId, session);
    // A session whose files are gone still gets a row, so a page of ids stays a page of rows.
    const candidates = sessionIds.map((sessionId) => found.get(sessionId) ?? { sessionId });
    return overlay(await addDetails(candidates, true, catalog !== undefined), true);
  }

  function startBuild(kind: SessionListKind): Promise<SessionListRow[]> {
    const slot = slots[kind];
    const includeArchived = kind === "all";
    // Before the build's first read: an invalidation from here on makes these rows too old to keep.
    const seq = slot.seq;
    const startedAt = Date.now();
    const promise = buildRows(includeArchived).then((rows) => {
      const stored = seq === slot.seq;
      if (stored) {
        slot.rows = { seq, builtAt: Date.now(), rows };
        if (slot.askedDetails.size > 0) {
          slot.askedDetails = new Set(rows
            .filter((row) => !("workspace" in row) && slot.askedDetails.has(row.sessionId))
            .map((row) => row.sessionId));
        }
      }
      recordSpan("session.enrichedList.build", Date.now() - startedAt, {
        result: stored ? "stored" : "discarded",
        includeArchived,
        cacheKind: kind,
        count: rows.length,
        generation: seq,
        currentGeneration: slot.seq,
      });
      return rows;
    }).finally(() => {
      if (slot.build?.promise === promise) slot.build = undefined;
    });
    slot.build = { seq, promise };
    return promise;
  }

  /** One build off the request path, unless one is running or a reader has to build anyway. */
  function buildInBackground(kind: SessionListKind): void {
    const slot = slots[kind];
    setImmediate(() => {
      if (slot.build || slot.rows?.seq !== slot.seq) return;
      startBuild(kind).catch((error) => {
        console.warn("[sessions] Background session list build failed:", error instanceof Error ? error.message : error);
      });
    });
  }

  function base(includeArchived = false): Promise<SessionListRow[]> {
    const kind: SessionListKind = includeArchived ? "all" : "active";
    const slot = slots[kind];
    // A reader may only get rows, or a build, that started at or after this count.
    const arrivedAt = slot.seq;
    const recordRead = (result: string, extra: Record<string, unknown> = {}) =>
      recordSpan("session.enrichedList.cache", 0, { result, includeArchived, cacheKind: kind, ...extra });

    if (slot.rows && slot.rows.seq >= arrivedAt) {
      const expired = Date.now() - slot.rows.builtAt >= REFRESH_AFTER_MS;
      // The reader that noticed does not wait for it.
      if (expired && !slot.build) buildInBackground(kind);
      recordRead(expired ? "stale-served" : "hit", { count: slot.rows.rows.length });
      return Promise.resolve(slot.rows.rows);
    }
    if (slot.build && slot.build.seq >= arrivedAt) {
      recordRead("coalesced");
      return slot.build.promise;
    }
    recordRead("miss", { queued: !!slot.build });
    if (slot.next) return slot.next;
    if (!slot.build) return startBuild(kind);
    // The running build started before the last invalidation. One more starts when it ends,
    // however it ends, and serves every reader that arrived in between.
    slot.next = slot.build.promise.then(() => undefined, () => undefined).then(() => {
      slot.next = undefined;
      return startBuild(kind);
    });
    return slot.next;
  }

  return {
    base,
    overlay,
    readSessions,
    read: async (includeArchived = false) => overlay(await base(includeArchived), includeArchived),
    invalidate(reason, kinds = ["active", "all"]) {
      for (const kind of kinds) {
        const slot = slots[kind];
        slot.seq += 1;
        slot.rows = undefined;
      }
      recordSpan("session.enrichedList.invalidate", 0, {
        reason,
        kinds,
        generation: slots.active.seq,
        hadActiveBuild: slots.active.build !== undefined,
        hadAllBuild: slots.all.build !== undefined,
      });
    },
  };
}
