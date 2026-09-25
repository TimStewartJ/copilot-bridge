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

import { CopilotClient } from "@github/copilot-sdk";
import { ChildProcess } from "node:child_process";
import { isRecord } from "../../shared/is-record.js";
import type { SubagentSettings } from "../../shared/subagent-settings.js";

import {
  HYDRAFUSION_MODEL_ID,
  HYDRAFUSION_MODEL_NAME,
  isHydraFusionModel,
} from "../../shared/hydrafusion.js";
import { BACKEND_DISCONNECTED_MESSAGE } from "../backend-availability.js";
import { capDeadline, createDeadline, settleByDeadline, sleepUntilDeadline, type Deadline } from "../deadline.js";
import {
  getProcessIdentityStatuses,
  sampleProcessTree,
  terminateProcessTree,
  type ProcessIdentity,
  type ProcessTreeSnapshot,
  type ProcessTreeTerminationResult,
} from "../platform.js";
import {
  isRetryableRuntimeFenceError,
  RUNTIME_FENCE_BUDGET_MS,
  RUNTIME_FENCE_CHILD_EXIT_WAIT_MS,
  RUNTIME_FENCE_STARTUP_WAIT_MS,
  RuntimeFenceError,
  type RuntimeFenceObservation,
  type RuntimeFenceOptions,
} from "./runtime-fence.js";
import { boundRpc, isAgentRpcTimeoutError, type AgentRpcName } from "./rpc-timeouts.js";
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
  AgentModelSwitchResult,
  AgentToolMetadata,
  AgentModelInfo,
  AgentSendArgs,
  AgentSlashCommandInfo,
  AgentSlashCommandInvocation,
  AgentSlashCommandList,
  AgentSlashCommandResult,
  AgentSession,
  AgentSessionActivity,
  AgentSessionRelease,
  AgentSessionConfig,
  AgentSessionEventHandler,
  AgentSessionSummary,
  AgentSetModelOptions,
  AgentUsageMetrics,
  AgentContextInfo,
  AgentUsageCodeChanges,
  AgentUsageTokenTotals,
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

const HYDRAFUSION_MODEL: AgentModelInfo = {
  id: HYDRAFUSION_MODEL_ID,
  name: HYDRAFUSION_MODEL_NAME,
  selectionMode: "dynamic",
  capabilities: {
    supports: {
      vision: false,
      reasoningEffort: false,
    },
    limits: {
      max_context_window_tokens: 0,
    },
  },
  supportedReasoningEfforts: [],
};

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return values.length > 0 ? values : undefined;
}

function normalizeNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Sum the SDK's per-model request and token counters into session-wide totals. */
function sumModelMetrics(value: unknown): { requests: number; tokens: AgentUsageTokenTotals } | undefined {
  if (!isRecord(value)) return undefined;
  const tokens: AgentUsageTokenTotals = {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
  };
  let requests = 0;
  let models = 0;
  for (const metric of Object.values(value)) {
    if (!isRecord(metric)) continue;
    models += 1;
    const requestCounts = isRecord(metric.requests) ? metric.requests : undefined;
    requests += normalizeNonNegativeNumber(requestCounts?.count) ?? 0;
    const usage = isRecord(metric.usage) ? metric.usage : undefined;
    for (const key of Object.keys(tokens) as Array<keyof AgentUsageTokenTotals>) {
      tokens[key] += normalizeNonNegativeNumber(usage?.[key]) ?? 0;
    }
  }
  return models > 0 ? { requests, tokens } : undefined;
}

