// CopilotBackend — AgentBackend implementation that delegates to
// `@github/copilot-sdk`.
//
// This file is the only place outside of agent-backend/index.ts that
// imports the Copilot SDK on the server side (apart from the per-tool
// legacy SDK tool registration and SDK-specific helpers which Step 2 owns).
// SessionManager and SessionRunner consume AgentBackend / AgentSession
// from this module and never reach for CopilotClient again.
//
// All previously-exposed rpc escape hatches (`backend.rpc`, `session.rpc`)
// are now hidden behind typed methods. Callers reach for typed methods like
// `forkSession`, `truncateHistory`, `getName`, etc.; this file knows about
// the underlying SDK rpc namespaces.

import {
  approveAll,
  CopilotClient,
} from "@github/copilot-sdk";

import { boundRpc, type AgentRpcName } from "./rpc-timeouts.js";
import type {
  AgentBackend,
  AgentBackendConnectionStatus,
  AgentBackendDisconnect,
  AgentBackendDisconnectReason,
  AgentBackgroundTask,
  AgentCapabilities,
  AgentCurrentModel,
  AgentElicitationResponse,
  AgentMcpOauthLoginOptions,
  AgentMcpServerStatus,
  AgentToolMetadata,
  AgentModelInfo,
  AgentPermissionPolicy,
  AgentSendArgs,
  AgentSlashCommandInfo,
  AgentSlashCommandInvocation,
  AgentSlashCommandList,
  AgentSlashCommandResult,
  AgentSession,
  AgentSessionConfig,
  AgentSessionEventHandler,
  AgentSessionSummary,
  AgentSetModelOptions,
  AgentUserInputResponse,
} from "./types.js";

const COPILOT_CAPABILITIES: AgentCapabilities = {
  resumeSession: true,
  streamingToolInput: true,
  costUsage: true,
  subAgents: true,
  images: true,
  // The Copilot SDK does not expose a stdin-write API to the Bridge today.
  // Claude Code (Step 3) will flip this to `true`.
  bidirectionalStdin: false,
  externalToolEvents: true,
  forkBoundaries: true,
  nativeBridgeTools: true,
  eagerNativeTools: true,
  toolMetadataWarmup: true,
};

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return values.length > 0 ? values : undefined;
}

/**
 * Map a Copilot SDK `TaskInfo` (agent or shell variant) to the backend-neutral
 * {@link AgentBackgroundTask}. Kept defensive because the `tasks` RPC is
 * `@experimental` and field presence varies across SDK builds.
 */
function mapCopilotTaskInfo(raw: any): AgentBackgroundTask {
  const kind = raw?.type === "shell" ? "shell" : "agent";
  const numericActiveTime = typeof raw?.activeTimeMs === "number" ? raw.activeTimeMs : undefined;
  return {
    kind,
    id: typeof raw?.id === "string" ? raw.id : "",
    toolCallId: normalizeString(raw?.toolCallId),
    description: normalizeString(raw?.description),
    status: typeof raw?.status === "string" ? raw.status : "unknown",
    executionMode: normalizeString(raw?.executionMode),
    agentType: normalizeString(raw?.agentType),
    startedAt: normalizeString(raw?.startedAt),
    completedAt: normalizeString(raw?.completedAt),
    activeTimeMs: numericActiveTime,
    idleSince: normalizeString(raw?.idleSince),
    model: normalizeString(raw?.model),
    error: normalizeString(raw?.error),
    prompt: normalizeString(raw?.prompt),
    result: normalizeString(raw?.result),
    latestResponse: normalizeString(raw?.latestResponse),
  };
}

function normalizeCopilotSlashCommandInfo(command: any): AgentSlashCommandInfo | null {
  const name = normalizeString(command?.name);
  const description = normalizeString(command?.description);
  if (!name || !description) return null;
  const input = command.input && typeof command.input === "object"
    ? {
        hint: normalizeString(command.input.hint) ?? "",
        ...(typeof command.input.required === "boolean" ? { required: command.input.required } : {}),
        ...(normalizeString(command.input.completion) ? { completion: command.input.completion } : {}),
        ...(typeof command.input.preserveMultilineInput === "boolean"
          ? { preserveMultilineInput: command.input.preserveMultilineInput }
          : {}),
      }
    : undefined;
  return {
    name,
    ...(normalizeStringArray(command.aliases) ? { aliases: normalizeStringArray(command.aliases) } : {}),
    description,
    kind: normalizeString(command.kind) ?? "unknown",
    ...(input ? { input } : {}),
    allowDuringAgentExecution: command.allowDuringAgentExecution === true,
    ...(typeof command.experimental === "boolean" ? { experimental: command.experimental } : {}),
  };
}

