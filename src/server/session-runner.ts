// SessionRunner — owns the per-session run loop, live SDK event handling,
// stale-cache retry, watchdog/heartbeat, stalled-session recovery, and
// tool/sub-agent event rendering. SessionManager remains the public facade
// and delegates the run-loop concerns here.

import type { CopilotClient } from "@github/copilot-sdk";
import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { getVisibleEventTimestamp } from "./event-transform.js";
import type { getOrCreateBus } from "./event-bus.js";
import type { EventBusRegistry } from "./event-bus.js";
import type { GlobalBus } from "./global-bus.js";
import type { SessionTitlesStore } from "./session-titles.js";
import type { SessionMetaStore } from "./session-meta-store.js";
import type { TelemetryStore } from "./telemetry-store.js";
import type { Task } from "./task-store.js";
import type { UserInputCancelReason } from "./user-input-types.js";
import { deriveFallbackSessionTitle } from "./session-formatting.js";
import {
  PROMPT_DELIVERY_ABORTED_MESSAGE,
  RESTART_PENDING_MESSAGE,
  isRestartCutoverInProgress,
  refreshRestartStateSync,
} from "./restart-controller.js";
import {
  type SessionRunController,
  type SessionRunStateController,
} from "./session-run-state-controller.js";
import type { SessionUserInputController } from "./session-user-input-controller.js";
import { getToolExecutionDisplayText } from "./tool-results.js";
import type {
  RoutedSdkAttachment,
  StartWorkAttachment,
} from "./session-attachment-routing.js";
import type { SessionConfigOptions } from "./session-config-builder.js";

const DEFAULT_FLEET_PROMPT = "Implement the current plan using Fleet. Run independent tracks in parallel where possible, respect dependencies in the plan, and report the results in this session.";

const SYNC_SHELL_TOOL_NAMES = new Set(["bash", "powershell"]);

export interface McpServerStatus {
  name: string;
  status: "connected" | "failed" | "pending" | "disabled" | "not_configured" | "unknown";
  error?: string;
  source?: string;
}

function asObjectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function getSyncShellInitialWaitUntil(toolName: string, args: unknown, startedAt: number): number | undefined {
  if (!SYNC_SHELL_TOOL_NAMES.has(toolName)) return undefined;
  const argRecord = asObjectRecord(args);
  if (!argRecord || argRecord.mode !== "sync") return undefined;

  const rawInitialWait = argRecord.initial_wait;
  const initialWaitSeconds = typeof rawInitialWait === "number"
    ? rawInitialWait
    : typeof rawInitialWait === "string"
      ? Number(rawInitialWait)
      : Number.NaN;
  if (!Number.isFinite(initialWaitSeconds) || initialWaitSeconds <= 0) return undefined;
  return startedAt + initialWaitSeconds * 1000;
}

function getSessionShutdownType(data: any): string | undefined {
  return typeof data?.shutdownType === "string" ? data.shutdownType.toLowerCase() : undefined;
}

function storeSessionTitle(
  sessionTitles: SessionTitlesStore,
  eventBusRegistry: EventBusRegistry,
  globalBus: GlobalBus,
  sessionId: string,
  title: string,
): void {
  sessionTitles.setTitle(sessionId, title);
  eventBusRegistry.getBus(sessionId)?.emit({ type: "title_changed", title });
  globalBus.emit({ type: "session:title", sessionId, title });
}

export interface SessionRunnerDeps {
  /** Lazy accessor for the SDK client; the manager owns lifecycle. */
  getClient(): CopilotClient | null;
  /** Shared cache of CopilotSession objects (owned by SessionManager). */
  sessionObjects: Map<string, any>;
  /** Shared per-session MCP status cache (owned by SessionManager). */
  mcpStatus: Map<string, McpServerStatus[]>;
  /** Shared map of in-flight run controllers (owned by SessionManager). */
  activeRunControllers: Map<string, SessionRunController>;

  runStateController: SessionRunStateController;
  userInputController: SessionUserInputController;
  eventBusRegistry: EventBusRegistry;
  globalBus: GlobalBus;
  sessionTitles: SessionTitlesStore;
  sessionMetaStore?: SessionMetaStore;
  telemetryStore?: TelemetryStore;
  copilotHome?: string;

