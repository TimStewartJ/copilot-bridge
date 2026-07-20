// SessionAgentRegistry — projects the Copilot SDK's authoritative per-session
// task registry (`session.rpc.tasks.list()`) into a freshness-aware in-memory
// cache the Bridge can surface in the UI.
//
// Design rule (see plan + rubber-duck review): never present stale data as live
// truth. Every snapshot records whether it came from a live SDK refresh and
// when, so `getSummary()` can label counts `live` / `lastSeen` / `unknown`. The
// UI only drives an active "background agent running" indicator on `live` data.
//
// Freshness is maintained two ways:
//   1. Active runs call `refresh()` when the SDK signals a task change
//      (session.background_tasks_changed / subagent.* / system.notification).
//   2. A bounded poll runs ONLY while a session has non-terminal background
//      agents AND a live session object is cached. It stops as soon as all
//      background agents are terminal, the session object is gone, or a hard
//      safety cap elapses — so it can never leak or churn idle sessions.

import type { GlobalBus } from "./global-bus.js";
import type { AgentBackgroundTask, AgentSession } from "./agent-backend/index.js";
import {
  type AgentCountsSource,
  type AgentExecutionMode,
  type AgentTaskStatus,
  type BackgroundAgentsAggregate,
  type BackgroundAgentsSummary,
  type SessionAgentTask,
  emptyBackgroundAgentsSummary,
  isTerminalAgentStatus,
  summarizeBackgroundAgents,
} from "../shared/session-agents.js";

/** After this window without a live refresh, a snapshot degrades to `lastSeen`. */
const FRESHNESS_WINDOW_MS = 60_000;
/** Interval for the bounded in-flight poll. */
const DEFAULT_POLL_INTERVAL_MS = 15_000;
/** Hard cap on a single session's poll lifetime, so a stuck task can't leak a timer. */
const POLL_MAX_DURATION_MS = 10 * 60_000;
/**
 * Soft cap on retained `entries`. When exceeded, the least-recently-refreshed
 * entries without a live session are dropped so the map cannot grow unbounded
 * across long-lived servers. Entries with a live SDK object are always kept.
 */
const DEFAULT_MAX_ENTRIES = 500;

const KNOWN_STATUSES: ReadonlySet<string> = new Set<AgentTaskStatus>([
  "running",
  "idle",
  "completed",
  "failed",
  "cancelled",
]);

interface RegistryEntry {
  tasks: SessionAgentTask[];
  tasksSignature?: string;
  ownerSession?: AgentSession;
  /** Epoch ms of the last successful live refresh. */
  refreshedAt: number;
  /** Whether this entry has ever been populated from a live SDK refresh. */
  hadLiveRefresh: boolean;
  /** Last emitted counts signature, to suppress redundant bus traffic. */
  lastSignature?: string;
  refreshPromise?: Promise<void>;
  reapPromise?: Promise<number>;
  pollTimer?: ReturnType<typeof setInterval>;
  pollStartedAt?: number;
}

export interface SessionAgentRegistryDeps {
  globalBus: GlobalBus;
  /** Returns the cached live SDK session object, or undefined when not cached. */
  getLiveSession(sessionId: string): AgentSession | undefined;
  /** Called when the authoritative task set or task activity changes. */
  onTasksChanged?(sessionId: string): void;
  now?(): number;
  pollIntervalMs?: number;
  /** Soft cap on retained entries (see DEFAULT_MAX_ENTRIES). Normalized to a finite int >= 1. */
  maxEntries?: number;
  logger?: Pick<Console, "warn">;
}

