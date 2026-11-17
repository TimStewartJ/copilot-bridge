// Backend-neutral interface over the agent SDK; payloads stay Copilot-shaped for now.

import type {
  CopilotClient,
  CopilotSession,
  ModelInfo,
  PermissionHandler,
  PermissionRequest,
  PermissionRequestResult,
  SectionOverride,
} from "@github/copilot-sdk";
import type { CopilotAccount } from "../../shared/copilot-accounts.js";
import type { CopilotModelContextMetadata } from "../../shared/copilot-context.js";
import type { SubagentPlan } from "../../shared/subagent-settings.js";
import type { RuntimeFenceOptions } from "./runtime-fence.js";

/** Optional features a backend supports; consumers degrade when a flag is false. */
export interface AgentCapabilities {
  /** `resumeSession(id, ...)` returns a live session that can stream new events. */
  resumeSession: boolean;
  /** Tool-call argument JSON is streamed incrementally (input_json_delta). */
  streamingToolInput: boolean;
  /** Backend emits usage/cost data per turn (input_tokens, output_tokens, cached, cost). */
  costUsage: boolean;
  /** Backend models sub-agents as first-class events (subagent.started/completed/failed). */
  subAgents: boolean;
  /** Backend accepts image attachments alongside prompts. */
  images: boolean;
  /** Backend accepts more messages on stdin mid-turn (stream-json input mode). */
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

/** Re-exported SDK shapes, so callers import from here and not @github/copilot-sdk. */
export type AgentModelInfo = Omit<ModelInfo, "supportedReasoningEfforts" | "defaultReasoningEffort">
  & Pick<CopilotModelContextMetadata, "selectionMode" | "reasoningEffortLabels">
  & {
    /** Reasoning levels, or a router's tiers (Copilot Fusion's Standard, High and Max). */
    supportedReasoningEfforts?: string[];
    defaultReasoningEffort?: string;
  };
export type AgentSectionOverride = SectionOverride;
// Step 3: replace these Copilot-shaped aliases with backend-neutral permission types.
export type AgentPermissionRequest = PermissionRequest;
export type AgentPermissionDecision = PermissionRequestResult;
export type AgentPermissionPolicy = PermissionHandler;

/** Loose create/resume config; still Copilot-shaped, as session-config-builder.ts produces it. */
export interface AgentSessionConfig {
  /** Surface native pending-interaction events without an in-process responder; may be ignored. */
  pendingInteractionEvents?: boolean;
  /** Applied after every create/resume (the runtime doesn't persist it) and on model changes. */
  subagents?: SubagentPlan;
  /** Experimental Fusion prompt-token limit, applied on create, resume and switch to Fusion. */
  fusionContextTokens?: number;
  [key: string]: unknown;
}

/** Options for `AgentSession.send(...)`; loose, as backends shape attachments differently. */
export interface AgentSendArgs {
  prompt: string;
  attachments?: unknown[];
  /** Copilot SDK: "immediate" steers a busy session; undefined queues normally. */
  mode?: "immediate";
  [extra: string]: unknown;
}

/** Answer to the switch preflight; if omitted the runtime may report `confirmation_required`. */
export type AgentModelCompactionDecision = "compact" | "cancel";

/** Options for `AgentSession.setModel(...)`. */
export interface AgentSetModelOptions {
  reasoningEffort?: string;
  contextTier?: string;
  compactionDecision?: AgentModelCompactionDecision;
  [extra: string]: unknown;
}

type CopilotModelSwitchTo = CopilotSession["rpc"]["model"]["switchTo"];

/** Copilot runtime `session.model.switchTo` result, including the compaction preflight. */
export type AgentModelSwitchResult = Awaited<ReturnType<CopilotModelSwitchTo>>;

type CopilotHistoryCompact = CopilotSession["rpc"]["history"]["compact"];

/** Copilot runtime `session.history.compact` result. `success: false` means nothing changed. */
export type AgentCompactionResult = Awaited<ReturnType<CopilotHistoryCompact>>;

export type AgentModelSwitchConfirmation = NonNullable<AgentModelSwitchResult["confirmation"]>;

type CopilotClassifyTrajectory = CopilotClient["rpc"]["taskAnalytics"]["classifyTrajectory"];

/** Trajectory classifier result for a chat: model-derived, for measurement, never for decisions. */
export type AgentTrajectoryClassifyResult = Awaited<ReturnType<CopilotClassifyTrajectory>>;
export type AgentTrajectoryClassification = AgentTrajectoryClassifyResult["classifications"][number];

export interface AgentTrajectoryClassifyRequest {
  /** The chat's events.jsonl records, parsed, in file order. */
  events: unknown[];
  /** Check the input locally only: free, no inference, no classifications. */
  validateOnly?: boolean;
  /** An earlier result for the identical log; only its failed rows run again. */
  previousResult?: AgentTrajectoryClassifyResult;
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

export interface AgentUsageMetrics {
  totalNanoAiu?: number;
  totalPremiumRequestCost: number;
  totalUserRequests: number;
  /** Model API calls across every model and agent in the session. */
  modelRequests?: number;
  /** Session-wide token counts summed over every model; input includes cache traffic. */
  tokens?: AgentUsageTokenTotals;
  apiDurationMs?: number;
  codeChanges?: AgentUsageCodeChanges;
}

export interface AgentUsageTokenTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

export interface AgentUsageCodeChanges {
  linesAdded: number;
  linesRemoved: number;
  filesModified: number;
}

export interface AgentMcpServerToolTokens {
  serverName: string;
  tokens: number;
}

export interface AgentContextInfo {
  systemTokens: number;
  conversationTokens: number;
  toolDefinitionsTokens: number;
  /** The MCP share of the tool definitions. */
  mcpToolsTokens?: number;
  /** What each MCP server's loaded tool definitions cost, largest first. */
  mcpServerTools?: AgentMcpServerToolTokens[];
  totalTokens: number;
  /** Advertised prompt allowance used for context displays. */
  limit?: number;
  promptTokenLimit?: number;
  /** Token count at which background compaction starts. */
  compactionThreshold?: number;
  bufferTokens?: number;
}

export interface AgentSessionRelease {
  /** Handle-release acknowledgement, not proof that background processes have exited. */
  status: "released" | "unsupported" | "uncertain";
  detail?: string;
}

/** The runtime's own account of what a session is doing right now. */
export interface AgentSessionActivity {
  /** The main agent is in a turn or continuation; false when idle, even with background work. */
  processing: boolean;
}

/** Required facade: methods always exist; unsupported calls resolve undefined or throw. */
export interface AgentSession {
  // No full-history RPC: one big reply kills the shared connection. Read events.jsonl instead.
  readonly sessionId: string;