  isSessionBusy(sessionId: string): boolean;
  hasPlan(sessionId: string): boolean;
  getSessionStateDir(sessionId: string): string;
  buildSessionConfig(opts?: SessionConfigOptions): any;
  findLinkedTask(sessionId: string): Task | undefined;
  lookupGroupNotes(groupId?: string): { groupName: string; notes: string } | null;
  hasStoredSessionTitle(sessionId: string): boolean;
  hasExistingSessionTitle(sessionId: string): boolean;
  persistAndRouteAttachments(
    sessionId: string,
    attachments?: StartWorkAttachment[],
  ): RoutedSdkAttachment[] | undefined;
  probeMcpStatus(sessionId: string, session: any): void;
  ensureSessionModelMatchesSettings(session: any, sid: string): Promise<void>;
  flushPendingSessionEviction(sessionId: string): void;
  cancelPendingUserInputRequests(
    sessionId: string,
    reason: UserInputCancelReason,
    message?: string,
  ): void;
  invalidateSessionListCache(): void;
}

export class SessionRunner {
  constructor(private readonly deps: SessionRunnerDeps) {}

  private get client(): CopilotClient | null {
    return this.deps.getClient();
  }

  private recordSpan(name: string, duration: number, sessionId?: string, metadata?: Record<string, unknown>): void {
    try {
      this.deps.telemetryStore?.recordSpan({ name, duration, sessionId, metadata, source: "server" });
    } catch { /* telemetry should never break core flow */ }
  }

  private persistLastVisibleActivityAt(sessionId: string, lastVisibleActivityAt?: string): void {
    if (!lastVisibleActivityAt) return;
    try {
      this.deps.sessionMetaStore?.setLastVisibleActivityAt(sessionId, lastVisibleActivityAt);
    } catch (err) {
      console.warn(`[sdk] [${sessionId.slice(0, 8)}] Failed to persist visible activity:`, err);
    }
  }

  private touchSessionRun(sessionId: string, at = Date.now()): void {
    this.deps.runStateController.touchSessionRun(sessionId, at);
  }

  private setSessionRunState(
    sessionId: string,
    state: "busy" | "stalled" | "idle",
    opts: { now?: number; lastEventAt?: number } = {},
  ): void {
    this.deps.runStateController.setSessionRunState(sessionId, state, opts);
  }

  private createRunController(
    sessionId: string,
    bus: ReturnType<typeof getOrCreateBus>,
  ): SessionRunController {
    return this.deps.runStateController.createRunController(sessionId, bus);
  }

  startWorkRun(sessionId: string, prompt: string, attachments?: StartWorkAttachment[]): SessionRunController {
    if (!this.client) throw new Error("SessionManager not initialized");
    if (isRestartCutoverInProgress(refreshRestartStateSync())) {
      throw new Error(RESTART_PENDING_MESSAGE);
    }

    if (this.deps.isSessionBusy(sessionId)) {
      throw new Error("Session is busy processing another message");
    }

    const bus = this.deps.eventBusRegistry.getOrCreateBus(sessionId);
    bus.reset();
    bus.setPendingPrompt(prompt);
    return this.startBackgroundRun(
      sessionId,
      bus,
      (runController) => this.doWork(sessionId, prompt, bus, runController, attachments),
    );
  }

  startWork(sessionId: string, prompt: string, attachments?: StartWorkAttachment[]): void {
    this.startWorkRun(sessionId, prompt, attachments);
  }

  async startWorkAndWaitForDelivery(sessionId: string, prompt: string, attachments?: StartWorkAttachment[]): Promise<void> {
    const runController = this.startWorkRun(sessionId, prompt, attachments);
    const delivery = await runController.promptDelivery;
    if (delivery.status === "accepted") return;
    throw new Error(delivery.message);
  }

  startFleet(sessionId: string, prompt?: string): void {
    if (!this.client) throw new Error("SessionManager not initialized");
    if (!this.deps.hasPlan(sessionId)) {
      throw new Error("Session has no plan to run with Fleet");
    }
    if (isRestartCutoverInProgress(refreshRestartStateSync())) {
      throw new Error(RESTART_PENDING_MESSAGE);
    }
    if (this.deps.isSessionBusy(sessionId)) {
      throw new Error("Session is busy processing another request");
    }

    const bus = this.deps.eventBusRegistry.getOrCreateBus(sessionId);
    bus.reset();
    const fleetPrompt = prompt?.trim() || DEFAULT_FLEET_PROMPT;
    this.startBackgroundRun(sessionId, bus, (runController) => this.doFleet(sessionId, fleetPrompt, bus, runController));
  }