function normalizeCopilotSlashCommandList(result: any): AgentSlashCommandList {
  const commands = Array.isArray(result?.commands)
    ? result.commands
        .map(normalizeCopilotSlashCommandInfo)
        .filter((command: AgentSlashCommandInfo | null): command is AgentSlashCommandInfo => command !== null)
    : [];
  return { commands };
}

function normalizeCopilotSlashCommandResult(result: any): AgentSlashCommandResult {
  switch (result?.kind) {
    case "agent-prompt": {
      const prompt = normalizeString(result.prompt);
      if (!prompt) throw new Error("Slash command returned an empty agent prompt");
      const displayPrompt = normalizeString(result.displayPrompt);
      const mode = normalizeString(result.mode);
      return {
        kind: "send",
        prompt,
        ...(displayPrompt ? { displayPrompt } : {}),
        ...(mode ? { mode } : {}),
      };
    }
    case "text":
      return {
        kind: "text",
        text: normalizeString(result.text) ?? "",
        ...(typeof result.markdown === "boolean" ? { markdown: result.markdown } : {}),
        ...(typeof result.preserveAnsi === "boolean" ? { preserveAnsi: result.preserveAnsi } : {}),
      };
    case "completed":
      return {
        kind: "completed",
        ...(normalizeString(result.message) ? { message: result.message } : {}),
      };
    case "select-subcommand":
      return {
        kind: "select",
        command: normalizeString(result.command) ?? "",
        title: normalizeString(result.title) ?? "Select an option",
        options: Array.isArray(result.options) ? result.options : [],
      };
    default:
      throw new Error(`Unsupported slash command result: ${normalizeString(result?.kind) ?? "unknown"}`);
  }
}

/** Shared RPC guard so session- and backend-scoped calls report into one disconnect detector. */
interface CopilotRpcGuard {
  <T>(rpc: AgentRpcName, operation: () => Promise<T>): Promise<T>;
}

/**
 * Wraps a CopilotSession so the rest of the Bridge talks to AgentSession.
 * Method signatures intentionally mirror the SDK 1:1 — every typed method
 * delegates to the underlying rpc namespace, returning `undefined` when
 * the namespace is missing on older SDK builds. Every RPC the Bridge waits
 * on is bounded by {@link boundRpc}; a timeout feeds the backend's liveness
 * probe so a dead channel is detected instead of hanging callers forever.
 */
class CopilotAgentSession implements AgentSession {
  constructor(private readonly session: any, private readonly rpc: CopilotRpcGuard) {}

  get sessionId(): string {
    return this.session.sessionId;
  }

  send(args: AgentSendArgs): Promise<unknown> {
    return this.rpc("session.send", () => this.session.send(args));
  }

  sendAndWait(args: AgentSendArgs, timeoutMs?: number): Promise<unknown> {
    // Waits for the whole turn; callers own the timeout.
    return this.session.sendAndWait(args, timeoutMs);
  }

  abort(): Promise<unknown> {
    return this.rpc("session.abort", () => this.session.abort());
  }

  setModel(model: string, opts?: AgentSetModelOptions): Promise<unknown> {
    return this.rpc("session.setModel", () => this.session.setModel(model, opts));
  }

  disconnect(): Promise<unknown> | void {
    if (typeof this.session.disconnect !== "function") return undefined;
    return this.rpc("session.destroy", () => Promise.resolve(this.session.disconnect()));
  }

  on(handler: AgentSessionEventHandler): () => void {
    return this.session.on(handler);
  }

  async respondToUserInput(requestId: string, response: AgentUserInputResponse): Promise<boolean> {
    const handle = this.session?.rpc?.ui?.handlePendingUserInput;
    if (typeof handle !== "function") {
      throw new Error("Pending user input responses are not available in this Copilot SDK build");
    }
    const result = await this.rpc("session.respondToUserInput", () => handle.call(this.session.rpc.ui, { requestId, response }));
    return (result as any)?.success === true;
  }

