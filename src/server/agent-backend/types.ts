// AgentBackend abstraction over the coding-agent SDK in use.
//
// Today the Bridge talks to `@github/copilot-sdk` directly. This module
// introduces a thin interface that wraps the SDK surface actually consumed by
// SessionManager and SessionRunner so future backends (Claude Code, Codex,
// ACP) can slot in without rewriting the core run loop.
//
// **Step 1 scope: structural wrap only — zero behavior change.**
// The CopilotBackend implementation delegates 1:1 to the SDK. Event payload
// shapes, session-object semantics, and raw `rpc` escape-hatch access all stay
// Copilot-flavoured until Step 3 forces normalization when a second backend
// lands.
//
// SDK surface enumerated for Step 1 (sourced from `session-manager.ts` and
// `session-runner.ts`):
//
//   CopilotClient methods:
//     start, stop, forceStop, listModels, listSessions,
//     createSession, resumeSession, deleteSession, getSessionMetadata,
//     rpc?.sessions?.fork (raw escape hatch, session fork)
//
//   CopilotSession methods/properties:
//     sessionId, send, abort, setModel, disconnect (optional),
//     on (returns unsubscribe); never getEvents (history is read from disk),
//     rpc (raw escape hatch: mcp.list, mcp.oauth.login, model.getCurrent,
//          history.truncate, name.get/set)
//
// The `rpc` escape hatch is documented and preserved verbatim in Step 1 so
// the structural refactor stays behavior-preserving. Step 3 will replace
// these raw accesses with first-class methods on the interface once a second
// backend forces the shape question.

import type {
  ModelInfo,
  PermissionHandler,
  PermissionRequest,
  PermissionRequestResult,
  SectionOverride,
} from "@github/copilot-sdk";

/**
 * Declares which optional features a backend supports. Consumers (UI, run
 * loop) should consult this map and degrade gracefully when a backend
 * cannot back a given feature.
 *
 * Step 1 ships only one backend (Copilot) where every flag is `true`. The
 * surface exists so Steps 3-5 can wire a second backend with reduced
 * capabilities without rippling type changes through callers.
 */
export interface AgentCapabilities {
  /** Backend supports `resumeSession(id, ...)` returning a live session that can stream new events. */
  resumeSession: boolean;
  /** Tool-call argument JSON is streamed incrementally (assistant.streaming_delta with input_json_delta). */
  streamingToolInput: boolean;
  /** Backend emits usage/cost data per turn (input_tokens, output_tokens, cached, cost). */
  costUsage: boolean;
  /** Backend models sub-agents as first-class events (subagent.started/completed/failed). */
  subAgents: boolean;
  /** Backend accepts image attachments alongside prompts. */
  images: boolean;
  /** Backend supports writing additional messages to stdin mid-turn (Claude Code's stream-json input mode). */
  bidirectionalStdin: boolean;
  /** Backend emits external_tool.requested / external_tool.completed events for MCP tool calls. */
  externalToolEvents: boolean;
  /** Backend models conversation forks (assistant.turn_end carries fork-boundary event ids). */
  forkBoundaries: boolean;
  /** Backend can expose Bridge tools through a native first-class tool declaration surface. */
  nativeBridgeTools?: boolean;
  /** Backend supports eager-loading native tools so they are not hidden behind tool search. */
  eagerNativeTools?: boolean;
  /** Backend exposes RPCs to initialize tools and inspect current tool metadata. */
  toolMetadataWarmup?: boolean;
}

/**
 * Re-exports the SDK's info shapes so backend-neutral callers can rely on the
 * abstraction's module path instead of importing `@github/copilot-sdk`
 * directly. Step 3 may replace these with backend-neutral shapes; for Step 1
 * they are aliases.
 */
export type AgentModelInfo = ModelInfo;
export type AgentSectionOverride = SectionOverride;
// Step 3: replace these Copilot-shaped aliases with backend-neutral permission types.
export type AgentPermissionRequest = PermissionRequest;
export type AgentPermissionDecision = PermissionRequestResult;
export type AgentPermissionPolicy = PermissionHandler;

/**
 * Loose alias for the configuration object passed to createSession /
 * resumeSession. The Copilot SDK has a deep type here that mixes
 * SectionOverride entries, MCP server descriptors, identity, and tool
 * arrays. Step 1 keeps this opaque (`unknown`) at the AgentBackend
 * boundary because session-config-builder.ts still produces a
 * Copilot-shaped config; Step 3 will introduce a normalized config type.
 */
export interface AgentSessionConfig {
  /**
   * Ask the backend to surface native pending-interaction events without
   * installing an in-process responder. Backends that do not support this
   * marker may ignore it.
   */
  pendingInteractionEvents?: boolean;
  [key: string]: unknown;
}