  send(args: AgentSendArgs): Promise<unknown>;
  /** Sends and resolves on `session.idle`; pass null to wait without a timeout. */
  sendAndWait(args: AgentSendArgs, timeoutMs?: number | null): Promise<unknown>;
  abort(): Promise<unknown>;
  /** Returns the runtime switch result when the backend exposes it. */
  setModel(model: string, opts?: AgentSetModelOptions): Promise<AgentModelSwitchResult | undefined>;
  setReasoningEffort(reasoningEffort: string): Promise<void>;
  /** Makes an account active for new sessions; runtime-wide reads follow only after a restart. */
  switchAccount?(accountId: string): Promise<void>;
  /** Optional compatibility facade; lifecycle owners use release(). */
  disconnect?(): Promise<unknown> | void;
  /** Single-flight handle release after task RPCs settle; keeps history, proves no quiescence. */
  release(): Promise<AgentSessionRelease>;

  /** Subscribe to live session events. Returns an unsubscribe function. */
  on(handler: AgentSessionEventHandler): () => void;

  /** Resolve an ask_user request. False means another responder already won or the ID is stale. */
  respondToUserInput(requestId: string, response: AgentUserInputResponse): Promise<boolean>;

  /** Resolve an elicitation request. False means another responder won or the ID is stale. */
  tryRespondToElicitation(requestId: string, response: AgentElicitationResponse): Promise<boolean>;