  private startBackgroundRun(
    sessionId: string,
    bus: ReturnType<typeof getOrCreateBus>,
    runner: (runController: SessionRunController) => Promise<void>,
  ): SessionRunController {
    const now = Date.now();
    const runController = this.createRunController(sessionId, bus);
    this.deps.activeRunControllers.set(sessionId, runController);
    this.setSessionRunState(sessionId, "busy", { now, lastEventAt: now });

    runner(runController).catch((err) => {
      console.error(`[sdk] Unhandled error in session ${sessionId}:`, err);
      runController.completeError(err instanceof Error ? err.message : String(err));
    }).finally(() => {
      runController.clearAbortWait();
      this.deps.cancelPendingUserInputRequests(
        sessionId,
        "session_ended",
        "Session operation ended before the user input request was answered",
      );
      if (this.deps.activeRunControllers.get(sessionId) === runController) {
        this.deps.activeRunControllers.delete(sessionId);
      }
      this.setSessionRunState(sessionId, "idle");
      this.deps.flushPendingSessionEviction(sessionId);
    });
    return runController;
  }

  async doWork(
    sessionId: string,
    prompt: string,
    bus: ReturnType<typeof getOrCreateBus>,
    runController?: SessionRunController,
    attachments?: StartWorkAttachment[],
  ): Promise<void> {
    const sid = sessionId.slice(0, 8);
    const sdkAttachments = this.deps.persistAndRouteAttachments(sessionId, attachments);
    const attachCount = sdkAttachments?.length ?? 0;
    const activeRunController = runController ?? this.createRunController(sessionId, bus);

    await this.runSessionOperation(sessionId, bus, activeRunController, {
      resumeContext: "message",
      fallbackTitleSource: prompt,
      idleSpanName: "session.sendToIdle",
      startLog: `[sdk] [${sid}] Sending prompt (${prompt.length} chars${attachCount ? `, ${attachCount} attachment${attachCount > 1 ? "s" : ""}` : ""})...`,
      execute: async (session) => {
        await session.send({ prompt, ...(sdkAttachments?.length ? { attachments: sdkAttachments } : {}) });
      },
    });
  }

  private async doFleet(
    sessionId: string,
    prompt: string,
    bus: ReturnType<typeof getOrCreateBus>,
    runController?: SessionRunController,
  ): Promise<void> {
    const sid = sessionId.slice(0, 8);
    const activeRunController = runController ?? this.createRunController(sessionId, bus);
    await this.runSessionOperation(sessionId, bus, activeRunController, {
      resumeContext: "fleet",
      idleSpanName: "session.fleetToIdle",
      startLog: `[sdk] [${sid}] Starting Fleet (${prompt.length} chars)...`,
      execute: async (session) => {
        if (typeof session.rpc?.fleet?.start !== "function") {
          throw new Error("Fleet mode is not available in this Copilot SDK build");
        }
        await session.rpc.fleet.start({ prompt });
      },
    });
  }