/**
 * Options for `AgentSession.send(...)`. Mirrors the Copilot SDK's send
 * argument; kept loose because Claude Code / Codex carry different
 * attachment + mode shapes.
 */
export interface AgentSendArgs {
  prompt: string;
  attachments?: unknown[];
  /** Copilot SDK: "immediate" steers a busy session; undefined queues normally. */
  mode?: "immediate";
  [extra: string]: unknown;
}

/**
 * Options for `AgentSession.setModel(...)`. Copilot SDK accepts an optional
 * `{ reasoningEffort, contextTier, modelCapabilities }` second argument.
 */
export interface AgentSetModelOptions {
  reasoningEffort?: string;
  contextTier?: string;
  modelCapabilities?: unknown;
  [extra: string]: unknown;
}

export interface AgentSlashCommandInvocation {
  name: string;
  input?: string;
}

export interface AgentSlashCommandInput {
  hint: string;
  required?: boolean;
  completion?: string;
  preserveMultilineInput?: boolean;
}

export interface AgentSlashCommandInfo {
  name: string;
  aliases?: string[];
  description: string;
  kind: string;
  input?: AgentSlashCommandInput;
  allowDuringAgentExecution: boolean;
  experimental?: boolean;
}

export interface AgentSlashCommandList {
  commands: AgentSlashCommandInfo[];
}

export type AgentSlashCommandResult =
  | {
    kind: "send";
    prompt: string;
    displayPrompt?: string;
    mode?: string;
  }
  | {
    kind: "text";
    text: string;
    markdown?: boolean;
    preserveAnsi?: boolean;
  }
  | {
    kind: "completed";
    message?: string;
  }
  | {
    kind: "select";
    command: string;
    title: string;
    options: Array<{ label?: string; value?: string; description?: string }>;
  };

/**
 * Subscription callback for live session events. Step 1 keeps the payload
 * `unknown`; the existing session-runner pattern-matches on Copilot event
 * type discriminators (e.g. "assistant.turn_end"). Step 3 will normalize
 * these into a discriminated union when a second backend lands.
 */
export interface AgentUserInputRequest {
  question: string;
  choices?: string[];
  allowFreeform?: boolean;
  toolCallId?: string;
}

export interface AgentUserInputResponse {
  answer: string;
  wasFreeform: boolean;
  /** Set when the request was dismissed instead of answered. */
  dismissed?: boolean;
}

export type AgentElicitationAction = "accept" | "decline" | "cancel";

export interface AgentElicitationRequest {
  message: string;
  mode?: "form" | "url";
  requestedSchema?: unknown;
  url?: string;
  toolCallId?: string;
}

export interface AgentElicitationResponse {
  action: AgentElicitationAction;
  content?: Record<string, unknown>;
}

export type AgentPendingInteractionEvent =
  | {
    type: "user_input.requested";
    data: AgentUserInputRequest & { requestId: string };
    timestamp?: string;
  }
  | {
    type: "user_input.completed";
    data: Partial<AgentUserInputResponse> & { requestId: string };
    timestamp?: string;
  }
  | {
    type: "elicitation.requested";
    data: AgentElicitationRequest & {
      requestId: string;
      elicitationSource?: string;
    };
    timestamp?: string;
  }
  | {
    type: "elicitation.completed";
    data: AgentElicitationResponse & { requestId: string };
    timestamp?: string;
  };

export type AgentSessionEvent = AgentPendingInteractionEvent | {
  type: string;
  data?: unknown;
  timestamp?: string;
  [key: string]: unknown;
};

export type AgentSessionEventHandler = (event: AgentSessionEvent) => void;

export interface AgentCurrentModel {
  modelId?: string;
  reasoningEffort?: string;
  contextTier?: string;
}

/**
 * Live or resumed session object. Mirrors `CopilotSession`'s feature surface
 * through typed methods.
 *
 * This is a **required facade**, not a capability map: an implementation must
 * define every method, and method presence says nothing about whether the
 * underlying runtime can actually serve the call. A backend that cannot serve a
 * capability reports it in one of two ways, decided by the return type:
 *
 * - methods whose result includes `| undefined` resolve `undefined`;
 * - every other method throws.
 *
 * Callers must therefore branch on the result, never on `typeof session.x`.
 * A `typeof` probe against this interface is always true and detects nothing —
 * the wrapper method exists even when the RPC behind it does not.
 *
 * `sessionId` (not `id`) is preserved as the property name to match the
 * SDK and avoid rippling renames across api-router, push-notification,
 * schedule-retention, and other call sites that already read
 * `.sessionId` from session summaries. Step 3 may consolidate to `id`.
 */
export interface AgentSession {
  readonly sessionId: string;