  async tryRespondToElicitation(
    requestId: string,
    response: AgentElicitationResponse,
  ): Promise<boolean> {
    const handle = this.session?.rpc?.ui?.handlePendingElicitation;
    if (typeof handle !== "function") {
      throw new Error("Pending elicitation responses are not available in this Copilot SDK build");
    }
    const result = await this.rpc(
      "session.respondToElicitation",
      () => handle.call(this.session.rpc.ui, { requestId, result: response }),
    );
    return (result as any)?.success === true;
  }

  async setSendMode(opts: { mode: string }): Promise<unknown> {
    const setMode = this.session?.rpc?.mode?.set;
    if (typeof setMode !== "function") {
      throw new Error("Session mode switching is not available in this Copilot SDK build");
    }
    return this.rpc("session.setSendMode", () => setMode.call(this.session.rpc.mode, opts));
  }

  async invokeSlashCommand(command: AgentSlashCommandInvocation): Promise<AgentSlashCommandResult> {
    const invoke = this.session?.rpc?.commands?.invoke;
    if (typeof invoke !== "function") {
      throw new Error("Slash command invocation is not available in this agent backend");
    }
    const result = await this.rpc("session.invokeSlashCommand", () => invoke.call(this.session.rpc.commands, {
      name: command.name,
      ...(command.input ? { input: command.input } : {}),
    }));
    return normalizeCopilotSlashCommandResult(result);
  }

  async listSlashCommands(): Promise<AgentSlashCommandList | undefined> {
    const list = this.session?.rpc?.commands?.list;
    if (typeof list !== "function") return undefined;
    const result = await this.rpc("session.listSlashCommands", () => list.call(this.session.rpc.commands, {
      includeBuiltins: true,
      includeSkills: true,
      includeClientCommands: true,
    }));
    return normalizeCopilotSlashCommandList(result);
  }

  async getCurrentModel(): Promise<AgentCurrentModel | undefined> {
    const get = this.session?.rpc?.model?.getCurrent;
    if (typeof get !== "function") return undefined;
    return this.rpc("session.getCurrentModel", () => get.call(this.session.rpc.model));
  }

  async truncateHistory(opts: { eventId: string }): Promise<{ eventsRemoved?: number } | undefined> {
    const truncate = this.session?.rpc?.history?.truncate;
    if (typeof truncate !== "function") return undefined;
    return this.rpc("session.truncateHistory", () => truncate.call(this.session.rpc.history, opts));
  }

  async listMcpServers(): Promise<{ servers?: AgentMcpServerStatus[] } | undefined> {
    const list = this.session?.rpc?.mcp?.list;
    if (typeof list !== "function") return undefined;
    return this.rpc("session.listMcpServers", () => list.call(this.session.rpc.mcp));
  }

  async initializeTools(): Promise<unknown> {
    const initialize = this.session?.rpc?.tools?.initializeAndValidate;
    if (typeof initialize !== "function") return undefined;
    return this.rpc("session.initializeTools", () => initialize.call(this.session.rpc.tools));
  }

  async getCurrentToolMetadata(): Promise<{ tools?: AgentToolMetadata[] | null } | undefined> {
    const getCurrent = this.session?.rpc?.tools?.getCurrentMetadata;
    if (typeof getCurrent !== "function") return undefined;
    return this.rpc("session.getCurrentToolMetadata", () => getCurrent.call(this.session.rpc.tools));
  }

  async startMcpOauthLogin(opts: AgentMcpOauthLoginOptions): Promise<unknown> {
    const login = this.session?.rpc?.mcp?.oauth?.login;
    if (typeof login !== "function") {
      throw new Error("MCP OAuth login is not available in this Copilot SDK build");
    }
    return this.rpc("session.startMcpOauthLogin", () => login.call(this.session.rpc.mcp.oauth, opts));
  }

  async getName(): Promise<{ name?: string } | undefined> {
    const get = this.session?.rpc?.name?.get;
    if (typeof get !== "function") return undefined;
    return this.rpc("session.getName", () => get.call(this.session.rpc.name));
  }

  async setName(opts: { name: string }): Promise<unknown> {
    const set = this.session?.rpc?.name?.set;
    if (typeof set !== "function") {
      throw new Error("Session name RPC is not available in this Copilot SDK build");
    }
    return this.rpc("session.setName", () => set.call(this.session.rpc.name, opts));
  }

