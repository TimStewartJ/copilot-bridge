// The poll isn't redundant: snapshots expire while agents run silent, freeing them for eviction.

import type { GlobalBus } from "./global-bus.js";
import type { AgentBackgroundTask, AgentSession } from "./agent-backend/index.js";
import {
  BACKGROUND_COMMAND_PROTECT_MS,
  isWithinBackgroundCommandProtection,
  type RunningBackgroundCommand,
} from "./background-commands.js";
import {
  type AgentCountsSource,
  type AgentDismissResult,
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
/** Covers the gap before the runtime's post-command turn; must stay below FRESHNESS_WINDOW_MS. */
const COMMAND_SETTLE_MS = 10_000;
/** Interval for the bounded in-flight poll. */
const DEFAULT_POLL_INTERVAL_MS = 15_000;
/** Hard cap on a single session's poll lifetime, so a stuck task can't leak a timer. */
const POLL_MAX_DURATION_MS = 10 * 60_000;
/** Soft cap; evicts least-recently-refreshed entries that have no live session. */
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
  /** Background commands running in the session's attached shells, from the `tasks` listing. */
  commands: RunningBackgroundCommand[];
  commandsSignature: string;
  /** Epoch ms until which a command that just left the running set still protects the session. */
  commandSettleUntil?: number;
  ownerSession?: AgentSession;
  /** Epoch ms of the last successful live refresh. */
  refreshedAt: number;
  /** Whether this entry has ever been populated from a live SDK refresh. */
  hadLiveRefresh: boolean;
  /** Last emitted counts signature, to suppress redundant bus traffic. */
  lastSignature?: string;
  refreshPromise?: Promise<void>;
  /** The reap or dismissal in flight. They change the runtime's list, so they run one at a time. */
  mutationPromise?: Promise<unknown>;
  pollTimer?: ReturnType<typeof setInterval>;
  pollStartedAt?: number;
}

export interface SessionAgentRegistryDeps {
  globalBus: GlobalBus;
  /** Returns the cached live SDK session object, or undefined when not cached. */
  getLiveSession(sessionId: string): AgentSession | undefined;
  /** Called when the authoritative task set or task activity changes. */
  onTasksChanged?(sessionId: string): void;
  /** Called with the full current set when a command starts running or leaves the running set. */
  onCommandsChanged?(sessionId: string, commands: RunningBackgroundCommand[]): void;
  /** Called when a session's live object goes away while commands were still running in it. */
  onCommandsStopped?(sessionId: string, commands: RunningBackgroundCommand[]): void;
  now?(): number;
  pollIntervalMs?: number;
  /** How long after a command starts it keeps its session protected. */
  commandProtectMs?: number;
  /** Soft cap on retained entries (see DEFAULT_MAX_ENTRIES). Normalized to a finite int >= 1. */
  maxEntries?: number;
  logger?: Pick<Console, "warn">;
}