  send(args: AgentSendArgs): Promise<unknown>;
  /**
   * Send a message and block until the agent finishes (resolves on
   * `session.idle`).
   */
  sendAndWait(args: AgentSendArgs, timeoutMs?: number): Promise<unknown>;
  abort(): Promise<unknown>;
  setModel(model: string, opts?: AgentSetModelOptions): Promise<unknown>;
  disconnect?(): Promise<unknown> | void;

  /** Subscribe to live session events. Returns an unsubscribe function. */
  on(handler: AgentSessionEventHandler): () => void;

  // Intentionally no full-history read (`getEvents` / `session.getMessages`):
  // the Bridge reads persisted history from events.jsonl on disk. A single
  // full-history RPC response for a large transcript tears down the shared
  // backend connection. See session-disk-reader.ts.

  /** Resolve an ask_user request. False means another responder already won or the ID is stale. */
  respondToUserInput(requestId: string, response: AgentUserInputResponse): Promise<boolean>;

  /** Resolve an elicitation request. False means another responder already won or the ID is stale. */
  tryRespondToElicitation(requestId: string, response: AgentElicitationResponse): Promise<boolean>;

  /** Switch the session's send mode. */
  setSendMode(opts: { mode: string }): Promise<unknown>;

  /** Invoke a session-scoped slash command. */
  invokeSlashCommand(command: AgentSlashCommandInvocation): Promise<AgentSlashCommandResult>;

  /** List session-scoped slash commands. Resolves `undefined` when unsupported. */
  listSlashCommands(): Promise<AgentSlashCommandList | undefined>;

  /** Fetch the session's current model settings snapshot. Resolves `undefined` when unsupported. */
  getCurrentModel(): Promise<AgentCurrentModel | undefined>;

  /** Truncate the session's persisted event history at the named event. */
  truncateHistory(opts: { eventId: string }): Promise<{ eventsRemoved?: number } | undefined>;

  /** List MCP servers configured for the session. Resolves `undefined` when unsupported. */
  listMcpServers(): Promise<{ servers?: AgentMcpServerStatus[] } | undefined>;

  /** Initialize and validate the currently configured tool set. */
  initializeTools(): Promise<unknown>;

  /** Return lightweight metadata for the currently initialized tool set. */
  getCurrentToolMetadata(): Promise<{ tools?: AgentToolMetadata[] | null } | undefined>;

  /** Begin an OAuth login flow for the named MCP server. */
  startMcpOauthLogin(opts: AgentMcpOauthLoginOptions): Promise<unknown>;

  /** Read the persisted session title/name. Resolves `undefined` when unsupported. */
  getName(): Promise<{ name?: string } | undefined>;

  /** Persist a new session title/name. */
  setName(opts: { name: string }): Promise<unknown>;

  /**
   * List background tasks (agents + shells) the backend is tracking for this
   * session. Resolves `undefined` when the backend has no task RPC.
   */
  listTasks(): Promise<{ tasks?: AgentBackgroundTask[] } | undefined>;

  /** Request cancellation of a tracked background task. */
  cancelTask(id: string): Promise<{ cancelled: boolean } | undefined>;

  /** Remove a completed or cancelled background task from backend tracking. */
  removeTask(id: string): Promise<{ removed: boolean } | undefined>;
}

/**
 * Backend-neutral projection of one SDK background task. Mirrors the Copilot
 * SDK `TaskInfo` (agent variant) but trimmed to the fields the Bridge consumes.
 * `kind` distinguishes agent tasks from detached shells; the agent surface only
 * renders `kind: "agent"`.
 */
export type AgentBackgroundTask = {
  kind: "agent" | "shell";
  id: string;
  toolCallId?: string;
  description?: string;
  /** running | idle | completed | failed | cancelled */
  status: string;
  /** sync | background */
  executionMode?: string;
  agentType?: string;
  startedAt?: string;
  completedAt?: string;
  activeTimeMs?: number;
  idleSince?: string;
  model?: string;
  error?: string;
  prompt?: string;
  result?: string;
  latestResponse?: string;
} & Record<string, unknown>;

/**
 * Loose MCP server status shape returned by `listMcpServers`. The Copilot
 * SDK populates extra fields; this captures the ones the Bridge actually
 * consumes.
 */
export type AgentMcpServerStatus = {
  name: string;
  status?: string;
  error?: string;
  source?: string;
} & Record<string, unknown>;

export type AgentToolMetadata = {
  name: string;
  namespacedName?: string;
  mcpServerName?: string;
  mcpToolName?: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  deferLoading?: boolean;
} & Record<string, unknown>;

/** Arguments for `AgentSession.startMcpOauthLogin`. */
export interface AgentMcpOauthLoginOptions {
  serverName: string;
  forceReauth?: boolean;
  clientName?: string;
  callbackSuccessMessage?: string;
  [extra: string]: unknown;
}