function readCodeChanges(value: unknown): AgentUsageCodeChanges | undefined {
  if (!isRecord(value)) return undefined;
  const linesAdded = normalizeNonNegativeNumber(value.linesAdded);
  const linesRemoved = normalizeNonNegativeNumber(value.linesRemoved);
  const filesModified = normalizeNonNegativeNumber(value.filesModifiedCount);
  if (linesAdded === undefined && linesRemoved === undefined && filesModified === undefined) return undefined;
  return { linesAdded: linesAdded ?? 0, linesRemoved: linesRemoved ?? 0, filesModified: filesModified ?? 0 };
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
 * the namespace is missing on older SDK builds, except native approval setup
 * and task lifecycle RPCs, which reject unsupported or malformed results.
 * RPC timeouts bound callers, not task ownership: raw task operations stay serialized until settlement.
 * Release deliberately has no timeout and joins one SDK detach forever. Its
 * acknowledgement does not prove that background processes have exited.
 */
class CopilotAgentSession implements AgentSession {
  private taskTail: Promise<void> = Promise.resolve();
  private releasePromise: Promise<AgentSessionRelease> | undefined;
  private toolPermissionsReady: Promise<void> | undefined;
  constructor(
    private readonly session: any,
    private readonly rpc: CopilotRpcGuard,
    private readonly onBackendDisconnect: (
      handler: (info: AgentBackendDisconnect) => void,
    ) => () => void,
    private readonly useNativeToolPermissions: boolean,
  ) {}

  get sessionId(): string {
    return this.session.sessionId;
  }

  private async withToolPermissions<T>(work: () => Promise<T>): Promise<T> {
    if (this.releasePromise) throw new Error("Session tool intake is closed for release");
    if (this.useNativeToolPermissions) {
      // Configure the existing auto-approval policy once, instead of answering every prompt over RPC.
      await (this.toolPermissionsReady ??= this.rpc("session.setPermissionMode", async () => {
        const permissions = this.session?.rpc?.permissions;
        if (typeof permissions?.setMode !== "function") {
          throw new Error("Native tool permission mode is unavailable in this Copilot SDK build");
        }
        const result: unknown = await permissions.setMode({ mode: "allow-all" });
        if (!isRecord(result) || result.success !== true || result.mode !== "allow-all") {
          throw new Error("Copilot runtime did not enable native tool approvals; check its managed permission policy");
        }
      }));
    }
    if (this.releasePromise) throw new Error("Session tool intake is closed for release");
    return work();
  }

  send(args: AgentSendArgs): Promise<unknown> {
    return this.withToolPermissions(() => this.rpc("session.send", () => this.session.send(args)));
  }

  sendAndWait(args: AgentSendArgs, timeoutMs?: number | null): Promise<unknown> {
    return this.withToolPermissions(() => this.sendAndWaitReady(args, timeoutMs));
  }

  private sendAndWaitReady(args: AgentSendArgs, timeoutMs?: number | null): Promise<unknown> {
    if (timeoutMs !== null) {
      // Waits for the whole turn; callers own the timeout.
      return this.session.sendAndWait(args, timeoutMs);
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      let sendCompleted = false;
      let idleObserved = false;
      let lastAssistantMessage: unknown;
      let unsubscribeSession = () => {};
      let unsubscribeBackend = () => {};
      const settle = (complete: () => void) => {
        if (settled) return;
        settled = true;
        unsubscribeSession();
        unsubscribeBackend();
        complete();
      };
      const resolveIfComplete = () => {
        if (sendCompleted && idleObserved) {
          settle(() => resolve(lastAssistantMessage));
        }
      };
      unsubscribeSession = this.session.on((event: any) => {
        if (event?.type === "assistant.message") {
          lastAssistantMessage = event;
        } else if (event?.type === "session.idle") {
          idleObserved = true;
          resolveIfComplete();
        } else if (event?.type === "session.error") {
          const error = new Error(event?.data?.message ?? "Agent session failed.");
          if (typeof event?.data?.stack === "string") error.stack = event.data.stack;
          settle(() => reject(error));
        }
      });
      unsubscribeBackend = this.onBackendDisconnect((info) => {
        const detail = info.detail ? `: ${info.detail}` : "";
        settle(() => reject(new Error(
          `${BACKEND_DISCONNECTED_MESSAGE} (${info.reason}${detail})`,
        )));
      });
      if (!settled) {
        void Promise.resolve(this.session.send(args))
          .then(() => {
            sendCompleted = true;
            resolveIfComplete();
          })
          .catch((error) => settle(() => reject(error)));
      }
    });
  }

  abort(): Promise<unknown> {
    return this.rpc("session.abort", () => this.session.abort());
  }

  async setModel(model: string, opts?: AgentSetModelOptions): Promise<AgentModelSwitchResult | undefined> {
    // SDK session.setModel() awaits model.switchTo but discards the result, which hides the compaction preflight.
    const switchTo = this.session?.rpc?.model?.switchTo;
    if (typeof switchTo !== "function") {
      await this.rpc("session.setModel", () => this.session.setModel(model, opts));
      return undefined;
    }
    return this.rpc("session.setModel", () => switchTo.call(this.session.rpc.model, { ...opts, modelId: model }));
  }

  disconnect(): Promise<AgentSessionRelease> {
    return this.release();
  }

  release(): Promise<AgentSessionRelease> {
    this.releasePromise ??= this.taskTail.then(async () => {
      if (typeof this.session.disconnect !== "function") {
        return { status: "unsupported", detail: "SDK session disconnect is unavailable" };
      }
      await this.session.disconnect();
      return { status: "released" };
    });
    return this.releasePromise;
  }

  private taskRpc<T>(name: AgentRpcName, operation: () => Promise<T>): Promise<T> {
    if (this.releasePromise) return Promise.reject(new Error("Session task intake is closed for release"));
    const raw = this.taskTail.then(operation);
    // The caller's RPC timeout does not relinquish the underlying task-operation slot.
    this.taskTail = raw.then(() => undefined, () => undefined);
    return this.rpc(name, () => raw);
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

  invokeSlashCommand(command: AgentSlashCommandInvocation): Promise<AgentSlashCommandResult> {
    return this.withToolPermissions(async () => {
      const invoke = this.session?.rpc?.commands?.invoke;
      if (typeof invoke !== "function") {
        throw new Error("Slash command invocation is not available in this agent backend");
      }
      const result = await this.rpc("session.invokeSlashCommand", () => invoke.call(this.session.rpc.commands, {
        name: command.name,
        ...(command.input ? { input: command.input } : {}),
      }));
      return normalizeCopilotSlashCommandResult(result);
    });
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

  async getUsageMetrics(): Promise<AgentUsageMetrics | undefined> {
    const getMetrics = this.session?.rpc?.usage?.getMetrics;
    if (typeof getMetrics !== "function") return undefined;
    const result = await this.rpc(
      "session.getUsageMetrics",
      () => getMetrics.call(this.session.rpc.usage),
    ) as {
      totalNanoAiu?: unknown;
      totalPremiumRequestCost?: unknown;
      totalUserRequests?: unknown;
      totalApiDurationMs?: unknown;
      modelMetrics?: unknown;
      codeChanges?: unknown;
    };
    const metrics: AgentUsageMetrics = {
      totalNanoAiu: normalizeNonNegativeNumber(result?.totalNanoAiu),
      totalPremiumRequestCost: normalizeNonNegativeNumber(result?.totalPremiumRequestCost) ?? 0,
      totalUserRequests: normalizeNonNegativeNumber(result?.totalUserRequests) ?? 0,
    };
    const apiDurationMs = normalizeNonNegativeNumber(result?.totalApiDurationMs);
    if (apiDurationMs !== undefined) metrics.apiDurationMs = apiDurationMs;
    const modelTotals = sumModelMetrics(result?.modelMetrics);
    if (modelTotals) {
      metrics.modelRequests = modelTotals.requests;
      metrics.tokens = modelTotals.tokens;
    }
    const codeChanges = readCodeChanges(result?.codeChanges);
    if (codeChanges) metrics.codeChanges = codeChanges;
    return metrics;
  }

  async getActivity(): Promise<AgentSessionActivity | undefined> {
    const isProcessing = this.session?.rpc?.metadata?.isProcessing;
    if (typeof isProcessing !== "function") return undefined;
    const result = await this.rpc(
      "session.getActivity",
      () => isProcessing.call(this.session.rpc.metadata),
    ) as { processing?: unknown };
    if (typeof result?.processing !== "boolean") throw new Error("Malformed Copilot session activity response");
    return { processing: result.processing };
  }

  async getContextInfo(opts: { promptTokenLimit: number }): Promise<AgentContextInfo | undefined> {
    const contextInfo = this.session?.rpc?.metadata?.contextInfo;
    if (typeof contextInfo !== "function") return undefined;
    const result = await this.rpc(
      "session.getContextInfo",
      () => contextInfo.call(this.session.rpc.metadata, {
        promptTokenLimit: Math.max(0, Math.floor(opts.promptTokenLimit)),
        outputTokenLimit: 0,
      }),
    ) as { contextInfo?: unknown };
    const info = isRecord(result?.contextInfo) ? result.contextInfo : undefined;
    if (!info) return undefined;
    const read = (key: string) => normalizeNonNegativeNumber(info[key]);
    const systemTokens = read("systemTokens");
    const conversationTokens = read("conversationTokens");
    const toolDefinitionsTokens = read("toolDefinitionsTokens");
    if (systemTokens === undefined || conversationTokens === undefined || toolDefinitionsTokens === undefined) return undefined;
    return {
      systemTokens,
      conversationTokens,
      toolDefinitionsTokens,
      mcpToolsTokens: read("mcpToolsTokens"),
      totalTokens: read("totalTokens") ?? systemTokens + conversationTokens + toolDefinitionsTokens,
      promptTokenLimit: read("promptTokenLimit"),
      compactionThreshold: read("compactionThreshold"),
    };
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

  initializeTools(): Promise<unknown> {
    return this.withToolPermissions(async () => {
      const initialize = this.session?.rpc?.tools?.initializeAndValidate;
      if (typeof initialize !== "function") return undefined;
      return this.rpc("session.initializeTools", () => initialize.call(this.session.rpc.tools));
    });
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
    if (typeof list !== "function") throw new Error("Session task listing is unavailable in this Copilot SDK build");
    const result = await this.taskRpc("session.listTasks", () => list.call(this.session.rpc.tasks));
    if (typeof result !== "object" || result === null || !("tasks" in result)
      || !Array.isArray(result.tasks) || result.tasks.some((task: unknown) =>
      typeof task !== "object" || task === null || !("id" in task)
      || typeof task.id !== "string" || !task.id.trim())) {
      throw new Error("Malformed Copilot task list response");
    }
    const rawTasks = result.tasks;
    return { tasks: rawTasks.map(mapCopilotTaskInfo) };
  }

  async cancelTask(id: string): Promise<{ cancelled: boolean } | undefined> {
    const cancel = this.session?.rpc?.tasks?.cancel;
    if (typeof cancel !== "function") throw new Error("Session task cancellation is unavailable in this Copilot SDK build");
    const result = await this.taskRpc("session.cancelTask", () => cancel.call(this.session.rpc.tasks, { id }));
    if (typeof result !== "object" || result === null || !("cancelled" in result)
      || typeof result.cancelled !== "boolean") throw new Error("Malformed Copilot task cancellation response");
    return { cancelled: result.cancelled };
  }

  async removeTask(id: string): Promise<{ removed: boolean } | undefined> {
    const remove = this.session?.rpc?.tasks?.remove;
    if (typeof remove !== "function") throw new Error("Session task removal is unavailable in this Copilot SDK build");
    const result = await this.taskRpc("session.removeTask", () => remove.call(this.session.rpc.tasks, { id }));
    if (typeof result !== "object" || result === null || !("removed" in result)
      || typeof result.removed !== "boolean") throw new Error("Malformed Copilot task removal response");
    return { removed: result.removed };
  }

}

const PENDING_INTERACTION_PLACEHOLDER = async (): Promise<{ action: "cancel" }> => ({
  action: "cancel",
});
const PENDING_INTERACTION_ASK_USER_VARIANT = "elicitation";

function prepareCopilotSessionConfig(config: AgentSessionConfig): {
  sdkConfig: Record<string, unknown>;
  pendingInteractionEvents: boolean;
  useNativeToolPermissions: boolean;
  subagents: SubagentSettings | undefined;
} {
  const {
    pendingInteractionEvents = false,
    subagents,
    ...sdkConfig
  } = config;
  // Apply on every create/resume, including helpers and sessions with a different model.
  sdkConfig.toolSearch = { enabled: false };
  if (isHydraFusionModel(sdkConfig.model)) {
    delete sdkConfig.reasoningEffort;
    delete sdkConfig.contextTier;
    delete sdkConfig.modelCapabilities;
    sdkConfig.enableExperimentalMode = true;
  }
  if (pendingInteractionEvents) {
    sdkConfig.onElicitationRequest = PENDING_INTERACTION_PLACEHOLDER;
    sdkConfig.askUserVariant = PENDING_INTERACTION_ASK_USER_VARIANT;
  }
  return {
    sdkConfig,
    pendingInteractionEvents,
    useNativeToolPermissions: !sdkConfig.onPermissionRequest,
    subagents,
  };
}

function wrapCopilotSession(
  session: any,
  pendingInteractionEvents: boolean,
  rpc: CopilotRpcGuard,
  onBackendDisconnect: (handler: (info: AgentBackendDisconnect) => void) => () => void,
  useNativeToolPermissions: boolean,
): AgentSession {
  if (pendingInteractionEvents) {
    // The placeholder makes the Node SDK advertise elicitation and register
    // event interest during create/resume. Remove it before exposing the
    // session so only Bridge transport listeners can answer runtime requests.
    session.registerElicitationHandler?.(undefined);
  }
  return new CopilotAgentSession(session, rpc, onBackendDisconnect, useNativeToolPermissions);
}

/** A runtime whose transport still looks alive must miss this many consecutive pings before it is declared lost. */
export const BACKEND_PING_ATTEMPTS = 3;
export const BACKEND_PING_RETRY_DELAY_MS = 1_000;

function identityKey(identity: ProcessIdentity): string {
  return `${identity.pid}:${identity.startMarker}`;
}

/**
 * Termination failures that prove nothing about the runtime: the process table could not be
 * observed in time, or the kill command ran out of time. A later attempt may still succeed.
 */
function isRetryableTerminationFailure(result: Extract<ProcessTreeTerminationResult, { ok: false }>): boolean {
  return result.status === "snapshot-unavailable"
    || result.status === "deadline-exceeded"
    || (result.status === "kill-failed" && result.commandTimedOut === true);
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
  readonly permissionPolicy = undefined;

  private readonly disconnectHandlers = new Set<(info: AgentBackendDisconnect) => void>();
  private lastDisconnect: AgentBackendDisconnect | undefined;
  private stopping = false;
  private detachTransportWatchers: (() => void) | undefined;
  private healthProbe: Promise<boolean> | undefined;
  private readonly logger: Pick<Console, "warn" | "error">;
  private startPromise: Promise<unknown> | undefined;
  /** Set once by the first fence request and never cleared: a fenced backend never starts again. */
  private fenceRequested = false;
  /** The current fence attempt. Cleared only after a retryable failure so a later caller can try again. */
  private fencePromise: Promise<void> | undefined;
  /**
   * Processes a failed fence attempt may already have signalled but did not prove gone. The next
   * attempt must re-check them before acknowledging: killing a parent orphans its surviving
   * children, so the owned tree the next attempt starts from may no longer reach them.
   */
  private unverifiedFenceIdentities: ProcessIdentity[] = [];
  private ownedChild: ChildProcess | undefined;
  private ownedTree: ProcessTreeSnapshot | null = null;
  private readonly localStdioOwnership: boolean;
  private readonly startClient: () => Promise<void>;

  constructor(private readonly client: CopilotClient, options: {
    logger?: Pick<Console, "warn" | "error">;
    /** Set only by the factory for the pinned, locally owning stdio runtime. */
    localStdioOwnership?: boolean;
  } = {}) {
    this.logger = options.logger ?? console;
    this.startClient = client.start.bind(client);
    this.localStdioOwnership = options.localStdioOwnership === true;
    if (this.localStdioOwnership) {
      // SDK create/resume can implicitly start a client; route those through the same fence guard.
      client.start = () => this.start().then(() => undefined);
      const forceStop = client.forceStop.bind(client);
      client.forceStop = async () => {
        await this.captureOwnedTree();
        return forceStop();
      };
      const descriptor = Object.getOwnPropertyDescriptor(client, "cliProcess");
      if (descriptor?.configurable && "value" in descriptor) {
        let child: unknown = descriptor.value;
        Object.defineProperty(client, "cliProcess", {
          configurable: true,
          enumerable: descriptor.enumerable,
          get: () => child,
          set: (value: unknown) => {
            child = value;
            if (value instanceof ChildProcess) this.ownedChild = value;
          },
        });
        if (child instanceof ChildProcess) this.ownedChild = child;
      }
    }
  }

  private readonly rpc: CopilotRpcGuard = (name, operation) => boundRpc(name, operation, {
    onTimeout: (rpc, timeoutMs) => {
      this.logger.warn(`[copilot-backend] RPC ${rpc} timed out after ${timeoutMs}ms; probing backend liveness`);
      void this.probeHealth(undefined, `rpc-timeout:${rpc}`);
    },
  });

  start(): Promise<unknown> {
    if (this.fenceRequested) return Promise.reject(new Error("Cannot start a fenced backend"));
    this.startPromise ??= (async () => {
      const result = await this.startClient();
      await this.captureOwnedTree(createDeadline(RUNTIME_FENCE_STARTUP_WAIT_MS));
      if (!this.stopping) this.attachTransportWatchers();
      return result;
    })();
    return this.startPromise;
  }

  fence(options: RuntimeFenceOptions = {}): Promise<void> {
    this.fenceRequested = true;
    if (!this.fencePromise) {
      const attempt = this.fenceOwnedRuntime(options.deadline ?? createDeadline(RUNTIME_FENCE_BUDGET_MS), options.onPhase);
      this.fencePromise = attempt;
      void attempt.catch((error: unknown) => {
        if (this.fencePromise === attempt && isRetryableRuntimeFenceError(error)) this.fencePromise = undefined;
      });
    }
    return this.fencePromise;
  }

  private async captureOwnedTree(deadline = createDeadline(2_000)): Promise<void> {
    if (this.localStdioOwnership && this.ownedChild?.pid) {
      const tree = await sampleProcessTree(this.ownedChild.pid, deadline);
      if (tree) {
        const previous = this.ownedTree;
        if (previous?.root.pid === tree.root.pid && previous.root.startMarker === tree.root.startMarker) {
          for (const identity of previous.descendants) {
            if (!tree.descendants.some((entry) => entry.pid === identity.pid && entry.startMarker === identity.startMarker)) {
              tree.descendants.push(identity);
            }
          }
        }
        this.ownedTree = tree;
      } else if (this.ownedChild.exitCode === null && this.ownedChild.signalCode === null) {
        this.logger.warn("[copilot-backend] Could not capture the local stdio runtime identity; replacement remains gated on verified fencing");
      }
    }
  }

  private async fenceOwnedRuntime(
    deadline: Deadline,
    onPhase?: (observation: RuntimeFenceObservation) => void,
  ): Promise<void> {
    this.stopping = true;
    this.detachTransportWatchers?.();
    const connection = Reflect.get(this.client, "connectionConfig");
    if (!this.localStdioOwnership || Reflect.get(this.client, "isExternalServer") !== false
      || Reflect.get(this.client, "ffiHost") || connection?.kind !== "stdio") {
      throw new RuntimeFenceError("Cannot fence an external, FFI, or unknown runtime owner", false);
    }
    const starting = this.startPromise;
    if (!starting) return;
    const startupStartedAt = performance.now();
    const startup = await settleByDeadline(() => starting, capDeadline(deadline, RUNTIME_FENCE_STARTUP_WAIT_MS));
    onPhase?.({ phase: "startup", durationMs: performance.now() - startupStartedAt,
      outcome: startup.status === "fulfilled" ? "completed" : "failed",
      ...(startup.status === "rejected" ? { error: formatDisconnectDetail(startup.error) } : {}),
    });
    if (startup.status === "timed-out") throw new RuntimeFenceError("Cannot fence while SDK startup is still pending", true);
    const child = this.ownedChild;
    if (child && !this.ownedTree && child.exitCode === null && child.signalCode === null) {
      // The startup capture can fail on a loaded host. A child whose exit has not been
      // observed cannot have had its PID recycled, so its current tree is still ours.
      await this.captureOwnedTree(deadline);
      if (!this.ownedTree) {
        throw new RuntimeFenceError("Runtime fencing failed: snapshot-unavailable: could not capture the owned runtime process tree", true);
      }
    }
    // The loader's exit alone is not proof that its native runtime child exited.
    if (!child || !this.ownedTree || this.ownedTree.descendants.length === 0) {
      throw new RuntimeFenceError("Cannot prove ownership of the native stdio runtime process tree", false);
    }
    const ownedIdentities = this.ownedTree.descendants.concat(this.ownedTree.root);
    const owned = new Set(ownedIdentities.map(identityKey));
    const retained = (await this.recheckUnverifiedFenceIdentities(deadline, onPhase))
      .filter((identity) => !owned.has(identityKey(identity)));
    // Sampling is breadth-first. Fence each native subtree once, then let the
    // loader reap it before fencing the loader. Retained orphan identities remain
    // in the list and still require their own identity-verified termination.
    const identities = [...this.ownedTree.descendants, ...retained, this.ownedTree.root];
    const verified = new Set<string>();
    for (const identity of identities) {
      const key = identityKey(identity);
      if (verified.has(key)) continue;
      const result = await terminateProcessTree(identity, deadline, onPhase);
      if (!result.ok) {
        this.retainUnverifiedFenceIdentities([...(result.snapshot?.descendants ?? []), ...(result.survivors ?? [])]);
        if (result.status !== "survivors" || !result.survivors?.length) {
          throw new RuntimeFenceError(
            `Runtime fencing failed: ${result.status}${result.error ? `: ${result.error}` : ""}`,
            isRetryableTerminationFailure(result),
          );
        }
        await this.waitForFencedSurvivors(result.survivors, deadline, onPhase);
      }
      verified.add(key);
      for (const entry of result.snapshot?.descendants ?? []) {
        verified.add(identityKey(entry));
      }
    }
    if (child.exitCode === null && child.signalCode === null) {
      const exitStartedAt = performance.now();
      let onExit = () => {};
      try {
        const exited = await settleByDeadline(() => new Promise<void>((resolve) => {
          onExit = resolve;
          child.once("exit", onExit);
        }), capDeadline(deadline, RUNTIME_FENCE_CHILD_EXIT_WAIT_MS));
        onPhase?.({ phase: "child-exit", durationMs: performance.now() - exitStartedAt,
          outcome: exited.status === "fulfilled" ? "completed" : "failed", pid: child.pid });
        if (exited.status !== "fulfilled") {
          throw new RuntimeFenceError("Runtime process tree terminated but SDK child exit is unconfirmed", true);
        }
      } finally {
        child.off("exit", onExit);
      }
    }
    this.unverifiedFenceIdentities = [];
  }

  private retainUnverifiedFenceIdentities(identities: readonly ProcessIdentity[]): void {
    const known = new Set(this.unverifiedFenceIdentities.map(identityKey));
    for (const identity of identities) {
      const key = identityKey(identity);
      if (known.has(key)) continue;
      known.add(key);
      this.unverifiedFenceIdentities.push(identity);
    }
  }

  /**
   * Checks every process a previous attempt left unverified with one process-table read.
   * Returns the ones still alive, which this attempt must terminate. An unreadable status
   * proves nothing either way, so it fails the attempt without acknowledging ownership.
   */
  private async recheckUnverifiedFenceIdentities(
    deadline: Deadline,
    onPhase?: (observation: RuntimeFenceObservation) => void,
  ): Promise<ProcessIdentity[]> {
    const retained = this.unverifiedFenceIdentities;
    if (retained.length === 0) return [];
    const startedAt = performance.now();
    const statuses = await getProcessIdentityStatuses(retained, deadline);
    const unknown = retained.find((identity) => {
      const status = statuses.get(identity);
      return !status || status === "unknown";
    });
    onPhase?.({ phase: "survivors", durationMs: performance.now() - startedAt,
      outcome: unknown ? "failed" : "completed" });
    if (unknown) {
      throw new RuntimeFenceError(`Runtime fencing failed: survivors (${unknown.pid}, unknown)`, true);
    }
    this.unverifiedFenceIdentities = retained.filter((identity) => statuses.get(identity) === "alive");
    return this.unverifiedFenceIdentities;
  }

  private async waitForFencedSurvivors(
    survivors: ProcessIdentity[],
    deadline: Deadline,
    onPhase?: (observation: RuntimeFenceObservation) => void,
  ): Promise<void> {
    const startedAt = performance.now();
    let pending = survivors;
    let uncertain = false;
    try {
      do {
        const statuses = await getProcessIdentityStatuses(pending, deadline);
        uncertain = false;
        pending = pending.filter((identity) => {
          const status = statuses.get(identity);
          if (!status || status === "unknown") uncertain = true;
          return !status || status === "unknown" || status === "alive";
        });
        if (pending.length === 0) return;
      } while (await sleepUntilDeadline(100, deadline));
      throw new RuntimeFenceError(
        `Runtime fencing failed: survivors (${pending.map((identity) => identity.pid).join(", ")}, ${uncertain ? "unknown" : "alive"})`,
        uncertain,
      );
    } finally {
      onPhase?.({ phase: "survivors", durationMs: performance.now() - startedAt,
        outcome: pending.length === 0 ? "completed" : "failed" });
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.detachTransportWatchers?.();
    await this.captureOwnedTree();
    const errors = await this.client.stop();
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `Copilot SDK stop reported ${errors.length} cleanup error${errors.length === 1 ? "" : "s"}`,
      );
    }
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

  async diagnosticPing(): Promise<"responsive" | "timeout" | "failed" | "skipped"> {
    if (this.fenceRequested || this.stopping || this.lastDisconnect
      || Reflect.get(this.client, "state") !== "connected" || !Reflect.get(this.client, "connection")) {
      return "skipped";
    }
    try {
      await boundRpc("backend.ping", () => this.client.ping("bridge-diagnostics"), {}, 5_000);
      return "responsive";
    } catch (error) {
      return isAgentRpcTimeoutError(error) ? "timeout" : "failed";
    }
  }

  /**
   * Ping the runtime over the RPC channel. Coalesces concurrent probes. A
   * single slow ping on a loaded host is not proof of loss, so while the
   * transport still looks alive the probe retries timed-out pings and only
   * declares the backend disconnected (once) after consecutive misses. A
   * closed transport, exited process, or non-timeout failure still reports
   * immediately.
   */
  probeHealth(timeoutMs?: number, reason = "health-probe"): Promise<boolean> {
    if (this.healthProbe) return this.healthProbe;
    const probe = (async (): Promise<boolean> => {
      for (let attempt = 1; ; attempt++) {
        if (this.stopping) return false;
        if (this.lastDisconnect) return false;
        const client = this.client as any;
        if (client.state !== "connected" || !client.connection) {
          this.emitDisconnect("health-probe-failed", `${reason}: client state is ${String(client.state)}`);
          return false;
        }
        try {
          await boundRpc("backend.ping", () => client.ping("bridge-health"), {}, timeoutMs);
          if (attempt > 1) {
            this.logger.warn(`[copilot-backend] ${reason}: backend.ping answered on attempt ${attempt}/${BACKEND_PING_ATTEMPTS}; keeping the backend`);
          }
          return true;
        } catch (error) {
          if (this.stopping) return false;
          const detail = error instanceof Error ? error.message : String(error);
          if (isAgentRpcTimeoutError(error) && attempt < BACKEND_PING_ATTEMPTS) {
            this.logger.warn(
              `[copilot-backend] ${reason}: backend.ping timed out (attempt ${attempt}/${BACKEND_PING_ATTEMPTS}); retrying before declaring the backend lost`,
            );
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, BACKEND_PING_RETRY_DELAY_MS);
              timer.unref?.();
            });
            continue;
          }
          this.emitDisconnect(
            reason.startsWith("rpc-timeout") ? "rpc-timeout" : "health-probe-failed",
            `${reason}: ${detail}${attempt > 1 ? ` (${attempt} consecutive pings)` : ""}`,
          );
          return false;
        }
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

  private subscribeSessionDisconnect(handler: (info: AgentBackendDisconnect) => void): () => void {
    if (this.lastDisconnect) {
      handler(this.lastDisconnect);
      return () => {};
    }
    return this.onDisconnect(handler);
  }

  async listModels(): Promise<AgentModelInfo[]> {
    const models = await this.rpc("backend.listModels", () => this.client.listModels());
    if (!models.some((model) => isHydraFusionModel(model.id))) {
      return [...models, HYDRAFUSION_MODEL] as AgentModelInfo[];
    }
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
    if (this.fenceRequested) throw new Error("Cannot create a session on a fenced backend");
    const prepared = prepareCopilotSessionConfig(config);
    const session = await this.client.createSession(prepared.sdkConfig as any);
    await this.applySubagentSettings(session, prepared.subagents);
    return wrapCopilotSession(
      session,
      prepared.pendingInteractionEvents,
      this.rpc,
      (handler) => this.subscribeSessionDisconnect(handler),
      prepared.useNativeToolPermissions,
    );
  }

  async resumeSession(sessionId: string, config: AgentSessionConfig): Promise<AgentSession> {
    if (this.fenceRequested) throw new Error("Cannot resume a session on a fenced backend");
    const prepared = prepareCopilotSessionConfig(config);
    const session = await this.client.resumeSession(sessionId, prepared.sdkConfig as any);
    await this.applySubagentSettings(session, prepared.subagents);
    return wrapCopilotSession(
      session,
      prepared.pendingInteractionEvents,
      this.rpc,
      (handler) => this.subscribeSessionDisconnect(handler),
      prepared.useNativeToolPermissions,
    );
  }

  // The runtime override replaces the CLI user's subagent settings for this
  // session only, and a resume starts from user settings again. A failed apply
  // leaves the session usable on those user settings, so it is logged, not thrown.
  private async applySubagentSettings(session: any, subagents: SubagentSettings | undefined): Promise<void> {
    if (!subagents) return;
    const sid = typeof session?.sessionId === "string" ? session.sessionId.slice(0, 8) : "unknown";
    const update = session?.rpc?.tools?.updateSubagentSettings;
    if (typeof update !== "function") {
      this.logger.warn(`[copilot-backend] [${sid}] Runtime cannot apply Bridge sub-agent settings; using CLI user settings`);
      return;
    }
    try {
      await this.rpc("session.updateSubagentSettings", () => update.call(session.rpc.tools, { subagents }));
    } catch (error) {
      this.logger.warn(
        `[copilot-backend] [${sid}] Failed to apply Bridge sub-agent settings; using CLI user settings: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
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

  async fetchAccountCopilotUser(): Promise<unknown> {
    const account = (this.client as any).rpc?.account;
    const getCurrentAuth = account?.getCurrentAuth;
    const getAllUsers = account?.getAllUsers;
    if (typeof getCurrentAuth !== "function" || typeof getAllUsers !== "function") {
      throw new Error("Account user lookup is not available in this Copilot SDK build");
    }
    const [auth, users] = await Promise.all([
      this.rpc("backend.getAccountAuth", () => getCurrentAuth.call(account)),
      this.rpc("backend.getAccountUsers", () => getAllUsers.call(account)),
    ]) as [any, unknown];
    const login = auth?.authInfo?.login;
    const host = auth?.authInfo?.host;
    const current = Array.isArray(users)
      ? users.find((user: any) => user?.authInfo?.login === login && user?.authInfo?.host === host)
      : undefined;
    const token = typeof current?.token === "string" ? current.token : null;
    if (!login || !token) throw new Error("No token for the current Copilot account");
    const response = await fetch(`${githubApiBase(host)}/copilot_internal/user`, {
      headers: { Authorization: `token ${token}`, Accept: "application/json", "User-Agent": "copilot-bridge" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Copilot user lookup failed with HTTP ${response.status}`);
    return response.json();
  }
}

function githubApiBase(host: unknown): string {
  const origin = typeof host === "string" && host.trim() ? host.trim().replace(/\/+$/, "") : "https://github.com";
  return origin === "https://github.com" ? "https://api.github.com" : `${origin}/api/v3`;
}