  private async runSessionOperation(
    sessionId: string,
    bus: ReturnType<typeof getOrCreateBus>,
    runController: SessionRunController,
    opts: {
      resumeContext: string;
      idleSpanName: string;
      startLog: string;
      execute: (session: any) => Promise<void>;
      fallbackTitleSource?: string;
    },
  ): Promise<void> {
    const sid = sessionId.slice(0, 8);

    const linkedTask = this.deps.findLinkedTask(sessionId);
    const resumeConfig = this.deps.buildSessionConfig({
      sessionId,
      task: linkedTask,
      groupNotes: this.deps.lookupGroupNotes(linkedTask?.groupId),
      forResume: true,
    });

    if (linkedTask) {
      console.log(`[sdk] [${sid}] Injecting task context for "${linkedTask.title}"`);
    }

    let usedCache = false;
    const resumeSession = async (): Promise<any> => {
      const resumeStart = Date.now();
      let s = this.deps.sessionObjects.get(sessionId);
      if (s) {
        usedCache = true;
        console.log(`[sdk] [${sid}] Reusing cached session object`);
      } else {
        usedCache = false;
        console.log(`[sdk] [${sid}] Resuming session...`);
        s = await Promise.race([
          this.client!.resumeSession(sessionId, resumeConfig),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("resumeSession timed out after 60s")), 60_000),
          ),
        ]);
        await this.deps.ensureSessionModelMatchesSettings(s, sid);
        this.deps.sessionObjects.set(sessionId, s);
        this.deps.probeMcpStatus(sessionId, s);
        const resumeDuration = Date.now() - resumeStart;
        this.recordSpan("session.resume", resumeDuration, sessionId, { context: opts.resumeContext });
        console.log(`[sdk] [${sid}] Session resumed (${resumeDuration}ms)`);
      }
      return s;
    };

    const abandonSession = (activeSession: any) => {
      try { activeSession.disconnect?.(); } catch { /* best-effort */ }
      if (this.deps.sessionObjects.get(sessionId) === activeSession) {
        this.deps.sessionObjects.delete(sessionId);
      }
    };

    let session = await resumeSession();
    if (runController.isCompleted()) {
      abandonSession(session);
      return;
    }

    const toolNameMap = new Map<string, string>();
    const toolStartTimes = new Map<string, number>();
    const subAgentMap = new Map<string, string>();
    const subAgentResponseMap = new Map<string, string>();
    const rememberToolName = (toolCallId: unknown, toolName: unknown): string | undefined => {
      if (typeof toolName !== "string") return undefined;
      const normalized = toolName.trim();
      if (!normalized) return undefined;
      if (typeof toolCallId === "string" && toolCallId) {
        toolNameMap.set(toolCallId, normalized);
      }
      return normalized;
    };
    const getTrackedToolDisplayName = (toolCallId: unknown, fallbackName?: string): string => {
      if (typeof toolCallId === "string" && toolCallId) {
        return subAgentMap.get(toolCallId) ?? toolNameMap.get(toolCallId) ?? fallbackName ?? "unknown";
      }
      return fallbackName ?? "unknown";
    };
    const syncShellWaits = new Map<string, number>();
    const handledCurrentTurnEventKeys = new Set<string>();
    let lastAssistantContent: string | undefined;
    let lastEventTime = Date.now();
    let sendStart = lastEventTime;
    let acceptingSessionEvents = false;
    const beginSend = () => {
      sendStart = Date.now();
      lastEventTime = sendStart;
      handledCurrentTurnEventKeys.clear();
      lastAssistantContent = undefined;
      acceptingSessionEvents = true;
    };

    const getEventTimestampMs = (event: any): number | undefined => {
      const rawTimestamp = event?.data?.timestamp ?? event?.timestamp;
      if (typeof rawTimestamp !== "string") return undefined;
      const eventTime = Date.parse(rawTimestamp);
      return Number.isFinite(eventTime) ? eventTime : undefined;
    };

    const getEventReplayKey = (event: any): string | undefined => {
      const rawTimestamp = event?.data?.timestamp ?? event?.timestamp;
      const timestampPart = typeof rawTimestamp === "string" ? rawTimestamp : "";
      try {
        return createHash("sha1")
          .update(JSON.stringify([event?.type ?? "", timestampPart, event?.data ?? null]))
          .digest("hex");
      } catch {
        return undefined;
      }
    };

    const resolvePersistedTerminalEvent = (
      persistedTerminal: { event: any; assistantContent?: string } | null,
      reason: string,
    ): boolean => {
      if (!persistedTerminal) return false;
      if (runController.isCompleted()) return true;
      lastAssistantContent = persistedTerminal.assistantContent ?? lastAssistantContent;
      console.warn(`[sdk] [${sid}] ✅ Stall recovery found persisted ${persistedTerminal.event.type} ${reason} — resolving locally`);
      handleEvent(persistedTerminal.event);
      return true;
    };

    const handleEvent = (event: any) => {
      if (!acceptingSessionEvents || runController.isCompleted()) return;
      const eventAt = Date.now();
      const replayKey = getEventReplayKey(event);
      if (replayKey) handledCurrentTurnEventKeys.add(replayKey);
      const isTerminalEvent = event.type === "session.idle"
        || event.type === "session.error"
        || event.type === "abort"
        || event.type === "session.shutdown";
      if (!isTerminalEvent) {
        lastEventTime = eventAt;
        this.touchSessionRun(sessionId, eventAt);
      }
      const data = (event as any).data;
      this.persistLastVisibleActivityAt(sessionId, getVisibleEventTimestamp(event, sessionId));
      switch (event.type) {
        case "user.message":
          bus.clearPendingPrompt();
          runController.markPromptAccepted();
          break;
        case "assistant.turn_start":
          console.log(`[sdk] [${sid}] ⏳ Turn started`);
          bus.emit({ type: "thinking" });
          break;
        case "assistant.message_delta":
          if (data?.parentToolCallId) break;
          if (data?.deltaContent) {
            bus.emit({ type: "delta", content: data.deltaContent });
          }
          break;
        case "assistant.streaming_delta":
          if (data?.parentToolCallId) break;
          if (data?.content) {
            bus.emit({ type: "delta", content: data.content });
          }
          break;
        case "assistant.intent":
          console.log(`[sdk] [${sid}] 🎯 Intent: ${data?.intent}`);
          bus.emit({ type: "intent", intent: data?.intent ?? "" });
          this.deps.globalBus.emit({ type: "session:intent", sessionId, intent: data?.intent ?? "" });
          break;
        case "assistant.message":
          if (data?.parentToolCallId && data?.content) {
            subAgentResponseMap.set(data.parentToolCallId, data.content);
            break;
          }
          if (data?.content) {
            console.log(`[sdk] [${sid}] ✅ Response (${data.content.length} chars)`);
            lastAssistantContent = data.content;
          }
          if (data?.toolRequests?.length) {
            bus.emit({ type: "assistant_partial", content: data.content ?? "" });
          }
          break;
        case "tool.execution_start": {
          const toolName = data?.toolName ?? data?.name ?? "unknown";
          if (data?.toolCallId) {
            toolNameMap.set(data.toolCallId, toolName);
            toolStartTimes.set(data.toolCallId, Date.now());
            const toolStartAt = getEventTimestampMs(event) ?? eventAt;
            const syncShellWaitUntil = getSyncShellInitialWaitUntil(toolName, data?.arguments, toolStartAt);
            if (syncShellWaitUntil) syncShellWaits.set(data.toolCallId, syncShellWaitUntil);
            else syncShellWaits.delete(data.toolCallId);
          }
          const pendingAgent = data?.toolCallId ? subAgentMap.get(data.toolCallId) : undefined;
          const displayName = pendingAgent ?? toolName;
          console.log(`[sdk] [${sid}] 🔧 Tool: ${displayName}${data?.parentToolCallId ? ` (sub-agent)` : ""}`);
          bus.emit({
            type: "tool_start",
            toolCallId: data?.toolCallId,
            name: displayName,
            args: data?.arguments,
            parentToolCallId: data?.parentToolCallId,
            isSubAgent: pendingAgent ? true : undefined,
            timestamp: event.timestamp,
          });
          break;
        }
        case "tool.execution_progress":
          bus.emit({
            type: "tool_progress",
            toolCallId: data?.toolCallId,
            name: getTrackedToolDisplayName(
              data?.toolCallId,
              rememberToolName(data?.toolCallId, data?.toolName ?? data?.name),
            ),
            message: data?.progressMessage ?? "",
          });
          break;
        case "tool.execution_partial_result":
          bus.emit({
            type: "tool_output",
            toolCallId: data?.toolCallId,
            name: getTrackedToolDisplayName(
              data?.toolCallId,
              rememberToolName(data?.toolCallId, data?.toolName ?? data?.name),
            ),
            content: data?.partialOutput ?? "",
          });
          break;
        case "tool.execution_complete": {
          if (data?.toolCallId) syncShellWaits.delete(data.toolCallId);
          const completedToolName = toolNameMap.get(data?.toolCallId) ?? "unknown";
          const ok = data?.success !== false;
          const isAgent = subAgentMap.has(data?.toolCallId);
          const agentDisplayName = subAgentMap.get(data?.toolCallId);
          const result = getToolExecutionDisplayText(data, {
            subAgentResponse: isAgent ? subAgentResponseMap.get(data?.toolCallId) : undefined,
          });
          console.log(`[sdk] [${sid}] 🔧 Tool complete: ${isAgent ? agentDisplayName : completedToolName} (${ok ? "ok" : "failed"})`);
          const toolStart = toolStartTimes.get(data?.toolCallId);
          if (toolStart) {
            this.recordSpan("tool.execution", Date.now() - toolStart, sessionId, {
              toolName: completedToolName,
              success: ok,
              isSubAgent: isAgent || undefined,
            });
          }
          bus.emit({
            type: "tool_done",
            toolCallId: data?.toolCallId,
            name: isAgent ? agentDisplayName : completedToolName,
            result,
            success: data?.success,
            isSubAgent: isAgent || undefined,
            timestamp: event.timestamp,
          });
          break;
        }
        case "subagent.started": {
          const displayName = `🤖 ${data?.agentDisplayName ?? data?.agentName ?? "agent"}`;
          console.log(`[sdk] [${sid}] ${displayName}`);
          if (data?.toolCallId) subAgentMap.set(data.toolCallId, displayName);
          bus.emit({
            type: "tool_update",
            toolCallId: data?.toolCallId,
            name: displayName,
            isSubAgent: true,
          });
          break;
        }
        case "subagent.completed":
        case "subagent.failed":
          break;
        case "session.error":
          console.error(`[sdk] [${sid}] ❌ Error: ${data?.message ?? "unknown"}`);
          runController.completeError(data?.message ?? "unknown");
          break;
        case "abort": {
          const reason = data?.reason ?? "user initiated";
          console.log(`[sdk] [${sid}] 🛑 Aborted: ${reason}`);
          const partialContent = lastAssistantContent ?? bus.getSnapshot().accumulatedContent ?? "";
          runController.completeAborted(partialContent);
          break;
        }
        case "session.shutdown": {
          const shutdownType = getSessionShutdownType(data);
          if (shutdownType === "error") {
            const message = data?.message ?? data?.reason ?? "session shutdown";
            console.error(`[sdk] [${sid}] ❌ Shutdown(error): ${message}`);
            runController.completeError(message);
          } else {
            console.log(`[sdk] [${sid}] 🛑 Shutdown${shutdownType ? ` (${shutdownType})` : ""}`);
            const partialContent = lastAssistantContent ?? bus.getSnapshot().accumulatedContent ?? "";
            runController.completeShutdown(partialContent);
          }
          break;
        }
        case "session.title_changed":
          bus.emit({ type: "title_changed", title: data?.title ?? "" });
          this.deps.globalBus.emit({ type: "session:title", sessionId, title: data?.title ?? "" });
          break;
        case "session.idle": {
          const elapsed = ((Date.now() - sendStart) / 1000).toFixed(1);
          const content = lastAssistantContent ?? "(no response)";
          console.log(`[sdk] [${sid}] 💤 Session idle — done: ${content.length} chars (${elapsed}s)`);
          this.recordSpan(opts.idleSpanName, Date.now() - sendStart, sessionId, { chars: content.length });
          if (opts.fallbackTitleSource && !this.deps.hasStoredSessionTitle(sessionId) && !this.deps.hasExistingSessionTitle(sessionId)) {
            const fallbackTitle = deriveFallbackSessionTitle(opts.fallbackTitleSource);
            if (fallbackTitle) {
              storeSessionTitle(this.deps.sessionTitles, this.deps.eventBusRegistry, this.deps.globalBus, sessionId, fallbackTitle);
              console.log(`[titles] [${sid}] Fallback title: "${fallbackTitle}"`);
            }
          }

          runController.completeDone(content);
          break;
        }
        case "session.mcp_servers_loaded": {
          const servers: McpServerStatus[] = (data?.servers ?? []).map((s: any) => ({
            name: s.name,
            status: s.status ?? "unknown",
            error: s.error,
            source: s.source,
          }));
          this.deps.mcpStatus.set(sessionId, servers);
          const failed = servers.filter((s) => s.status === "failed");
          if (failed.length > 0) {
            console.warn(`[sdk] [${sid}] ⚠️ MCP failures: ${failed.map((s) => `${s.name} (${s.error ?? "unknown"})`).join(", ")}`);
          }
          console.log(`[sdk] [${sid}] 🔌 MCP: ${servers.map((s) => `${s.name}=${s.status}`).join(", ")}`);
          bus.emit({ type: "mcp_status", servers });
          break;
        }
        case "session.mcp_server_status_changed": {
          const current = this.deps.mcpStatus.get(sessionId) ?? [];
          const name = data?.serverName;
          const status = data?.status ?? "unknown";
          const existing = current.find((s) => s.name === name);
          if (existing) {
            existing.status = status;
            if (data?.error) existing.error = data.error;
          } else if (name) {
            current.push({ name, status, error: data?.error, source: data?.source });
          }
          this.deps.mcpStatus.set(sessionId, current);
          console.log(`[sdk] [${sid}] 🔌 MCP ${name}: ${status}${data?.error ? ` — ${data.error}` : ""}`);
          bus.emit({ type: "mcp_status", servers: current });
          break;
        }
        default:
          break;
      }
    };

    const subscribeToSession = (activeSession: typeof session) => {
      acceptingSessionEvents = false;
      return activeSession.on(handleEvent);
    };

    let unsub = subscribeToSession(session);

    const cachedMcp = this.deps.mcpStatus.get(sessionId);
    if (cachedMcp?.length) {
      bus.emit({ type: "mcp_status", servers: cachedMcp });
    }

    const heartbeatLog = setInterval(() => {
      const elapsed = ((Date.now() - sendStart) / 1000).toFixed(0);
      console.log(`[sdk] [${sid}] ⏳ Still working... (${elapsed}s)`);
    }, 30_000);

    const eventsJsonlPath = join(this.deps.getSessionStateDir(sessionId), "events.jsonl");

    let recoveryInProgress = false;
    let lastRecoveryAttempt = 0;

    const readPersistedTerminalEvent = (): { event: any; assistantContent?: string } | null => {
      let raw: string;
      try {
        raw = readFileSync(eventsJsonlPath, "utf-8");
      } catch {
        return null;
      }

      let assistantContentFromDisk = lastAssistantContent;
      let latestRelevantState: "active" | "terminal" | undefined;
      let terminalEvent: any | null = null;

      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;

        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }

        const rawTimestamp = event?.data?.timestamp ?? event?.timestamp;
        const eventTime = typeof rawTimestamp === "string" ? Date.parse(rawTimestamp) : Number.NaN;
        if (!Number.isFinite(eventTime) || eventTime < sendStart) continue;

        const data = event?.data;
        switch (event?.type) {
          case "assistant.message":
            if (data?.parentToolCallId) break;
            if (typeof data?.content === "string") {
              assistantContentFromDisk = data.content;
            }
            latestRelevantState = "active";
            terminalEvent = null;
            break;
          case "user.message":
          case "assistant.turn_start":
          case "assistant.message_delta":
          case "assistant.streaming_delta":
          case "assistant.intent":
          case "tool.execution_start":
          case "tool.execution_progress":
          case "tool.execution_partial_result":
          case "tool.execution_complete":
          case "subagent.started":
          case "subagent.completed":
          case "subagent.failed":
            latestRelevantState = "active";
            terminalEvent = null;
            break;
          case "session.idle":
          case "session.error":
          case "abort":
          case "session.shutdown":
            latestRelevantState = "terminal";
            terminalEvent = event;
            break;
          default:
            break;
        }
      }

      if (latestRelevantState !== "terminal" || !terminalEvent) return null;
      return { event: terminalEvent, assistantContent: assistantContentFromDisk };
    };

    const resumeFreshRecoverySession = async (): Promise<any> => {
      const resumeStart = Date.now();
      console.log(`[sdk] [${sid}] Re-resuming session for stalled recovery...`);
      const recoveredSession = await Promise.race([
        this.client!.resumeSession(sessionId, resumeConfig),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("resumeSession timed out after 60s")), 60_000),
        ),
      ]);
      await this.deps.ensureSessionModelMatchesSettings(recoveredSession, sid);
      const resumeDuration = Date.now() - resumeStart;
      this.recordSpan("session.resume", resumeDuration, sessionId, { context: `${opts.resumeContext}:stalled-recovery` });
      console.log(`[sdk] [${sid}] Recovery session resumed (${resumeDuration}ms)`);
      return recoveredSession;
    };

    const attemptStalledRecovery = async () => {
      if (recoveryInProgress) return;
      recoveryInProgress = true;
      lastRecoveryAttempt = Date.now();
      try {
        if (resolvePersistedTerminalEvent(readPersistedTerminalEvent(), "before resume")) return;

        const elapsed = ((Date.now() - sendStart) / 1000).toFixed(0);
        console.warn(`[sdk] [${sid}] 🔄 Stall recovery: re-subscribing (${elapsed}s total)...`);
        const previousSession = session;
        const previousUnsub = unsub;
        const recoveredSession = await resumeFreshRecoverySession();

        if (runController.isCompleted() || this.deps.runStateController.getSessionRunState(sessionId) !== "stalled") {
          try { recoveredSession.disconnect?.(); } catch { /* best-effort */ }
          return;
        }

        const persistedTerminalAfterResume = readPersistedTerminalEvent();
        if (persistedTerminalAfterResume) {
          try { recoveredSession.disconnect?.(); } catch { /* best-effort */ }
          resolvePersistedTerminalEvent(persistedTerminalAfterResume, "after resume");
          return;
        }

        const shouldIgnoreRecoveredEvent = (event: any) => {
          const eventTimestampMs = getEventTimestampMs(event);
          if (eventTimestampMs !== undefined && eventTimestampMs < sendStart) return true;
          const replayKey = getEventReplayKey(event);
          return replayKey !== undefined && handledCurrentTurnEventKeys.has(replayKey);
        };

        const bufferedRecoveredEvents: any[] = [];
        let acceptingRecoveredEvents = false;
        const recoveredUnsub = recoveredSession.on((event: any) => {
          if (!acceptingRecoveredEvents) {
            bufferedRecoveredEvents.push(event);
            return;
          }
          if (shouldIgnoreRecoveredEvent(event)) return;
          handleEvent(event);
        });

        session = recoveredSession;
        unsub = recoveredUnsub;
        this.deps.sessionObjects.set(sessionId, recoveredSession);
        this.deps.probeMcpStatus(sessionId, recoveredSession);
        acceptingSessionEvents = true;

        try { previousUnsub(); } catch { /* best-effort */ }
        if (previousSession !== recoveredSession) {
          try { previousSession.disconnect?.(); } catch { /* best-effort */ }
        }

        acceptingRecoveredEvents = true;
        for (const event of bufferedRecoveredEvents) {
          if (shouldIgnoreRecoveredEvent(event)) continue;
          handleEvent(event);
          if (runController.isCompleted()) break;
        }

        console.log(`[sdk] [${sid}] ✅ Stall recovery complete — listener re-attached`);
      } catch (err) {
        if (!resolvePersistedTerminalEvent(readPersistedTerminalEvent(), "after failed resume")) {
          console.error(`[sdk] [${sid}] ❌ Stall recovery failed:`, err);
        }
      } finally {
        recoveryInProgress = false;
      }
    };

    const WATCHDOG_INTERVAL = 60_000;
    const WATCHDOG_TIMEOUT = 300_000;
    const RECOVERY_INTERVAL = 300_000;
    const watchdog = setInterval(() => {
      const now = Date.now();

      try {
        const fileStat = statSync(eventsJsonlPath);
        if (fileStat.mtimeMs > lastEventTime) {
          this.deps.runStateController.touchSessionRunIfNewer(sessionId, fileStat.mtimeMs);
        }
      } catch { /* events.jsonl may not exist yet */ }

      let syncShellWaitUntil = 0;
      for (const waitUntil of syncShellWaits.values()) {
        if (waitUntil > syncShellWaitUntil) syncShellWaitUntil = waitUntil;
      }
      if (syncShellWaitUntil > now) return;

      if (this.deps.userInputController.getPendingCount(sessionId) > 0) {
        lastEventTime = now;
        this.touchSessionRun(sessionId, now);
        return;
      }

      if (now - lastEventTime < WATCHDOG_TIMEOUT) return;

      const currentState = this.deps.runStateController.getSessionRunState(sessionId);
      const elapsed = ((now - sendStart) / 1000).toFixed(0);

      if (currentState !== "stalled") {
        console.error(`[sdk] [${sid}] ⚠️ Watchdog: no events for ${WATCHDOG_TIMEOUT / 1000}s — marking stalled (${elapsed}s total)`);
        this.setSessionRunState(sessionId, "stalled");
        void attemptStalledRecovery();
      } else if (now - lastRecoveryAttempt >= RECOVERY_INTERVAL) {
        console.warn(`[sdk] [${sid}] ⚠️ Session still stalled — retrying recovery (${elapsed}s total)`);
        void attemptStalledRecovery();
      }
    }, WATCHDOG_INTERVAL);

    try {
      console.log(opts.startLog);

      try {
        if (runController.isCompleted()) return;
        beginSend();
        if (runController.isCompleted()) return;
        await opts.execute(session);
        runController.markPromptAccepted();
      } catch (operationErr) {
        if (operationErr instanceof Error && operationErr.message.includes("Session not found") && usedCache) {
          console.warn(`[sdk] [${sid}] Stale cached session — evicting and re-resuming...`);
          unsub();
          this.deps.sessionObjects.delete(sessionId);
          session = await resumeSession();
          if (runController.isCompleted()) {
            abandonSession(session);
            return;
          }
          unsub = subscribeToSession(session);
          if (runController.isCompleted()) return;
          beginSend();
          if (runController.isCompleted()) return;
          await opts.execute(session);
          runController.markPromptAccepted();
        } else {
          throw operationErr;
        }
      }

      await runController.completion;
    } finally {
      clearInterval(heartbeatLog);
      clearInterval(watchdog);
      syncShellWaits.clear();
      unsub();
    }
  }
}

// Re-exported only so SessionManager keeps a single source of truth for the
// abort confirmation message used in the standalone abort fallback path.
export { PROMPT_DELIVERY_ABORTED_MESSAGE };
