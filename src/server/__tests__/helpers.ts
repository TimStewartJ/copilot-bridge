// Shared test helpers — lightweight test fixtures (temp dirs, runtime paths,
// in-memory SQLite, mock services).
//
// Deliberately kept free of the Express/API-router graph. `createTestApp` lives
// in ./test-app.ts because importing `createApiRouter` pulls ~180 modules
// (~2 MB) into every file that touches this module, and most test files only
// need `makeTestDir` or `setupTestDb`.

import { afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openMemoryDatabase } from "../db.js";
import type { DatabaseSync } from "../db.js";
import { createGlobalBus } from "../global-bus.js";
import { resolveRuntimePaths } from "../runtime-paths.js";
import type { RuntimePathOverrides, RuntimePaths } from "../runtime-paths.js";
import type { TranscriptionService } from "../transcription-service.js";
import type { AgentSession } from "../agent-backend/index.js";

const TEST_RUNTIME_ENV_KEYS = ["BRIDGE_DATA_DIR", "BRIDGE_DOCS_DIR", "BRIDGE_DOCS_SNAPSHOTS_DIR", "COPILOT_HOME"] as const;
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
  let cleanedUp = false;
  const trackedCleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    testAppCleanups.delete(trackedCleanup);
    await cleanup();
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
  const workspaceDir = overrides.workspaceDir;

  mkdirSync(dataDir, { recursive: true });
  mkdirSync(docsDir, { recursive: true });
  mkdirSync(docsSnapshotsDir, { recursive: true });
  mkdirSync(copilotHome, { recursive: true });
  if (workspaceDir) {
    mkdirSync(workspaceDir, { recursive: true });
  }

  return resolveRuntimePaths(createHermeticEnv(baseEnv), {
    ...overrides,
    dataDir,
    docsDir,
    docsSnapshotsDir,
    copilotHome,
    ...(workspaceDir ? { workspaceDir } : {}),
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

/**
 * Create an in-memory SQLite database with schema initialized.
 * Returns the database instance. No cleanup needed — GC handles it.
 */
export function setupTestDb(): DatabaseSync {
  return openMemoryDatabase();
}

/** Create a test global bus (no-op emitter) */
export function createTestBus() {
  return createGlobalBus();
}

/** Minimal mock SessionManager for API route tests */
export function createMockSessionManager() {
  const manager = {
    listSessions: async () => [],
    listModels: async () => [],
    getBackendCreatedAt: () => "2026-01-01T00:00:00.000Z",
    refreshModels: async () => ({ models: [], refreshed: true, activeSessions: 0, refreshedAt: "2026-01-01T00:00:00.000Z", clientCreatedAt: "2026-01-01T00:00:00.000Z" }),
    listSessionsFromDisk: () => [],
    getSessionActivity: () => [],
    isSessionBusy: () => false,
    getSessionRunState: () => "idle",
    getBackgroundAgentsSummary: () => ({ running: 0, idle: 0, failed: 0, total: 0, source: "unknown" as const }),
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
    listSlashCommands: async () => ({ supported: false, commands: [] }),
    getPendingUserInputCount: () => 0,
    hydratePendingInteractions: async () => ({
      pendingUserInputs: [],
      pendingElicitations: [],
    }),
    getActiveSessions: () => [],
    getLifecycleBlockingSessionCount: () => 0,
    isSessionWarm: () => false,
    createSession: async () => ({ sessionId: "test-session" }),
    forkSession: async () => ({ sessionId: "fork-session" }),
    setSessionName: async () => {},
    startWork: () => {},
    startWorkAndWaitForDelivery: async () => {},
    steerSession: async () => {},
    markSessionAttention: () => {},
    abortSession: async () => true,
    readMessagesFromDisk: () => ({ messages: [], total: 0, hasMore: false, coverage: {} }),
    undoSessionTurn: async () => ({ eventsRemoved: 1 }),
    warmSession: async () => {},
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
    deleteSession: async () => {},
    gracefulShutdown: async () => {},
    evictAllCachedSessions: async () => {},
    invalidateTaskSessionConfig: () => 0,
    evictIdleCachedSessions: async () => ({ evictedSessions: 0, protectedSessions: 0 }),
    setSessionModel: async (_id: string, model: string, reasoningEffort?: string, contextTier?: string) => ({
      model,
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(contextTier ? { contextTier } : {}),
    }),
    getSessionModelState: async () => ({ source: "unknown" as const }),
    getMcpStatus: async () => [],
    loginMcpServer: async (_sessionId: string, serverName: string) => ({
      serverName,
      authorizationUrl: "https://login.example.test",
      servers: [{ name: serverName, status: "pending" }],
    }),
    getLatestMcpStatus: () => [],
    hasPlan: () => true,
    createTaskSession: async () => ({ sessionId: "task-session" }),
    invalidateSessionListCache: () => {},
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
      reason: "Voice input is not configured on the server.",
      maxDurationSeconds: 120,
    }),
    transcribe: async () => {
      throw new Error("Voice input is not configured on the server.");
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


/**
 * Fills a partial session double out to the full `AgentSession` facade.
 *
 * `AgentSession` requires every method: the Copilot wrapper defines them all
 * unconditionally and reports capability absence through the *result* (either
 * `undefined` or a thrown error), never through method presence. Callers
 * therefore no longer guard with `typeof session.x === "function"`, so a mock
 * that omits a method fails at runtime — and the `as unknown as AgentSession`
 * casts these doubles rely on mean the compiler will not catch it.
 *
 * Build session doubles through this helper and override only what the test
 * asserts on. The returned object keeps the caller's concrete mock types.
 */
export function makeAgentSessionStub<T extends object>(overrides: T): T & AgentSession {
  const defaults: AgentSession = {
    sessionId: "session-1",
    send: async () => undefined,
    sendAndWait: async () => undefined,
    abort: async () => undefined,
    setModel: async () => undefined,
    disconnect: () => undefined,
    on: () => () => {},
    getEvents: async () => [],
    respondToUserInput: async () => true,
    tryRespondToElicitation: async () => true,
    setSendMode: async () => undefined,
    invokeSlashCommand: async () => ({ kind: "text", text: "" }),
    listSlashCommands: async () => undefined,
    getCurrentModel: async () => undefined,
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