  async listTasks(): Promise<{ tasks?: AgentBackgroundTask[] } | undefined> {
    const list = this.session?.rpc?.tasks?.list;
    if (typeof list !== "function") return undefined;
    const result = await this.rpc("session.listTasks", () => list.call(this.session.rpc.tasks));
    const rawTasks = Array.isArray((result as any)?.tasks) ? (result as any).tasks : [];
    return { tasks: rawTasks.map(mapCopilotTaskInfo) };
  }

  async cancelTask(id: string): Promise<{ cancelled: boolean } | undefined> {
    const cancel = this.session?.rpc?.tasks?.cancel;
    if (typeof cancel !== "function") return undefined;
    const result = await this.rpc("session.cancelTask", () => cancel.call(this.session.rpc.tasks, { id }));
    return { cancelled: Boolean((result as any)?.cancelled) };
  }

  async removeTask(id: string): Promise<{ removed: boolean } | undefined> {
    const remove = this.session?.rpc?.tasks?.remove;
    if (typeof remove !== "function") return undefined;
    const result = await this.rpc("session.removeTask", () => remove.call(this.session.rpc.tasks, { id }));
    return { removed: Boolean((result as any)?.removed) };
  }

}

const PENDING_INTERACTION_PLACEHOLDER = async (): Promise<{ action: "cancel" }> => ({
  action: "cancel",
});

function prepareCopilotSessionConfig(config: AgentSessionConfig): {
  sdkConfig: Record<string, unknown>;
  pendingInteractionEvents: boolean;
} {
  const {
    pendingInteractionEvents = false,
    ...sdkConfig
  } = config;
  if (pendingInteractionEvents) {
    sdkConfig.onElicitationRequest = PENDING_INTERACTION_PLACEHOLDER;
  }
  return { sdkConfig, pendingInteractionEvents };
}

function wrapCopilotSession(session: any, pendingInteractionEvents: boolean, rpc: CopilotRpcGuard): AgentSession {
  if (pendingInteractionEvents) {
    // The placeholder makes the Node SDK advertise elicitation and register
    // event interest during create/resume. Remove it before exposing the
    // session so only Bridge transport listeners can answer runtime requests.
    session.registerElicitationHandler?.(undefined);
  }
  return new CopilotAgentSession(session, rpc);
}

function formatDisconnectDetail(error: unknown): string | undefined {
  if (error === undefined || error === null) return undefined;
  if (error instanceof Error) return error.message;
  if (Array.isArray(error)) {
    const [first] = error;
    return first instanceof Error ? first.message : first === undefined ? undefined : String(first);
  }
  return String(error);
}

/**
 * Wraps a CopilotClient as an AgentBackend. Constructor takes a
 * pre-built client so the factory can apply env / options resolution
 * in one place.
 *
 * Besides delegating, the backend watches the transport the SDK leaves
 * unobserved: the JSON-RPC connection close/error events, the runtime child
 * exiting, and stdin pipe errors. The SDK itself only flips `client.state`
 * on those, so without this every pending and future RPC would hang forever.
 */
export class CopilotBackend implements AgentBackend {
  readonly id = "copilot" as const;
  readonly capabilities: AgentCapabilities = COPILOT_CAPABILITIES;
  readonly permissionPolicy: AgentPermissionPolicy = approveAll;

  private readonly disconnectHandlers = new Set<(info: AgentBackendDisconnect) => void>();
  private lastDisconnect: AgentBackendDisconnect | undefined;
  private stopping = false;
  private detachTransportWatchers: (() => void) | undefined;
  private healthProbe: Promise<boolean> | undefined;
  private readonly logger: Pick<Console, "warn" | "error">;

  constructor(private readonly client: CopilotClient, options: { logger?: Pick<Console, "warn" | "error"> } = {}) {
    this.logger = options.logger ?? console;
  }

  private readonly rpc: CopilotRpcGuard = (name, operation) => boundRpc(name, operation, {
    onTimeout: (rpc, timeoutMs) => {
      this.logger.warn(`[copilot-backend] RPC ${rpc} timed out after ${timeoutMs}ms; probing backend liveness`);
      void this.probeHealth(undefined, `rpc-timeout:${rpc}`);
    },
  });

  async start(): Promise<unknown> {
    const result = await this.client.start();
    this.attachTransportWatchers();
    return result;
  }