/**
 * Lightweight summary returned by `listSessions()`. The Copilot SDK
 * returns an array of metadata objects with at least a `sessionId`; the
 * Bridge consumes a handful of fields on top of that, so this type
 * stays open-ended.
 */
export type AgentSessionSummary = {
  sessionId: string;
} & Record<string, unknown>;

/** Why the backend considers its RPC channel lost. */
export type AgentBackendDisconnectReason =
  | "connection-closed"
  | "connection-error"
  | "process-exit"
  | "stdin-error"
  | "rpc-timeout"
  | "health-probe-failed";

export interface AgentBackendDisconnect {
  /** ISO timestamp of detection. */
  at: string;
  reason: AgentBackendDisconnectReason;
  detail?: string;
}

export interface AgentBackendConnectionStatus {
  /** Transport state as reported by the underlying SDK client. */
  state: "connected" | "connecting" | "disconnected" | "error" | "unknown";
  /** Child runtime process id when the backend spawned one. */
  pid?: number;
  lastDisconnect?: AgentBackendDisconnect;
}

/**
 * Backend handle that owns a coding-agent SDK client process and exposes
 * the operations Bridge uses to manage sessions.
 */
export interface AgentBackend {
  /** Stable id of the backend implementation, e.g. "copilot". */
  readonly id: "copilot" | (string & {});

  /** Capability flags surfaced to the UI / run loop for graceful degradation. */
  readonly capabilities: AgentCapabilities;

  /**
   * Backend-native handler for permission requests during session execution.
   * Backends that auto-accept via CLI flags can return undefined.
   * Step 3 will replace the Copilot-shaped alias with a backend-neutral type.
   */
  readonly permissionPolicy: AgentPermissionPolicy | undefined;

  /** Boot the underlying CLI process and JSON-RPC channel. */
  start(): Promise<unknown>;

  /** Graceful shutdown. */
  stop(): Promise<unknown>;

  /** Force-stop. Optional because not every SDK exposes one. */
  forceStop?(): Promise<unknown>;

  /**
   * Subscribe to the loss of the backend RPC channel (connection closed,
   * runtime process exited, or an RPC timed out and a liveness probe failed).
   * Fires at most once per backend instance and never for an intentional
   * stop. Returns an unsubscribe function.
   */
  onDisconnect?(handler: (info: AgentBackendDisconnect) => void): () => void;

  /** Current transport state for health reporting. */
  getConnectionStatus?(): AgentBackendConnectionStatus;

  /**
   * Cheap liveness probe of the RPC channel. Resolves false when the channel
   * is not connected or does not answer within `timeoutMs`; a failed probe
   * also fires `onDisconnect`.
   */
  probeHealth?(timeoutMs?: number, reason?: string): Promise<boolean>;

  /** List models available to the active backend account/subscription. */
  listModels(): Promise<AgentModelInfo[]>;

  /** List existing sessions known to the backend. */
  listSessions(): Promise<AgentSessionSummary[]>;

  /**
   * Return sessions held by another backend process. Optional because older
   * runtimes may not expose the experimental sessions.checkInUse RPC.
   */
  checkSessionsInUse?(sessionIds: readonly string[]): Promise<Set<string> | undefined>;

  /** Create a brand-new session. */
  createSession(config: AgentSessionConfig): Promise<AgentSession>;

  /** Resume an existing session by id. */
  resumeSession(sessionId: string, config: AgentSessionConfig): Promise<AgentSession>;

  /** Delete a session from the backend's storage. */
  deleteSession(sessionId: string): Promise<unknown>;

  /** Fetch backend-stored metadata for a session. */
  getSessionMetadata(sessionId: string): Promise<unknown>;

  /**
   * Fork an existing session at a specific event. Optional — older SDK
   * builds may lack the `sessions.fork` RPC.
   */
  forkSession?(
    sourceSessionId: string,
    opts?: { toEventId?: string },
  ): Promise<{ sessionId: string }>;

  /**
   * Live quota/usage counter for the authenticated account. Optional — older
   * SDK builds may lack the `account.getQuota` RPC. The payload is
   * backend-shaped and normalized by the caller.
   */
  getAccountQuota?(): Promise<unknown>;

  /**
   * Current authentication state, including the backend's raw account
   * passthrough. Optional for the same reason as `getAccountQuota`.
   */
  getAccountAuth?(): Promise<unknown>;
}

/**
 * Factory signature for tests and the staging backend manager: produce an
 * AgentBackend. Backend-specific configuration (env, client options) is
 * owned by the concrete factory implementation, not threaded through this
 * seam.
 */
export type AgentBackendFactory = () => AgentBackend;