  /** Asks the user a form on the Bridge's behalf from inside a tool; absent where unsupported. */
  requestElicitation?(request: { message: string; requestedSchema: unknown }): Promise<AgentElicitationResponse>;

  /** Switch the session's send mode. */
  setSendMode(opts: { mode: string }): Promise<unknown>;

  /** The session's current send mode. Resolves `undefined` when the runtime cannot say. */
  getSendMode?(): Promise<string | undefined>;

  /** Invoke a session-scoped slash command. */
  invokeSlashCommand(command: AgentSlashCommandInvocation): Promise<AgentSlashCommandResult>;

  /** List session-scoped slash commands. Resolves `undefined` when unsupported. */
  listSlashCommands(): Promise<AgentSlashCommandList | undefined>;

  /** Fetch the session's current model settings snapshot. Resolves `undefined` when unsupported. */
  getCurrentModel(): Promise<AgentCurrentModel | undefined>;

  /** Fetch accumulated live usage metrics. Resolves `undefined` when unsupported. */
  getUsageMetrics(): Promise<AgentUsageMetrics | undefined>;

  /** Authority on whether a run goes on: events.jsonl is shared with sub-agents and can't tell. */
  getActivity(): Promise<AgentSessionActivity | undefined>;

  /** The context window split; `undefined` if unsupported or before the prompt and tools exist. */
  getContextInfo(): Promise<AgentContextInfo | undefined>;

  /** Truncate the session's persisted event history at the named event. */
  truncateHistory(opts: { eventId: string }): Promise<{ eventsRemoved?: number } | undefined>;

  /** Safe mid-turn: the runtime compacts in the background and keeps later additions. */
  compactHistory?(opts?: { customInstructions?: string }): Promise<AgentCompactionResult | undefined>;

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

  /** Background agents and shells. Copilot rejects bad replies; others may resolve undefined. */
  listTasks(): Promise<{ tasks?: AgentBackgroundTask[] } | undefined>;

  /** Request cancellation of a tracked background task. */
  cancelTask(id: string): Promise<{ cancelled: boolean } | undefined>;

  /** Remove a completed or cancelled background task from backend tracking. */
  removeTask(id: string): Promise<{ removed: boolean } | undefined>;
}

/** Trimmed SDK TaskInfo; `kind` splits agents from shells, and only agents are rendered. */
export type AgentBackgroundTask = {
  kind: "agent" | "shell";
  id: string;
  toolCallId?: string;
  /** Agent tasks only: the name the agent was launched under. */
  displayName?: string;
  description?: string;
  /** running | idle | completed | failed | cancelled */
  status: string;
  /** sync | background */
  executionMode?: string;
  agentType?: string;
  startedAt?: string;
  completedAt?: string;
  activeTimeMs?: number;
  /** Agent tasks only: when the period of work in flight began. */
  activeStartedAt?: string;
  idleSince?: string;
  model?: string;
  error?: string;
  prompt?: string;
  result?: string;
  latestResponse?: string;
  /** Shell tasks only: the command line. */
  command?: string;
  /** Shell tasks only: attached | detached. Attached dies with its session's runtime handle. */
  attachmentMode?: string;
  /** Shell tasks only: the operating system's ID for the process running the command. */
  pid?: number;
} & Record<string, unknown>;

/** The `listMcpServers` fields the Bridge reads; the SDK adds more. */
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

export type AgentSessionSummary = {
  sessionId: string;
} & Record<string, unknown>;

/** Why the backend was replaced; `cleanup-stalled` means a session would not release. */
export type AgentBackendDisconnectReason =
  | "connection-closed"
  | "connection-error"
  | "process-exit"
  | "stdin-error"
  | "rpc-timeout"
  | "cleanup-stalled"
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
  /** Every process of the owned runtime captured so far, the spawned child first. */
  runtimePids?: number[];
  lastDisconnect?: AgentBackendDisconnect;
}

/** Owns a coding-agent SDK client process and the operations the Bridge manages sessions with. */
export interface AgentBackend {
  /** Stable id of the backend implementation, e.g. "copilot". */
  readonly id: "copilot" | (string & {});

