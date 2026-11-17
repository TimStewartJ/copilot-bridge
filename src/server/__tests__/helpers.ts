// Light fixtures only; keep the API router graph out (createTestApp lives in ./test-app.ts).

import type { SessionPlaybookView } from "../../shared/workflow-vocabulary.js";
import { afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openMemoryDatabase } from "../db.js";
import type { DatabaseSync } from "../db.js";
import type { TriggerStore } from "../triggers/store.js";
import type { Trigger, TriggerCreate } from "../triggers/types.js";
import { createGlobalBus } from "../global-bus.js";
import { resolveRuntimePaths } from "../runtime-paths.js";
import type { RuntimePathOverrides, RuntimePaths } from "../runtime-paths.js";
import type { TranscriptionService } from "../transcription-service.js";
import type { AgentSession, AgentSessionRelease } from "../agent-backend/index.js";

const TEST_RUNTIME_ENV_KEYS = [
  "BRIDGE_DATA_DIR",
  "BRIDGE_DOCS_DIR",
  "BRIDGE_DOCS_SNAPSHOTS_DIR",
  "BRIDGE_WORKSPACE_DIR",
  "COPILOT_HOME",
] as const;
const TEST_CLEANUP_MAX_RETRIES = 20;
const TEST_CLEANUP_RETRY_DELAY_MS = 50;
const testCleanupPaths = new Set<string>();
const testAppCleanups = new Set<() => Promise<void>>();

afterEach(async () => {
  const cleanupErrors: unknown[] = [];

  for (const cleanup of [...testAppCleanups].reverse()) {
    try {
      await cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  testAppCleanups.clear();

  vi.unstubAllEnvs();
  const cleanupPaths = [...testCleanupPaths].sort((a, b) => b.length - a.length);
  testCleanupPaths.clear();
  for (const dir of cleanupPaths) {
    try {
      rmSync(dir, {
        recursive: true,
        force: true,
        maxRetries: TEST_CLEANUP_MAX_RETRIES,
        retryDelay: TEST_CLEANUP_RETRY_DELAY_MS,
      });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  throwCleanupErrors(cleanupErrors, "Test cleanup failed");
});

function sanitizeTestPrefix(prefix: string): string {
  return prefix.replace(/[^a-z0-9-]+/gi, "-").replace(/^-+|-+$/g, "") || "test";
}

export function createHermeticEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  for (const key of TEST_RUNTIME_ENV_KEYS) {
    delete env[key];
  }
  return env;
}

export function makeTestDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `bridge-${sanitizeTestPrefix(prefix)}-`));
  testCleanupPaths.add(dir);
  return dir;
}

export function registerTestAppCleanup(cleanup: () => Promise<void>): () => Promise<void> {
  let completion: Promise<void> | undefined;
  const trackedCleanup = () => {
    // A timed-out test's finally can overlap afterEach; both join one cleanup before files go.
    completion ??= Promise.resolve().then(cleanup).finally(() => {
      testAppCleanups.delete(trackedCleanup);
    });
    return completion;
  };
  testAppCleanups.add(trackedCleanup);
  return trackedCleanup;
}

export function throwCleanupErrors(cleanupErrors: unknown[], message: string): void {
  if (cleanupErrors.length === 1) {
    throw cleanupErrors[0];
  }
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, message);
  }
}

export function makeTestRuntimePaths(
  prefix: string,
  overrides: RuntimePathOverrides = {},
  baseEnv: NodeJS.ProcessEnv = process.env,
): RuntimePaths {
  const rootDir = makeTestDir(prefix);
  const dataDir = overrides.dataDir ?? join(rootDir, "data");
  const docsDir = overrides.docsDir ?? join(rootDir, "docs");
  const docsSnapshotsDir = overrides.docsSnapshotsDir ?? join(rootDir, "docs-snapshots");
  const copilotHome = overrides.copilotHome ?? join(rootDir, ".copilot");
  // Never resolve the real per-user Bridge workspace from a test.
  const workspaceDir = overrides.workspaceDir ?? join(rootDir, "workspace");

  mkdirSync(dataDir, { recursive: true });
  mkdirSync(docsDir, { recursive: true });
  mkdirSync(docsSnapshotsDir, { recursive: true });
  mkdirSync(copilotHome, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });

  return resolveRuntimePaths(createHermeticEnv(baseEnv), {
    ...overrides,
    dataDir,
    docsDir,
    docsSnapshotsDir,
    copilotHome,
    workspaceDir,
  });
}

