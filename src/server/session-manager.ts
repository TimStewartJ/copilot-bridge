// Coding-agent session manager (currently backed by Copilot via `CopilotBackend`).
//
// As of Step 1 of the agent-agnostic roadmap, this file no longer imports
// the SDK directly. All client/session lifecycle goes through the
// `AgentBackend` / `AgentSession` interfaces in `./agent-backend`. Bridge
// tools are exposed through a backend-native tool surface when available,
// with the in-process Bridge MCP server retained as a fallback/export.

import { randomUUID } from "node:crypto";
import {
  CopilotBackend,
  createAgentBackend,
  type AgentBackend,
  type AgentBackendFactory,
  type AgentBackgroundTask,
  type AgentModelInfo,
  type AgentSession,
  type AgentSlashCommandInfo,
} from "./agent-backend/index.js";
import { existsSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { config } from "./config.js";
import { createTaskStore } from "./task-store.js";
import type { WorkItemRef } from "./task-store.js";
import type { Task } from "./task-store.js";
import type { TaskGroupStore } from "./task-group-store.js";
import { createTaskGroupStore } from "./task-group-store.js";
import { createScheduleStore } from "./schedule-store.js";
import { getOrCreateBus } from "./event-bus.js";
import {
  buildSessionConfig as buildSessionConfigWithDeps,
  type ScheduleContext,
  type SessionConfigOptions,
} from "./session-config-builder.js";
import { BRIDGE_EXCLUDED_TOOLS } from "./session-instructions.js";
export type { ScheduleContext, SessionConfigOptions } from "./session-config-builder.js";
import type { AppContext } from "./app-context.js";
import type { GlobalBus } from "./global-bus.js";
import type { EventBusRegistry } from "./event-bus.js";
import type { SessionTitlesStore } from "./session-titles.js";
import type { TaskStore } from "./task-store.js";
import type { ChecklistStore } from "./checklist-store.js";
import type { SessionWorkspaceStore } from "./session-workspace-store.js";
import type { SessionMetaStore } from "./session-meta-store.js";
import type { CopilotCliSessionCatalog } from "./copilot-cli-session-catalog.js";
import {
  capDeadline,
  createDeadline,
  deadlineBefore,
  remainingMs,
  settleByDeadline,
  type Deadline,
} from "./deadline.js";

import type { SettingsStore } from "./settings-store.js";
import type { TagStore } from "./tag-store.js";
import type { TelemetryStore } from "./telemetry-store.js";
import type { SessionContextStore } from "./session-context-store.js";
import type { DocsIndex } from "./docs-index.js";
import type { DocsStore } from "./docs-store.js";
import type { BrowserSessionStore } from "./browser-session-store.js";
import { isLocalMcpServerConfig, type McpServerConfig } from "./mcp-config.js";
import type { McpServerStore } from "./mcp-server-store.js";
import { sampleProcessTree, type ProcessTreeSnapshot } from "./platform.js";
import type { BridgeToolDefinition, BridgeToolsMcpServer } from "./agent-tools-mcp/server.js";
import { createNativeBridgeTools, type BridgeNativeTool } from "./bridge-native-tools.js";
import { getOrCreateBrowserSessionStore } from "./browser-session-store.js";
import { getBrowserLaunchConfig } from "./agent-browser.js";
import { createBridgeBrowserLifecycle, noopBrowserLifecycle, type BrowserLifecycle } from "./browser-lifecycle.js";
import type { RuntimePaths } from "./runtime-paths.js";
import { UserInputBrokerError, type UserInputBroker } from "./user-input-broker.js";
import type { NativeUserInputRequest, NativeUserInputResponse, UserInputCancelReason, UserInputRequestId } from "./user-input-types.js";
import { ElicitationBrokerError, type ElicitationBroker } from "./elicitation-broker.js";
import type {
  ElicitationRequestId,
  NativeElicitationRequest,
  NativeElicitationResult,
  SubmittedElicitationResponse,
} from "./elicitation-types.js";
import { SessionWorkspaceController } from "./session-workspace-controller.js";
import { SessionUserInputController } from "./session-user-input-controller.js";
import { SessionElicitationController } from "./session-elicitation-controller.js";
import {
  deduplicateFilename as deduplicateAttachmentFilename,
  persistAndRouteAttachments as persistAndRouteSessionAttachments,
  type RoutedSdkAttachment,
  type StartWorkAttachment,
} from "./session-attachment-routing.js";
import {
  clearEventLogStatsCache,
  listSessionsFromDisk as listSessionsFromDiskWithDeps,
  readMessagesFromDisk as readMessagesFromDiskWithDeps,
} from "./session-disk-reader.js";
import {
  PROMPT_DELIVERY_ABORTED_MESSAGE,
  PROMPT_DELIVERY_SHUTDOWN_MESSAGE,
  RESTART_PENDING_MESSAGE,
  configureRestartEventBus,
  configureRestartActiveSessionCountProvider,
  configureRestartStateStore,
  isRestartCutoverInProgress,
  isRestartPending,
  refreshRestartState,
  refreshRestartStateSync,
  syncRestartWaitingSessions,
  triggerRestartPending,
  triggerRestartPendingForExternalRequest,
} from "./restart-controller.js";
import {
  ABORT_CONFIRMATION_TIMEOUT_MS,
  SessionRunStateController,
  type SessionRunController,
  type SessionRunRecord,
  type SessionRunState,
  type SessionActivity,
} from "./session-run-state-controller.js";
import {
  isStaleAgentSessionError,
  SessionRunner,
  type McpServerStatus,
  type SessionResumeLease,
  type StartWorkOptions,
} from "./session-runner.js";
import { SessionAgentRegistry } from "./session-agent-registry.js";
import type {
  AgentCountsSource,
  BackgroundAgentsAggregate,
  BackgroundAgentsSummary,
  SessionAgentTask,
} from "../shared/session-agents.js";
export type { McpServerStatus, StartWorkOptions } from "./session-runner.js";
import {
  deriveModelStateFromEventsFile,
  type DerivedModelState,
} from "./session-events-model.js";
import {
  getLastVisibleActivityAt,
  getUndoBoundaryEventId,
} from "./event-transform.js";
import { readSdkSessionEvents } from "./sdk-session-events.js";
import { createSessionContextTruncationMarker } from "./session-context-normalizer.js";
import {
  getModelCapabilitiesOverrideForContextTier,
  normalizeCopilotContextTier,
  resolveContextTierForModel,
  type CopilotContextTier,
  type CopilotModelContextMetadata,
} from "../shared/copilot-context.js";
import {
  readPersistedSessionModelState,
  writePersistedSessionModelState,
  type PersistedSessionModelState,
} from "./session-model-state-sidecar.js";
import {
  buildSessionNameResumeConfig,
  createSessionNameRpc,
  type SetSessionNameOptions,
  type SessionNameRpc,
} from "./session-name-rpc.js";
import {
  createSessionNameAutogenerator,
  type SessionNameAutogenerator,
} from "./session-name-autogen.js";
import { deleteCliSessionStoreRows, sweepLeakedCliSessionStoreRows } from "./cli-session-store.js";
import { DISPOSABLE_TITLE_SESSION_ID_PREFIX } from "./session-name-generator.js";
import { migrateLegacySessionTitles as migrateLegacySessionTitlesWithDeps } from "./migrate-legacy-session-titles.js";
import { buildCopilotClientOptions } from "./copilot-client-options.js";
import { writeRestartSignalFile } from "./restart-signal.js";
export type { DerivedModelState } from "./session-events-model.js";
export {
  PROMPT_DELIVERY_ABORTED_MESSAGE,
  PROMPT_DELIVERY_SHUTDOWN_MESSAGE,
  RESTART_PENDING_MESSAGE,
  clearRestartPending,
  configureRestartEventBus,
  configureRestartStateStore,
  getRestartWaitingCount,
  isPromptDeliveryInterruptedError,
  isRestartCutoverInProgress,
  isRestartImminent,
  isRestartPending,
  isRestartPendingError,
  refreshRestartState,
  refreshRestartStateSync,
  syncRestartWaitingSessions,
  triggerRestartPending,
  triggerRestartPendingForExternalRequest,
} from "./restart-controller.js";
export type {
  PromptDeliveryResult,
  SessionActivity,
  SessionRunController,
  SessionRunRecord,
  SessionRunState,
} from "./session-run-state-controller.js";

export {
  BRIDGE_COPILOT_GITHUB_TOKEN_ENV,
  buildCopilotClientOptions,
  resolveBridgeCopilotCliPath,
} from "./copilot-client-options.js";

type CopilotModelList = AgentModelInfo[];
export const MODEL_REFRESH_CLIENT_ROTATION_TIMEOUT_MS = 30_000;

// Graceful shutdown must finish before the launcher's force-kill window
// (GRACEFUL_EXIT_WAIT = 15s) so the server exits on its own. The overall budget
// is shared across every phase (session drain, browser teardown, backend stop)
// so a hung backend can never push the server past the launcher deadline.
const GRACEFUL_SHUTDOWN_BUDGET_MS = 13_000;
const SESSION_ABORT_TIMEOUT_MS = 4_000;
const SESSION_DRAIN_TIMEOUT_MS = 3_000;
const BROWSER_SHUTDOWN_TIMEOUT_MS = 1_500;
const BACKEND_STOP_TIMEOUT_MS = 4_000;
const BACKEND_FORCE_STOP_RESERVE_MS = 1_000;
const DISCONNECT_TIMEOUT_MS = 5_000;
const DISCONNECT_MAX_ATTEMPTS = 2;
const SESSION_TASK_CLEANUP_TIMEOUT_MS = 10_000;
const SESSION_TASK_CLEANUP_POLL_MS = 100;
const DEFAULT_SESSION_CACHE_IDLE_TTL_MS = 60 * 60_000;
const SESSION_CACHE_SWEEP_INTERVAL_MS = 60_000;
const PROCESS_TREE_SAMPLE_THROTTLE_MS = 60_000;
const PROCESS_TREE_SAMPLE_DEADLINE_MS = 5_000;
const PROCESS_TREE_WARNING_THRESHOLD = 128;
const PROCESS_TREE_GROWTH_WARNING_THRESHOLD = 64;
const DEFAULT_MAX_CACHED_CONTEXTS = 32;
const DEFAULT_SESSION_CAPACITY_UNITS = 64;
const DEFAULT_LOCAL_MCP_CAPACITY_WEIGHT = 0.25;
const DEFAULT_SESSION_CAPACITY_WAIT_SECONDS = 30;
const SESSION_CAPACITY_WAIT_POLL_MS = 500;
const DEFAULT_SESSION_CREATE_TIMEOUT_SECONDS = 30;
const DEFAULT_SESSION_RESUME_TIMEOUT_SECONDS = 60;
const DEFAULT_BACKEND_RECOVERY_STOP_TIMEOUT_SECONDS = 10;
const DEFAULT_BACKEND_RECOVERY_START_TIMEOUT_SECONDS = 30;
const DEFAULT_MAX_PROCESS_TREE_DESCENDANTS = 96;
const DEFAULT_PROCESS_TREE_SAMPLE_MAX_AGE_SECONDS = 5;
const DEFAULT_PROCESS_TREE_ADMISSION_SAMPLE_TIMEOUT_MS = 1_000;

type SessionCapacityProfile = {
  localMcpCount: number;
};

type SessionCapacityReservation = {
  capacityUnits: number;
  localMcpInstances: number;
  processSlots: number;
};

type SessionCreationLease = {
  token: symbol;
  reservation: SessionCapacityReservation;
  generation: BackendGeneration;
};

type BackendGenerationState = "ready" | "fenced";

type BackendGeneration = {
  id: number;
  backend: AgentBackend;
  state: BackendGenerationState;
  fenceError?: SessionBackendUnavailableError;
  fenceSignal: Promise<SessionBackendUnavailableError>;
  signalFence: (error: SessionBackendUnavailableError) => void;
  recoveryStarted: boolean;
};

type BackendSessionOwner = {
  generation: BackendGeneration;
  deleteOnDiscard: boolean;
};

export type SessionCapacityReason =
  | "cleanup-failed"
  | "cleanup-demand"
  | "context-limit"
  | "weighted-capacity"
  | "retained-capacity"
  | "process-pressure";

export interface SessionCapacitySnapshot {
  contexts: number;
  contextLimit: number;
  localMcpInstances: number;
  capacityUnits: number;
  capacityLimit: number;
  processDescendants?: number | null;
  processReservations?: number;
  processLimit?: number;
}

export interface SessionCapacityRuntimeStatus {
  contexts: {
    used: number;
    retained: number;
    limit: number;
  };
  weightedUnits: {
    used: number;
    retained: number;
    limit: number;
  };
  localMcpSlots: {
    used: number;
    retained: number;
  };
  cache: {
    readyParents: number;
    protectedParents: number;
    limit: number;
  };
  cleanup: {
    pending: number;
    failed: number;
    limit: number;
  };
  processes: {
    actualDescendants: number | null;
    projectedReservations: number;
    used: number;
    limit: number;
    sampleStatus: "never" | "sampled" | "unavailable" | "failed" | "timed-out";
    sampledAt: string | null;
  };
  waitingRequests: number;
  localMcpWeight: number;
  waitTimeoutSeconds: number;
}

function formatCapacityUnits(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

export class SessionCapacityError extends Error {
  readonly code = "session_capacity";
  readonly retryAfterSeconds = 2;

  constructor(
    readonly reason: SessionCapacityReason,
    readonly snapshot: SessionCapacitySnapshot,
  ) {
    const message = reason === "cleanup-failed"
      ? "Bridge could not release one or more previous Copilot sessions. Wait for automatic cleanup, or restart Bridge if this persists."
      : reason === "cleanup-demand" || reason === "retained-capacity"
        ? "Copilot session cleanup is still catching up. Wait a few seconds for another chat to finish closing, then try again."
        : reason === "process-pressure"
          ? `Copilot process capacity is full at ${snapshot.processDescendants ?? 0} observed descendants plus ${snapshot.processReservations ?? 0} reserved process slots against a limit of ${snapshot.processLimit ?? 0}. Wait for existing sessions to finish, then try again.`
        : reason === "context-limit"
          ? `All ${snapshot.contextLimit} live Copilot contexts are currently in use. Wait for one to finish, or stop a running chat or agent, then try again.`
          : `Live Copilot capacity is full at ${formatCapacityUnits(snapshot.capacityUnits)}/${formatCapacityUnits(snapshot.capacityLimit)} units across ${snapshot.contexts} context${snapshot.contexts === 1 ? "" : "s"} and ${snapshot.localMcpInstances} estimated local MCP slot${snapshot.localMcpInstances === 1 ? "" : "s"}. Wait for work to finish, or stop a running chat or agent, then try again.`;
    super(message);
    this.name = "SessionCapacityError";
  }
}

export type SessionBackendUnavailableReason =
  | "create-timeout"
  | "resume-timeout"
  | "generation-fenced"
  | "recovery-failed";

export class SessionBackendUnavailableError extends Error {
  readonly code = "session_backend_unavailable";
  readonly retryAfterSeconds = 5;

  constructor(
    readonly reason: SessionBackendUnavailableReason,
    readonly generation: number,
    message?: string,
  ) {
    super(message ?? (
      reason === "create-timeout"
        ? "Copilot session creation timed out. The backend is recovering; retry this request shortly."
        : reason === "resume-timeout"
          ? "Copilot session resume timed out. The backend is recovering; retry this request shortly."
          : "The Copilot session backend is recovering. Retry this request shortly."
    ));
    this.name = "SessionBackendUnavailableError";
  }
}

type SessionCleanupRecord = {
  sessionId: string;
  state: "pending" | "failed";
  attempts: number;
  contextWeight: number;
  localMcpInstances: number;
  capacityUnits: number;
  lastOutcome?: "rejected" | "timed-out";
  promise?: Promise<boolean>;
};

class SessionTaskCleanupTimeoutError extends Error {
  constructor() {
    super("Background task cleanup timed out");
    this.name = "SessionTaskCleanupTimeoutError";
  }
}

const MODEL_REFRESH_CLIENT_ROTATION_OPERATIONS = {
  stopPrevious: "stopping the previous client",
  startNext: "starting the refreshed client",
  restorePrevious: "restoring the previous client",
} as const;

type ModelRefreshClientRotationOperation =
  (typeof MODEL_REFRESH_CLIENT_ROTATION_OPERATIONS)[keyof typeof MODEL_REFRESH_CLIENT_ROTATION_OPERATIONS];

export class ModelRefreshClientRotationTimeoutError extends Error {
  constructor(
    readonly operation: ModelRefreshClientRotationOperation,
    readonly timeoutMs: number,
  ) {
    super(`Agent backend model-refresh rotation timed out after ${timeoutMs}ms while ${operation}.`);
    this.name = "ModelRefreshClientRotationTimeoutError";
  }
}

export class ModelRefreshBlockedError extends Error {
  constructor(readonly activeSessions: number) {
    super(`Cannot refresh model list while ${activeSessions} active session(s) are running. Try again after active turns finish.`);
    this.name = "ModelRefreshBlockedError";
  }
}

export interface ModelRefreshResult {
  models: CopilotModelList;
  refreshed: true;
  activeSessions: number;
  refreshedAt: string;
  clientCreatedAt: string | null;
}

function isMissingSessionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not found|does not exist|no such (file|session)|ENOENT/i.test(message);
}

const MCP_SERVER_STATUS_VALUES = new Set<McpServerStatus["status"]>([
  "connected", "failed", "needs-auth", "pending", "disabled", "not_configured", "unknown",
]);

function coerceMcpServerStatus(value: unknown): McpServerStatus["status"] {
  if (typeof value === "string" && MCP_SERVER_STATUS_VALUES.has(value as McpServerStatus["status"])) {
    return value as McpServerStatus["status"];
  }
  return "unknown";
}

function isModelRefreshClientRotationTimeoutError(error: unknown): error is ModelRefreshClientRotationTimeoutError {
  return error instanceof ModelRefreshClientRotationTimeoutError;
}

function getBackendStopErrors(value: unknown): unknown[] | undefined {
  return Array.isArray(value) && value.length > 0 ? value : undefined;
}

function withModelRefreshClientRotationTimeout<T>(
  operation: ModelRefreshClientRotationOperation,
  promise: Promise<T>,
  timeoutMs = MODEL_REFRESH_CLIENT_ROTATION_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new ModelRefreshClientRotationTimeoutError(operation, timeoutMs));
    }, timeoutMs);

    Promise.resolve(promise).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export interface SessionManagerDeps {
  globalBus: GlobalBus;
  eventBusRegistry: EventBusRegistry;
  userInputBroker?: UserInputBroker;
  elicitationBroker?: ElicitationBroker;
  sessionTitles: SessionTitlesStore;
  sessionWorkspaceStore?: SessionWorkspaceStore;
  sessionMetaStore?: SessionMetaStore;
  cliSessionCatalog?: Pick<CopilotCliSessionCatalog, "hasSession">;
  taskStore: TaskStore;
  taskGroupStore?: TaskGroupStore;
  checklistStore?: ChecklistStore;
  settingsStore?: SettingsStore;
  tagStore?: TagStore;
  mcpServerStore?: McpServerStore;
  docsIndex?: DocsIndex;
  docsStore?: DocsStore;
  browserSessionStore?: BrowserSessionStore;
  /**
   * Browser lifecycle owned by SessionManager. Defaults to `noopBrowserLifecycle`
   * when omitted so unit tests do not accidentally spawn the agent-browser CLI
   * or scan OS processes. Production callers MUST inject a real lifecycle via
   * `createSessionManager`, which wires `createBridgeBrowserLifecycle`.
   */
  browserLifecycle?: BrowserLifecycle;
  config: { sessionMcpServers: Record<string, McpServerConfig>; model?: string };
  builtInMcpServers?: Record<string, McpServerConfig>;
  bridgeToolsMcpServer?: BridgeToolsMcpServer;
  telemetryStore?: TelemetryStore;
  sessionContextStore?: SessionContextStore;
  /** Custom env for the agent backend — use to set COPILOT_HOME for session isolation */
  clientEnv?: Record<string, string | undefined>;
  /**
   * Test seam: build an arbitrary AgentBackend. When unset, SessionManager
   * constructs a real Copilot-backed AgentBackend via `createAgentBackend`.
   */
  createBackend?: AgentBackendFactory;
  /** Bounded server process-tree sampler used by admission control. */
  sampleProcessTree?: (rootPid: number, deadline: Deadline) => Promise<ProcessTreeSnapshot | null>;
  /** Root of .copilot directory — defaults to homedir()/.copilot */
  copilotHome?: string;
  runtimePaths?: RuntimePaths;
}

/** Options that don't come from AppContext — caller provides these directly. */
export interface CreateSessionManagerOpts {
  config: SessionManagerDeps["config"];
  builtInMcpServers?: SessionManagerDeps["builtInMcpServers"];
  clientEnv?: SessionManagerDeps["clientEnv"];
  createBackend?: AgentBackendFactory;
  copilotHome?: string;
  runtimePaths?: RuntimePaths;
}
export interface McpLoginResult {
  serverName: string;
  authorizationUrl?: string;
  servers: McpServerStatus[];
}

export type SessionHistoryUndoErrorCode = "busy" | "stale-boundary" | "unsupported";

export class SessionHistoryUndoError extends Error {
  constructor(
    readonly code: SessionHistoryUndoErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SessionHistoryUndoError";
  }
}


/**
 * Factory that maps AppContext → SessionManagerDeps.
 *
 * Staging preview dynamically imports this from the worktree, so new deps are
 * picked up automatically without touching staging-tools.ts.
 */