export class SessionAgentRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly now: () => number;
  private readonly pollIntervalMs: number;
  private readonly maxEntries: number;
  private readonly logger: Pick<Console, "warn">;

  constructor(private readonly deps: SessionAgentRegistryDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const max = deps.maxEntries;
    this.maxEntries =
      typeof max === "number" && Number.isFinite(max) && max >= 1
        ? Math.floor(max)
        : DEFAULT_MAX_ENTRIES;
    this.logger = deps.logger ?? console;
  }

  /**
   * Pure synchronous counts projection for the session-list DTO. Computes
   * `source` from freshness without touching the SDK or disk.
   */
  getSummary(sessionId: string): BackgroundAgentsSummary {
    const entry = this.entries.get(sessionId);
    if (!entry || !entry.hadLiveRefresh) return emptyBackgroundAgentsSummary("unknown");
    const source = this.deriveSource(entry);
    return summarizeBackgroundAgents(
      entry.tasks,
      source,
      new Date(entry.refreshedAt).toISOString(),
    );
  }

  /**
   * Pure in-memory aggregate for server-wide activity reporting. Only fresh
   * snapshots contribute agent counts; stale snapshots are reported separately.
   */
  getAggregate(): BackgroundAgentsAggregate {
    const aggregate: BackgroundAgentsAggregate = {
      running: 0,
      idle: 0,
      failed: 0,
      total: 0,
      liveSessions: 0,
      staleSessions: 0,
      unknownSessions: 0,
    };

    for (const entry of this.entries.values()) {
      if (!entry.hadLiveRefresh) {
        aggregate.unknownSessions += 1;
        continue;
      }
      if (this.deriveSource(entry) !== "live") {
        aggregate.staleSessions += 1;
        continue;
      }

      aggregate.liveSessions += 1;
      const summary = summarizeBackgroundAgents(entry.tasks, "live");
      aggregate.running += summary.running;
      aggregate.idle += summary.idle;
      aggregate.failed += summary.failed;
      aggregate.total += summary.total;
    }

    return aggregate;
  }

  /** Full snapshot for the authorized per-session endpoint. */
  getSnapshot(sessionId: string): {
    tasks: SessionAgentTask[];
    source: AgentCountsSource;
    refreshedAt?: string;
  } {
    const entry = this.entries.get(sessionId);
    if (!entry || !entry.hadLiveRefresh) return { tasks: [], source: "unknown" };
    return {
      tasks: entry.tasks.map((task) => ({ ...task })),
      source: this.deriveSource(entry),
      refreshedAt: new Date(entry.refreshedAt).toISOString(),
    };
  }

  /** Number of tracked agent task contexts owned by a cached parent session. */
  getTrackedAgentCount(sessionId: string): number {
    return this.entries.get(sessionId)?.tasks.length ?? 0;
  }

  /** Remove finished synchronous one-shot agents after their result is consumed. */
  async reapFinishedSyncTasks(sessionId: string, toolCallId?: string): Promise<number> {
    let entry = this.entries.get(sessionId);
    if (!entry) {
      await this.refresh(sessionId, "sync-task-reap");
      entry = this.entries.get(sessionId);
    }
    if (!entry) return 0;

    const previousReap = entry.reapPromise;
    const reapPromise = (async (): Promise<number> => {
      if (previousReap) await previousReap;
      if (entry.refreshPromise) await entry.refreshPromise;

      const session = this.deps.getLiveSession(sessionId);
      if (
        !session
        || typeof session.listTasks !== "function"
        || typeof session.removeTask !== "function"
      ) {
        return 0;
      }

      try {
        const removedIds = new Set<string>();
        const readTasks = async (): Promise<SessionAgentTask[] | undefined> => {
          const result = await session.listTasks!();
          if (this.deps.getLiveSession(sessionId) !== session) return undefined;
          const tasks = (Array.isArray(result?.tasks) ? result.tasks : [])
            .filter((task) => task.kind === "agent")
            .map((task) => this.normalizeTask(task));
          this.commitTasks(sessionId, entry, session, tasks);
          return tasks;
        };
        let tasks = await readTasks();
        if (!tasks) return 0;

        for (let attempt = 0; attempt < 2; attempt++) {
          const candidates = tasks
            .filter((task) =>
              task.executionMode === "sync"
              && task.status !== "running"
              && (!toolCallId || task.toolCallId === toolCallId));
          if (candidates.length === 0) break;

          let changed = false;
          for (const task of candidates) {
            try {
              if (task.status === "idle") {
                const cancelResult = await session.cancelTask?.(task.id);
                if (cancelResult?.cancelled) changed = true;
              }
              const removeResult = await session.removeTask(task.id);
              if (removeResult?.removed) {
                removedIds.add(task.id);
                changed = true;
              }
            } catch (err) {
              this.logger.warn(
                `[agents] [${sessionId.slice(0, 8)}] failed to reap finished sync task ${task.id}: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            }
          }
          if (!changed) break;
          tasks = await readTasks();
          if (!tasks) return removedIds.size;
        }

        return removedIds.size;
      } catch (err) {
        this.logger.warn(
          `[agents] [${sessionId.slice(0, 8)}] finished sync task sweep failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return 0;
      }
    })();
    entry.reapPromise = reapPromise;
    try {
      return await reapPromise;
    } finally {
      if (entry.reapPromise === reapPromise) entry.reapPromise = undefined;
    }
  }

  /** True while any tracked agent task is actively running. */
  hasRunningAgents(sessionId: string): boolean {
    const entry = this.entries.get(sessionId);
    return !!entry
      && this.deriveSource(entry) === "live"
      && entry.tasks.some((task) => task.status === "running");
  }

  /**
   * Refresh a session's tasks from its live SDK session object. No-ops (leaving
   * any prior snapshot to age into `lastSeen`) when no session is cached or the
   * backend lacks the experimental tasks RPC.
   */
  async refresh(sessionId: string, reason: string): Promise<void> {
    const session = this.deps.getLiveSession(sessionId);
    if (!session || typeof session.listTasks !== "function") return;
    const listTasks = session.listTasks.bind(session);

    const existing = this.entries.get(sessionId);
    if (existing?.reapPromise) {
      await existing.reapPromise;
      return this.refresh(sessionId, reason);
    }
    if (existing?.refreshPromise) return existing.refreshPromise;
    const entry = existing ?? this.createEntry();
    this.entries.set(sessionId, entry);

    const refreshPromise = (async (): Promise<void> => {
      try {
        const result = await listTasks();
        if (this.deps.getLiveSession(sessionId) !== session) {
          // Session was evicted while the refresh was in flight. Don't repopulate
          // heavy task text or emit a `live` update for a session we can no longer
          // vouch for; leave any prior (now text-cleared) snapshot to age out.
          return;
        }
        const rawTasks = Array.isArray(result?.tasks) ? result!.tasks! : [];
        const tasks = rawTasks
          .filter((task) => task.kind === "agent")
          .map((task) => this.normalizeTask(task));
        this.commitTasks(sessionId, entry, session, tasks);
      } catch (err) {
        this.logger.warn(
          `[agents] [${sessionId.slice(0, 8)}] tasks.list refresh failed (${reason}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    })();
    entry.refreshPromise = refreshPromise;
    try {
      await refreshPromise;
    } finally {
      if (entry.refreshPromise === refreshPromise) entry.refreshPromise = undefined;
    }
  }

  /**
   * Signal that a session's live object is gone (evicted / disconnected).
   * Stops polling and, if surfaced background agents were still tracked, pushes
   * a `lastSeen` demotion so clients stop presenting the snapshot as live.
   */
  markSessionUnavailable(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    this.stopPoll(entry);
    this.emitLastSeenIfSurfaced(sessionId, entry);
    // Drop heavy untruncated free-text the evicted session no longer needs:
    // counts/status/freshness are enough to age the snapshot out, and the
    // live-gated UI bar won't reopen for an evicted session. A re-resumed
    // session repopulates text via the detail endpoint's live refresh.
    this.clearHeavyTaskFields(entry);
    // Eviction can make older entries prunable; converge the bound now so the
    // map shrinks even without a subsequent refresh.
    this.enforceEntryBound(sessionId);
  }

  /** Drop all state for a deleted session. */
  forget(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    this.stopPoll(entry);
    this.entries.delete(sessionId);
  }

  /** Drop state only when it still belongs to the session object being cleaned. */
  forgetIfOwnedBy(sessionId: string, session: AgentSession): void {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.ownerSession !== session) return;
    this.stopPoll(entry);
    this.entries.delete(sessionId);
  }

  /** Stop all timers (server shutdown / test teardown). */
  dispose(): void {
    for (const entry of this.entries.values()) this.stopPoll(entry);
    this.entries.clear();
  }

  // ── internals ────────────────────────────────────────────────────

  private createEntry(): RegistryEntry {
    return { tasks: [], refreshedAt: 0, hadLiveRefresh: false };
  }

  private commitTasks(
    sessionId: string,
    entry: RegistryEntry,
    session: AgentSession,
    tasks: SessionAgentTask[],
  ): void {
    const tasksSignature = this.getTasksSignature(tasks);
    const tasksChanged = entry.tasksSignature !== tasksSignature;
    entry.tasks = tasks;
    entry.tasksSignature = tasksSignature;
    entry.ownerSession = session;
    entry.refreshedAt = this.now();
    entry.hadLiveRefresh = true;
    this.emitIfChanged(sessionId, entry);
    this.managePoll(sessionId, entry);
    this.enforceEntryBound(sessionId);
    if (!tasksChanged) return;
    try {
      this.deps.onTasksChanged?.(sessionId);
    } catch (err) {
      this.logger.warn(
        `[agents] [${sessionId.slice(0, 8)}] task-change callback failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private getTasksSignature(tasks: readonly SessionAgentTask[]): string {
    return tasks
      .map((task) => [
        task.id,
        task.status,
        task.executionMode ?? "",
        task.activeTimeMs ?? "",
        task.idleSince ?? "",
        task.completedAt ?? "",
      ].join("\u0000"))
      .sort()
      .join("\u0001");
  }

  /** Strip heavy untruncated free-text from retained tasks (in place). */
  private clearHeavyTaskFields(entry: RegistryEntry): void {
    for (const task of entry.tasks) {
      task.prompt = undefined;
      task.result = undefined;
      task.latestResponse = undefined;
      task.error = undefined;
    }
  }

  /**
   * Enforce the soft cap on retained entries. Drops the least-recently-refreshed
   * entries that have no live session and aren't mid-refresh/reap, using the same
   * teardown as `forget`. The just-touched session (`keepSessionId`) and any
   * entry with a live SDK object are never evicted, so the per-session live
   * snapshot stays fully intact (the cap may be exceeded while many sessions are
   * live, which is bounded by the live session cache anyway).
   */
  private enforceEntryBound(keepSessionId: string): void {
    if (this.entries.size <= this.maxEntries) return;
    const evictable: Array<{ id: string; entry: RegistryEntry }> = [];
    for (const [id, entry] of this.entries) {
      if (id === keepSessionId || entry.refreshPromise || entry.reapPromise) continue;
      if (this.deps.getLiveSession(id)) continue;
      evictable.push({ id, entry });
    }
    evictable.sort((a, b) => a.entry.refreshedAt - b.entry.refreshedAt);
    let overflow = this.entries.size - this.maxEntries;
    for (const { id, entry } of evictable) {
      if (overflow <= 0) break;
      this.stopPoll(entry);
      this.entries.delete(id);
      overflow -= 1;
    }
  }

  private deriveSource(entry: RegistryEntry): AgentCountsSource {
    if (!entry.hadLiveRefresh) return "unknown";
    return this.now() - entry.refreshedAt <= FRESHNESS_WINDOW_MS ? "live" : "lastSeen";
  }

  private normalizeTask(task: AgentBackgroundTask): SessionAgentTask {
    const status: AgentTaskStatus = KNOWN_STATUSES.has(task.status)
      ? (task.status as AgentTaskStatus)
      : "running";
    const executionMode: AgentExecutionMode | undefined =
      task.executionMode === "sync" || task.executionMode === "background"
        ? task.executionMode
        : undefined;
    return {
      id: task.id,
      toolCallId: task.toolCallId,
      description: task.description,
      status,
      executionMode,
      agentType: task.agentType,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      activeTimeMs: task.activeTimeMs,
      idleSince: task.idleSince,
      model: task.model,
      error: task.error,
      prompt: task.prompt,
      result: task.result,
      latestResponse: task.latestResponse,
    };
  }

  private emitIfChanged(sessionId: string, entry: RegistryEntry, sourceOverride?: AgentCountsSource): void {
    const source = sourceOverride ?? this.deriveSource(entry);
    const summary = summarizeBackgroundAgents(
      entry.tasks,
      source,
      entry.hadLiveRefresh ? new Date(entry.refreshedAt).toISOString() : undefined,
    );
    const signature = `${summary.running}|${summary.idle}|${summary.failed}|${summary.total}|${summary.source}`;
    if (entry.lastSignature === signature) return;
    entry.lastSignature = signature;
    this.deps.globalBus.emit({
      type: "session:agents",
      sessionId,
      backgroundAgents: summary,
    });
  }

  /**
   * Push a `lastSeen` demotion when we stop refreshing a session that still has
   * surfaced (running/idle) background agents — e.g. the poll hit its cap or the
   * live session was evicted. Without this, a client that received a `live`
   * snapshot would keep showing an active indicator against data the server can
   * no longer vouch for. Terminal-only snapshots carry nothing to demote.
   */
  private emitLastSeenIfSurfaced(sessionId: string, entry: RegistryEntry): void {
    if (!entry.hadLiveRefresh) return;
    const summary = summarizeBackgroundAgents(entry.tasks, "lastSeen");
    if (summary.running === 0 && summary.idle === 0) return;
    this.emitIfChanged(sessionId, entry, "lastSeen");
  }

  private hasNonTerminalBackground(entry: RegistryEntry): boolean {
    return entry.tasks.some(
      (task) =>
        (task.executionMode === undefined || task.executionMode === "background") &&
        !isTerminalAgentStatus(task.status),
    );
  }

  private managePoll(sessionId: string, entry: RegistryEntry): void {
    const session = this.deps.getLiveSession(sessionId);
    const shouldPoll = !!session && this.hasNonTerminalBackground(entry);
    if (!shouldPoll) {
      this.stopPoll(entry);
      return;
    }
    if (entry.pollTimer) return;
    entry.pollStartedAt = this.now();
    entry.pollTimer = setInterval(() => {
      const current = this.entries.get(sessionId);
      if (!current) return;
      if (
        current.pollStartedAt !== undefined &&
        this.now() - current.pollStartedAt > POLL_MAX_DURATION_MS
      ) {
        if (current.tasks.some((task) => task.status === "running")) {
          current.pollStartedAt = this.now();
          void this.refresh(sessionId, "running-poll");
          return;
        }
        this.stopPoll(current);
        this.emitLastSeenIfSurfaced(sessionId, current);
        return;
      }
      void this.refresh(sessionId, "poll");
    }, this.pollIntervalMs);
    if (typeof entry.pollTimer.unref === "function") entry.pollTimer.unref();
  }

  private stopPoll(entry: RegistryEntry): void {
    if (entry.pollTimer) {
      clearInterval(entry.pollTimer);
      entry.pollTimer = undefined;
    }
    entry.pollStartedAt = undefined;
  }
}
