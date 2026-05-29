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
//     on (returns unsubscribe), getEvents (read via readSdkSessionEvents),
//     rpc (raw escape hatch: mcp.list, mcp.oauth.login, model.getCurrent,
//          history.truncate, name.get/set)
//
// The `rpc` escape hatch is documented and preserved verbatim in Step 1 so
// the structural refactor stays behavior-preserving. Step 3 will replace
// these raw accesses with first-class methods on the interface once a second
// backend forces the shape question.

import type {
  CopilotClientOptions,
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
}

/**
 * Re-exports the SDK's option/info shapes so callers can rely on the
 * abstraction's module path. Step 3 may replace these with backend-neutral
 * shapes; for Step 1 they are aliases.
 */
export type AgentClientOptions = CopilotClientOptions;
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
export type AgentSessionConfig = unknown;

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
 * `{ reasoningEffort, modelCapabilities }` second argument.
 */
export interface AgentSetModelOptions {
  reasoningEffort?: string;
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
export type AgentSessionEventHandler = (event: unknown) => void;

/**
 * Live or resumed session object. Mirrors `CopilotSession`'s feature surface
 * through typed methods. Each optional method may be absent on older SDK
 * builds or alternative backends; callers should treat `undefined` as "this
 * capability is not available" and surface a clear error to the user.
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
   * `session.idle`). Optional — Copilot SDK provides this convenience
   * via `session.sendAndWait`; other backends (Claude Code, Codex, ACP)
   * may not, in which case callers should fall back to `send` + their
   * own event-loop wait.
   */
  sendAndWait?(args: AgentSendArgs, timeoutMs?: number): Promise<unknown>;
  abort(): Promise<unknown>;
  setModel(model: string, opts?: AgentSetModelOptions): Promise<unknown>;
  disconnect?(): Promise<unknown> | void;

  /** Subscribe to live session events. Returns an unsubscribe function. */
  on(handler: AgentSessionEventHandler): () => void;

  /** Read the full on-disk event log. Used by readSdkSessionEvents. */
  getEvents?(): Promise<unknown>;

  /** Switch the session's send mode. Optional — older SDK builds may lack `mode.set`. */
  setSendMode?(opts: { mode: string }): Promise<unknown>;

  /** Invoke a session-scoped slash command. Optional for agent backends that do not expose commands. */
  invokeSlashCommand?(command: AgentSlashCommandInvocation): Promise<AgentSlashCommandResult>;

  /** List session-scoped slash commands. Optional for agent backends that do not expose commands. */
  listSlashCommands?(): Promise<AgentSlashCommandList | undefined>;

  /** Fetch the session's currently-selected model id. */
  getCurrentModel?(): Promise<{ modelId?: string } | undefined>;

  /** Truncate the session's persisted event history at the named event. */
  truncateHistory?(opts: { eventId: string }): Promise<{ eventsRemoved?: number } | undefined>;

  /** List MCP servers configured for the session. */
  listMcpServers?(): Promise<{ servers?: AgentMcpServerStatus[] } | undefined>;

  /** Begin an OAuth login flow for the named MCP server. */
  startMcpOauthLogin?(opts: AgentMcpOauthLoginOptions): Promise<unknown>;

  /** Read the persisted session title/name. */
  getName?(): Promise<{ name?: string } | undefined>;

  /** Persist a new session title/name. */
  setName?(opts: { name: string }): Promise<unknown>;
}

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

  /** List models available to the active backend account/subscription. */
  listModels(): Promise<AgentModelInfo[]>;

  /** List existing sessions known to the backend. */
  listSessions(): Promise<AgentSessionSummary[]>;

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
}

/**
 * Factory signature for tests and the staging backend manager: produce an
 * AgentBackend given the resolved env. Replaces the previous
 * `CopilotClientFactory` type while preserving callsite ergonomics.
 */
export type AgentBackendFactory = (
  options: AgentClientOptions | undefined,
) => AgentBackend;