export function createSessionManager(ctx: AppContext, opts: CreateSessionManagerOpts): SessionManager {
  const runtimePaths = opts.runtimePaths ?? ctx.runtimePaths;
  const copilotHome = opts.copilotHome ?? ctx.copilotHome ?? runtimePaths?.copilotHome;
  const clientEnv = opts.clientEnv
    ?? runtimePaths?.env
    ?? (copilotHome ? { ...process.env, COPILOT_HOME: copilotHome } : undefined);
  return new SessionManager({
    globalBus: ctx.globalBus,
    eventBusRegistry: ctx.eventBusRegistry,
    sessionTitles: ctx.sessionTitles,
    sessionWorkspaceStore: ctx.sessionWorkspaceStore,
    sessionMetaStore: ctx.sessionMetaStore,
    cliSessionCatalog: ctx.cliSessionCatalog,
    taskStore: ctx.taskStore,
    taskGroupStore: ctx.taskGroupStore,
    checklistStore: ctx.checklistStore,
    settingsStore: ctx.settingsStore,
    tagStore: ctx.tagStore,
    mcpServerStore: ctx.mcpServerStore ?? ctx.settingsStore.getMcpServerStore(),
    docsIndex: ctx.docsIndex,
    docsStore: ctx.docsStore,
    browserSessionStore: getOrCreateBrowserSessionStore(ctx, {
      copilotHome,
      telemetryStore: ctx.telemetryStore,
      getBrowserLaunchConfig: () => getBrowserLaunchConfig(ctx.settingsStore.getSettings()),
    }),
    browserLifecycle: createBridgeBrowserLifecycle({
      copilotHome,
      settingsStore: ctx.settingsStore,
      telemetryStore: ctx.telemetryStore,
    }),
    telemetryStore: ctx.telemetryStore,
    sessionContextStore: ctx.sessionContextStore,
    config: opts.config,
    builtInMcpServers: opts.builtInMcpServers,
    bridgeToolsMcpServer: ctx.bridgeToolsMcpServer,
    clientEnv,
    createBackend: opts.createBackend,
    sampleProcessTree,
    copilotHome,
    runtimePaths,
  });
}

export class SessionManager {
  private static DISPOSABLE_TITLE_SWEEP_GRACE_MS = 60_000;
  private backend: AgentBackend | null = null;
  private backendCreatedAtMs: number | null = null;
  private backendRotation: Promise<AgentBackend> | null = null;
  private backendGeneration: BackendGeneration | null = null;
  private backendGenerationCounter = 0;
  private readonly backendGenerations = new Map<number, BackendGeneration>();
  private backendRecovery: Promise<void> | null = null;
  private shuttingDown = false;
  private deps: SessionManagerDeps;
  private readonly processStartedAtMs = Date.now();
  private activeRunControllers = new Map<string, SessionRunController>();
  private resumingSessions = new Map<string, number>();
  private readonly resumingCapacityReservations = new Map<symbol, SessionCapacityReservation>();
  private readonly creatingCapacityReservations = new Map<symbol, SessionCapacityReservation>();
  private modelSwitchingSessions = new Set<string>();
  private historyUndoingSessions = new Set<string>();
  private sessionObjects = new Map<string, AgentSession>();
  private readonly sessionCapacityProfiles = new WeakMap<AgentSession, SessionCapacityProfile>();
  private mcpStatus = new Map<string, McpServerStatus[]>(); // per-session MCP server status
  private liveSessionModelState = new Map<string, DerivedModelState>();
  private modelMetadataForContextTiers: readonly CopilotModelContextMetadata[] | undefined;
  private pendingSessionEvictions = new Set<string>();
  private cacheQueue: Promise<void> = Promise.resolve();
  private cleanupQueue: Promise<void> = Promise.resolve();
  private readonly cleanupOwnership = new Map<AgentSession, SessionCleanupRecord>();
  private readonly sessionTreeLastActivityAt = new Map<string, number>();
  private sessionCacheSweepHandle?: ReturnType<typeof setInterval>;
  private cumulativeCleanupFailures = 0;
  private failedCleanupRetryScheduled = false;
  private processTreeBaselineCount: number | null = null;
  private lastProcessTreeSampleAttemptAt = 0;
  private lastProcessTreeSampleSucceededAt: number | null = null;
  private lastProcessTreeDescendantCount: number | null = null;
  private processTreeSampleStatus: SessionCapacityRuntimeStatus["processes"]["sampleStatus"] = "never";
  private processTreeSampleInFlight: Promise<void> | null = null;
  private processTreeSampleSequence = 0;
  private readonly settledProcessReservations = new Map<number, Map<number, number>>();
  private readonly sessionBackendOwners = new WeakMap<AgentSession, BackendSessionOwner>();
  private readonly sessionResumeLeases = new WeakMap<AgentSession, SessionResumeLease>();
  private readonly ownedSessionResumeLeases = new WeakSet<SessionResumeLease>();
  private readonly disposableSessionOwners = new Map<string, BackendGeneration>();
  private sessionCapacityWaitTimeoutMs = SessionManager.resolvePositiveNumberEnv(
    "BRIDGE_SESSION_CAPACITY_WAIT_SECONDS",
    DEFAULT_SESSION_CAPACITY_WAIT_SECONDS,
  ) * 1_000;
  private maxSessionCapacityUnits = SessionManager.resolvePositiveNumberEnv(
    "BRIDGE_MAX_SESSION_CAPACITY_UNITS",
    DEFAULT_SESSION_CAPACITY_UNITS,
  );
  private localMcpCapacityWeight = SessionManager.resolvePositiveNumberEnv(
    "BRIDGE_LOCAL_MCP_CAPACITY_WEIGHT",
    DEFAULT_LOCAL_MCP_CAPACITY_WEIGHT,
  );
  private sessionCreateTimeoutMs = SessionManager.resolvePositiveNumberEnv(
    "BRIDGE_SESSION_CREATE_TIMEOUT_SECONDS",
    DEFAULT_SESSION_CREATE_TIMEOUT_SECONDS,
  ) * 1_000;
  private sessionResumeTimeoutMs = SessionManager.resolvePositiveNumberEnv(
    "BRIDGE_SESSION_RESUME_TIMEOUT_SECONDS",
    DEFAULT_SESSION_RESUME_TIMEOUT_SECONDS,
  ) * 1_000;
  private backendRecoveryStopTimeoutMs = SessionManager.resolvePositiveNumberEnv(
    "BRIDGE_BACKEND_RECOVERY_STOP_TIMEOUT_SECONDS",
    DEFAULT_BACKEND_RECOVERY_STOP_TIMEOUT_SECONDS,
  ) * 1_000;
  private backendRecoveryStartTimeoutMs = SessionManager.resolvePositiveNumberEnv(
    "BRIDGE_BACKEND_RECOVERY_START_TIMEOUT_SECONDS",
    DEFAULT_BACKEND_RECOVERY_START_TIMEOUT_SECONDS,
  ) * 1_000;
  private maxProcessTreeDescendants = SessionManager.resolvePositiveIntegerEnv(
    "BRIDGE_MAX_PROCESS_TREE_DESCENDANTS",
    DEFAULT_MAX_PROCESS_TREE_DESCENDANTS,
  );
  private processTreeSampleMaxAgeMs = SessionManager.resolvePositiveNumberEnv(
    "BRIDGE_PROCESS_TREE_SAMPLE_MAX_AGE_SECONDS",
    DEFAULT_PROCESS_TREE_SAMPLE_MAX_AGE_SECONDS,
  ) * 1_000;
  private processTreeAdmissionSampleTimeoutMs = SessionManager.resolvePositiveIntegerEnv(
    "BRIDGE_PROCESS_TREE_ADMISSION_SAMPLE_TIMEOUT_MS",
    DEFAULT_PROCESS_TREE_ADMISSION_SAMPLE_TIMEOUT_MS,
  );
  private readonly sessionCapacityWaiters = new Set<() => void>();
  private readonly workspaceController: SessionWorkspaceController;
  private readonly userInputController: SessionUserInputController;
  private readonly elicitationController: SessionElicitationController;
  private readonly runStateController: SessionRunStateController;
  private readonly agentRegistry: SessionAgentRegistry;
  private readonly sessionNameRpc: SessionNameRpc;
  private readonly sessionNameAutogenerator: SessionNameAutogenerator;
  private readonly sessionRunner: SessionRunner;
  readonly sessionRuns: Map<string, SessionRunRecord>;

  // listSessions cache — avoids expensive SDK filesystem scan on every call
  private sessionListCache: { data: any[]; timestamp: number } | null = null;
  private sessionDiskListCache = new Map<string, { data: any[]; timestamp: number; generation: number }>();
  private sessionDiskListBuilds = new Map<string, { generation: number; promise: Promise<any[]> }>();
  private sessionDiskListCacheGeneration = 0;
  private warmSessionPromises = new Map<string, Promise<void>>();
  private slashCommandListCache = new Map<string, AgentSlashCommandInfo[]>();
  private static SESSION_LIST_TTL = 60_000; // 1 minute TTL
  private static SESSION_DISK_LIST_TTL = 30_000; // 30 seconds

  // Parent sessions and their tracked background agents form one cache tree.
  // Parent count, total context weight, and a shared idle TTL bound the MCP
  // subprocess footprint. Active/resuming parents and running agents protect
  // their tree; eviction cancels/removes child tasks before disconnecting it.
  private maxCachedSessions = SessionManager.resolveMaxCachedSessions();
  private maxCachedContexts = SessionManager.resolvePositiveIntegerEnv(
    "BRIDGE_MAX_CACHED_CONTEXTS",
    DEFAULT_MAX_CACHED_CONTEXTS,
  );
  private sessionCacheIdleTtlMs = SessionManager.resolvePositiveIntegerEnv(
    "BRIDGE_SESSION_CACHE_IDLE_TTL_SECONDS",
    DEFAULT_SESSION_CACHE_IDLE_TTL_MS / 1_000,
  ) * 1_000;
  private maxPendingSessionCleanups = SessionManager.resolvePositiveIntegerEnv(
    "BRIDGE_MAX_PENDING_SESSION_CLEANUPS",
    this.maxCachedContexts,
  );

  private static resolveMaxCachedSessions(): number {
    const raw = Number(process.env.BRIDGE_MAX_CACHED_SESSIONS);
    return Number.isFinite(raw) && raw >= 2 ? Math.floor(raw) : 16;
  }

  private startSessionCacheSweep(): void {
    const intervalMs = Math.min(this.sessionCacheIdleTtlMs, SESSION_CACHE_SWEEP_INTERVAL_MS);
    this.sessionCacheSweepHandle = setInterval(() => {
      this.scheduleCacheOperation(
        this.trimSessionCache("session tree idle TTL"),
        "sweeping idle session trees",
      );
    }, intervalMs);
    this.sessionCacheSweepHandle.unref?.();
  }

  private stopSessionCacheSweep(): void {
    if (!this.sessionCacheSweepHandle) return;
    clearInterval(this.sessionCacheSweepHandle);
    this.sessionCacheSweepHandle = undefined;
  }

  constructor(deps: SessionManagerDeps) {
    this.deps = { ...deps, browserLifecycle: deps.browserLifecycle ?? noopBrowserLifecycle };
    this.workspaceController = new SessionWorkspaceController({
      sessionWorkspaceStore: deps.sessionWorkspaceStore,
      taskStore: deps.taskStore,
      copilotHome: deps.copilotHome,
      runtimePaths: deps.runtimePaths,
      isSessionBusy: (sessionId) => this.isSessionBusy(sessionId),
      onWorkspaceChange: (sessionId, { busy }) => {
        if (busy) {
          this.pendingSessionEvictions.add(sessionId);
        } else {
          this.scheduleCacheOperation(
            this.evictCachedSession(sessionId, undefined, "workspace changed"),
            "evicting a session after its workspace changed",
          );
        }
        this.invalidateSessionListCache("workspace:changed");
      },
    });
    this.userInputController = new SessionUserInputController({
      broker: deps.userInputBroker,
      eventBusRegistry: deps.eventBusRegistry,
      globalBus: deps.globalBus,
      touchActivity: (sessionId, timestamp) => this.touchUserInputActivity(sessionId, timestamp),
      getPendingCount: (sessionId) => this.getPendingInteractionCount(sessionId),
    });
    this.elicitationController = new SessionElicitationController({
      broker: deps.elicitationBroker,
      eventBusRegistry: deps.eventBusRegistry,
      touchActivity: (sessionId, timestamp) => this.touchUserInputActivity(sessionId, timestamp),
      emitPendingStatus: (sessionId) => this.userInputController.emitPendingStatus(sessionId),
    });
    this.runStateController = new SessionRunStateController({
      globalBus: deps.globalBus,
      isRestartPending,
      syncRestartWaitingSessions,
      getActiveSessionCount: () => this.getActiveSessions().length,
      isSessionResuming: (sessionId) => this.isSessionResuming(sessionId),
      cancelPendingUserInputRequests: (sessionId, reason, message) =>
        this.cancelPendingUserInputRequests(sessionId, reason, message),
      promptDeliveryAbortedMessage: PROMPT_DELIVERY_ABORTED_MESSAGE,
      promptDeliveryShutdownMessage: PROMPT_DELIVERY_SHUTDOWN_MESSAGE,
      logger: console,
    });
    this.sessionRuns = this.runStateController.getRunRecords();
    this.agentRegistry = new SessionAgentRegistry({
      globalBus: deps.globalBus,
      getLiveSession: (sessionId) => this.sessionObjects.get(sessionId),
      onTasksChanged: (sessionId) => {
        this.touchSessionTree(sessionId);
        this.notifySessionCapacityChanged();
        this.scheduleCacheOperation(
          this.trimSessionCache("background agent tasks changed"),
          "trimming the session-tree cache after background agent activity",
        );
      },
    });
    this.sessionNameRpc = createSessionNameRpc({
      withSessionNameRpc: (sessionId, operation) => this.withSessionNameRpc(sessionId, operation),
      getSessionStateDir: (sessionId) => this.getSessionStateDir(sessionId),
      emitSessionNameChanged: (sessionId, name) => this.emitSessionNameChanged(sessionId, name),
    });
    this.sessionNameAutogenerator = createSessionNameAutogenerator({
      listModels: () => this.listModels(),
      createSession: async (sessionConfig) => {
        const created = await this.createBackendSession(sessionConfig, {
          kind: "title-helper",
          expectedSessionId: typeof sessionConfig?.sessionId === "string" ? sessionConfig.sessionId : undefined,
          trackDisposableOwner: true,
        });
        this.endSessionCreation(created.lease, true);
        return created.session;
      },
      deleteSession: async (sessionId) => {
        await this.deleteDisposableSession(sessionId);
      },
      getCopilotHome: () => this.getCopilotHome(),
      getSessionName: (sessionId) => this.getSessionName(sessionId),
      getSessionNameMetadata: (sessionId) => this.sessionNameRpc.readSessionNameMetadataFromWorkspace(sessionId),
      setSessionName: (sessionId, name, opts) => this.setSessionName(sessionId, name, opts),
      recordSpan: (name, duration, sessionId, metadata) => this.recordSpan(name, duration, sessionId, metadata),
      logger: console,
    });
    this.sessionRunner = new SessionRunner({
      getBackend: () => {
        if (this.backendGeneration?.state === "fenced") {
          throw this.backendGeneration.fenceError
            ?? new SessionBackendUnavailableError("generation-fenced", this.backendGeneration.id);
        }
        return this.backend ? this.getBackend() : null;
      },
      resumeSession: (sessionId, sessionConfig, lease) =>
        this.resumeBackendSession(sessionId, sessionConfig, lease),
      sessionObjects: this.sessionObjects,
      mcpStatus: this.mcpStatus,
      activeRunControllers: this.activeRunControllers,
      runStateController: this.runStateController,
      agentRegistry: this.agentRegistry,
      eventBusRegistry: deps.eventBusRegistry,
      globalBus: deps.globalBus,
      sessionMetaStore: deps.sessionMetaStore,
      telemetryStore: deps.telemetryStore,
      sessionContextStore: deps.sessionContextStore,
      copilotHome: deps.copilotHome,
      isSessionBusy: (sessionId) => this.isSessionBusy(sessionId),
      hasPlan: (sessionId) => this.hasPlan(sessionId),
      getSessionStateDir: (sessionId) => this.getSessionStateDir(sessionId),
      buildSessionConfig: (opts) => this.buildSessionConfig(opts),
      findLinkedTask: (sessionId) => this.findLinkedTask(sessionId),
      lookupGroupNotes: (groupId) => this.lookupGroupNotes(groupId),
      persistAndRouteAttachments: (sessionId, attachments) => this.persistAndRouteAttachments(sessionId, attachments),
      beginSessionResume: (sessionId, sessionConfig, isCancelled, options) =>
        this.beginSessionResume(sessionId, sessionConfig, {
          isCancelled,
          reserveCachedSession: options?.reserveCachedSession,
          trackResuming: options?.trackResuming,
        }),
      endSessionResume: (lease) => this.endSessionResume(lease),
      notifySessionCapacityChanged: () => this.notifySessionCapacityChanged(),
      cacheResumedSession: (sessionId, session, sessionConfig) =>
        this.cacheResumedSession(sessionId, session, sessionConfig),
      replaceCachedSession: (sessionId, expectedSession, nextSession) =>
        this.replaceCachedSession(sessionId, expectedSession, nextSession),
      abandonCachedSession: (sessionId, expectedSession) => this.abandonCachedSession(sessionId, expectedSession),
      disposeSession: (sessionId, session, reason) => this.disposeSession(sessionId, session, reason),
      probeMcpStatus: (sessionId, session) => this.probeMcpStatus(sessionId, session),
      markCachedSessionForEviction: (sessionId, reason) => this.markCachedSessionForEviction(sessionId, reason),
      deferMcpStatusSessionEviction: (sessionId, reason) => this.deferMcpStatusSessionEviction(sessionId, reason),
      flushPendingSessionEviction: (sessionId) => this.flushPendingSessionEviction(sessionId),
      getPendingUserInputCount: (sessionId) => this.userInputController.getPendingCount(sessionId),
      getPendingInteractionCount: (sessionId) => this.getPendingInteractionCount(sessionId),
      cancelPendingUserInputRequests: (sessionId, reason, message) =>
        this.cancelPendingUserInputRequests(sessionId, reason, message),
      recordSessionAttention: (sessionId, at) => this.markSessionAttention(sessionId, at),
      touchSessionActivity: (sessionId, at) => this.touchSessionTree(sessionId, at),
      invalidateSessionListCache: () => this.invalidateSessionListCache("session-runner"),
      maybeAutoNameSession: (sessionId, options) => this.maybeAutoNameSession(sessionId, options),
    });
    configureRestartStateStore(deps.runtimePaths);
    configureRestartEventBus(deps.globalBus);
    void refreshRestartState();
    this.startSessionCacheSweep();
  }

  private recordSpan(name: string, duration: number, sessionId?: string, metadata?: Record<string, unknown>): void {
    try {
      this.deps.telemetryStore?.recordSpan({ name, duration, sessionId, metadata, source: "server" });
    } catch { /* telemetry should never break core flow */ }
  }

  private getSessionCacheState(): {
    ready: number;
    retained: number;
    readyParents: number;
    retainedParents: number;
    trackedAgents: number;
    readyContextWeight: number;
    retainedContextWeight: number;
    readyLocalMcpInstances: number;
    retainedLocalMcpInstances: number;
    readyCapacityUnits: number;
    retainedCapacityUnits: number;
    reservedContexts: number;
    reservedLocalMcpInstances: number;
    reservedCapacityUnits: number;
    pendingCleanup: number;
    failedCleanup: number;
    waitingForCapacity: number;
  } {
    let pendingCleanup = 0;
    let failedCleanup = 0;
    let cleanupContextWeight = 0;
    let cleanupLocalMcpInstances = 0;
    let cleanupCapacityUnits = 0;
    for (const record of this.cleanupOwnership.values()) {
      if (record.state === "pending") pendingCleanup++;
      else failedCleanup++;
      cleanupContextWeight += record.contextWeight;
      cleanupLocalMcpInstances += record.localMcpInstances;
      cleanupCapacityUnits += record.capacityUnits;
    }
    const readyParents = this.sessionObjects.size;
    let trackedAgents = 0;
    let readyLocalMcpInstances = 0;
    let readyCapacityUnits = 0;
    for (const sessionId of this.sessionObjects.keys()) {
      trackedAgents += this.agentRegistry.getTrackedAgentCount(sessionId);
      const capacity = this.getSessionTreeCapacity(sessionId);
      readyLocalMcpInstances += capacity.localMcpInstances;
      readyCapacityUnits += capacity.capacityUnits;
    }
    const readyContextWeight = readyParents + trackedAgents;
    const retainedParents = readyParents + this.cleanupOwnership.size;
    const reservations = [
      ...this.creatingCapacityReservations.values(),
      ...this.resumingCapacityReservations.values(),
    ];
    const reservedContexts = reservations.length;
    const reservedLocalMcpInstances = reservations
      .reduce((total, reservation) => total + reservation.localMcpInstances, 0);
    const reservedCapacityUnits = reservations
      .reduce((total, reservation) => total + reservation.capacityUnits, 0);
    return {
      ready: readyParents,
      retained: retainedParents,
      readyParents,
      retainedParents,
      trackedAgents,
      readyContextWeight,
      retainedContextWeight: readyContextWeight + cleanupContextWeight,
      readyLocalMcpInstances,
      retainedLocalMcpInstances: readyLocalMcpInstances + cleanupLocalMcpInstances,
      readyCapacityUnits,
      retainedCapacityUnits: readyCapacityUnits + cleanupCapacityUnits,
      reservedContexts,
      reservedLocalMcpInstances,
      reservedCapacityUnits,
      pendingCleanup,
      failedCleanup,
      waitingForCapacity: this.sessionCapacityWaiters.size,
    };
  }