  /** Capability flags surfaced to the UI / run loop for graceful degradation. */
  readonly capabilities: AgentCapabilities;

  /** Native permission handler; undefined when the backend approves natively. */
  readonly permissionPolicy: AgentPermissionPolicy | undefined;

  /** Boot the underlying CLI process and JSON-RPC channel. */
  start(): Promise<unknown>;

  /** Graceful shutdown. */
  stop(): Promise<void>;

  /** Force-stop. Optional because not every SDK exposes one. */
  forceStop?(): Promise<unknown>;
  /** Single-flight runtime-ownership boundary; rejects when ownership cannot be proved. */
  fence(options?: RuntimeFenceOptions): Promise<void>;

  /** Fires at most once on channel loss, never for an intentional stop. */
  onDisconnect?(handler: (info: AgentBackendDisconnect) => void): () => void;

  /** Current transport state for health reporting. */
  getConnectionStatus?(): AgentBackendConnectionStatus;

  /** Observe-only ping within the ping limit: never starts, recovers or disconnects a backend. */
  diagnosticPing?(): Promise<"responsive" | "timeout" | "failed" | "skipped">;

  /** RPC liveness probe; false if down or silent past `timeoutMs`, which fires onDisconnect. */
  probeHealth?(timeoutMs?: number, reason?: string): Promise<boolean>;

  /** List models available to the active backend account/subscription. */
  listModels(): Promise<AgentModelInfo[]>;

  /** List existing sessions known to the backend. */
  listSessions(): Promise<AgentSessionSummary[]>;

  /** Sessions held by another backend process; needs the experimental sessions.checkInUse RPC. */
  checkSessionsInUse?(sessionIds: readonly string[]): Promise<Set<string> | undefined>;

  /** Create a brand-new session. */
  createSession(config: AgentSessionConfig): Promise<AgentSession>;

  /** Resume an existing session by id. */
  resumeSession(sessionId: string, config: AgentSessionConfig): Promise<AgentSession>;

  /** Delete a session from the backend's storage. */
  deleteSession(sessionId: string): Promise<unknown>;

  /** Fetch backend-stored metadata for a session. */
  getSessionMetadata(sessionId: string): Promise<unknown>;

  /** Fork a session at an event; older SDK builds lack the `sessions.fork` RPC. */
  forkSession?(
    sourceSessionId: string,
    opts?: { toEventId?: string },
  ): Promise<{ sessionId: string }>;

  /** Live quota for the signed-in account, backend-shaped; the caller normalizes it. */
  getAccountQuota?(): Promise<unknown>;

  /** Current authentication state, including the backend's raw account passthrough. */
  getAccountAuth?(): Promise<unknown>;

  /** Fetches the Copilot user now (the backend's copy is from startup) for a fresh quota. */
  fetchAccountCopilotUser?(): Promise<unknown>;

  /** The accounts the runtime has signed in, without their tokens. */
  listAccounts?(): Promise<CopilotAccount[]>;

  /** Runs the trajectory classifiers on a chat; billed unless `validateOnly`. Optional: new RPC. */
  classifyTrajectory?(request: AgentTrajectoryClassifyRequest): Promise<AgentTrajectoryClassifyResult>;
}

export type AgentBackendFactory = () => AgentBackend;