export class SessionAgentRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly now: () => number;
  private readonly pollIntervalMs: number;
  private readonly commandProtectMs: number;
  private readonly maxEntries: number;
  private readonly logger: Pick<Console, "warn">;

  constructor(private readonly deps: SessionAgentRegistryDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.commandProtectMs = deps.commandProtectMs ?? BACKGROUND_COMMAND_PROTECT_MS;
    const max = deps.maxEntries;
    this.maxEntries =
      typeof max === "number" && Number.isFinite(max) && max >= 1
        ? Math.floor(max)
        : DEFAULT_MAX_ENTRIES;
    this.logger = deps.logger ?? console;
  }

  /** Counts for the session-list DTO; `source` comes from freshness, without SDK or disk. */
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

  /** Server-wide activity; only fresh snapshots add agent counts, stale ones are reported apart. */
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

    return this.runTaskMutation(entry, async (): Promise<number> => {
      const session = this.deps.getLiveSession(sessionId);
      if (!session) return 0;

      try {
        const removedIds = new Set<string>();
        const readTasks = () => this.readAndCommitTasks(sessionId, entry, session);
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
                const cancelResult = await session.cancelTask(task.id);
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
    });
  }

  /** Ends an idle agent first (only ended ones are removed); checks by re-reading the list. */
  async dismissTask(sessionId: string, agentId: string): Promise<AgentDismissResult> {
    if (!this.deps.getLiveSession(sessionId)) return { dismissed: false, reason: "unavailable" };
    let entry = this.entries.get(sessionId);
    if (!entry) {
      await this.refresh(sessionId, "dismiss");
      entry = this.entries.get(sessionId);
    }
    if (!entry) return { dismissed: false, reason: "unavailable" };
    const tracked = entry;

    return this.runTaskMutation(tracked, async (): Promise<AgentDismissResult> => {
      const session = this.deps.getLiveSession(sessionId);
      if (!session) return { dismissed: false, reason: "unavailable" };
      const find = async (): Promise<SessionAgentTask | null | undefined> => {
        const tasks = await this.readAndCommitTasks(sessionId, tracked, session);
        return tasks && (tasks.find((task) => task.id === agentId) ?? null);
      };

      let task = await find();
      if (task === undefined) return { dismissed: false, reason: "unavailable" };
      if (task === null) return { dismissed: false, reason: "not-found" };

      // The runtime can be slow to show an agent as ended, so removal gets a second try.
      for (let attempt = 0; attempt < 2; attempt++) {
        if (task.status === "running") return { dismissed: false, reason: "running" };
        if (task.status === "idle") await session.cancelTask(agentId);
        await session.removeTask(agentId);
        task = await find();
        if (task === undefined) return { dismissed: false, reason: "unavailable" };
        if (task === null) return { dismissed: true };
      }
      return { dismissed: false, reason: "refused" };
    });
  }

  /** True while any tracked agent task is actively running. */
  hasRunningAgents(sessionId: string): boolean {
    const entry = this.entries.get(sessionId);
    return !!entry
      && this.deriveSource(entry) === "live"
      && entry.tasks.some((task) => task.status === "running");
  }

  /** True while a recent command runs or just ended; old ones don't count, so none pins forever. */
  hasProtectedCommand(sessionId: string): boolean {
    const entry = this.entries.get(sessionId);
    return !!entry
      && this.deriveSource(entry) === "live"
      && (this.hasProtectedCommandIn(entry) || this.now() < (entry.commandSettleUntil ?? 0));
  }

  /** Background commands running in the session's attached shells as of the last refresh. */
  getRunningCommands(sessionId: string): RunningBackgroundCommand[] {
    return (this.entries.get(sessionId)?.commands ?? []).map((command) => ({ ...command }));
  }

  /** No-op (prior snapshot ages into `lastSeen`) without a cached session or the tasks RPC. */
  async refresh(sessionId: string, reason: string): Promise<void> {
    const session = this.deps.getLiveSession(sessionId);
    if (!session) return;
    const listTasks = session.listTasks.bind(session);

    const existing = this.entries.get(sessionId);
    if (existing?.mutationPromise) {
      await existing.mutationPromise.catch(() => undefined);
      return this.refresh(sessionId, reason);
    }
    if (existing?.refreshPromise) return existing.refreshPromise;
    const entry = existing ?? this.createEntry();
    this.entries.set(sessionId, entry);

    const refreshPromise = (async (): Promise<void> => {
      try {
        const result = await listTasks();
        if (this.deps.getLiveSession(sessionId) !== session) {
          // Evicted mid-refresh: don't restore text or emit `live` for a session we can't vouch for
          return;
        }
        const rawTasks = Array.isArray(result?.tasks) ? result!.tasks! : [];
        const tasks = rawTasks
          .filter((task) => task.kind === "agent")
          .map((task) => this.normalizeTask(task));
        this.commitTasks(sessionId, entry, session, tasks, this.readRunningCommands(entry, rawTasks));
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

  /** Live object gone: stop polling, demote to lastSeen, report its commands as stopped. */
  markSessionUnavailable(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    this.stopPoll(entry);
    const stoppedCommands = entry.commands;
    entry.commands = [];
    entry.commandsSignature = "";
    entry.commandSettleUntil = undefined;
    if (stoppedCommands.length > 0) {
      try {
        this.deps.onCommandsStopped?.(sessionId, stoppedCommands);
      } catch (err) {
        this.logger.warn(
          `[agents] [${sessionId.slice(0, 8)}] stopped-command callback failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    this.emitLastSeenIfSurfaced(sessionId, entry);
    // Evicted: drop heavy task text; counts suffice and a resumed session refetches it.
    this.clearHeavyTaskFields(entry);
    // Eviction can make older entries prunable; enforce the bound now, not at the next refresh.
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
    return { tasks: [], commands: [], commandsSignature: "", refreshedAt: 0, hadLiveRefresh: false };
  }

  /** Runs a task-list change after any earlier change and any refresh in flight. */
  private async runTaskMutation<T>(entry: RegistryEntry, mutate: () => Promise<T>): Promise<T> {
    const previous = entry.mutationPromise;
    const mutation = (async (): Promise<T> => {
      if (previous) await previous.catch(() => undefined);
      if (entry.refreshPromise) await entry.refreshPromise;
      return mutate();
    })();
    entry.mutationPromise = mutation;
    try {
      return await mutation;
    } finally {
      if (entry.mutationPromise === mutation) entry.mutationPromise = undefined;
    }
  }

  /** Reads and records the runtime's list; undefined if the session object was replaced. */
  private async readAndCommitTasks(
    sessionId: string,
    entry: RegistryEntry,
    session: AgentSession,
  ): Promise<SessionAgentTask[] | undefined> {
    const result = await session.listTasks();
    if (this.deps.getLiveSession(sessionId) !== session) return undefined;
    const rawTasks = Array.isArray(result?.tasks) ? result.tasks : [];
    const tasks = rawTasks
      .filter((task) => task.kind === "agent")
      .map((task) => this.normalizeTask(task));
    this.commitTasks(sessionId, entry, session, tasks, this.readRunningCommands(entry, rawTasks));
    return tasks;
  }

  /** Agents' running shell commands minus sync (a live run's) and detached (outlive the handle). */
  private readRunningCommands(
    entry: RegistryEntry,
    rawTasks: readonly AgentBackgroundTask[],
  ): RunningBackgroundCommand[] {
    const known = new Map(entry.commands.map((command) => [command.shellId, command]));
    const firstSeenAt = new Date(this.now()).toISOString();
    return rawTasks
      .filter((task) => task.kind === "shell"
        && task.status === "running"
        && task.executionMode === "background"
        && task.attachmentMode !== "detached")
      .map((task) => ({
        shellId: task.id,
        // Start time is identity and age: without one from the runtime, keep the first one seen.
        startedAt: task.startedAt && Number.isFinite(Date.parse(task.startedAt))
          ? task.startedAt
          : known.get(task.id)?.startedAt ?? firstSeenAt,
        ...(task.description ? { description: task.description } : {}),
        ...(task.command ? { command: task.command } : {}),
        ...(task.pid !== undefined ? { pid: task.pid } : {}),
      }));
  }

  private hasProtectedCommandIn(entry: RegistryEntry): boolean {
    const now = this.now();
    return entry.commands.some((command) =>
      isWithinBackgroundCommandProtection(command.startedAt, now, this.commandProtectMs));
  }

  private commitTasks(
    sessionId: string,
    entry: RegistryEntry,
    session: AgentSession,
    tasks: SessionAgentTask[],
    commands: RunningBackgroundCommand[],
  ): void {
    const tasksSignature = this.getTasksSignature(tasks);
    const tasksChanged = entry.tasksSignature !== tasksSignature;
    const commandKey = (command: RunningBackgroundCommand) => `${command.shellId}\u0000${command.startedAt}`;
    // A pid can arrive after the command is listed: record it as a change, not a command ending.
    const commandsSignature = commands
      .map((command) => `${commandKey(command)}\u0000${command.pid ?? ""}`)
      .sort()
      .join("\u0001");
    const commandsChanged = entry.commandsSignature !== commandsSignature;
    if (commandsChanged) {
      const stillRunning = new Set(commands.map(commandKey));
      if (entry.commands.some((command) => !stillRunning.has(commandKey(command)))) {
        entry.commandSettleUntil = this.now() + COMMAND_SETTLE_MS;
      }
    }
    entry.tasks = tasks;
    entry.tasksSignature = tasksSignature;
    entry.commands = commands;
    entry.commandsSignature = commandsSignature;
    entry.ownerSession = session;
    entry.refreshedAt = this.now();
    entry.hadLiveRefresh = true;
    this.emitIfChanged(sessionId, entry);
    this.managePoll(sessionId, entry);
    this.enforceEntryBound(sessionId);
    if (commandsChanged) {
      try {
        this.deps.onCommandsChanged?.(sessionId, commands.map((command) => ({ ...command })));
      } catch (err) {
        this.logger.warn(
          `[agents] [${sessionId.slice(0, 8)}] command-change callback failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
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

  /** Never evicts the touched, live or mid-refresh entries, so the cap may be exceeded. */
  private enforceEntryBound(keepSessionId: string): void {
    if (this.entries.size <= this.maxEntries) return;
    const evictable: Array<{ id: string; entry: RegistryEntry }> = [];
    for (const [id, entry] of this.entries) {
      if (id === keepSessionId || entry.refreshPromise || entry.mutationPromise) continue;
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
      name: task.displayName,
      description: task.description,
      status,
      executionMode,
      agentType: task.agentType,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      activeTimeMs: task.activeTimeMs,
      activeStartedAt: task.activeStartedAt,
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

  /** Without this, clients keep a live indicator the server can no longer vouch for. */
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
    const shouldPoll = !!session && (this.hasNonTerminalBackground(entry) || this.hasProtectedCommandIn(entry));
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
        if (current.tasks.some((task) => task.status === "running") || this.hasProtectedCommandIn(current)) {
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