  private getSessionCapacityPressure(): {
    state: ReturnType<SessionManager["getSessionCacheState"]>;
    protectedReadySessionCount: number;
    contexts: number;
    localMcpInstances: number;
    capacityUnits: number;
  } {
    const state = this.getSessionCacheState();
    const protectedSessionIds = this.getProtectedSessionTreeIds();
    let protectedReadySessionCount = 0;
    let protectedReadyContextWeight = 0;
    let protectedReadyLocalMcpInstances = 0;
    let protectedReadyCapacityUnits = 0;
    for (const sessionId of protectedSessionIds) {
      if (!this.sessionObjects.has(sessionId)) continue;
      protectedReadySessionCount++;
      protectedReadyContextWeight += this.getSessionTreeContextWeight(sessionId);
      const capacity = this.getSessionTreeCapacity(sessionId);
      protectedReadyLocalMcpInstances += capacity.localMcpInstances;
      protectedReadyCapacityUnits += capacity.capacityUnits;
    }
    return {
      state,
      protectedReadySessionCount,
      contexts: state.retainedContextWeight - state.readyContextWeight
        + protectedReadyContextWeight
        + state.reservedContexts,
      localMcpInstances: state.retainedLocalMcpInstances - state.readyLocalMcpInstances
        + protectedReadyLocalMcpInstances
        + state.reservedLocalMcpInstances,
      capacityUnits: state.retainedCapacityUnits - state.readyCapacityUnits
        + protectedReadyCapacityUnits
        + state.reservedCapacityUnits,
    };
  }

  private getSessionCapacityRuntimeStatus(): SessionCapacityRuntimeStatus {
    const pressure = this.getSessionCapacityPressure();
    const { state } = pressure;
    const projectedProcessReservations = this.getProjectedProcessReservations();
    const actualProcessDescendants = this.lastProcessTreeDescendantCount;
    return {
      contexts: {
        used: pressure.contexts,
        retained: state.retainedContextWeight + state.reservedContexts,
        limit: this.maxCachedContexts,
      },
      weightedUnits: {
        used: pressure.capacityUnits,
        retained: state.retainedCapacityUnits + state.reservedCapacityUnits,
        limit: this.maxSessionCapacityUnits,
      },
      localMcpSlots: {
        used: pressure.localMcpInstances,
        retained: state.retainedLocalMcpInstances + state.reservedLocalMcpInstances,
      },
      cache: {
        readyParents: state.readyParents,
        protectedParents: pressure.protectedReadySessionCount,
        limit: this.maxCachedSessions,
      },
      cleanup: {
        pending: state.pendingCleanup,
        failed: state.failedCleanup,
        limit: this.maxPendingSessionCleanups,
      },
      processes: {
        actualDescendants: actualProcessDescendants,
        projectedReservations: projectedProcessReservations,
        used: (actualProcessDescendants ?? 0) + projectedProcessReservations,
        limit: this.maxProcessTreeDescendants,
        sampleStatus: this.processTreeSampleStatus,
        sampledAt: this.lastProcessTreeSampleSucceededAt === null
          ? null
          : new Date(this.lastProcessTreeSampleSucceededAt).toISOString(),
      },
      waitingRequests: state.waitingForCapacity,
      localMcpWeight: this.localMcpCapacityWeight,
      waitTimeoutSeconds: this.sessionCapacityWaitTimeoutMs / 1_000,
    };
  }

  private getCapacityProfile(sessionConfig: { mcpServers?: Record<string, McpServerConfig> }): SessionCapacityProfile {
    return {
      localMcpCount: Object.values(sessionConfig.mcpServers ?? {})
        .filter(isLocalMcpServerConfig)
        .length,
    };
  }

  private getCapacityReservation(
    sessionConfig: { mcpServers?: Record<string, McpServerConfig> },
  ): SessionCapacityReservation {
    const profile = this.getCapacityProfile(sessionConfig);
    return {
      localMcpInstances: profile.localMcpCount,
      capacityUnits: 1 + profile.localMcpCount * this.localMcpCapacityWeight,
      processSlots: 1 + profile.localMcpCount,
    };
  }

  private trackSessionCapacityProfile(
    session: AgentSession,
    sessionConfig: { mcpServers?: Record<string, McpServerConfig> },
  ): void {
    this.sessionCapacityProfiles.set(session, this.getCapacityProfile(sessionConfig));
  }

  private getSessionTreeCapacity(sessionId: string): SessionCapacityReservation {
    const session = this.sessionObjects.get(sessionId);
    const profile = session ? this.sessionCapacityProfiles.get(session) : undefined;
    const contexts = this.getSessionTreeContextWeight(sessionId);
    const localMcpInstances = contexts * (profile?.localMcpCount ?? 0);
    return {
      localMcpInstances,
      capacityUnits: contexts + localMcpInstances * this.localMcpCapacityWeight,
      processSlots: contexts + localMcpInstances,
    };
  }

  private getCapacitySnapshot(
    contexts: number,
    localMcpInstances: number,
    capacityUnits: number,
  ): SessionCapacitySnapshot {
    return {
      contexts,
      contextLimit: this.maxCachedContexts,
      localMcpInstances,
      capacityUnits,
      capacityLimit: this.maxSessionCapacityUnits,
      processDescendants: this.lastProcessTreeDescendantCount,
      processReservations: this.getProjectedProcessReservations(),
      processLimit: this.maxProcessTreeDescendants,
    };
  }

  private getProjectedProcessReservations(): number {
    let total = 0;
    for (const reservation of this.creatingCapacityReservations.values()) {
      total += reservation.processSlots;
    }
    for (const reservation of this.resumingCapacityReservations.values()) {
      total += reservation.processSlots;
    }
    for (const generationReservations of this.settledProcessReservations.values()) {
      for (const processSlots of generationReservations.values()) {
        total += processSlots;
      }
    }
    return total;
  }

  private retainSettledProcessReservation(
    backendGeneration: number,
    reservation: SessionCapacityReservation,
  ): void {
    const settledAtSequence = this.processTreeSampleSequence;
    let generationReservations = this.settledProcessReservations.get(backendGeneration);
    if (!generationReservations) {
      generationReservations = new Map<number, number>();
      this.settledProcessReservations.set(backendGeneration, generationReservations);
    }
    generationReservations.set(
      settledAtSequence,
      (generationReservations.get(settledAtSequence) ?? 0) + reservation.processSlots,
    );
  }

  private clearSettledProcessReservationsForGeneration(backendGeneration: number): void {
    if (!this.settledProcessReservations.delete(backendGeneration)) return;
    this.notifySessionCapacityChanged();
  }

  private assertSessionCapacityAvailable(
    request: SessionCapacityReservation,
  ): void {
    const pressure = this.getSessionCapacityPressure();
    const { state } = pressure;
    const projectedProcessReservations = this.getProjectedProcessReservations() + request.processSlots;
    const projectedProcessDescendants = (this.lastProcessTreeDescendantCount ?? 0)
      + projectedProcessReservations;
    if (projectedProcessDescendants > this.maxProcessTreeDescendants) {
      throw new SessionCapacityError(
        "process-pressure",
        {
          ...this.getCapacitySnapshot(
            pressure.contexts + 1,
            pressure.localMcpInstances + request.localMcpInstances,
            pressure.capacityUnits + request.capacityUnits,
          ),
          processReservations: projectedProcessReservations,
        },
      );
    }
    if (state.failedCleanup > 0) {
      if (!this.failedCleanupRetryScheduled) {
        this.failedCleanupRetryScheduled = true;
        const retry = this.enqueueCache("retry-cleanup", undefined, () => this.retryFailedCleanupsUnsafe());
        void retry.then(
          () => { this.failedCleanupRetryScheduled = false; },
          () => { this.failedCleanupRetryScheduled = false; },
        );
        this.scheduleCacheOperation(retry, "retrying failed session cleanup");
      }
      throw new SessionCapacityError(
        "cleanup-failed",
        this.getCapacitySnapshot(
          state.retainedContextWeight + state.reservedContexts,
          state.retainedLocalMcpInstances + state.reservedLocalMcpInstances,
          state.retainedCapacityUnits + state.reservedCapacityUnits,
        ),
      );
    }
    const projectedCleanupDemand = state.pendingCleanup
      + pressure.protectedReadySessionCount
      + state.reservedContexts
      + 1;
    const projectedNonEvictableContexts = pressure.contexts + 1;
    const projectedNonEvictableLocalMcpInstances = pressure.localMcpInstances
      + request.localMcpInstances;
    const projectedNonEvictableCapacityUnits = pressure.capacityUnits
      + request.capacityUnits;
    if (projectedNonEvictableContexts > this.maxCachedContexts) {
      throw new SessionCapacityError(
        "context-limit",
        this.getCapacitySnapshot(
          projectedNonEvictableContexts,
          projectedNonEvictableLocalMcpInstances,
          projectedNonEvictableCapacityUnits,
        ),
      );
    }
    if (projectedNonEvictableCapacityUnits > this.maxSessionCapacityUnits) {
      throw new SessionCapacityError(
        "weighted-capacity",
        this.getCapacitySnapshot(
          projectedNonEvictableContexts,
          projectedNonEvictableLocalMcpInstances,
          projectedNonEvictableCapacityUnits,
        ),
      );
    }
    if (projectedCleanupDemand > this.maxPendingSessionCleanups) {
      throw new SessionCapacityError(
        "cleanup-demand",
        this.getCapacitySnapshot(
          state.retainedContextWeight + state.reservedContexts + 1,
          state.retainedLocalMcpInstances + state.reservedLocalMcpInstances + request.localMcpInstances,
          state.retainedCapacityUnits + state.reservedCapacityUnits + request.capacityUnits,
        ),
      );
    }
    const projectedRetainedContexts = state.retainedContextWeight
      + state.reservedContexts
      + 1;
    const projectedRetainedLocalMcpInstances = state.retainedLocalMcpInstances
      + state.reservedLocalMcpInstances
      + request.localMcpInstances;
    const projectedRetainedCapacityUnits = state.retainedCapacityUnits
      + state.reservedCapacityUnits
      + request.capacityUnits;
    if (
      state.pendingCleanup > 0
      && (
        projectedRetainedContexts > this.maxCachedContexts
        || projectedRetainedCapacityUnits > this.maxSessionCapacityUnits
      )
    ) {
      throw new SessionCapacityError(
        "retained-capacity",
        this.getCapacitySnapshot(
          projectedRetainedContexts,
          projectedRetainedLocalMcpInstances,
          projectedRetainedCapacityUnits,
        ),
      );
    }
  }

  private notifySessionCapacityChanged(): void {
    const waiters = [...this.sessionCapacityWaiters];
    this.sessionCapacityWaiters.clear();
    for (const resolve of waiters) resolve();
  }