export async function withTestEnv<T>(
  overrides: Record<string, string | undefined>,
  run: () => T | Promise<T>,
): Promise<T> {
  const keys = new Set<string>([...TEST_RUNTIME_ENV_KEYS, ...Object.keys(overrides)]);
  const previous = new Map<string, string | undefined>();
  for (const key of keys) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await run();
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

/** An in-memory SQLite database with the schema; no cleanup needed. */
export function setupTestDb(): DatabaseSync {
  return openMemoryDatabase();
}

/** Fixture: stops a trigger directly, which the store only does via runner, cancel or limits. */
export function endTrigger(
  db: DatabaseSync,
  triggerId: string,
  status: "completed" | "expired" | "failed",
  lastError: string | null = null,
): void {
  db.prepare(`
    UPDATE triggers
    SET status = ?, lastError = ?, claimToken = NULL, leaseExpiresAt = NULL, updatedAt = ?
    WHERE id = ?
  `).run(status, lastError, new Date().toISOString(), triggerId);
}

/** A recurring worker trigger owned by a chat, as a fixture. */
export function createChatTrigger(
  store: TriggerStore,
  sessionId: string,
  fields: Partial<TriggerCreate> = {},
): Trigger {
  return store.create({
    sessionId,
    prompt: "check it",
    when: { kind: "every", seconds: 600 },
    action: { kind: "chat", via: "worker" },
    nextRunAt: "2099-01-01T00:00:00.000Z",
    ...fields,
  });
}
/** Create a test global bus (no-op emitter) */
export function createTestBus() {
  return createGlobalBus();
}

/** `readSessionsFromDisk` for a double: by-id lookups find the sessions `list` returns. */
export function sessionsOnDisk(list: (options: { includeArchived: boolean }) => any[] | Promise<any[]>) {
  return async (sessionIds: readonly string[], options: { includeArchived?: boolean } = {}): Promise<any[]> => {
    const sessions = await list({ includeArchived: options.includeArchived ?? true });
    return sessionIds.flatMap((sessionId) => sessions.filter((session) => session.sessionId === sessionId));
  };
}

/** Minimal mock SessionManager for API route tests */
export function createMockSessionManager() {
  const manager = {
    listSessions: async () => [],
    listModels: async () => [],
    validateModelSelection: async () => ({ ok: true as const }),
    getBackendCreatedAt: () => "2026-01-01T00:00:00.000Z",
    getBackendUnavailableReason: (): string | undefined => undefined,
    getBackendStatus: () => ({
      state: "ready" as const,
      connection: "connected" as const,
      pid: 12345,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastDisconnect: null,
      disconnectCount: 0,
      recoveryCount: 0,
      lastRecoveryAt: null,
      lastRecoveryError: null,
      recoveryBlockedAt: null,
      lastInterruptedSessionCount: 0,
      lastAutoResumedSessionCount: 0,
    }),
    refreshModels: async () => ({ models: [], refreshed: true, activeSessions: 0, refreshedAt: "2026-01-01T00:00:00.000Z", clientCreatedAt: "2026-01-01T00:00:00.000Z" }),
    listSessionsFromDisk: () => [],
    listPendingSessionCreationIds: () => [] as string[],
    // The sessions a test lists are also the ones that exist when asked for by id.
    readSessionsFromDisk(this: any, sessionIds: readonly string[], options?: { includeArchived?: boolean }) {
      return sessionsOnDisk((listOptions) => this.listSessionsFromDisk(listOptions))(sessionIds, options);
    },
    getExternalSessionUse: async () => ({
      status: "available" as const,
      inUse: [],
      checkedAt: "2026-01-01T00:00:00.000Z",
    }),
    getSessionActivity: () => [],
    isSessionBusy: () => false,
    isSessionSettling: () => false,
    waitForSessionCreation: async () => {},
    waitWhileSessionSettles: async () => true,
    hasRunInFlight: () => false,
    getSessionCapacityWait: (): string | undefined => undefined,
    getSessionHold: () => undefined,
    subscribeSessionHold: () => () => {},
    getSessionRunState: () => "idle",
    getBackgroundAgentsSummary: () => ({ running: 0, idle: 0, failed: 0, total: 0, source: "unknown" as const }),
    getSessionAgentMode: () => undefined,
    getRuntimeActivity: () => ({
      sessions: { active: 0, stalled: 0, waitingForUserInput: 0 },
      agents: {
        running: 0,
        idle: 0,
        failed: 0,
        total: 0,
        liveSessions: 0,
        staleSessions: 0,
        unknownSessions: 0,
      },
      capacity: {
        contexts: { used: 0, retained: 0, limit: 32 },
        weightedUnits: { used: 0, retained: 0, limit: 64 },
        localMcpSlots: { used: 0, retained: 0 },
        cache: { readyParents: 0, protectedParents: 0, limit: 16 },
        cleanup: { pending: 0, failed: 0, limit: 32 },
        waitingRequests: 0,
        localMcpWeight: 0.25,
        waitTimeoutSeconds: 30,
      },
    }),
    listSessionAgents: async () => ({ tasks: [], source: "unknown" as const }),
    cancelSessionAgent: async () => ({ cancelled: false }),
    dismissSessionAgent: async () => ({ dismissed: false as const, reason: "unavailable" as const }),
    listSlashCommands: async () => ({ supported: false, commands: [] }),
    getPendingUserInputCount: () => 0,
    getPendingInputSessionIds: () => [],
    hydratePendingInteractions: async () => ({
      pendingUserInputs: [],
      pendingElicitations: [],
      pendingShellAuths: [],
    }),
    getActiveSessions: () => [],
    getLifecycleBlockingSessionCount: () => 0,
    getLifecycleBlockingSessionIds: () => [],
    getEffectiveSessionCwd: () => undefined,
    getActiveRuns: () => [],
    isRuntimeIdle: async () => true,
    stopAdmittingWork: () => {},
    isSessionWarm: () => false,
    createSession: async (options?: { expectedSessionId?: string; onCreateStarting?: () => void }) => {
      options?.onCreateStarting?.();
      return { sessionId: options?.expectedSessionId ?? "test-session" };
    },
    getSessionCreationState: async () => "absent" as const,
    forkSession: async () => ({ sessionId: "fork-session" }),
    setSessionName: async () => {},
    startWork: () => {},
    startWorkAndWaitForDelivery: async () => {},
    steerSession: async () => {},
    markSessionAttention: () => {},
    abortSession: async () => true,
    readMessagesFromDisk: () => ({ messages: [], total: 0, hasMore: false, coverage: {} }),
    undoSessionTurn: async () => ({ eventsRemoved: 1 }),
    warmSession: vi.fn(async () => {}),
    reloadSession: async () => [],
    submitUserInputResponse: async (_sessionId: string, requestId: string, payload: any) => ({
      requestId,
      answer: payload?.answer,
      wasFreeform: payload?.wasFreeform,
      timestamp: "2026-04-29T12:00:00.000Z",
    }),
    submitElicitationResponse: async (_sessionId: string, requestId: string, payload: any) => ({
      requestId,
      action: payload?.action,
      timestamp: "2026-07-13T12:00:00.000Z",
    }),
    submitShellAuthResponse: (_sessionId: string, requestId: string, payload: any) => ({
      requestId,
      action: payload?.action,
      timestamp: "2026-11-16T12:00:00.000Z",
    }),
    deleteSession: async () => {},
    gracefulShutdown: async () => {},
    evictAllCachedSessions: async () => {},
    invalidateTaskSessionConfig: () => 0,
    invalidateSessionConfig: () => false,
    evictIdleCachedSessions: async () => ({ evictedSessions: 0, protectedSessions: 0 }),
    unloadIdleSession: async () => false,
    setSessionModel: async (_id: string, model: string, reasoningEffort?: string, contextTier?: string) => ({
      model,
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(contextTier ? { contextTier } : {}),
    }),
    getSessionModelState: async () => ({ source: "unknown" as const }),
    getSessionPlaybook: (): SessionPlaybookView | undefined => ({}),
    setSessionPlaybook: async (_id: string, playbook: string | null, source: "user" | "agent"): Promise<SessionPlaybookView> =>
      (playbook ? { playbook, source } : {}),
    getMcpStatus: async () => [],
    getCachedMcpStatus: () => [],
    getSessionToolReadiness: () => undefined,
    loginMcpServer: async (_sessionId: string, serverName: string) => ({
      serverName,
      authorizationUrl: "https://login.example.test",
      servers: [{ name: serverName, status: "pending" }],
    }),
    getLatestMcpStatus: () => [],
    hasPlan: () => true,
    createTaskSession: async (...args: unknown[]) => {
      const options = args[8] as { expectedSessionId?: string; onCreateStarting?: () => void } | undefined;
      options?.onCreateStarting?.();
      return { sessionId: options?.expectedSessionId ?? "task-session" };
    },
    setSessionWorkspace: (sessionId: string, cwd: string) => ({
      cwd,
      source: "explicit",
      message: `Session workspace set to ${cwd} for future turns`,
      sessionId,
    }),
    resetSessionWorkspace: (_sessionId: string) => ({
      cwd: "",
      source: "task-default",
      message: "Session workspace reset to linked task default",
    }),
  } as any;
  manager.forkSessionWithFinalizer = async (
    sourceSessionId: string,
    options: { toEventId?: string },
    finalize: (result: { sessionId: string }) => Promise<void>,
  ) => {
    const result = await manager.forkSession(sourceSessionId, options);
    await finalize(result);
    return result;
  };
  return manager;
}
export function createMockTranscriptionService(overrides?: Partial<TranscriptionService>): TranscriptionService {
  return {
    getStatus: () => ({
      available: false,
      provider: "disabled",
      label: "Unavailable",
      reason: "Set up the speech engine in Settings → Voice, or from Helm's hands-free mode.",
      maxDurationSeconds: 120,
    }),
    transcribe: async () => {
      throw new Error("Set up the speech engine in Settings → Voice, or from Helm's hands-free mode.");
    },
    ...overrides,
  };
}

/** Shared cross-platform test helpers */
export {
  isWindows,
  normalizePath,
  pathBasename,
  pathSegments,
  testCopilotHome,
  testExecutablePath,
  testPath,
} from "./test-paths.js";


/** Fills a partial double out to a full AgentSession; `as` casts would hide a missing method. */
export function makeAgentSessionStub<T extends object>(overrides: T): T & AgentSession {
  let releasePromise: Promise<AgentSessionRelease> | undefined;
  const defaults: AgentSession = {
    sessionId: "session-1",
    send: async () => undefined,
    sendAndWait: async () => undefined,
    abort: async () => undefined,
    setModel: async () => undefined,
    setReasoningEffort: async () => undefined,
    disconnect: () => undefined,
    release: () => {
      releasePromise ??= Promise.resolve().then(async () => {
        if (typeof defaults.disconnect !== "function") {
          return { status: "unsupported", detail: "Simulated SDK disconnect is unavailable" };
        }
        await defaults.disconnect();
        return { status: "released" };
      });
      return releasePromise;
    },
    on: () => () => {},
    respondToUserInput: async () => true,
    tryRespondToElicitation: async () => true,
    setSendMode: async () => undefined,
    invokeSlashCommand: async () => ({ kind: "text", text: "" }),
    listSlashCommands: async () => undefined,
    getCurrentModel: async () => undefined,
    getUsageMetrics: async () => undefined,
    getActivity: async () => undefined,
    getContextInfo: async () => undefined,
    truncateHistory: async () => undefined,
    listMcpServers: async () => undefined,
    initializeTools: async () => undefined,
    getCurrentToolMetadata: async () => undefined,
    startMcpOauthLogin: async () => undefined,
    getName: async () => undefined,
    setName: async () => undefined,
    listTasks: async () => ({ tasks: [] }),
    cancelTask: async () => ({ cancelled: false }),
    removeTask: async () => ({ removed: false }),
  };
  return Object.assign(defaults, overrides) as T & AgentSession;
}

/** Advances fake timers, then awaits `settle` for real I/O the timer started. */
export async function advanceTimersAndSettle(
  ms: number,
  settle: () => Promise<void>,
): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
}

/** Fakes setTimeout and Date so lifecycle deadlines can't expire mid-test; restore timers after. */
export function freezeLifecycleDeadlines(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
}