  stop(): Promise<unknown> {
    this.stopping = true;
    this.detachTransportWatchers?.();
    return this.client.stop();
  }

  forceStop(): Promise<unknown> {
    this.stopping = true;
    this.detachTransportWatchers?.();
    const fn = (this.client as any).forceStop;
    if (typeof fn !== "function") return Promise.resolve();
    return fn.call(this.client);
  }

  onDisconnect(handler: (info: AgentBackendDisconnect) => void): () => void {
    this.disconnectHandlers.add(handler);
    return () => {
      this.disconnectHandlers.delete(handler);
    };
  }

  getConnectionStatus(): AgentBackendConnectionStatus {
    const client = this.client as any;
    const rawState = typeof client.state === "string" ? client.state : "unknown";
    const state: AgentBackendConnectionStatus["state"] = this.lastDisconnect
      ? "disconnected"
      : rawState === "connected" || rawState === "connecting" || rawState === "disconnected" || rawState === "error"
        ? rawState
        : "unknown";
    const pid = client.cliProcess?.pid;
    return {
      state,
      ...(typeof pid === "number" ? { pid } : {}),
      ...(this.lastDisconnect ? { lastDisconnect: this.lastDisconnect } : {}),
    };
  }

  /**
   * Ping the runtime over the RPC channel. Coalesces concurrent probes. A
   * failed probe marks the backend disconnected (once) so every caller sees
   * the same outcome.
   */
  probeHealth(timeoutMs?: number, reason = "health-probe"): Promise<boolean> {
    if (this.healthProbe) return this.healthProbe;
    const probe = (async (): Promise<boolean> => {
      if (this.stopping) return false;
      if (this.lastDisconnect) return false;
      const client = this.client as any;
      if (client.state !== "connected" || !client.connection) {
        this.emitDisconnect("health-probe-failed", `${reason}: client state is ${String(client.state)}`);
        return false;
      }
      try {
        await boundRpc("backend.ping", () => client.ping("bridge-health"), {}, timeoutMs);
        return true;
      } catch (error) {
        if (this.stopping) return false;
        const detail = error instanceof Error ? error.message : String(error);
        this.emitDisconnect(
          reason.startsWith("rpc-timeout") ? "rpc-timeout" : "health-probe-failed",
          `${reason}: ${detail}`,
        );
        return false;
      }
    })();
    this.healthProbe = probe;
    void probe.finally(() => {
      if (this.healthProbe === probe) this.healthProbe = undefined;
    });
    return probe;
  }

  private attachTransportWatchers(): void {
    this.detachTransportWatchers?.();
    const client = this.client as any;
    const disposers: Array<() => void> = [];
    const connection = client.connection;
    if (connection && typeof connection.onClose === "function") {
      const closeDisposable = connection.onClose(() => {
        this.emitDisconnect("connection-closed", "JSON-RPC connection closed");
      });
      disposers.push(() => closeDisposable?.dispose?.());
    }
    if (connection && typeof connection.onError === "function") {
      const errorDisposable = connection.onError((error: unknown) => {
        // Reader errors do not always end the stream; confirm with a probe
        // instead of declaring the backend dead on a single bad frame.
        this.logger.warn(`[copilot-backend] JSON-RPC connection error: ${formatDisconnectDetail(error) ?? "unknown"}`);
        void this.probeHealth(undefined, "connection-error");
      });
      disposers.push(() => errorDisposable?.dispose?.());
    }
    const child = client.cliProcess;
    if (child && typeof child.once === "function") {
      const onExit = (code: number | null, signal: string | null) => {
        this.emitDisconnect("process-exit", `runtime process exited (code=${code ?? "null"}, signal=${signal ?? "null"})`);
      };
      child.once("exit", onExit);
      disposers.push(() => child.off?.("exit", onExit));
      const stdin = child.stdin;
      if (stdin && typeof stdin.on === "function") {
        const onStdinError = (error: unknown) => {
          this.emitDisconnect("stdin-error", `stdin pipe error: ${formatDisconnectDetail(error) ?? "unknown"}`);
        };
        stdin.on("error", onStdinError);
        disposers.push(() => stdin.off?.("error", onStdinError));
      }
    }
    this.detachTransportWatchers = () => {
      for (const dispose of disposers) {
        try { dispose(); } catch { /* best-effort */ }
      }
      this.detachTransportWatchers = undefined;
    };
  }