  private waitForSessionCapacityChange(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.sessionCapacityWaiters.delete(finish);
        resolve();
      };
      this.sessionCapacityWaiters.add(finish);
      timer = setTimeout(finish, timeoutMs);
      timer.unref?.();
    });
  }

  private async waitForSessionCapacity(
    sessionConfig: { mcpServers?: Record<string, McpServerConfig> },
    options: {
      isCancelled?: () => boolean;
      assertAdmission?: () => void;
      reserve: (reservation: SessionCapacityReservation) => void;
    },
  ): Promise<boolean> {
    const startedAt = Date.now();
    const deadline = startedAt + this.sessionCapacityWaitTimeoutMs;
    const request = this.getCapacityReservation(sessionConfig);
    let lastCapacityError: SessionCapacityError | undefined;
    let waitingLogged = false;

    while (!options.isCancelled?.()) {
      options.assertAdmission?.();
      await this.refreshProcessPressureForAdmission();
      options.assertAdmission?.();
      try {
        this.assertSessionCapacityAvailable(request);
        options.reserve(request);
        if (waitingLogged) {
          this.recordSpan("session.capacity.wait", Date.now() - startedAt, undefined, {
            outcome: "admitted",
            reason: lastCapacityError?.reason,
            ...lastCapacityError?.snapshot,
          });
        }
        return true;
      } catch (error) {
        if (!(error instanceof SessionCapacityError)) throw error;
        lastCapacityError = error;
      }

      const remaining = deadline - Date.now();
      if (this.sessionCapacityWaitTimeoutMs <= 0 || remaining <= 0) {
        this.recordSpan("session.capacity.wait", Date.now() - startedAt, undefined, {
          outcome: "timed-out",
          reason: lastCapacityError.reason,
          ...lastCapacityError.snapshot,
        });
        throw lastCapacityError;
      }
      if (!waitingLogged) {
        waitingLogged = true;
        console.warn(
          `[sdk] Session capacity is full (${formatCapacityUnits(lastCapacityError.snapshot.capacityUnits)}/${formatCapacityUnits(lastCapacityError.snapshot.capacityLimit)} units, ${lastCapacityError.snapshot.contexts}/${lastCapacityError.snapshot.contextLimit} contexts); waiting up to ${Math.ceil(this.sessionCapacityWaitTimeoutMs / 1_000)}s`,
        );
      }
      await this.waitForSessionCapacityChange(Math.min(SESSION_CAPACITY_WAIT_POLL_MS, remaining));
    }

    return false;
  }

  private async beginSessionCreation(
    sessionConfig: { mcpServers?: Record<string, McpServerConfig> },
    generation: BackendGeneration,
  ): Promise<SessionCreationLease> {
    const lease: SessionCreationLease = {
      token: Symbol("session-create"),
      reservation: this.getCapacityReservation(sessionConfig),
      generation,
    };
    let capacityReservation: SessionCapacityReservation | undefined;
    await this.waitForSessionCapacity(sessionConfig, {
      assertAdmission: () => this.assertBackendGenerationReady(generation),
      reserve: (reservation) => {
        capacityReservation = reservation;
        this.creatingCapacityReservations.set(lease.token, reservation);
      },
    });
    lease.reservation = capacityReservation!;
    return lease;
  }

  private endSessionCreation(lease: SessionCreationLease, retainSettledProcessProjection = false): void {
    const released = this.creatingCapacityReservations.delete(lease.token);
    if (
      released
      && retainSettledProcessProjection
      && lease.generation.state === "ready"
      && this.backendGeneration === lease.generation
      && this.backend === lease.generation.backend
    ) {
      this.retainSettledProcessReservation(lease.generation.id, lease.reservation);
    }
    this.notifySessionCapacityChanged();
  }

  private recordSessionCacheState(
    operation: string,
    outcome: "succeeded" | "failed",
    duration: number,
    sessionId?: string,
  ): void {
    this.recordSpan("session.cache.operation", duration, sessionId, {
      operation,
      outcome,
      max: this.maxCachedSessions,
      maxContexts: this.maxCachedContexts,
      maxCapacityUnits: this.maxSessionCapacityUnits,
      localMcpCapacityWeight: this.localMcpCapacityWeight,
      maxProcessTreeDescendants: this.maxProcessTreeDescendants,
      processTreeSampleStatus: this.processTreeSampleStatus,
      processTreeDescendants: this.lastProcessTreeDescendantCount,
      projectedProcessReservations: this.getProjectedProcessReservations(),
      capacityWaitTimeoutMs: this.sessionCapacityWaitTimeoutMs,
      idleTtlMs: this.sessionCacheIdleTtlMs,
      maxPendingCleanup: this.maxPendingSessionCleanups,
      cumulativeCleanupFailures: this.cumulativeCleanupFailures,
      ...this.getSessionCacheState(),
    });
  }

  private enqueueCache<T>(
    operation: string,
    sessionId: string | undefined,
    work: () => T,
  ): Promise<T> {
    const startedAt = Date.now();
    const run = this.cacheQueue.then(() => {
      try {
        const result = work();
        this.recordSessionCacheState(operation, "succeeded", Date.now() - startedAt, sessionId);
        return result;
      } catch (error) {
        this.recordSessionCacheState(operation, "failed", Date.now() - startedAt, sessionId);
        throw error;
      } finally {
        this.maybeSampleProcessTree();
      }
    });
    this.cacheQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  async _drainCacheQueue(): Promise<void> {
    await this.cacheQueue;
    await this.cleanupQueue;
  }

  private scheduleCacheOperation(operation: Promise<unknown>, context: string): void {
    void operation.catch((error) => {
      console.error(`[sdk] Cache cleanup failed while ${context}:`, error);
    });
  }

  private isTerminalBackgroundTask(task: AgentBackgroundTask): boolean {
    return task.status === "completed" || task.status === "failed" || task.status === "cancelled";
  }

  private async runTaskRpcBeforeDeadline<T>(
    operation: () => Promise<T>,
    deadline: Deadline,
  ): Promise<T> {
    const outcome = await settleByDeadline(operation, deadline);
    if (outcome.status === "timed-out") throw new SessionTaskCleanupTimeoutError();
    if (outcome.status === "rejected") throw outcome.error;
    return outcome.value;
  }

  private async reapSessionTasks(sessionId: string, session: AgentSession): Promise<void> {
    if (typeof session.listTasks !== "function") return;
    const deadline = createDeadline(SESSION_TASK_CLEANUP_TIMEOUT_MS);

    while (remainingMs(deadline) > 0) {
      const result = await this.runTaskRpcBeforeDeadline(
        () => Promise.resolve(session.listTasks!()),
        deadline,
      );
      const tasks = Array.isArray(result?.tasks) ? result.tasks : [];
      if (tasks.length === 0) {
        return;
      }

      for (const task of tasks) {
        if (this.isTerminalBackgroundTask(task)) {
          if (typeof session.removeTask !== "function") {
            throw new Error("Agent backend cannot remove completed background tasks");
          }
          await this.runTaskRpcBeforeDeadline(
            () => Promise.resolve(session.removeTask!(task.id)),
            deadline,
          );
        } else {
          if (typeof session.cancelTask !== "function") {
            throw new Error("Agent backend cannot cancel active background tasks");
          }
          await this.runTaskRpcBeforeDeadline(
            () => Promise.resolve(session.cancelTask!(task.id)),
            deadline,
          );
        }
      }

      const waitMs = Math.min(SESSION_TASK_CLEANUP_POLL_MS, remainingMs(deadline));
      if (waitMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      }
    }

    throw new SessionTaskCleanupTimeoutError();
  }

  private async runSessionCleanup(
    sessionId: string,
    session: AgentSession,
    reason: string,
  ): Promise<boolean> {
    const record = this.cleanupOwnership.get(session);
    if (!record) return true;

    let lastOutcome: "rejected" | "timed-out" = "rejected";
    for (let cycleAttempt = 1; cycleAttempt <= DISCONNECT_MAX_ATTEMPTS; cycleAttempt++) {
      const startedAt = Date.now();
      record.attempts++;
      let taskOutcome: "fulfilled" | "rejected" | "timed-out" = "fulfilled";
      try {
        await this.reapSessionTasks(sessionId, session);
      } catch (error) {
        if (isStaleAgentSessionError(error)) {
          this.recordSpan("session.cache.tasks", Date.now() - startedAt, sessionId, {
            reason,
            attempt: record.attempts,
            cycleAttempt,
            outcome: "stale-session",
            error: error instanceof Error ? error.message : String(error),
            ...this.getSessionCacheState(),
          });
          this.completeSessionCleanup(sessionId, session, reason, "task cleanup found the session no longer addressable");
          return true;
        }
        taskOutcome = error instanceof SessionTaskCleanupTimeoutError ? "timed-out" : "rejected";
        lastOutcome = taskOutcome;
        this.recordSpan("session.cache.tasks", Date.now() - startedAt, sessionId, {
          reason,
          attempt: record.attempts,
          cycleAttempt,
          outcome: taskOutcome,
          error: error instanceof Error ? error.message : String(error),
          ...this.getSessionCacheState(),
        });
        continue;
      }
      this.recordSpan("session.cache.tasks", Date.now() - startedAt, sessionId, {
        reason,
        attempt: record.attempts,
        cycleAttempt,
        outcome: taskOutcome,
        ...this.getSessionCacheState(),
      });
      const result = await settleByDeadline<void>(
        () => Promise.resolve(session.disconnect?.()).then(() => undefined),
        createDeadline(DISCONNECT_TIMEOUT_MS),
      );
      const staleSession = result.status === "rejected" && isStaleAgentSessionError(result.error);
      this.recordSpan("session.cache.disconnect", Date.now() - startedAt, sessionId, {
        reason,
        attempt: record.attempts,
        cycleAttempt,
        outcome: staleSession ? "stale-session" : result.status,
        ...(result.status === "rejected"
          ? { error: result.error instanceof Error ? result.error.message : String(result.error) }
          : {}),
        ...this.getSessionCacheState(),
      });
      if (result.status === "fulfilled" || staleSession) {
        this.completeSessionCleanup(
          sessionId,
          session,
          reason,
          staleSession ? "disconnect found the session no longer addressable" : undefined,
        );
        return true;
      }
      lastOutcome = result.status;
    }

    this.cumulativeCleanupFailures++;
    record.state = "failed";
    record.lastOutcome = lastOutcome;
    delete record.promise;
    this.notifySessionCapacityChanged();
    console.warn(
      `[sdk] [${sessionId.slice(0, 8)}] Session-tree cleanup ${lastOutcome} after ${DISCONNECT_MAX_ATTEMPTS} attempts; retained for retry (${reason})`,
    );
    return false;
  }

  private completeSessionCleanup(
    sessionId: string,
    session: AgentSession,
    reason: string,
    staleOutcome?: string,
  ): void {
    this.cleanupOwnership.delete(session);
    this.agentRegistry.forgetIfOwnedBy(sessionId, session);
    this.notifySessionCapacityChanged();
    if (staleOutcome) {
      console.warn(
        `[sdk] [${sessionId.slice(0, 8)}] Session-tree cleanup self-healed: ${staleOutcome} (${reason})`,
      );
    }
  }

  private queueSessionCleanupUnsafe(
    sessionId: string,
    session: AgentSession,
    reason: string,
  ): Promise<boolean> {
    const existing = this.cleanupOwnership.get(session);
    if (existing?.state === "pending" && existing.promise) return existing.promise;

    const contextWeight = 1 + this.agentRegistry.getTrackedAgentCount(sessionId);
    const localMcpCount = this.sessionCapacityProfiles.get(session)?.localMcpCount ?? 0;
    const localMcpInstances = contextWeight * localMcpCount;
    const capacityUnits = contextWeight + localMcpInstances * this.localMcpCapacityWeight;
    const record = existing ?? {
      sessionId,
      state: "pending" as const,
      attempts: 0,
      contextWeight,
      localMcpInstances,
      capacityUnits,
    };
    record.sessionId = sessionId;
    record.state = "pending";
    record.contextWeight = Math.max(
      record.contextWeight,
      contextWeight,
    );
    record.localMcpInstances = Math.max(record.localMcpInstances, localMcpInstances);
    record.capacityUnits = Math.max(record.capacityUnits, capacityUnits);
    delete record.lastOutcome;
    this.cleanupOwnership.set(session, record);

    const cleanup = this.cleanupQueue.then(() => this.runSessionCleanup(sessionId, session, reason));
    record.promise = cleanup;
    this.cleanupQueue = cleanup.then(() => undefined, () => undefined);
    return cleanup;
  }

  private retryFailedCleanupsUnsafe(): void {
    for (const [session, record] of this.cleanupOwnership) {
      if (record.state !== "failed") continue;
      this.queueSessionCleanupUnsafe(record.sessionId, session, "retrying failed cleanup");
    }
  }

  private removeReadySessionUnsafe(sessionId: string, expectedSession?: AgentSession): AgentSession | undefined {
    const session = this.sessionObjects.get(sessionId);
    if (!session || (expectedSession && session !== expectedSession)) return undefined;
    this.sessionObjects.delete(sessionId);
    this.sessionTreeLastActivityAt.delete(sessionId);
    this.liveSessionModelState.delete(sessionId);
    this.slashCommandListCache.delete(sessionId);
    this.agentRegistry.markSessionUnavailable(sessionId);
    return session;
  }

  private evictCachedSessionUnsafe(
    sessionId: string,
    expectedSession: AgentSession | undefined,
    reason: string,
  ): Promise<boolean> | undefined {
    const session = this.removeReadySessionUnsafe(sessionId, expectedSession);
    if (!session) return undefined;
    return this.queueSessionCleanupUnsafe(sessionId, session, reason);
  }

  private evictReadySessionsOverLimitUnsafe(
    protectedIds: Set<string>,
    reason: string,
    warning: string,
  ): void {
    while (
      this.sessionObjects.size > this.maxCachedSessions
      || this.getReadySessionContextWeight() > this.maxCachedContexts
      || this.getReadySessionCapacityUnits() > this.maxSessionCapacityUnits
    ) {
      const candidateId = [...this.sessionObjects.keys()]
        .find((id) => !protectedIds.has(id));
      if (!candidateId) {
        console.warn(warning);
        return;
      }
      this.evictCachedSessionUnsafe(candidateId, undefined, reason);
    }
  }

  private getReadySessionContextWeight(): number {
    let weight = this.sessionObjects.size;
    for (const sessionId of this.sessionObjects.keys()) {
      weight += this.agentRegistry.getTrackedAgentCount(sessionId);
    }
    return weight;
  }

  private getReadySessionCapacityUnits(): number {
    let units = 0;
    for (const sessionId of this.sessionObjects.keys()) {
      units += this.getSessionTreeCapacity(sessionId).capacityUnits;
    }
    return units;
  }

  private getSessionTreeContextWeight(sessionId: string): number {
    return 1 + this.agentRegistry.getTrackedAgentCount(sessionId);
  }

  private evictExpiredSessionTreesUnsafe(protectedIds: Set<string>, now = Date.now()): void {
    for (const sessionId of [...this.sessionObjects.keys()]) {
      if (protectedIds.has(sessionId) || !this.isSessionTreeIdleExpired(sessionId, now)) continue;
      this.evictCachedSessionUnsafe(sessionId, undefined, "session tree idle TTL");
    }
  }

  private enforceSessionCacheLimitUnsafe(justCachedId: string): void {
    const protectedIds = this.getProtectedSessionTreeIds(justCachedId);
    this.evictExpiredSessionTreesUnsafe(protectedIds);
    this.evictReadySessionsOverLimitUnsafe(
      protectedIds,
      "enforcing session-tree cache limit",
      `[sdk] Session-tree cache temporarily above parent/context/capacity limits ${this.maxCachedSessions}/${this.maxCachedContexts}/${formatCapacityUnits(this.maxSessionCapacityUnits)}; remaining trees are protected`,
    );
  }

  private trimSessionCacheUnsafe(reason: string): void {
    const protectedIds = this.getProtectedSessionTreeIds();
    this.evictExpiredSessionTreesUnsafe(protectedIds);
    this.evictReadySessionsOverLimitUnsafe(
      protectedIds,
      reason,
      `[sdk] Session-tree cache remains above parent/context/capacity limits ${this.maxCachedSessions}/${this.maxCachedContexts}/${formatCapacityUnits(this.maxSessionCapacityUnits)}; remaining trees are protected`,
    );
    this.retryFailedCleanupsUnsafe();
  }

  private trimSessionCache(reason: string): Promise<void> {
    return this.enqueueCache("trim", undefined, () => this.trimSessionCacheUnsafe(reason));
  }

  private startProcessTreeSample(): Promise<void> {
    if (this.processTreeSampleInFlight) return this.processTreeSampleInFlight;
    const sampleSequence = ++this.processTreeSampleSequence;
    this.lastProcessTreeSampleAttemptAt = Date.now();
    const sampler = this.deps.sampleProcessTree ?? (async () => null);
    const sample = Promise.resolve()
      .then(() => sampler(process.pid, createDeadline(PROCESS_TREE_SAMPLE_DEADLINE_MS)))
      .then((snapshot) => {
        if (!snapshot) {
          this.processTreeSampleStatus = "unavailable";
          this.recordSpan("session.cache.processTree", 0, undefined, { outcome: "unavailable" });
          return;
        }
        const sampledAt = Date.now();
        const descendantCount = snapshot.descendants.length;
        const nodeCount = 1 + descendantCount;
        this.lastProcessTreeDescendantCount = descendantCount;
        this.lastProcessTreeSampleSucceededAt = sampledAt;
        this.processTreeSampleStatus = "sampled";
        for (const [backendGeneration, generationReservations] of this.settledProcessReservations) {
          for (const settledAtSequence of generationReservations.keys()) {
            if (settledAtSequence < sampleSequence) {
              generationReservations.delete(settledAtSequence);
            }
          }
          if (generationReservations.size === 0) {
            this.settledProcessReservations.delete(backendGeneration);
          }
        }
        this.processTreeBaselineCount ??= nodeCount;
        const baseline = this.processTreeBaselineCount;
        const absoluteThreshold = SessionManager.resolvePositiveIntegerEnv(
          "BRIDGE_PROCESS_TREE_WARNING_THRESHOLD",
          PROCESS_TREE_WARNING_THRESHOLD,
        );
        const growthThreshold = SessionManager.resolvePositiveIntegerEnv(
          "BRIDGE_PROCESS_TREE_GROWTH_WARNING_THRESHOLD",
          PROCESS_TREE_GROWTH_WARNING_THRESHOLD,
        );
        const growth = nodeCount - baseline;
        this.recordSpan("session.cache.processTree", 0, undefined, {
          outcome: "sampled",
          nodeCount,
          descendantCount,
          baseline,
          growth,
          absoluteThreshold,
          growthThreshold,
          ...this.getSessionCacheState(),
        });
        if (nodeCount >= absoluteThreshold || growth >= growthThreshold) {
          console.warn(
            `[sdk] Process tree warning: ${nodeCount} nodes, growth ${growth} from baseline ${baseline}`,
          );
        }
        this.notifySessionCapacityChanged();
      })
      .catch((error) => {
        this.processTreeSampleStatus = "failed";
        console.warn("[sdk] Process tree sampling failed:", error);
        this.recordSpan("session.cache.processTree", 0, undefined, {
          outcome: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        if (this.processTreeSampleInFlight === sample) {
          this.processTreeSampleInFlight = null;
        }
      });
    this.processTreeSampleInFlight = sample;
    return sample;
  }

  private async refreshProcessPressureForAdmission(): Promise<void> {
    if (!this.deps.sampleProcessTree) {
      if (this.processTreeSampleStatus === "never") this.processTreeSampleStatus = "unavailable";
      return;
    }
    const lastSucceededAt = this.lastProcessTreeSampleSucceededAt;
    if (
      lastSucceededAt !== null
      && Date.now() - lastSucceededAt <= this.processTreeSampleMaxAgeMs
    ) {
      return;
    }
    const sample = this.startProcessTreeSample();
    const outcome = await settleByDeadline(
      () => sample,
      createDeadline(this.processTreeAdmissionSampleTimeoutMs),
    );
    if (outcome.status === "timed-out" && this.processTreeSampleInFlight === sample) {
      this.processTreeSampleStatus = "timed-out";
      this.recordSpan("session.cache.processTree", this.processTreeAdmissionSampleTimeoutMs, undefined, {
        outcome: "timed-out",
      });
    }
  }

  private maybeSampleProcessTree(): void {
    if (!this.deps.sampleProcessTree) return;
    const now = Date.now();
    if (now - this.lastProcessTreeSampleAttemptAt < PROCESS_TREE_SAMPLE_THROTTLE_MS) return;
    void this.startProcessTreeSample();
  }

  private static resolvePositiveIntegerEnv(name: string, fallback: number): number {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  }

  private static resolvePositiveNumberEnv(name: string, fallback: number): number {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }

  private cacheSession(
    sessionId: string,
    session: AgentSession,
    expectedSession: AgentSession | null,
    sessionConfig?: { mcpServers?: Record<string, McpServerConfig> },
  ): Promise<AgentSession> {
    const owner = this.sessionBackendOwners.get(session);
    if (
      owner
      && (
        owner.generation.state !== "ready"
        || this.backendGeneration !== owner.generation
        || this.backend !== owner.generation.backend
      )
    ) {
      return this.discardGenerationSession(
        owner,
        session,
        `session ${sessionId} from fenced backend generation ${owner.generation.id}`,
      ).then(() => {
        throw owner.generation.fenceError
          ?? new SessionBackendUnavailableError("generation-fenced", owner.generation.id);
      });
    }
    return this.enqueueCache("insert", sessionId, () => {
      const current = this.sessionObjects.get(sessionId);
      const capacityProfile = sessionConfig
        ? this.getCapacityProfile(sessionConfig)
        : expectedSession
          ? this.sessionCapacityProfiles.get(expectedSession)
          : current
            ? this.sessionCapacityProfiles.get(current)
            : undefined;
      this.sessionCapacityProfiles.set(session, capacityProfile ?? { localMcpCount: 0 });
      const accepted = current === undefined
        || current === session
        || (expectedSession !== null && current === expectedSession);
      if (!accepted) {
        this.queueSessionCleanupUnsafe(sessionId, session, "discarding superseded session");
        if (expectedSession !== null && expectedSession !== current && expectedSession !== session) {
          this.queueSessionCleanupUnsafe(
            sessionId,
            expectedSession,
            "discarding superseded cached session",
          );
        }
        return current;
      }

      if (current !== session) {
        this.sessionObjects.delete(sessionId);
        this.sessionObjects.set(sessionId, session);
        this.slashCommandListCache.delete(sessionId);
        if (current) {
          this.queueSessionCleanupUnsafe(sessionId, current, "replacing cached session");
        }
      } else {
        this.sessionObjects.delete(sessionId);
        this.sessionObjects.set(sessionId, session);
      }

      const resumeLease = this.sessionResumeLeases.get(session);
      if (resumeLease) this.ownedSessionResumeLeases.add(resumeLease);
      this.sessionTreeLastActivityAt.set(sessionId, Date.now());
      this.enforceSessionCacheLimitUnsafe(sessionId);
      return session;
    });
  }

  private evictCachedSession(
    sessionId: string,
    expectedSession?: AgentSession,
    reason = "evicting cached session",
  ): Promise<boolean> {
    return this.enqueueCache(
      "evict",
      sessionId,
      () => this.evictCachedSessionUnsafe(sessionId, expectedSession, reason) !== undefined,
    );
  }

  private abandonCachedSession(sessionId: string, expectedSession: AgentSession): Promise<void> {
    return this.enqueueCache("abandon", sessionId, () => {
      const current = this.sessionObjects.get(sessionId);
      if (current === expectedSession) {
        this.evictCachedSessionUnsafe(sessionId, expectedSession, "abandoning cached session");
      } else {
        this.queueSessionCleanupUnsafe(sessionId, expectedSession, "abandoning superseded session");
      }
    });
  }

  private async disposeSession(sessionId: string, session: AgentSession, reason: string): Promise<void> {
    const { cleanup } = await this.enqueueCache("dispose", sessionId, () => {
      this.removeReadySessionUnsafe(sessionId, session);
      return { cleanup: this.queueSessionCleanupUnsafe(sessionId, session, reason) };
    });
    if (!await cleanup) throw new Error(`Session ${sessionId} could not be reaped while ${reason}`);
  }

  private persistLastVisibleActivityAt(sessionId: string, lastVisibleActivityAt?: string): void {
    if (!lastVisibleActivityAt) return;
    try {
      this.deps.sessionMetaStore?.setLastVisibleActivityAt(sessionId, lastVisibleActivityAt);
    } catch (err) {
      console.warn(`[sdk] [${sessionId.slice(0, 8)}] Failed to persist visible activity:`, err);
    }
  }

  private persistLastAttentionAt(sessionId: string, lastAttentionAt?: string): void {
    if (!lastAttentionAt) return;
    try {
      this.deps.sessionMetaStore?.setLastAttentionAt(sessionId, lastAttentionAt);
      this.deps.globalBus.emit({ type: "sessions:changed", sessionId });
    } catch (err) {
      console.warn(`[sdk] [${sessionId.slice(0, 8)}] Failed to persist attention activity:`, err);
    }
  }

  markSessionAttention(sessionId: string, at = new Date().toISOString()): void {
    this.persistLastAttentionAt(sessionId, at);
  }

  private createRunController(
    sessionId: string,
    bus: ReturnType<typeof getOrCreateBus>,
  ): SessionRunController {
    return this.runStateController.createRunController(sessionId, bus);
  }

  private setSessionRunState(
    sessionId: string,
    state: SessionRunState,
    opts: { now?: number; lastEventAt?: number } = {},
  ): void {
    this.runStateController.setSessionRunState(sessionId, state, opts);
  }

  private touchSessionRun(sessionId: string, at = Date.now()): void {
    this.runStateController.touchSessionRun(sessionId, at);
    this.touchSessionTree(sessionId, at);
  }

  private touchSessionTree(sessionId: string, at = Date.now()): void {
    const session = this.sessionObjects.get(sessionId);
    if (!session) return;
    const previous = this.sessionTreeLastActivityAt.get(sessionId) ?? 0;
    this.sessionTreeLastActivityAt.set(sessionId, Math.max(previous, at));
    this.sessionObjects.delete(sessionId);
    this.sessionObjects.set(sessionId, session);
  }

  private getProtectedSessionTreeIds(extraProtectedId?: string): Set<string> {
    const protectedIds = new Set(this.getActiveSessions());
    if (extraProtectedId) protectedIds.add(extraProtectedId);
    for (const sessionId of this.sessionObjects.keys()) {
      if (this.agentRegistry.hasRunningAgents(sessionId)) protectedIds.add(sessionId);
    }
    return protectedIds;
  }

  private isSessionTreeIdleExpired(sessionId: string, now = Date.now()): boolean {
    const lastActivityAt = this.sessionTreeLastActivityAt.get(sessionId);
    return lastActivityAt !== undefined && now - lastActivityAt >= this.sessionCacheIdleTtlMs;
  }

  private getCopilotHome(): string {
    return this.workspaceController.getCopilotHome();
  }

  private getSessionStateDir(sessionId: string): string {
    return this.workspaceController.getSessionStateDir(sessionId);
  }

  private getSessionPlanPath(sessionId: string): string {
    return join(this.getSessionStateDir(sessionId), "plan.md");
  }

  private getSessionEventsPath(sessionId: string): string {
    return join(this.getSessionStateDir(sessionId), "events.jsonl");
  }

  hasPlan(sessionId: string): boolean {
    return existsSync(this.getSessionPlanPath(sessionId));
  }

  private lookupGroupNotes(groupId?: string): { groupName: string; notes: string } | null {
    if (!groupId || !this.deps.taskGroupStore) return null;
    const group = this.deps.taskGroupStore.getGroup(groupId);
    if (!group?.notes?.trim()) return null;
    return { groupName: group.name, notes: group.notes };
  }

  private findLinkedTask(sessionId: string): Task | undefined {
    return this.workspaceController.findLinkedTask(sessionId);
  }

  private resolveEffectiveSessionCwd(opts: { sessionId?: string; task?: Pick<Task, "cwd"> | null }): string | undefined {
    return this.workspaceController.resolveEffectiveSessionCwd(opts);
  }

  private persistSessionWorkspace(sessionId: string, cwd?: string): void {
    this.workspaceController.persistSessionWorkspace(sessionId, cwd);
  }

  setSessionWorkspace(sessionId: string, cwd: string, opts: { allowDuringActiveTurn?: boolean } = {}): {
    cwd: string;
    source: "explicit";
    message: string;
  } {
    return this.workspaceController.setSessionWorkspace(sessionId, cwd, opts);
  }

  resetSessionWorkspace(
    sessionId: string,
    opts: { allowDuringActiveTurn?: boolean; taskCwd?: string; taskId?: string } = {},
  ): {
    cwd: string;
    source: "task-default";
    message: string;
  } {
    return this.workspaceController.resetSessionWorkspace(sessionId, opts);
  }

  private flushPendingSessionEviction(sessionId: string): void {
    if (!this.pendingSessionEvictions.has(sessionId) || this.isSessionBusy(sessionId)) return;
    this.pendingSessionEvictions.delete(sessionId);
    this.scheduleCacheOperation(
      this.evictCachedSession(sessionId, undefined, "flushing pending eviction"),
      `flushing pending eviction for ${sessionId}`,
    );
    this.scheduleCacheOperation(
      this.trimSessionCache("session protection ended"),
      "trimming the session cache after protection ended",
    );
  }

  private markCachedSessionForEviction(sessionId: string, reason: string): void {
    if (!this.sessionObjects.has(sessionId)) return;
    const alreadyPending = this.pendingSessionEvictions.has(sessionId);
    this.pendingSessionEvictions.add(sessionId);
    if (!alreadyPending) {
      console.warn(`[sdk] [${sessionId.slice(0, 8)}] Scheduling cached session refresh after ${reason}`);
    }
    this.flushPendingSessionEviction(sessionId);
  }

  /**
   * Defer a cached-session eviction until the current run fully completes.
   *
   * Unlike {@link markCachedSessionForEviction}, this does NOT attempt an
   * immediate flush. The eviction is queued in {@link pendingSessionEvictions}
   * and drained by the run controller's `.finally()` hook in `SessionRunner`,
   * which only fires after `setSessionRunState(sessionId, "idle")`. This
   * closes a race where a mid-turn MCP status flip (e.g. `connected → not_configured`)
   * could otherwise drop the cached `AgentSession` while the SDK was still
   * persisting the in-flight turn's `fc_call_*` items to disk, causing the
   * next resume to re-write duplicate items (manifesting as upstream
   * `CAPIError: 400 Duplicate item found`).
   */
  private deferMcpStatusSessionEviction(sessionId: string, reason: string): void {
    if (!this.sessionObjects.has(sessionId)) return;
    const alreadyPending = this.pendingSessionEvictions.has(sessionId);
    this.pendingSessionEvictions.add(sessionId);
    if (!alreadyPending) {
      console.warn(`[sdk] [${sessionId.slice(0, 8)}] Deferring cached session refresh until run completion: ${reason}`);
    }
  }

  private syncRestartWaitingIfPending(): void {
    if (isRestartPending()) {
      syncRestartWaitingSessions(this.getActiveSessions().length);
    }
  }

  private async beginSessionResume(
    sessionId: string,
    sessionConfig: { mcpServers?: Record<string, McpServerConfig> },
    options: {
      isCancelled?: () => boolean;
      reserveCachedSession?: boolean;
      trackResuming?: boolean;
    } = {},
  ): Promise<SessionResumeLease | null> {
    const generation = this.backend ? this.getCurrentBackendGeneration() : null;
    const tracksResuming = options.trackResuming !== false;
    const lease: SessionResumeLease = {
      sessionId,
      token: Symbol(sessionId),
      backendGeneration: generation?.id ?? 0,
      tracksResuming,
    };
    if (this.sessionObjects.has(sessionId) && !options.reserveCachedSession) {
      if (generation) this.assertBackendGenerationReady(generation);
      this.touchSessionTree(sessionId);
      if (tracksResuming) {
        this.resumingSessions.set(sessionId, (this.resumingSessions.get(sessionId) ?? 0) + 1);
        this.syncRestartWaitingIfPending();
      }
      return lease;
    }
    const admitted = await this.waitForSessionCapacity(sessionConfig, {
      isCancelled: options.isCancelled,
      assertAdmission: generation
        ? () => this.assertBackendGenerationReady(generation)
        : undefined,
      reserve: (reservation) => {
        this.resumingCapacityReservations.set(lease.token, reservation);
        this.touchSessionTree(sessionId);
        if (tracksResuming) {
          this.resumingSessions.set(sessionId, (this.resumingSessions.get(sessionId) ?? 0) + 1);
          this.syncRestartWaitingIfPending();
        }
      },
    });
    return admitted ? lease : null;
  }

  private endSessionResume(lease: SessionResumeLease): void {
    const { sessionId } = lease;
    const reservation = this.resumingCapacityReservations.get(lease.token);
    const released = this.resumingCapacityReservations.delete(lease.token);
    if (
      released
      && reservation
      && this.ownedSessionResumeLeases.has(lease)
      && this.backendGeneration?.id === lease.backendGeneration
      && this.backendGeneration.state === "ready"
      && this.backend === this.backendGeneration.backend
    ) {
      this.retainSettledProcessReservation(lease.backendGeneration, reservation);
    }
    this.ownedSessionResumeLeases.delete(lease);
    if (lease.tracksResuming) {
      const count = this.resumingSessions.get(sessionId) ?? 0;
      if (count <= 1) {
        this.resumingSessions.delete(sessionId);
      } else {
        this.resumingSessions.set(sessionId, count - 1);
      }
      this.syncRestartWaitingIfPending();
    }
    this.notifySessionCapacityChanged();
    this.scheduleCacheOperation(
      this.trimSessionCache("session resume ended"),
      "trimming the session cache after a resume",
    );
  }

  private isSessionResuming(sessionId: string): boolean {
    return (this.resumingSessions.get(sessionId) ?? 0) > 0;
  }

  private handleUserInputRequest(
    request: NativeUserInputRequest,
    invocation: { sessionId: string },
  ): Promise<NativeUserInputResponse> {
    return this.userInputController.requestUserInput(invocation.sessionId, request);
  }

  private handleElicitationRequest(
    request: NativeElicitationRequest,
  ): Promise<NativeElicitationResult> {
    return this.elicitationController.requestElicitation(request);
  }

  private cancelPendingUserInputRequests(
    sessionId: string,
    reason: UserInputCancelReason,
    message?: string,
  ): void {
    this.userInputController.cancelPendingSessionRequests(sessionId, reason, message);
    this.elicitationController.cancelPendingSessionRequests(sessionId, reason, message);
  }

  private cancelAllPendingUserInputRequests(reason: UserInputCancelReason, message?: string): void {
    this.userInputController.cancelAllPendingRequests(reason, message);
    this.elicitationController.cancelAllPendingRequests(reason, message);
  }

  private getPendingInteractionCount(sessionId: string): number {
    return this.userInputController.getPendingCount(sessionId)
      + this.elicitationController.getPendingCount(sessionId);
  }

  private touchUserInputActivity(sessionId: string, timestamp?: string): void {
    const parsed = timestamp ? Date.parse(timestamp) : Number.NaN;
    this.touchSessionRun(sessionId, Number.isFinite(parsed) ? parsed : Date.now());
  }

  private buildSessionConfig(opts: SessionConfigOptions = {}) {
    const nativeBridgeTools = this.resolveNativeBridgeTools();
    const modelMetadata = opts.modelMetadata ?? this.modelMetadataForContextTiers;
    const cfg = buildSessionConfigWithDeps({
      deps: {
        ...this.deps,
        nativeBridgeTools,
        permissionPolicy: this.backend?.permissionPolicy,
      },
      options: {
        ...opts,
        modelMetadata,
      },
      callbacks: {
        resolveEffectiveSessionCwd: (cwdOpts) => this.resolveEffectiveSessionCwd(cwdOpts),
        getCopilotHome: () => this.getCopilotHome(),
        handleUserInputRequest: (request, invocation) => this.handleUserInputRequest(request, invocation),
        handleElicitationRequest: (request) => this.handleElicitationRequest(request),
      },
    });
    if (opts.forResume && opts.sessionId) {
      const persistedState = this.readPersistedSessionModelState(opts.sessionId);
      const modelCapabilities = this.resolvePersistedModelCapabilities(persistedState, modelMetadata);
      if (modelCapabilities) {
        cfg.modelCapabilities = modelCapabilities;
      }
    }
    return cfg;
  }

  private shouldUseNativeBridgeTools(): boolean {
    return Boolean(
      this.deps.bridgeToolsMcpServer
        && this.backend?.capabilities.nativeBridgeTools
        && this.backend.capabilities.eagerNativeTools,
    );
  }

  private eligibleNativeBridgeToolDefinitions(): BridgeToolDefinition[] {
    return this.deps.bridgeToolsMcpServer
      ?.getToolDefinitions("all")
      .filter((tool) => !BRIDGE_EXCLUDED_TOOLS.includes(tool.name)) ?? [];
  }

  private resolveNativeBridgeTools(): BridgeNativeTool[] | undefined {
    if (!this.shouldUseNativeBridgeTools()) return undefined;
    const definitions = this.eligibleNativeBridgeToolDefinitions();
    if (definitions.length === 0) return undefined;
    return createNativeBridgeTools(definitions);
  }

  private async loadModelMetadataForContextTiers(
    client = this.getBackend(),
    options: { refresh?: boolean } = {},
  ): Promise<readonly CopilotModelContextMetadata[] | undefined> {
    if (!options.refresh && this.modelMetadataForContextTiers) {
      return this.modelMetadataForContextTiers;
    }
    const listModels = (client as { listModels?: unknown }).listModels;
    if (typeof listModels !== "function") {
      return this.modelMetadataForContextTiers;
    }
    try {
      const models = await listModels.call(client);
      this.modelMetadataForContextTiers = models as readonly CopilotModelContextMetadata[];
      return this.modelMetadataForContextTiers;
    } catch (error) {
      console.warn(
        "[sdk] Failed to load model metadata for context-tier configuration:",
        error instanceof Error ? error.message : String(error),
      );
      return this.modelMetadataForContextTiers;
    }
  }

  private resolveModelContextTier(
    modelId: string,
    requestedContextTier?: string,
    modelMetadata = this.modelMetadataForContextTiers,
  ): { contextTier?: CopilotContextTier; modelCapabilities?: Record<string, unknown> } {
    const model = modelMetadata?.find((candidate) => candidate.id === modelId);
    const contextTier = resolveContextTierForModel(model, normalizeCopilotContextTier(requestedContextTier));
    return {
      ...(contextTier ? { contextTier } : {}),
      ...(contextTier
        ? { modelCapabilities: getModelCapabilitiesOverrideForContextTier(model, contextTier) as Record<string, unknown> | undefined }
        : {}),
    };
  }

  private resolvePersistedModelCapabilities(
    state: PersistedSessionModelState,
    modelMetadata = this.modelMetadataForContextTiers,
  ): Record<string, unknown> | undefined {
    if (state.modelCapabilities) return state.modelCapabilities;
    if (!state.model || !state.contextTier) return undefined;
    return this.resolveModelContextTier(state.model, state.contextTier, modelMetadata).modelCapabilities;
  }

  private persistSessionModelState(
    sessionId: string,
    state: DerivedModelState & { modelCapabilities?: Record<string, unknown> },
  ): void {
    try {
      writePersistedSessionModelState(this.getSessionStateDir(sessionId), state);
    } catch (error) {
      console.warn(
        `[sdk] [${sessionId.slice(0, 8)}] Failed to persist Bridge model state: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private readPersistedSessionModelState(sessionId: string): PersistedSessionModelState {
    return readPersistedSessionModelState(this.getSessionStateDir(sessionId));
  }

  private async warmNativeBridgeTools(sessionId: string, session: AgentSession): Promise<void> {
    if (!this.shouldUseNativeBridgeTools() || !this.backend?.capabilities.toolMetadataWarmup) return;
    if (typeof session.initializeTools !== "function") return;
    const expectedTools = this.eligibleNativeBridgeToolDefinitions().map((tool) => tool.name);
    try {
      await session.initializeTools();
      const metadata = typeof session.getCurrentToolMetadata === "function"
        ? await session.getCurrentToolMetadata()
        : undefined;
      const tools = metadata?.tools ?? [];
      if (tools.length === 0) return;
      const toolNames = new Set(tools.map((tool) => tool.name));
      const missing = expectedTools.filter((name) => !toolNames.has(name));
      const deferred = tools
        .filter((tool) => expectedTools.includes(tool.name) && tool.deferLoading === true)
        .map((tool) => tool.name);
      const sid = sessionId.slice(0, 8);
      if (missing.length > 0 || deferred.length > 0) {
        console.warn(
          `[sdk] [${sid}] Native Bridge tool warmup incomplete: ${
            missing.length > 0 ? `missing=${missing.join(", ")}` : "missing=none"
          }; ${deferred.length > 0 ? `deferred=${deferred.join(", ")}` : "deferred=none"}`,
        );
      } else {
        console.log(`[sdk] [${sid}] Native Bridge tools ready (${expectedTools.length} canonical tools)`);
      }
    } catch (error) {
      console.warn(
        `[sdk] [${sessionId.slice(0, 8)}] Native Bridge tool warmup failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private createBackend(): AgentBackend {
    return this.deps.createBackend?.() ?? createAgentBackend({ kind: "copilot", clientEnv: this.deps.clientEnv });
  }

  private createBackendGeneration(backend: AgentBackend): BackendGeneration {
    let signalFence!: (error: SessionBackendUnavailableError) => void;
    const fenceSignal = new Promise<SessionBackendUnavailableError>((resolve) => {
      signalFence = resolve;
    });
    const generation: BackendGeneration = {
      id: ++this.backendGenerationCounter,
      backend,
      state: "ready",
      fenceSignal,
      signalFence,
      recoveryStarted: false,
    };
    this.backendGenerations.set(generation.id, generation);
    return generation;
  }

  private getCurrentBackendGeneration(): BackendGeneration {
    if (this.backendRotation) {
      throw new Error("Copilot SDK client refresh is in progress; try again shortly");
    }
    if (this.backendGeneration?.state === "fenced") {
      throw this.backendGeneration.fenceError
        ?? new SessionBackendUnavailableError("generation-fenced", this.backendGeneration.id);
    }
    if (!this.backend) throw new Error("SessionManager not initialized");
    if (!this.backendGeneration || this.backendGeneration.backend !== this.backend) {
      this.backendGeneration = this.createBackendGeneration(this.backend);
    }
    return this.backendGeneration;
  }

  private assertBackendGenerationReady(generation: BackendGeneration): void {
    if (
      generation.state !== "ready"
      || this.backendGeneration !== generation
      || this.backend !== generation.backend
    ) {
      throw generation.fenceError
        ?? new SessionBackendUnavailableError("generation-fenced", generation.id);
    }
  }

  private async discardGenerationSession(
    owner: BackendSessionOwner,
    session: AgentSession,
    reason: string,
  ): Promise<void> {
    try {
      await session.disconnect?.();
    } catch (error) {
      console.warn(`[sdk] Failed to disconnect ${reason}:`, error);
    }
    if (owner.deleteOnDiscard) {
      try {
        await owner.generation.backend.deleteSession(session.sessionId);
      } catch (error) {
        console.warn(`[sdk] Failed to delete ${reason} via backend generation ${owner.generation.id}:`, error);
      }
    }
  }

  private async runBackendSessionOperation(
    generation: BackendGeneration,
    kind: "create" | "resume",
    start: () => Promise<AgentSession>,
    timeoutMs: number,
    deleteOnDiscard: boolean,
  ): Promise<AgentSession> {
    this.assertBackendGenerationReady(generation);
    let operation: Promise<AgentSession>;
    try {
      operation = Promise.resolve(start());
    } catch (error) {
      operation = Promise.reject(error);
    }
    let abandoned = false;
    const owner = { generation, deleteOnDiscard };
    let discardPromise: Promise<void> | undefined;
    const discardOnce = (session: AgentSession, reason: string): Promise<void> => {
      discardPromise ??= this.discardGenerationSession(owner, session, reason);
      return discardPromise;
    };
    void operation.then(
      (session) => {
        if (
          abandoned
          || generation.state !== "ready"
          || this.backendGeneration !== generation
          || this.backend !== generation.backend
        ) {
          void discardOnce(session, `late ${kind} session ${session.sessionId}`);
        }
      },
      () => {
        // Promise.race observes the rejection; this observer owns late settlement.
      },
    );
    const fenced = generation.fenceSignal.then<never>((error) => {
      throw error;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new SessionBackendUnavailableError(
          kind === "create" ? "create-timeout" : "resume-timeout",
          generation.id,
        );
        this.fenceBackendGeneration(generation, error);
        reject(error);
      }, timeoutMs);
      timer.unref?.();
    });
    try {
      const session = await Promise.race([operation, fenced, timedOut]);
      if (
        generation.state !== "ready"
        || this.backendGeneration !== generation
        || this.backend !== generation.backend
      ) {
        abandoned = true;
        await discardOnce(session, `fenced ${kind} session ${session.sessionId}`);
        throw generation.fenceError
          ?? new SessionBackendUnavailableError("generation-fenced", generation.id);
      }
      this.sessionBackendOwners.set(session, owner);
      return session;
    } catch (error) {
      abandoned = true;
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async createBackendSession(
    sessionConfig: { mcpServers?: Record<string, McpServerConfig>; sessionId?: string },
    options: {
      kind: "normal" | "task" | "title-helper";
      expectedSessionId?: string;
      trackDisposableOwner?: boolean;
    },
  ): Promise<{ session: AgentSession; generation: BackendGeneration; lease: SessionCreationLease }> {
    const generation = this.getCurrentBackendGeneration();
    const lease = await this.beginSessionCreation(sessionConfig, generation);
    let leaseTransferred = false;
    try {
      const session = await this.runBackendSessionOperation(
        generation,
        "create",
        () => generation.backend.createSession(sessionConfig),
        this.sessionCreateTimeoutMs,
        true,
      );
      if (options.expectedSessionId && session.sessionId !== options.expectedSessionId) {
        await this.discardGenerationSession(
          { generation, deleteOnDiscard: true },
          session,
          `mismatched ${options.kind} session ${session.sessionId}`,
        );
        throw new Error(
          `Agent backend returned session ${session.sessionId} instead of requested Bridge session ${options.expectedSessionId}`,
        );
      }
      if (options.trackDisposableOwner) {
        this.disposableSessionOwners.set(session.sessionId, generation);
      }
      leaseTransferred = true;
      return { session, generation, lease };
    } finally {
      if (!leaseTransferred) this.endSessionCreation(lease);
    }
  }

  private async resumeBackendSession(
    sessionId: string,
    sessionConfig: { mcpServers?: Record<string, McpServerConfig> },
    lease?: SessionResumeLease,
  ): Promise<AgentSession> {
    const generation = lease
      ? this.backendGenerations.get(lease.backendGeneration)
      : this.getCurrentBackendGeneration();
    if (!generation) {
      throw new SessionBackendUnavailableError("generation-fenced", lease?.backendGeneration ?? 0);
    }
    const session = await this.runBackendSessionOperation(
      generation,
      "resume",
      () => generation.backend.resumeSession(sessionId, sessionConfig),
      this.sessionResumeTimeoutMs,
      false,
    );
    if (lease) this.sessionResumeLeases.set(session, lease);
    return session;
  }

  private async deleteDisposableSession(sessionId: string): Promise<void> {
    const generation = this.disposableSessionOwners.get(sessionId);
    try {
      const backend = generation?.backend ?? this.getBackend();
      await backend.deleteSession(sessionId);
    } finally {
      this.disposableSessionOwners.delete(sessionId);
    }
  }

  private fenceBackendGeneration(
    generation: BackendGeneration,
    error: SessionBackendUnavailableError,
  ): void {
    if (generation.state === "fenced") return;
    const isCurrent = this.backendGeneration === generation
      && this.backend === generation.backend;
    generation.state = "fenced";
    generation.fenceError = error;
    generation.signalFence(error);
    if (!isCurrent) {
      console.warn(`[sdk] Fenced stale backend generation ${generation.id}: ${error.message}`);
      return;
    }
    this.creatingCapacityReservations.clear();
    this.resumingCapacityReservations.clear();
    this.resumingSessions.clear();
    this.notifySessionCapacityChanged();
    console.error(`[sdk] Fenced backend generation ${generation.id}: ${error.message}`);
    if (!generation.recoveryStarted) {
      generation.recoveryStarted = true;
      const recovery = this.recoverBackendGeneration(generation);
      this.backendRecovery = recovery;
      void recovery.then(
        () => {
          if (this.backendRecovery === recovery) this.backendRecovery = null;
        },
        (recoveryError) => {
          if (this.backendRecovery === recovery) this.backendRecovery = null;
          this.requestRestartForBackendRecovery(generation, recoveryError);
        },
      );
    }
  }

  private async invalidateFencedBackendSessions(): Promise<void> {
    const cleanups = await this.enqueueCache("backend-fence", undefined, () => {
      const scheduled: Promise<boolean>[] = [];
      for (const [sessionId] of this.sessionObjects) {
        const cleanup = this.evictCachedSessionUnsafe(
          sessionId,
          undefined,
          "invalidating a fenced backend generation",
        );
        if (cleanup) scheduled.push(cleanup);
      }
      this.pendingSessionEvictions.clear();
      return scheduled;
    });
    await Promise.allSettled(cleanups);
  }

  private async forceStopBackendWithinDeadline(backend: AgentBackend, context: string): Promise<void> {
    if (typeof backend.forceStop !== "function") return;
    const outcome = await settleByDeadline(
      () => backend.forceStop!(),
      createDeadline(this.backendRecoveryStopTimeoutMs),
    );
    if (outcome.status !== "fulfilled") {
      console.error(
        `[sdk] ${context} force stop ${outcome.status === "timed-out" ? "timed out" : "failed"}:`,
        outcome.status === "rejected" ? outcome.error : "",
      );
    }
  }

  private requestRestartForBackendRecovery(generation: BackendGeneration, cause: unknown): void {
    console.error(`[sdk] Backend generation ${generation.id} recovery requires a full Bridge restart:`, cause);
    triggerRestartPendingForExternalRequest(this.getActiveSessions().length);
    const dataDir = this.deps.runtimePaths?.dataDir;
    if (!dataDir) {
      console.error("[sdk] Backend recovery could not write restart.signal because runtime paths are unavailable");
      return;
    }
    try {
      mkdirSync(dataDir, { recursive: true });
      writeRestartSignalFile(join(dataDir, "restart.signal"), {
        validationMode: "operational",
        source: "backend_session_recovery",
      });
    } catch (error) {
      console.error("[sdk] Backend recovery failed to write restart.signal:", error);
    }
  }

  private async recoverBackendGeneration(generation: BackendGeneration): Promise<void> {
    await this.invalidateFencedBackendSessions();
    const stopOutcome = await settleByDeadline(
      () => generation.backend.stop(),
      createDeadline(this.backendRecoveryStopTimeoutMs),
    );
    const stopFailure = stopOutcome.status === "rejected"
      ? stopOutcome.error
      : stopOutcome.status === "timed-out"
        ? "backend stop verification timed out"
        : getBackendStopErrors(stopOutcome.value);
    if (stopFailure !== undefined) {
      await this.forceStopBackendWithinDeadline(generation.backend, "Backend recovery");
      this.requestRestartForBackendRecovery(generation, stopFailure);
      return;
    }
    if (
      this.shuttingDown
      || this.backendGeneration !== generation
      || this.backend !== generation.backend
    ) return;

    this.clearSettledProcessReservationsForGeneration(generation.id);
    this.backend = null;
    this.backendCreatedAtMs = null;
    let nextBackend: AgentBackend;
    try {
      nextBackend = this.createBackend();
    } catch (error) {
      this.requestRestartForBackendRecovery(generation, error);
      return;
    }
    if (this.shuttingDown || this.backendGeneration !== generation) return;
    const startOutcome = await settleByDeadline(
      () => nextBackend.start(),
      createDeadline(this.backendRecoveryStartTimeoutMs),
    );
    if (startOutcome.status !== "fulfilled") {
      await this.forceStopBackendWithinDeadline(nextBackend, "Backend recovery replacement");
      this.requestRestartForBackendRecovery(
        generation,
        startOutcome.status === "rejected" ? startOutcome.error : "replacement backend start timed out",
      );
      return;
    }
    if (this.shuttingDown || this.backendGeneration !== generation) {
      await this.forceStopBackendWithinDeadline(nextBackend, "Backend recovery replacement");
      return;
    }
    const nextGeneration = this.createBackendGeneration(nextBackend);
    this.backend = nextBackend;
    this.backendGeneration = nextGeneration;
    this.backendCreatedAtMs = Date.now();
    console.log(`[sdk] Recovered Copilot backend as generation ${nextGeneration.id}`);
  }

  private forceStopTimedOutBackend(backend: AgentBackend, context: string): void {
    if (typeof backend.forceStop !== "function") return;
    try {
      void backend.forceStop().catch((error) => {
        console.error(`[sdk] Model refresh backend rotation timed out while ${context}; force stop failed:`, error);
      });
    } catch (error) {
      console.error(`[sdk] Model refresh backend rotation timed out while ${context}; force stop failed:`, error);
    }
  }

  private getBackend(): AgentBackend {
    if (this.backendRotation) {
      throw new Error("Copilot SDK client refresh is in progress; try again shortly");
    }
    return this.getCurrentBackendGeneration().backend;
  }

  private async getBackendAfterRotation(): Promise<AgentBackend> {
    if (this.backendRotation) {
      await this.backendRotation;
    }
    return this.getCurrentBackendGeneration().backend;
  }

  private async rotateBackendForModelRefresh(): Promise<AgentBackend> {
    if (this.backendRotation) {
      return this.backendRotation;
    }
    if (this.backendGeneration?.state === "fenced") {
      throw this.backendGeneration.fenceError
        ?? new SessionBackendUnavailableError("generation-fenced", this.backendGeneration.id);
    }

    const activeSessions = this.getActiveSessions().length
      + this.creatingCapacityReservations.size
      + this.resumingCapacityReservations.size;
    if (activeSessions > 0) {
      throw new ModelRefreshBlockedError(activeSessions);
    }

    const previousBackend = this.backend;
    if (!previousBackend) throw new Error("SessionManager not initialized");
    const previousGeneration = this.getCurrentBackendGeneration();

    // Set backendRotation synchronously before the first await so concurrent
    // callers (e.g. listModels) join this rotation rather than starting a new one.
    // Eviction is moved inside the rotation body to preserve ordering: sessions
    // are drained before the backend stops.
    const rotation = Promise.resolve().then(async () => {
      await this.evictAllCachedSessions();
      console.log("[sdk] Rotating agent backend for model refresh...");
      this.backend = null;
      let stopResult: unknown;
      try {
        stopResult = await withModelRefreshClientRotationTimeout(
          MODEL_REFRESH_CLIENT_ROTATION_OPERATIONS.stopPrevious,
          previousBackend.stop(),
        );
      } catch (error) {
        if (isModelRefreshClientRotationTimeoutError(error)) {
          this.backend = null;
          this.backendCreatedAtMs = null;
          this.forceStopTimedOutBackend(previousBackend, "stopping the previous client");
        } else {
          this.backend = previousBackend;
        }
        throw error;
      }
      const stopErrors = getBackendStopErrors(stopResult);
      if (stopErrors) {
        this.backendCreatedAtMs = null;
        await this.forceStopBackendWithinDeadline(previousBackend, "Model refresh");
        throw new Error(
          `Agent backend model-refresh rotation returned ${stopErrors.length} stop error(s); shutdown was not verified.`,
          { cause: stopErrors },
        );
      }
      this.clearSettledProcessReservationsForGeneration(previousGeneration.id);

      const nextClient = this.createBackend();
      try {
        await withModelRefreshClientRotationTimeout(
          MODEL_REFRESH_CLIENT_ROTATION_OPERATIONS.startNext,
          nextClient.start(),
        );
      } catch (error) {
        if (isModelRefreshClientRotationTimeoutError(error)) {
          this.forceStopTimedOutBackend(nextClient, "starting the refreshed client");
        }
        try {
          await withModelRefreshClientRotationTimeout(
            MODEL_REFRESH_CLIENT_ROTATION_OPERATIONS.restorePrevious,
            previousBackend.start(),
          );
          this.backend = previousBackend;
          console.warn("[sdk] Model refresh backend rotation failed; restored previous agent backend");
        } catch (restoreError) {
          this.backend = null;
          this.backendCreatedAtMs = null;
          console.error("[sdk] Model refresh backend rotation failed and previous agent backend could not be restored:", restoreError);
          if (isModelRefreshClientRotationTimeoutError(restoreError)) {
            this.forceStopTimedOutBackend(previousBackend, "restoring the previous client");
            throw restoreError;
          }
        }
        throw error;
      }
      this.backend = nextClient;
      this.backendGeneration = this.createBackendGeneration(nextClient);
      this.backendCreatedAtMs = Date.now();
      console.log("[sdk] Agent backend rotated for model refresh");
      return nextClient;
    });

    this.backendRotation = rotation;
    try {
      return await rotation;
    } finally {
      if (this.backendRotation === rotation) {
        this.backendRotation = null;
      }
    }
  }

  async initialize(): Promise<void> {
    console.log("[sdk] Initializing agent backend...");
    configureRestartActiveSessionCountProvider(() => this.getActiveSessions().length);
    this.backend = this.createBackend();
    await this.backend.start();
    this.backendGeneration = this.createBackendGeneration(this.backend);
    this.backendCreatedAtMs = Date.now();
    console.log("[sdk] Agent backend ready");
    this.sweepLeakedDisposableTitleSessions();
    void this.migrateLegacySessionTitles().catch((error) => {
      console.warn(`[sdk] Legacy session title migration failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private sweepLeakedDisposableTitleSessions(): void {
    const start = Date.now();
    try {
      const sweptIds = sweepLeakedCliSessionStoreRows({
        copilotHome: this.getCopilotHome(),
        idPrefix: DISPOSABLE_TITLE_SESSION_ID_PREFIX,
        cutoffTimestampMs: this.processStartedAtMs - SessionManager.DISPOSABLE_TITLE_SWEEP_GRACE_MS,
      });
      this.recordSpan("session.name.cleanupSweep", Date.now() - start, undefined, {
        result: "ok",
        count: sweptIds.length,
      });
      if (sweptIds.length > 0) {
        console.warn(`[sdk] Cleaned up ${sweptIds.length} leaked disposable title session row(s)`);
      }
    } catch (error) {
      this.recordSpan("session.name.cleanupSweep", Date.now() - start, undefined, {
        result: "error",
        error: error instanceof Error ? error.message : String(error),
      });
      console.warn(`[sdk] Disposable title session sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async listSessions() {
    const client = await this.getBackendAfterRotation();

    const now = Date.now();
    if (this.sessionListCache && (now - this.sessionListCache.timestamp) < SessionManager.SESSION_LIST_TTL) {
      return this.sessionListCache.data;
    }

    const t0 = Date.now();
    const sessions = await client.listSessions();
    this.recordSpan("session.listSessions", Date.now() - t0);
    this.sessionListCache = { data: sessions, timestamp: Date.now() };
    return sessions;
  }

  /** List available models from the Copilot SDK */
  async listModels() {
    const client = await this.getBackendAfterRotation();
    const t0 = Date.now();
    const models = await client.listModels();
    this.modelMetadataForContextTiers = models as readonly CopilotModelContextMetadata[];
    this.recordSpan("session.listModels", Date.now() - t0);
    return models;
  }

  /**
   * ISO timestamp of when the current agent backend (SDK/CLI client) object was
   * created — either at startup or the last successful model-refresh rotation.
   * Returns null when no usable backend is currently active.
   */
  getBackendCreatedAt(): string | null {
    return this.backendCreatedAtMs == null
      ? null
      : new Date(this.backendCreatedAtMs).toISOString();
  }

  async refreshModels(): Promise<ModelRefreshResult> {
    const t0 = Date.now();
    const client = await this.rotateBackendForModelRefresh();
    const models = await client.listModels();
    this.modelMetadataForContextTiers = models as readonly CopilotModelContextMetadata[];
    this.recordSpan("session.refreshModels", Date.now() - t0, undefined, {
      count: Array.isArray(models) ? models.length : undefined,
    });
    return {
      models,
      refreshed: true,
      activeSessions: 0,
      refreshedAt: new Date().toISOString(),
      clientCreatedAt: this.getBackendCreatedAt(),
    };
  }

  /**
   * Fast session listing — reads workspace.yaml from disk instead of SDK RPC.
   * ~170ms for 4000+ sessions vs ~2500ms for SDK listSessions.
   * Async to avoid blocking the event loop during filesystem I/O.
   */
  async listSessionsFromDisk(options: { includeArchived?: boolean } = {}): Promise<any[]> {
    const includeArchived = options.includeArchived ?? true;
    const cacheKey = includeArchived ? "all" : "active";
    const now = Date.now();
    const cached = this.sessionDiskListCache.get(cacheKey);
    if (
      cached
      && cached.generation === this.sessionDiskListCacheGeneration
      && (now - cached.timestamp) < SessionManager.SESSION_DISK_LIST_TTL
    ) {
      this.recordSpan("session.listFromDisk.cache", 0, undefined, {
        result: "hit",
        includeArchived,
        count: cached.data.length,
      });
      return cached.data;
    }

    const existingBuild = this.sessionDiskListBuilds.get(cacheKey);
    if (existingBuild?.generation === this.sessionDiskListCacheGeneration) {
      const tWait = Date.now();
      const sessions = await existingBuild.promise;
      this.recordSpan("session.listFromDisk.cache", Date.now() - tWait, undefined, {
        result: "coalesced",
        includeArchived,
        count: sessions.length,
      });
      return sessions;
    }

    this.recordSpan("session.listFromDisk.cache", 0, undefined, {
      result: cached ? "stale" : "miss",
      includeArchived,
    });
    const generation = this.sessionDiskListCacheGeneration;
    const resolveEffectiveSessionCwdFromWorkspaceYaml = this.workspaceController.createWorkspaceYamlCwdResolver();
    const build = listSessionsFromDiskWithDeps({
      copilotHome: this.deps.copilotHome,
      sessionMetaStore: this.deps.sessionMetaStore,
      eventBusRegistry: this.deps.eventBusRegistry,
      resolveEffectiveSessionCwdFromWorkspaceYaml,
      recordSpan: (name, duration, sessionId, metadata) => this.recordSpan(name, duration, sessionId, metadata),
      persistLastVisibleActivityAt: (sessionId, lastVisibleActivityAt) =>
        this.persistLastVisibleActivityAt(sessionId, lastVisibleActivityAt),
    }, { includeArchived }).then((sessions) => {
      if (generation === this.sessionDiskListCacheGeneration) {
        this.sessionDiskListCache.set(cacheKey, {
          data: sessions,
          timestamp: Date.now(),
          generation,
        });
      }
      return sessions;
    }).finally(() => {
      const currentBuild = this.sessionDiskListBuilds.get(cacheKey);
      if (currentBuild?.promise === build) {
        this.sessionDiskListBuilds.delete(cacheKey);
      }
    });
    this.sessionDiskListBuilds.set(cacheKey, { generation, promise: build });
    return build;
  }

  /** Invalidate the listSessions cache (call after create/delete) */
  invalidateSessionListCache(reason = "unknown"): void {
    const cacheKeys = [...this.sessionDiskListCache.keys()];
    const buildKeys = [...this.sessionDiskListBuilds.keys()];
    this.sessionListCache = null;
    this.sessionDiskListCache.clear();
    this.sessionDiskListBuilds.clear();
    this.sessionDiskListCacheGeneration += 1;
    this.recordSpan("session.listFromDisk.invalidate", 0, undefined, {
      reason,
      generation: this.sessionDiskListCacheGeneration,
      cacheKeys,
      buildKeys,
    });
  }

  private emitSessionNameChanged(sessionId: string, name: string): void {
    this.deps.eventBusRegistry.getBus(sessionId)?.emit({ type: "title_changed", title: name });
    this.deps.globalBus.emit({ type: "session:title", sessionId, title: name });
    this.invalidateSessionListCache("session:name");
  }

  private async withSessionNameRpc<T>(sessionId: string, operation: (session: any) => Promise<T>): Promise<T> {
    const cachedSession = this.sessionObjects.get(sessionId);
    if (cachedSession) return operation(cachedSession);

    if (!this.isSessionStatePathSegment(sessionId)) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const sessionConfig = buildSessionNameResumeConfig(this.backend?.permissionPolicy);
    const resumeLease = await this.beginSessionResume(sessionId, sessionConfig);
    if (!resumeLease) throw new Error("Session name resume cancelled before admission");
    let session: any | undefined;
    try {
      session = await this.resumeBackendSession(sessionId, sessionConfig, resumeLease);
      this.trackSessionCapacityProfile(session, sessionConfig);
      return await operation(session);
    } finally {
      if (session) {
        try {
          await this.disposeSession(sessionId, session, "closing temporary session-name RPC");
        } catch (error) {
          console.warn(`[sdk] [${sessionId.slice(0, 8)}] Temporary session-name cleanup failed:`, error);
        }
      }
      this.endSessionResume(resumeLease);
      this.flushPendingSessionEviction(sessionId);
    }
  }

  async getSessionName(sessionId: string): Promise<string | undefined> {
    return this.sessionNameRpc.getSessionName(sessionId);
  }

  async setSessionName(sessionId: string, name: string, opts: SetSessionNameOptions = {}): Promise<void> {
    await this.sessionNameRpc.setSessionName(sessionId, name, opts);
  }

  maybeAutoNameSession(
    sessionId: string,
    options: { session?: any; userMessages?: string[] } = {},
  ): void {
    this.sessionNameAutogenerator.maybeAutoNameSession(sessionId, options);
  }

  async migrateLegacySessionTitles(): Promise<void> {
    await migrateLegacySessionTitlesWithDeps({
      sessionTitles: this.deps.sessionTitles,
      hasSessionOnDisk: (sessionId) => this.hasKnownPersistedSession(sessionId),
      readSessionNameFromWorkspace: (sessionId) => this.sessionNameRpc.readSessionNameFromWorkspace(sessionId),
      setSessionName: (sessionId, name, opts) => this.setSessionName(sessionId, name, opts),
      invalidateSessionListCache: (reason) => this.invalidateSessionListCache(reason),
      logger: console,
    });
  }

  async getSessionMetadata(sessionId: string) {
    const client = this.getBackend();
    return client.getSessionMetadata(sessionId);
  }

  /** Probe MCP server status via SDK RPC (fire-and-forget, updates mcpStatus map) */
  private probeMcpStatus(sessionId: string, session: AgentSession): void {
    const list = session.listMcpServers;
    if (typeof list !== "function") return;
    void list.call(session)
      .then((result) => {
        if (result?.servers) {
          const servers: McpServerStatus[] = result.servers.map((s) => ({
            name: s.name,
            status: coerceMcpServerStatus(s.status),
            error: typeof s.error === "string" ? s.error : undefined,
            source: typeof s.source === "string" ? s.source : undefined,
          }));
          this.mcpStatus.set(sessionId, servers);
          const sid = sessionId.slice(0, 8);
          console.log(`[sdk] [${sid}] 🔌 MCP probe: ${servers.map((s) => `${s.name}=${s.status}`).join(", ")}`);
        }
      })
      .catch(() => { /* best-effort */ });
  }

  private cacheResumedSession(
    sessionId: string,
    session: AgentSession,
    sessionConfig?: { mcpServers?: Record<string, McpServerConfig> },
  ): Promise<AgentSession> {
    return this.cacheSession(sessionId, session, null, sessionConfig).then((cachedSession) => {
      if (cachedSession === session) {
        void this.warmNativeBridgeTools(sessionId, session);
        this.maybeAutoNameSession(sessionId, { session });
      }
      return cachedSession;
    });
  }

  private replaceCachedSession(sessionId: string, expectedSession: AgentSession, nextSession: AgentSession): Promise<AgentSession> {
    return this.cacheSession(sessionId, nextSession, expectedSession).then((cachedSession) => {
      if (cachedSession === nextSession) {
        void this.warmNativeBridgeTools(sessionId, nextSession);
      }
      return cachedSession;
    });
  }

  async listSlashCommands(sessionId: string): Promise<{ supported: boolean; commands: AgentSlashCommandInfo[] }> {
    const cached = this.slashCommandListCache.get(sessionId);
    if (cached) return { supported: true, commands: cached };

    const session = this.sessionObjects.get(sessionId);
    if (!session || typeof session.listSlashCommands !== "function") {
      return { supported: false, commands: [] };
    }

    const result = await session.listSlashCommands();
    if (!result) return { supported: false, commands: [] };
    const commands = result.commands;
    this.slashCommandListCache.set(sessionId, commands);
    return { supported: true, commands };
  }

  /** Get cached MCP status for a session, or probe live if session is cached */
  async getMcpStatus(sessionId: string): Promise<McpServerStatus[]> {
    const session = this.sessionObjects.get(sessionId);
    if (session && typeof session.listMcpServers === "function") {
      try {
        const result = await session.listMcpServers();
        if (result?.servers) {
          const servers: McpServerStatus[] = result.servers.map((s) => ({
            name: s.name,
            status: coerceMcpServerStatus(s.status),
            error: typeof s.error === "string" ? s.error : undefined,
            source: typeof s.source === "string" ? s.source : undefined,
          }));
          this.mcpStatus.set(sessionId, servers);
          return servers;
        }
      } catch { /* fall through to cached */ }
    }
    return this.mcpStatus.get(sessionId) ?? [];
  }
  async loginMcpServer(
    sessionId: string,
    serverName: string,
    options: { forceReauth?: boolean } = {},
  ): Promise<McpLoginResult> {
    this.getBackend();
    if (this.isSessionBusy(sessionId)) {
      throw new Error("Cannot authenticate MCP server for a busy session");
    }

    const requestedServerName = serverName.trim();
    if (!requestedServerName) throw new Error("MCP server name is required");

    const sid = sessionId.slice(0, 8);
    const linkedTask = this.findLinkedTask(sessionId);
    const resumeConfig = this.buildSessionConfig({
      sessionId,
      task: linkedTask,
      groupNotes: this.lookupGroupNotes(linkedTask?.groupId),
      forResume: true,
    });
    const configuredServerName = Object.keys(resumeConfig.mcpServers ?? {})
      .find((name) => name.toLocaleLowerCase() === requestedServerName.toLocaleLowerCase());
    if (!configuredServerName) {
      throw new Error(`MCP server "${requestedServerName}" is not configured for this session`);
    }

    const resumeLease = await this.beginSessionResume(sessionId, resumeConfig);
    if (!resumeLease) throw new Error("MCP authentication resume cancelled before admission");
    try {
      let session = this.sessionObjects.get(sessionId);
      if (!session) {
        console.log(`[sdk] [${sid}] Resuming session for MCP auth...`);
        session = await this.resumeBackendSession(sessionId, resumeConfig, resumeLease);
        session = await this.cacheResumedSession(sessionId, session, resumeConfig);
      }

      if (typeof session.startMcpOauthLogin !== "function") {
        throw new Error("MCP OAuth login is not available in this Copilot SDK build");
      }

      const rawResult = await session.startMcpOauthLogin({
        serverName: configuredServerName,
        forceReauth: options.forceReauth,
        clientName: "Copilot Bridge",
        callbackSuccessMessage: "Authentication complete. You can return to Copilot Bridge.",
      });
      const result = rawResult as { authorizationUrl?: string } | undefined;
      const servers = await this.getMcpStatus(sessionId);
      console.log(`[sdk] [${sid}] MCP auth started for ${configuredServerName}${result?.authorizationUrl ? " (browser required)" : ""}`);
      return {
        serverName: configuredServerName,
        ...(typeof result?.authorizationUrl === "string" && result.authorizationUrl.trim()
          ? { authorizationUrl: result.authorizationUrl }
          : {}),
        servers,
      };
    } finally {
      this.endSessionResume(resumeLease);
      this.flushPendingSessionEviction(sessionId);
    }
  }


  /** Get latest MCP status from any session (for settings page) */
  getLatestMcpStatus(): McpServerStatus[] {
    // Return the most recent non-empty status from any session
    for (const [, status] of this.mcpStatus) {
      if (status.length > 0) return status;
    }
    return [];
  }

  private normalizeUserInputIdentifier(value: string, fieldName: string): string {
    const normalized = value.trim();
    if (!normalized) {
      throw new UserInputBrokerError("invalid_request", `${fieldName} is required`);
    }
    return normalized;
  }

  private isSessionStatePathSegment(sessionId: string): boolean {
    return sessionId !== "." && sessionId !== ".." && !sessionId.includes("/") && !sessionId.includes("\\");
  }

  private hasWorkspaceYamlOnDisk(sessionId: string): boolean {
    if (!this.isSessionStatePathSegment(sessionId)) return false;
    return existsSync(join(this.getSessionStateDir(sessionId), "workspace.yaml"));
  }

  private hasCliCatalogSession(sessionId: string): boolean {
    if (!this.isSessionStatePathSegment(sessionId)) return false;
    try {
      return this.deps.cliSessionCatalog?.hasSession(sessionId) === true;
    } catch (error) {
      console.warn(
        `[sdk] [${sessionId.slice(0, 8)}] Failed to check CLI session catalog:`,
        error instanceof Error ? error.message : error,
      );
      return false;
    }
  }

  private hasKnownPersistedSession(sessionId: string): boolean {
    return this.hasCliCatalogSession(sessionId) || this.hasWorkspaceYamlOnDisk(sessionId);
  }

  private async canAddressSession(sessionId: string): Promise<boolean> {
    if (
      this.sessionObjects.has(sessionId)
      || this.runStateController.hasSessionRun(sessionId)
      || this.isSessionResuming(sessionId)
      || this.modelSwitchingSessions.has(sessionId)
      || this.historyUndoingSessions.has(sessionId)
      || this.getPendingInteractionCount(sessionId) > 0
    ) {
      return true;
    }

    return this.hasKnownPersistedSession(sessionId);
  }

  async submitUserInputResponse(
    sessionId: string,
    requestId: UserInputRequestId,
    payload: unknown,
  ): Promise<{ requestId: UserInputRequestId; answer: string; wasFreeform: boolean; timestamp: string }> {
    const normalizedSessionId = this.normalizeUserInputIdentifier(sessionId, "sessionId");
    const normalizedRequestId = this.normalizeUserInputIdentifier(requestId, "requestId");

    if (!(await this.canAddressSession(normalizedSessionId))) {
      throw new UserInputBrokerError("request_not_found", "Session not found", { statusCode: 404 });
    }

    const response = this.userInputController.submitUserInputResponse(normalizedSessionId, normalizedRequestId, payload);
    const timestamp = new Date().toISOString();
    return { requestId: normalizedRequestId, ...response, timestamp };
  }

  async submitElicitationResponse(
    sessionId: string,
    requestId: ElicitationRequestId,
    payload: unknown,
  ): Promise<SubmittedElicitationResponse> {
    const normalizedSessionId = this.normalizeUserInputIdentifier(sessionId, "sessionId");
    const normalizedRequestId = this.normalizeUserInputIdentifier(requestId, "requestId");

    if (!(await this.canAddressSession(normalizedSessionId))) {
      throw new ElicitationBrokerError("request_not_found", "Session not found", { statusCode: 404 });
    }

    const result = this.elicitationController.submitResponse(
      normalizedSessionId,
      normalizedRequestId,
      payload,
    );
    return {
      requestId: normalizedRequestId,
      action: result.action,
      timestamp: new Date().toISOString(),
    };
  }

  async createSession(): Promise<{ sessionId: string }> {
    const client = this.getBackend();
    if (isRestartCutoverInProgress(refreshRestartStateSync())) {
      throw new Error(RESTART_PENDING_MESSAGE);
    }

    const t0 = Date.now();
    const bridgeSessionId = this.deps.bridgeToolsMcpServer ? randomUUID() : undefined;
    const modelMetadata = await this.loadModelMetadataForContextTiers(client);
    let session: AgentSession;
    const sessionConfig = this.buildSessionConfig({
      ...(bridgeSessionId ? { sessionId: bridgeSessionId } : {}),
      ...(modelMetadata ? { modelMetadata } : {}),
    });
    const created = await this.createBackendSession(sessionConfig, {
      kind: "normal",
      expectedSessionId: bridgeSessionId,
    });
    session = created.session;
    const duration = Date.now() - t0;
    let cacheOwned = false;
    try {
      await this.cacheSession(session.sessionId, session, null, sessionConfig);
      cacheOwned = true;
    } catch (error) {
      if (
        created.generation.state === "ready"
        && this.backendGeneration === created.generation
      ) {
        await this.discardGenerationSession(
          { generation: created.generation, deleteOnDiscard: true },
          session,
          `rejected session ${session.sessionId}`,
        );
      }
      throw error;
    } finally {
      this.endSessionCreation(created.lease, cacheOwned);
    }
    await this.warmNativeBridgeTools(session.sessionId, session);
    const settings = this.deps.settingsStore?.getSettings();
    const model = sessionConfig.model;
    if (typeof model === "string" && model.trim()) {
      const { contextTier } = this.resolveModelContextTier(model, settings?.contextTier, modelMetadata);
      const state = {
        model,
        ...(sessionConfig.reasoningEffort ? { reasoningEffort: sessionConfig.reasoningEffort } : {}),
        ...(contextTier ? { contextTier } : {}),
        ...(sessionConfig.modelCapabilities ? { modelCapabilities: sessionConfig.modelCapabilities } : {}),
      };
      this.liveSessionModelState.set(session.sessionId, state);
      this.persistSessionModelState(session.sessionId, state);
    }
    this.persistSessionWorkspace(session.sessionId, sessionConfig.workingDirectory);
    this.probeMcpStatus(session.sessionId, session);
    this.invalidateSessionListCache("session:create");
    this.recordSpan("session.create", duration, session.sessionId);
    console.log(`[sdk] Created session ${session.sessionId} (${duration}ms)`);
    return { sessionId: session.sessionId };
  }

  async forkSession(sourceSessionId: string, options: { toEventId?: string } = {}): Promise<{ sessionId: string }> {
    const backend = this.getBackend();
    if (isRestartCutoverInProgress(refreshRestartStateSync())) {
      throw new Error(RESTART_PENDING_MESSAGE);
    }

    const sourceTask = this.findLinkedTask(sourceSessionId);
    const sourceCwd = this.resolveEffectiveSessionCwd({ sessionId: sourceSessionId, task: sourceTask });
    if (typeof backend.forkSession !== "function") {
      throw new Error("Session fork is not available in this Copilot SDK build");
    }

    const toEventId = options.toEventId?.trim();
    const forkOpts = toEventId ? { toEventId } : undefined;
    const t0 = Date.now();
    const result = await backend.forkSession(sourceSessionId, forkOpts);
    const duration = Date.now() - t0;
    if (this.deps.bridgeToolsMcpServer && typeof backend.resumeSession === "function") {
      try {
        const forkResumeConfig = this.buildSessionConfig({
          sessionId: result.sessionId,
          task: sourceTask,
          groupNotes: this.lookupGroupNotes(sourceTask?.groupId),
          forResume: true,
        });
        const resumeLease = await this.beginSessionResume(result.sessionId, forkResumeConfig);
        if (!resumeLease) throw new Error("Fork resume cancelled before admission");
        try {
          const forkedSession = await this.resumeBackendSession(
            result.sessionId,
            forkResumeConfig,
            resumeLease,
          );
          await this.cacheResumedSession(result.sessionId, forkedSession, forkResumeConfig);
          this.probeMcpStatus(result.sessionId, forkedSession);
        } finally {
          this.endSessionResume(resumeLease);
          this.flushPendingSessionEviction(result.sessionId);
        }
      } catch (error) {
        try { await backend.deleteSession(result.sessionId); } catch { /* best-effort */ }
        throw error;
      }
    }
    this.persistSessionWorkspace(result.sessionId, sourceCwd);

    console.log(`[sdk] Forked session ${sourceSessionId.slice(0, 8)} → ${result.sessionId.slice(0, 8)}`);
    this.invalidateSessionListCache("session:fork");
    this.recordSpan("session.fork", duration, result.sessionId, {
      sourceSessionId,
      bounded: Boolean(toEventId),
    });
    return result;
  }

  async undoSessionTurn(
    sessionId: string,
    eventId: string,
  ): Promise<{ eventsRemoved: number; lastVisibleActivityAt?: string }> {
    if (isRestartCutoverInProgress(refreshRestartStateSync())) {
      throw new Error(RESTART_PENDING_MESSAGE);
    }
    if (this.isSessionBusy(sessionId)) {
      throw new SessionHistoryUndoError("busy", "Cannot undo history on a busy session");
    }

    const boundaryEventId = eventId.trim();
    if (!boundaryEventId) {
      throw new SessionHistoryUndoError("stale-boundary", "Undo boundary is missing or no longer available");
    }

    const backend = this.getBackend();
    const startedAt = Date.now();
    this.historyUndoingSessions.add(sessionId);
    this.syncRestartWaitingIfPending();

    try {
      let session = this.sessionObjects.get(sessionId);
      if (!session) {
        const linkedTask = this.findLinkedTask(sessionId);
        const resumeConfig = this.buildSessionConfig({
          sessionId,
          task: linkedTask,
          groupNotes: this.lookupGroupNotes(linkedTask?.groupId),
          forResume: true,
        });
        const resumeLease = await this.beginSessionResume(sessionId, resumeConfig);
        if (!resumeLease) throw new Error("History undo resume cancelled before admission");
        try {
          session = await this.resumeBackendSession(sessionId, resumeConfig, resumeLease);
          session = await this.cacheResumedSession(sessionId, session, resumeConfig);
          this.probeMcpStatus(sessionId, session);
        } finally {
          this.endSessionResume(resumeLease);
        }
      }

      if (typeof session.truncateHistory !== "function" || typeof session.getEvents !== "function") {
        throw new SessionHistoryUndoError(
          "unsupported",
          "Session history undo is not available in this agent backend",
        );
      }

      let events: unknown[];
      try {
        events = await readSdkSessionEvents(session);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/event API is not available/i.test(message)) {
          throw new SessionHistoryUndoError(
            "unsupported",
            "Session history undo is not available in this agent backend",
          );
        }
        throw error;
      }

      const boundaryIndex = events.findIndex(
        (event) => getUndoBoundaryEventId(event) === boundaryEventId,
      );
      if (boundaryIndex < 0) {
        throw new SessionHistoryUndoError(
          "stale-boundary",
          "This turn is no longer available to undo. Refresh the chat and try again.",
        );
      }

      const expectedEventsRemoved = events.length - boundaryIndex;
      let truncateResult: { eventsRemoved?: number } | undefined;
      try {
        truncateResult = await session.truncateHistory({ eventId: boundaryEventId });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/event.*not found|eventId.*not found/i.test(message)) {
          throw new SessionHistoryUndoError(
            "stale-boundary",
            "This turn is no longer available to undo. Refresh the chat and try again.",
          );
        }
        throw error;
      }

      const eventsRemoved = truncateResult?.eventsRemoved;
      if (typeof eventsRemoved !== "number") {
        throw new SessionHistoryUndoError(
          "unsupported",
          "Session history undo is not available in this agent backend",
        );
      }
      if (eventsRemoved <= 0) {
        throw new SessionHistoryUndoError(
          "stale-boundary",
          "This turn was already removed. Refresh the chat and try again.",
        );
      }

      if (eventsRemoved !== expectedEventsRemoved) {
        console.warn(
          `[sdk] [${sessionId.slice(0, 8)}] Undo removed ${eventsRemoved} event(s), expected ${expectedEventsRemoved}`,
        );
      }

      const remainingEvents = events.slice(0, boundaryIndex);
      const lastVisibleActivityAt = getLastVisibleActivityAt(remainingEvents, sessionId);
      const boundaryEvent = events[boundaryIndex] as any;
      const boundaryOccurredAt = boundaryEvent?.data?.timestamp ?? boundaryEvent?.timestamp;
      try {
        clearEventLogStatsCache(sessionId);
      } catch (error) {
        console.warn(`[sdk] [${sessionId.slice(0, 8)}] Failed to clear message stats after undo:`, error);
      }
      try {
        this.deps.sessionMetaStore?.replaceLastVisibleActivityAt(sessionId, lastVisibleActivityAt);
        const lastAttentionAt = this.deps.sessionMetaStore?.getMeta(sessionId)?.lastAttentionAt;
        if (
          lastAttentionAt
          && (
            typeof boundaryOccurredAt !== "string"
            || lastAttentionAt >= boundaryOccurredAt
          )
        ) {
          this.deps.sessionMetaStore?.replaceLastAttentionAt(sessionId, undefined);
        }
      } catch (error) {
        console.warn(`[sdk] [${sessionId.slice(0, 8)}] Failed to refresh session activity after undo:`, error);
      }
      try {
        this.deps.sessionContextStore?.recordContextEvent(createSessionContextTruncationMarker({
          sessionId,
          provider: "copilot",
          providerSessionId: sessionId,
          eventId: boundaryEventId,
          eventsRemoved,
          candidateEventsToRemove: expectedEventsRemoved,
          reason: "user-undo",
        }));
      } catch (error) {
        console.warn(`[sdk] [${sessionId.slice(0, 8)}] Failed to record context truncation after undo:`, error);
      }
      try {
        this.invalidateSessionListCache("session:history-undo");
      } catch (error) {
        console.warn(`[sdk] [${sessionId.slice(0, 8)}] Failed to invalidate session list after undo:`, error);
      }
      try {
        this.deps.globalBus.emit({ type: "session:history-truncated", sessionId });
        this.deps.globalBus.emit({ type: "sessions:changed", sessionId });
      } catch (error) {
        console.warn(`[sdk] [${sessionId.slice(0, 8)}] Failed to publish history undo:`, error);
      }

      this.recordSpan("session.history.undo", Date.now() - startedAt, sessionId, {
        outcome: "truncated",
        eventId: boundaryEventId,
        eventsRemoved,
        expectedEventsRemoved,
      });
      console.log(
        `[sdk] [${sessionId.slice(0, 8)}] Undid chat history from ${boundaryEventId} (${eventsRemoved} event(s))`,
      );
      return {
        eventsRemoved,
        ...(lastVisibleActivityAt ? { lastVisibleActivityAt } : {}),
      };
    } catch (error) {
      this.recordSpan("session.history.undo", Date.now() - startedAt, sessionId, {
        outcome: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      this.historyUndoingSessions.delete(sessionId);
      this.syncRestartWaitingIfPending();
      this.flushPendingSessionEviction(sessionId);
    }
  }

  async createTaskSession(taskId: string, taskTitle: string, workItems: WorkItemRef[], prDescriptions: string[], notes: string, cwd?: string, scheduleContext?: ScheduleContext, groupNotes?: { groupName: string; notes: string } | null): Promise<{ sessionId: string }> {
    const client = this.getBackend();
    if (isRestartCutoverInProgress(refreshRestartStateSync())) {
      throw new Error(RESTART_PENDING_MESSAGE);
    }

    const isPlaceholder = taskTitle === "New Task";

    // Look up the full task so the initial session context matches later resumes.
    const fullTask = this.deps.taskStore.getTask(taskId);

    const task = {
      id: taskId,
      title: taskTitle,
      kind: fullTask?.kind ?? "task",
      muted: fullTask?.muted ?? false,
      status: fullTask?.status ?? "active" as const,
      groupId: fullTask?.groupId,
      cwd: fullTask?.cwd ?? cwd,
      notes: notes || "",
      doneWhen: fullTask?.doneWhen,
      nextAction: fullTask?.nextAction,
      waitingOn: fullTask?.waitingOn,
      nextTouchAt: fullTask?.nextTouchAt,
      priority: 0,
      order: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sessionIds: [] as string[],
      workItems,
      pullRequests: [] as any[],
    };

    const t0 = Date.now();
    const bridgeSessionId = this.deps.bridgeToolsMcpServer ? randomUUID() : undefined;
    const modelMetadata = await this.loadModelMetadataForContextTiers(client);
    const sessionConfig = this.buildSessionConfig({
      ...(bridgeSessionId ? { sessionId: bridgeSessionId } : {}),
      task,
      isNewTask: isPlaceholder,
      prDescriptions,
      scheduleContext,
      groupNotes: groupNotes ?? this.lookupGroupNotes(fullTask?.groupId),
      ...(modelMetadata ? { modelMetadata } : {}),
    });
    const created = await this.createBackendSession(sessionConfig, {
      kind: "task",
      expectedSessionId: bridgeSessionId,
    });
    const session = created.session;
    const duration = Date.now() - t0;
    let cacheOwned = false;
    try {
      await this.cacheSession(session.sessionId, session, null, sessionConfig);
      cacheOwned = true;
    } catch (error) {
      if (
        created.generation.state === "ready"
        && this.backendGeneration === created.generation
      ) {
        await this.discardGenerationSession(
          { generation: created.generation, deleteOnDiscard: true },
          session,
          `rejected task session ${session.sessionId}`,
        );
      }
      throw error;
    } finally {
      this.endSessionCreation(created.lease, cacheOwned);
    }
    await this.warmNativeBridgeTools(session.sessionId, session);
    const settings = this.deps.settingsStore?.getSettings();
    const model = sessionConfig.model;
    if (typeof model === "string" && model.trim()) {
      const { contextTier } = this.resolveModelContextTier(model, settings?.contextTier, modelMetadata);
      const state = {
        model,
        ...(sessionConfig.reasoningEffort ? { reasoningEffort: sessionConfig.reasoningEffort } : {}),
        ...(contextTier ? { contextTier } : {}),
        ...(sessionConfig.modelCapabilities ? { modelCapabilities: sessionConfig.modelCapabilities } : {}),
      };
      this.liveSessionModelState.set(session.sessionId, state);
      this.persistSessionModelState(session.sessionId, state);
    }
    this.persistSessionWorkspace(session.sessionId, sessionConfig.workingDirectory);
    this.probeMcpStatus(session.sessionId, session);
    this.invalidateSessionListCache("session:create-task");
    this.recordSpan("session.createTask", duration, session.sessionId, { taskId });
    console.log(`[sdk] Created task session ${session.sessionId} for "${taskTitle}" (${duration}ms)`);
    return { sessionId: session.sessionId };
  }

  private completeSessionAbortLocally(sessionId: string, content: string): void {
    this.cancelPendingUserInputRequests(sessionId, "session_ended", PROMPT_DELIVERY_ABORTED_MESSAGE);
    const runController = this.activeRunControllers.get(sessionId);
    if (runController) {
      runController.completeAborted(content);
      return;
    }
    const bus = this.deps.eventBusRegistry.getBus(sessionId);
    bus?.emit({ type: "aborted", content });
    this.setSessionRunState(sessionId, "idle");
    this.flushPendingSessionEviction(sessionId);
  }

  // Abort an in-progress session turn. Shutdown callers pass their shared
  // absolute deadline so a hung SDK abort is finalized locally and cannot
  // block the remainder of process teardown.
  async abortSession(sessionId: string, deadline?: Deadline): Promise<boolean> {
    if (!this.runStateController.hasSessionRun(sessionId)) return false;

    const runController = this.activeRunControllers.get(sessionId);
    const bus = this.deps.eventBusRegistry.getBus(sessionId);
    const getAbortContent = () => {
      const snapshot = bus?.getSnapshot();
      return snapshot?.finalContent ?? snapshot?.accumulatedContent ?? "";
    };
    if (!runController) {
      console.warn(`[sdk] [${sessionId.slice(0, 8)}] 🛑 Missing run controller during abort — resolving locally`);
      this.completeSessionAbortLocally(sessionId, getAbortContent());
      return true;
    }

    const session = this.sessionObjects.get(sessionId);
    if (!session) {
      console.warn(`[sdk] [${sessionId.slice(0, 8)}] 🛑 No session object during abort — resolving locally`);
      runController.completeAborted(getAbortContent());
      return true;
    }

    const sid = sessionId.slice(0, 8);
    console.log(`[sdk] [${sid}] 🛑 Aborting session...`);
    try {
      if (deadline) {
        const abortResult = await settleByDeadline(() => session.abort(), deadline);
        if (abortResult.status === "timed-out") {
          console.error(`[sdk] [${sid}] 🛑 Abort timed out; resolving locally`);
          this.completeSessionAbortLocally(sessionId, getAbortContent());
          return true;
        }
        if (abortResult.status === "rejected") throw abortResult.error;
      } else {
        await session.abort();
      }
      console.log(`[sdk] [${sid}] 🛑 Abort sent`);
      if (deadline) {
        const confirmationDeadline = capDeadline(
          deadline,
          Math.min(ABORT_CONFIRMATION_TIMEOUT_MS, remainingMs(deadline)),
        );
        const confirmation = await settleByDeadline(
          () => runController.awaitAbortConfirmation(
            Math.max(1, remainingMs(confirmationDeadline)),
            getAbortContent,
          ),
          confirmationDeadline,
        );
        if (confirmation.status !== "fulfilled") {
          this.completeSessionAbortLocally(sessionId, getAbortContent());
        }
      } else {
        await runController.awaitAbortConfirmation(ABORT_CONFIRMATION_TIMEOUT_MS, getAbortContent);
      }
    } catch (err) {
      console.error(`[sdk] [${sid}] 🛑 Abort failed:`, err);
      this.completeSessionAbortLocally(sessionId, getAbortContent());
    }
    return true;
  }

  /**
   * Save blob attachments to the session's files/ directory and convert
   * non-image attachments to SDK `file` type (path-based) so the agent
   * can access them with its tools. Images stay as `blob` for inline viewing.
   */
  private persistAndRouteAttachments(
    sessionId: string,
    attachments?: StartWorkAttachment[],
  ): RoutedSdkAttachment[] | undefined {
    return persistAndRouteSessionAttachments(sessionId, attachments, {
      copilotHome: this.deps.copilotHome,
      logger: console,
    });
  }

  /** Generate a unique filename in dir, appending (1), (2) etc. if needed */
  private deduplicateFilename(dir: string, name: string): string {
    return deduplicateAttachmentFilename(dir, name);
  }

  // Fire and forget — starts work and emits events to the session's EventBus
  startWork(sessionId: string, prompt: string, attachments?: StartWorkAttachment[], options?: StartWorkOptions): void {
    this.sessionRunner.startWork(sessionId, prompt, attachments, options);
  }

  async startWorkAndWaitForDelivery(
    sessionId: string,
    prompt: string,
    attachments?: StartWorkAttachment[],
    options?: StartWorkOptions,
  ): Promise<void> {
    await this.sessionRunner.startWorkAndWaitForDelivery(sessionId, prompt, attachments, options);
  }

  async steerSession(sessionId: string, prompt: string, attachments?: StartWorkAttachment[]): Promise<void> {
    await this.sessionRunner.steerSession(sessionId, prompt, attachments);
  }

  /** @internal Test seam — delegates to the SessionRunner. */
  _doWork(
    sessionId: string,
    prompt: string,
    bus: ReturnType<typeof getOrCreateBus>,
    runController?: SessionRunController,
    attachments?: StartWorkAttachment[],
    options?: StartWorkOptions,
  ): Promise<void> {
    return this.sessionRunner.doWork(sessionId, prompt, bus, runController, attachments, options);
  }

  /**
   * Read messages directly from events.jsonl on disk — no SDK resume needed.
   * Returns messages instantly for the fast-load path.
   * Async to avoid blocking the event loop.
   */
  async readMessagesFromDisk(sessionId: string, opts?: { limit?: number; before?: number }): Promise<{ messages: any[]; total: number; hasMore: boolean; lastVisibleActivityAt?: string }> {
    return readMessagesFromDiskWithDeps({
      copilotHome: this.deps.copilotHome,
      sessionMetaStore: this.deps.sessionMetaStore,
      eventBusRegistry: this.deps.eventBusRegistry,
      resolveEffectiveSessionCwdFromWorkspaceYaml: (sessionId, content) =>
        this.workspaceController.resolveEffectiveSessionCwdFromWorkspaceYaml(sessionId, content),
      recordSpan: (name, duration, sessionId, metadata) => this.recordSpan(name, duration, sessionId, metadata),
      persistLastVisibleActivityAt: (sessionId, lastVisibleActivityAt) =>
        this.persistLastVisibleActivityAt(sessionId, lastVisibleActivityAt),
    }, sessionId, opts);
  }

  /**
   * Warm a session by resuming it in the background.
   * Returns a promise that resolves when the session is ready for interaction.
   */
  async warmSession(sessionId: string): Promise<void> {
    this.getBackend();
    if (this.sessionObjects.has(sessionId)) {
      this.recordSpan("session.warm.alreadyCached", 0, sessionId);
      return;
    }

    const existingWarm = this.warmSessionPromises.get(sessionId);
    if (existingWarm) {
      const tWait = Date.now();
      await existingWarm;
      this.recordSpan("session.warm.coalesced", Date.now() - tWait, sessionId);
      return;
    }

    const skipReason = this.modelSwitchingSessions.has(sessionId)
      ? "model-switching"
      : this.historyUndoingSessions.has(sessionId)
        ? "history-undo"
        : this.isSessionResuming(sessionId)
          ? "resuming"
          : this.runStateController.isSessionBusy(sessionId)
            ? "running"
            : undefined;
    if (skipReason) {
      this.recordSpan("session.warm.skipped", 0, sessionId, { reason: skipReason });
      return;
    }

    const sid = sessionId.slice(0, 8);
    const t0 = Date.now();
    console.log(`[sdk] [${sid}] Warming session...`);

    const linkedTask = this.findLinkedTask(sessionId);
    const resumeConfig = this.buildSessionConfig({ sessionId, task: linkedTask, groupNotes: this.lookupGroupNotes(linkedTask?.groupId), forResume: true });

    const warmPromise = (async () => {
      const resumeLease = await this.beginSessionResume(sessionId, resumeConfig);
      if (!resumeLease) throw new Error("Session warmup cancelled before admission");
      try {
        const session = await this.resumeBackendSession(sessionId, resumeConfig, resumeLease);
        const cachedSession = await this.cacheResumedSession(sessionId, session, resumeConfig);
        this.probeMcpStatus(sessionId, cachedSession);
        this.invalidateSessionListCache("session:warm");
        this.deps.globalBus.emit({ type: "sessions:changed", sessionId });

        const duration = Date.now() - t0;
        this.recordSpan("session.warm.coldResume", duration, sessionId);
        this.recordSpan("session.warm", duration, sessionId);
        console.log(`[sdk] [${sid}] Session warm (${duration}ms)`);
      } finally {
        this.endSessionResume(resumeLease);
        this.flushPendingSessionEviction(sessionId);
      }
    })();
    this.warmSessionPromises.set(sessionId, warmPromise);
    try {
      await warmPromise;
    } finally {
      if (this.warmSessionPromises.get(sessionId) === warmPromise) {
        this.warmSessionPromises.delete(sessionId);
      }
    }
  }

  /** Check if a session object is cached and ready for interaction */
  isSessionWarm(sessionId: string): boolean {
    return this.sessionObjects.has(sessionId);
  }

  async deleteSession(sessionId: string): Promise<void> {
    const client = this.getBackend();
    if (this.isSessionBusy(sessionId)) {
      throw new Error("Cannot delete a busy session");
    }
    let sdkDeleteError: unknown;
    this.cancelPendingUserInputRequests(
      sessionId,
      "session_ended",
      "Session was deleted before the user input request was answered",
    );
    await this.evictCachedSession(sessionId);
    this.agentRegistry.forget(sessionId);
    clearEventLogStatsCache(sessionId);
    try {
      await client.deleteSession(sessionId);
    } catch (err: unknown) {
      if (isMissingSessionError(err)) {
        console.log(`[sdk] Session ${sessionId} already gone, continuing cleanup`);
      } else {
        sdkDeleteError = err;
        console.warn(`[sdk] Delete session ${sessionId} failed before local cleanup:`, err);
      }
    }
    this.deps.sessionWorkspaceStore?.deleteWorkspace(sessionId);

    // Remove the session-state directory from disk so listSessionsFromDisk() won't resurrect it
    const copilotHome = this.getCopilotHome();
    const sessionDir = join(copilotHome, "session-state", sessionId);
    try {
      await rm(sessionDir, { recursive: true, force: true });
    } catch (err) {
      console.warn(`[sdk] Failed to remove session dir ${sessionId}:`, err);
    }
    try {
      deleteCliSessionStoreRows(copilotHome, sessionId);
    } catch (err) {
      console.warn(`[sdk] Failed to remove session ${sessionId} from CLI catalog:`, err);
    }
    this.invalidateSessionListCache("session:delete:removed");
    if (sdkDeleteError) throw sdkDeleteError;

    console.log(`[sdk] Deleted session ${sessionId}`);
  }

  async reloadSession(sessionId: string): Promise<McpServerStatus[]> {
    this.getBackend();
    if (this.isSessionBusy(sessionId)) {
      throw new Error("Cannot reload a busy session");
    }

    const sid = sessionId.slice(0, 8);
    const linkedTask = this.findLinkedTask(sessionId);
    const resumeConfig = this.buildSessionConfig({ sessionId, task: linkedTask, groupNotes: this.lookupGroupNotes(linkedTask?.groupId), forResume: true });

    const resumeLease = await this.beginSessionResume(
      sessionId,
      resumeConfig,
      { reserveCachedSession: true },
    );
    if (!resumeLease) throw new Error("Session reload cancelled before admission");
    try {
      this.cancelPendingUserInputRequests(
        sessionId,
        "session_ended",
        "Session was reloaded before the user input request was answered",
      );
      await this.evictCachedSession(sessionId);
      this.mcpStatus.delete(sessionId);

      console.log(`[sdk] [${sid}] Reloading session with fresh config...`);
      const session = await this.resumeBackendSession(sessionId, resumeConfig, resumeLease);
      await this.cacheResumedSession(sessionId, session, resumeConfig);

      return this.getMcpStatus(sessionId);
    } finally {
      this.endSessionResume(resumeLease);
      this.flushPendingSessionEviction(sessionId);
    }
  }

  isSessionBusy(sessionId: string): boolean {
    return this.modelSwitchingSessions.has(sessionId)
      || this.historyUndoingSessions.has(sessionId)
      || this.isSessionResuming(sessionId)
      || this.runStateController.isSessionBusy(sessionId);
  }

  getSessionRunState(sessionId: string): SessionRunState {
    if (this.modelSwitchingSessions.has(sessionId)) return "busy";
    if (this.historyUndoingSessions.has(sessionId)) return "busy";
    if (this.isSessionResuming(sessionId)) return "busy";
    return this.runStateController.getSessionRunState(sessionId);
  }

  isSessionStalled(sessionId: string): boolean {
    return this.runStateController.isSessionStalled(sessionId);
  }

  /**
   * Pure synchronous counts projection for the session-list DTO. Carries a
   * `source` so callers never present stale data as live truth.
   */
  getBackgroundAgentsSummary(sessionId: string): BackgroundAgentsSummary {
    return this.agentRegistry.getSummary(sessionId);
  }

  getRuntimeActivity(): {
    sessions: {
      active: number;
      stalled: number;
      waitingForUserInput: number;
    };
    agents: BackgroundAgentsAggregate;
    capacity: SessionCapacityRuntimeStatus;
  } {
    const activeSessionIds = this.getActiveSessions();
    return {
      sessions: {
        active: activeSessionIds.length,
        stalled: activeSessionIds.filter((sessionId) => this.isSessionStalled(sessionId)).length,
        waitingForUserInput: activeSessionIds.filter(
          (sessionId) => this.getPendingUserInputCount(sessionId) > 0,
        ).length,
      },
      agents: this.agentRegistry.getAggregate(),
      capacity: this.getSessionCapacityRuntimeStatus(),
    };
  }

  /**
   * Authoritative per-session agent snapshot for the detail endpoint. Triggers
   * a live refresh from the cached SDK session when one exists, then returns the
   * freshest cached projection (or `unknown` when nothing is available).
   */
  async listSessionAgents(sessionId: string): Promise<{
    tasks: SessionAgentTask[];
    source: AgentCountsSource;
    refreshedAt?: string;
  }> {
    await this.agentRegistry.refresh(sessionId, "endpoint");
    return this.agentRegistry.getSnapshot(sessionId);
  }

  /**
   * Request cancellation of a background agent task. Returns `undefined` when no
   * live session is cached or the backend lacks the cancellation RPC.
   */
  async cancelSessionAgent(
    sessionId: string,
    agentId: string,
  ): Promise<{ cancelled: boolean } | undefined> {
    const session = this.sessionObjects.get(sessionId);
    if (!session || typeof session.cancelTask !== "function") return undefined;
    const result = await session.cancelTask(agentId);
    await this.agentRegistry.refresh(sessionId, "cancel");
    return result;
  }

  getPendingUserInputCount(sessionId: string): number {
    return this.getPendingInteractionCount(sessionId);
  }

  hasActiveTurns(): boolean {
    return this.runStateController.hasActiveTurns();
  }

  getActiveSessions(): string[] {
    return Array.from(new Set([
      ...this.runStateController.getActiveSessions(),
      ...this.resumingSessions.keys(),
      ...this.modelSwitchingSessions,
      ...this.historyUndoingSessions,
    ]));
  }

  /** Evict all cached session objects so the next turn forces a re-resume with fresh config */
  async evictAllCachedSessions(): Promise<void> {
    const cleanups = await this.enqueueCache("evict-all", undefined, () => {
      const busy = new Set(this.getActiveSessions());
      const scheduled: Promise<boolean>[] = [];
      for (const id of busy) {
        this.pendingSessionEvictions.add(id);
      }
      let evicted = 0;
      for (const [id] of this.sessionObjects) {
        if (busy.has(id)) continue;
        const cleanup = this.evictCachedSessionUnsafe(id, undefined, "evicting all cached sessions");
        if (cleanup) scheduled.push(cleanup);
        evicted++;
      }
      console.log(`[sdk] Evicted ${evicted} cached session(s) (${busy.size} busy, skipped)`);
      return scheduled;
    });
    await Promise.all(cleanups);
  }

  /**
   * Explicitly switch the model for a single session.
   *
   * Reuses the cached session object when available; otherwise resumes with
   * forResume:true (no model/reasoningEffort in config) so the SDK loads
   * the session's own persisted model state before we apply the new model.
   * Rejects busy sessions to avoid racing with an in-progress turn.
   */
  async setSessionModel(
    sessionId: string,
    model: string,
    reasoningEffort?: string,
    contextTier?: string,
  ): Promise<{ model: string; reasoningEffort?: string; contextTier?: CopilotContextTier; modelId?: string }> {
    const client = this.getBackend();
    if (isRestartPending()) throw new Error("Cannot switch model while a restart is pending");
    if (this.isSessionBusy(sessionId)) throw new Error("Cannot switch model on a busy session");

    const sid = sessionId.slice(0, 8);
    this.modelSwitchingSessions.add(sessionId);
    this.syncRestartWaitingIfPending();

    try {
      const modelMetadata = await this.loadModelMetadataForContextTiers(client);
      let session = this.sessionObjects.get(sessionId);
      if (!session) {
        const linkedTask = this.findLinkedTask(sessionId);
        const resumeConfig = this.buildSessionConfig({
          sessionId,
          task: linkedTask,
          groupNotes: this.lookupGroupNotes(linkedTask?.groupId),
          forResume: true,
          ...(modelMetadata ? { modelMetadata } : {}),
        });
        const resumeLease = await this.beginSessionResume(sessionId, resumeConfig);
        if (!resumeLease) throw new Error("Model switch resume cancelled before admission");
        try {
          session = await this.resumeBackendSession(sessionId, resumeConfig, resumeLease);
          session = await this.cacheResumedSession(sessionId, session, resumeConfig);
          this.probeMcpStatus(sessionId, session);
        } finally {
          this.endSessionResume(resumeLease);
        }
      }

      const eventsState = deriveModelStateFromEventsFile(this.getSessionEventsPath(sessionId));
      const persistedState = this.readPersistedSessionModelState(sessionId);
      const liveState = this.liveSessionModelState.get(sessionId);
      let currentModelBeforeSwitch: string | undefined;
      if (reasoningEffort === undefined && liveState?.reasoningEffort !== undefined) {
        try {
          if (typeof session.getCurrentModel === "function") {
            const current = await session.getCurrentModel();
            currentModelBeforeSwitch = current?.modelId;
          }
        } catch { /* best-effort */ }
      }
      const knownLiveReasoningEffort =
        liveState && (!currentModelBeforeSwitch || liveState.model === currentModelBeforeSwitch)
          ? liveState.reasoningEffort
          : undefined;
      const effectiveReasoningEffort = reasoningEffort
        ?? knownLiveReasoningEffort
        ?? eventsState.reasoningEffort;
      const effectiveRequestedContextTier = contextTier
        ?? (liveState?.model === model ? liveState.contextTier : undefined)
        ?? (eventsState.model === model ? eventsState.contextTier : undefined)
        ?? (persistedState.model === model ? persistedState.contextTier : undefined);
      const resolvedContext = this.resolveModelContextTier(model, effectiveRequestedContextTier, modelMetadata);
      const setModelOptions = {
        ...(effectiveReasoningEffort ? { reasoningEffort: effectiveReasoningEffort } : {}),
        ...(resolvedContext.modelCapabilities ? { modelCapabilities: resolvedContext.modelCapabilities } : {}),
      };
      const opts = Object.keys(setModelOptions).length > 0 ? setModelOptions : undefined;
      await session.setModel(model, opts);
      console.log(
        `[sdk] [${sid}] setSessionModel(${model}${effectiveReasoningEffort ? `, ${effectiveReasoningEffort}` : ""}${
          resolvedContext.contextTier ? `, ${resolvedContext.contextTier}` : ""
        })`,
      );

      let modelId: string | undefined;
      try {
        if (typeof session.getCurrentModel === "function") {
          const current = await session.getCurrentModel();
          modelId = current?.modelId;
        }
      } catch { /* best-effort */ }

      const liveModel = modelId ?? model;
      this.liveSessionModelState.set(sessionId, {
        model: liveModel,
        ...(effectiveReasoningEffort ? { reasoningEffort: effectiveReasoningEffort } : {}),
        ...(resolvedContext.contextTier ? { contextTier: resolvedContext.contextTier } : {}),
      });
      this.persistSessionModelState(sessionId, {
        model: liveModel,
        ...(effectiveReasoningEffort ? { reasoningEffort: effectiveReasoningEffort } : {}),
        ...(resolvedContext.contextTier ? { contextTier: resolvedContext.contextTier } : {}),
        ...(resolvedContext.modelCapabilities ? { modelCapabilities: resolvedContext.modelCapabilities } : {}),
      });

      return {
        model,
        ...(effectiveReasoningEffort ? { reasoningEffort: effectiveReasoningEffort } : {}),
        ...(resolvedContext.contextTier ? { contextTier: resolvedContext.contextTier } : {}),
        ...(modelId ? { modelId } : {}),
      };
    } finally {
      this.modelSwitchingSessions.delete(sessionId);
      this.syncRestartWaitingIfPending();
      this.flushPendingSessionEviction(sessionId);
      this.scheduleCacheOperation(
        this.trimSessionCache("model switch ended"),
        "trimming the session cache after a model switch",
      );
    }
  }

  /**
   * Return the current model / reasoning effort for a session on demand.
   *
   * - For active (cached) sessions, calls rpc.model.getCurrent() for the live
   *   modelId, then uses the latest explicit switch state or events.jsonl for
   *   reasoningEffort (the RPC only exposes modelId, not reasoningEffort).
   * - For inactive sessions (not in cache), falls back entirely to events.jsonl.
   * - Returns source='live' when the live RPC was used, 'events' when only the
   *   event log was used, or 'unknown' if neither had useful data.
   */
  async getSessionModelState(
    sessionId: string,
  ): Promise<{ model?: string; reasoningEffort?: string; contextTier?: CopilotContextTier; source: "live" | "events" | "unknown" }> {
    const eventsState = deriveModelStateFromEventsFile(this.getSessionEventsPath(sessionId));
    const persistedState = this.readPersistedSessionModelState(sessionId);

    const cached = this.sessionObjects.get(sessionId);
    if (cached) {
      try {
        if (typeof cached.getCurrentModel === "function") {
          const current = await cached.getCurrentModel();
          const liveModelId: string | undefined = current?.modelId;
          if (liveModelId) {
            const liveState = this.liveSessionModelState.get(sessionId);
            const reasoningEffort = liveState?.model === liveModelId
              ? liveState.reasoningEffort
              : eventsState.reasoningEffort ?? persistedState.reasoningEffort;
            const contextTier = liveState?.model === liveModelId
              ? liveState.contextTier
              : eventsState.contextTier ?? (persistedState.model === liveModelId ? persistedState.contextTier : undefined);
            return {
              model: liveModelId,
              ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
              ...(contextTier !== undefined ? { contextTier } : {}),
              source: "live",
            };
          }
        }
      } catch { /* best-effort */ }
    }

    const mergedEventsState = {
      ...persistedState,
      ...eventsState,
      contextTier: eventsState.contextTier ?? (
        !eventsState.model || eventsState.model === persistedState.model ? persistedState.contextTier : undefined
      ),
    };
    if (
      mergedEventsState.model !== undefined
      || mergedEventsState.reasoningEffort !== undefined
      || mergedEventsState.contextTier !== undefined
    ) {
      return { ...mergedEventsState, source: "events" };
    }

    return { source: "unknown" };
  }

  getSessionActivity(): SessionActivity[] {
    return this.runStateController.getSessionActivity();
  }

  async gracefulShutdown(
    deadline: Deadline = createDeadline(GRACEFUL_SHUTDOWN_BUDGET_MS),
  ): Promise<void> {
    this.shuttingDown = true;
    this.stopSessionCacheSweep();
    const active = this.getActiveSessions();
    if (active.length > 0) {
      console.log(`[sdk] Graceful shutdown: aborting ${active.length} active session(s)...`);
      const abortDeadline = capDeadline(deadline, SESSION_ABORT_TIMEOUT_MS);
      await Promise.allSettled(
        active.map(async (sessionId) => {
          const sid = sessionId.slice(0, 8);
          try {
            if (await this.abortSession(sessionId, abortDeadline)) {
              console.log(`[sdk] [${sid}] Aborted for shutdown`);
            }
          } catch (err) {
            console.error(`[sdk] [${sid}] Abort failed during shutdown:`, err);
          }
        }),
      );

      // A timed-out SDK abort is locally finalized by abortSession. Give the
      // normal run finally-blocks a bounded opportunity to release resources.
      const drainDeadline = capDeadline(deadline, SESSION_DRAIN_TIMEOUT_MS);
      let activeCount = this.getActiveSessions().length;
      while (activeCount > 0 && remainingMs(drainDeadline) > 0) {
        await new Promise((r) => setTimeout(r, Math.min(250, remainingMs(drainDeadline))));
        activeCount = this.getActiveSessions().length;
      }
      if (activeCount > 0) {
        console.log(`[sdk] ${activeCount} session(s) did not drain in time`);
      } else {
        console.log("[sdk] All sessions drained cleanly");
      }
    }

    this.cancelAllPendingUserInputRequests(
      "session_ended",
      "Session manager shut down before the user input request was answered",
    );

    if (this.deps.browserSessionStore) {
      const store = this.deps.browserSessionStore;
      const outcome = await settleByDeadline(
        () => store.closeAll(),
        capDeadline(deadline, BROWSER_SHUTDOWN_TIMEOUT_MS),
      );
      if (outcome.status === "timed-out") {
        console.error("[browser] Browser session cleanup timed out during shutdown");
      } else if (outcome.status === "rejected") {
        console.error("[browser] Browser session cleanup failed during shutdown:", outcome.error);
      }
    }

    if (this.deps.browserLifecycle) {
      const lifecycle = this.deps.browserLifecycle;
      const outcome = await settleByDeadline(
        () => lifecycle.shutdown(),
        capDeadline(deadline, BROWSER_SHUTDOWN_TIMEOUT_MS),
      );
      if (outcome.status === "timed-out") {
        console.error("[browser] Primary browser shutdown timed out during shutdown");
      } else if (outcome.status === "rejected") {
        console.error("[browser] Primary browser shutdown failed:", outcome.error);
      } else if (outcome.value.skipped && outcome.value.reason === "no_browser_activity") {
        console.log("[browser] Primary browser shutdown skipped (no runtime activity detected)");
      }
    }

    // Reserve time for forceStop. Both calls consume the same overall deadline.
    if (this.backend) {
      console.log("[sdk] Stopping Copilot SDK client...");
      const backend = this.backend;
      const stopDeadline = capDeadline(
        deadlineBefore(deadline, BACKEND_FORCE_STOP_RESERVE_MS),
        BACKEND_STOP_TIMEOUT_MS,
      );
      const stopOutcome = await settleByDeadline(
        () => Promise.resolve(backend.stop()),
        stopDeadline,
      );
      if (stopOutcome.status !== "fulfilled" && typeof backend.forceStop === "function") {
        console.error(
          `[sdk] Backend stop ${stopOutcome.status === "timed-out" ? "timed out" : "failed"} during graceful shutdown; forcing stop`,
        );
        const forceOutcome = await settleByDeadline(
          () => Promise.resolve(backend.forceStop!()),
          deadline,
        );
        if (forceOutcome.status === "timed-out") {
          console.error("[sdk] Backend force stop timed out during graceful shutdown");
        } else if (forceOutcome.status === "rejected") {
          console.error("[sdk] Backend force stop failed during graceful shutdown:", forceOutcome.error);
        }
      }
      this.backend = null;
      this.backendGeneration = null;
      this.backendCreatedAtMs = null;
    }
    this.agentRegistry.dispose();
    console.log("[sdk] Graceful shutdown complete");
  }

  async shutdown(): Promise<void> {
    await this.gracefulShutdown();
  }
}