  private emitDisconnect(reason: AgentBackendDisconnectReason, detail?: string): void {
    if (this.stopping || this.lastDisconnect) return;
    const info: AgentBackendDisconnect = {
      at: new Date().toISOString(),
      reason,
      ...(detail ? { detail } : {}),
    };
    this.lastDisconnect = info;
    this.detachTransportWatchers?.();
    this.logger.error(`[copilot-backend] Backend RPC channel lost (${reason}${detail ? `: ${detail}` : ""})`);
    for (const handler of [...this.disconnectHandlers]) {
      try {
        handler(info);
      } catch (error) {
        this.logger.error("[copilot-backend] Disconnect handler failed:", error);
      }
    }
  }

  async listModels(): Promise<AgentModelInfo[]> {
    const models = await this.rpc("backend.listModels", () => this.client.listModels());
    return models as AgentModelInfo[];
  }

  async listSessions(): Promise<AgentSessionSummary[]> {
    const sessions = await this.rpc("backend.listSessions", () => this.client.listSessions());
    return sessions as unknown as AgentSessionSummary[];
  }

  async checkSessionsInUse(sessionIds: readonly string[]): Promise<Set<string> | undefined> {
    const sessions = (this.client as any).rpc?.sessions;
    const checkInUse = sessions?.checkInUse;
    if (typeof checkInUse !== "function") return undefined;
    // This optional UI probe can queue behind active turns on the shared RPC
    // channel. A timeout means the indicator is unavailable, not that the
    // backend is dead; transport watchers and critical RPCs still detect loss.
    const result = await boundRpc(
      "backend.checkSessionsInUse",
      () => checkInUse.call(sessions, { sessionIds: [...sessionIds] }),
    );
    const inUse = Array.isArray((result as any)?.inUse)
      ? (result as any).inUse.filter((sessionId: unknown): sessionId is string => typeof sessionId === "string")
      : [];
    return new Set(inUse);
  }

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    const prepared = prepareCopilotSessionConfig(config);
    const session = await this.client.createSession(prepared.sdkConfig as any);
    return wrapCopilotSession(session, prepared.pendingInteractionEvents, this.rpc);
  }

  async resumeSession(sessionId: string, config: AgentSessionConfig): Promise<AgentSession> {
    const prepared = prepareCopilotSessionConfig(config);
    const session = await this.client.resumeSession(sessionId, prepared.sdkConfig as any);
    return wrapCopilotSession(session, prepared.pendingInteractionEvents, this.rpc);
  }

  deleteSession(sessionId: string): Promise<unknown> {
    return this.rpc("backend.deleteSession", () => this.client.deleteSession(sessionId) as Promise<unknown>);
  }

  getSessionMetadata(sessionId: string): Promise<unknown> {
    return this.rpc("backend.getSessionMetadata", () => this.client.getSessionMetadata(sessionId) as Promise<unknown>);
  }

  async forkSession(
    sourceSessionId: string,
    opts?: { toEventId?: string },
  ): Promise<{ sessionId: string }> {
    const fork = (this.client as any).rpc?.sessions?.fork;
    if (typeof fork !== "function") {
      throw new Error("Session fork is not available in this Copilot SDK build");
    }
    const params = opts?.toEventId
      ? { sessionId: sourceSessionId, toEventId: opts.toEventId }
      : { sessionId: sourceSessionId };
    return this.rpc("backend.forkSession", () => fork.call((this.client as any).rpc.sessions, params));
  }

  async getAccountQuota(): Promise<unknown> {
    const account = (this.client as any).rpc?.account;
    const getQuota = account?.getQuota;
    if (typeof getQuota !== "function") {
      throw new Error("Account quota lookup is not available in this Copilot SDK build");
    }
    return this.rpc("backend.getAccountQuota", () => getQuota.call(account, {}));
  }

  async getAccountAuth(): Promise<unknown> {
    const account = (this.client as any).rpc?.account;
    const getCurrentAuth = account?.getCurrentAuth;
    if (typeof getCurrentAuth !== "function") {
      throw new Error("Account auth lookup is not available in this Copilot SDK build");
    }
    return this.rpc("backend.getAccountAuth", () => getCurrentAuth.call(account));
  }
}
