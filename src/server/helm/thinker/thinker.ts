// Helm's looks at all Bridges: the careful pass that writes the brief on Home and keeps Helm's
// memory, on a schedule and on demand; serves the brief; and carries out what Tim clicks. It is the
// same Helm as the chat (same model role, same memory); the chat reads through readConversation and
// readBridge here. A run is an
// ordinary Bridge session with the thinker profile, hidden from the chat lists. The run can only
// read and publish; every change to a conversation, checklist or task comes from Tim's click,
// except marking FYI replies read on this Bridge when Tim allows routine handling (undoable).
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AppContext } from "../../app-context.js";
import { defineBridgeTool, type BridgeToolInvocation } from "../../agent-tools-mcp/adapter.js";
import type { BridgeToolDefinition } from "../../agent-tools-mcp/server.js";
import type { AgentModelInfo } from "../../agent-backend/types.js";
import type { SessionConfigProfile } from "../../session-manager.js";
import { sendChatMessage } from "../../chat-message-delivery.js";
import { toolFailure } from "../../tool-results.js";
import {
  HELM_MEMORY_LIMITS,
  isRebuildSlot,
  nextScheduledRun,
  previousScheduledRun,
  validateHelmThinkerSettingsPatch,
  type HelmAction,
  type HelmBrief,
  type HelmBriefItem,
  type HelmBriefResponse,
  type HelmProposal,
  type HelmHandledView,
  type HelmMemoryChange,
  type HelmMemoryEntry,
  type HelmMemoryKind,
  type HelmRunTrigger,
  type HelmRunView,
  type HelmThinkerSettings,
} from "../../../shared/helm-thinker.js";
import { HelmError } from "../helm-service.js";
import { chooseHelmModel, usableModels } from "../helm-model.js";
import { applyHelmSessionProfile } from "../helm-session-profile.js";
import { createHelmToolDefinitions, type HelmBridgeFacade, type HelmToolRuntime } from "../helm-tools.js";
import { bridgeStatuses, buildThinkerPacket, countChanges, readBridgeForChat, renderThinkerPacket, type ChatBridgeView, type ThinkerPacket } from "./context.js";
import { buildThinkerPrompt, buildThinkerSystemPrompt, THINKER_NUDGE } from "./prompt.js";
import { normalizeChoice, validatePublication, type HandledPlan, type MemoryOp } from "./publish.js";
import { createLocalSource, createPeerSource, sourceLink, type HelmSource } from "./sources.js";
import { toRunView, type HelmRunRecord, type HelmThinkerStore } from "./store.js";

/** How long one run may take before it is given up. */
const RUN_TIMEOUT_MS = 30 * 60_000;
/** A missed scheduled slot this recent still runs when the server starts. */
const CATCH_UP_MS = 2 * 60 * 60_000;
const KEEP_RUN_SESSIONS_MS = 7 * 86_400_000;
const KEEP_RUNS_MS = 60 * 86_400_000;
const KEEP_RECENT_SESSIONS = 5;
const MAX_TIMER_MS = 2_147_000_000;
/** Effort for a look when the Helm role doesn't set one. */
const DEFAULT_LOOK_EFFORT = "high";

/** Read-only Bridge tools the thinker may use besides its own. */
const THINKER_TOOL_NAMES = new Set([
  "bridge_overview", "find", "list_sessions", "read_session",
  "task_list", "task_get_info", "task_history_list", "action_list", "schedule_list", "tag_list",
  "docs_search", "docs_read", "docs_list",
]);

export interface HelmThinkerOptions {
  ctx: AppContext;
  store: HelmThinkerStore;
  facade: HelmBridgeFacade;
  runtime: HelmToolRuntime;
  readSessions(): Promise<any[]>;
  deleteSession(sessionId: string): Promise<void>;
  emitReadStateChanged(): void;
  now?: () => Date;
  fetchImpl?: typeof fetch;
}

interface ActiveRun {
  runId: string;
  sessionId: string;
  packet?: ThinkerPacket;
  /** Set the moment a run is given up: nothing it publishes after that counts. */
  fenced?: boolean;
}

export class HelmThinker {
  private readonly ctx: AppContext;
  private readonly store: HelmThinkerStore;
  private readonly facade: HelmBridgeFacade;
  private readonly runtime: HelmToolRuntime;
  private readonly readSessions: () => Promise<any[]>;
  private readonly deleteSession: (sessionId: string) => Promise<void>;
  private readonly emitReadStateChanged: () => void;
  private readonly now: () => Date;
  private readonly fetchImpl?: typeof fetch;
  private active?: ActiveRun;
  private timer?: NodeJS.Timeout;
  private nextRunAt: Date | null = null;
  private tools?: BridgeToolDefinition[];
  private workingDirectory?: string;
  private disposed = false;

  constructor(options: HelmThinkerOptions) {
    this.ctx = options.ctx;
    this.store = options.store;
    this.facade = options.facade;
    this.runtime = options.runtime;
    this.readSessions = options.readSessions;
    this.deleteSession = options.deleteSession;
    this.emitReadStateChanged = options.emitReadStateChanged;
    this.now = options.now ?? (() => new Date());
    this.fetchImpl = options.fetchImpl;
  }

  /** A staged preview never runs on its own and never changes a peer Bridge. */
  get isPreview(): boolean {
    return this.ctx.isStaging === true;
  }

  start(): void {
    const interrupted = this.store.failInterruptedRuns("The server restarted while this run was in progress.");
    if (interrupted) console.log(`[helm-thinker] Marked ${interrupted} interrupted run(s) failed`);
    this.schedule({ catchUp: true });
    void this.retention().catch(() => undefined);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  isRunSession(sessionId: string | undefined | null): boolean {
    return this.store.isRunSession(sessionId);
  }

  // ── Settings ──────────────────────────────────────────────

  getSettings(): HelmThinkerSettings {
    return this.store.getSettings();
  }

  async patchSettings(input: unknown): Promise<HelmThinkerSettings> {
    let patch: Partial<HelmThinkerSettings>;
    try {
      patch = validateHelmThinkerSettingsPatch(input);
    } catch (error) {
      throw new HelmError(error instanceof Error ? error.message : String(error), 400);
    }
    const settings = this.store.updateSettings(patch);
    this.schedule({ catchUp: false });
    return settings;
  }

  /** The Helm role's model (Settings › Models), at its tier's effort or high. */
  private async chooseModel(): Promise<{ model?: string; effort?: string; contextTier?: "default" | "long_context" }> {
    const models = await this.ctx.sessionManager.listModels().catch(() => [] as AgentModelInfo[]);
    const choice = chooseHelmModel(this.ctx.settingsStore.getSettings(), usableModels(models), { effort: DEFAULT_LOOK_EFFORT, tierEffort: true });
    return {
      ...(choice.model ? { model: choice.model } : {}),
      ...(choice.reasoningEffort ? { effort: choice.reasoningEffort } : {}),
      ...(choice.contextTier ? { contextTier: choice.contextTier } : {}),
    };
  }

  // ── Sources ───────────────────────────────────────────────

  private sources(settings = this.store.getSettings()): HelmSource[] {
    return [
      createLocalSource(this.ctx, this.readSessions, settings.label),
      ...settings.peers.map((peer) => createPeerSource(peer, { readOnly: this.isPreview, ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}) })),
    ];
  }

  private source(bridge: string): HelmSource {
    const source = this.sources().find((candidate) => candidate.id === bridge);
    if (!source) throw new HelmError(`Bridge "${bridge}" is no longer configured`, 409);
    return source;
  }

  // ── Session profile ───────────────────────────────────────

  private getWorkingDirectory(): string {
    if (!this.workingDirectory) {
      const dataDir = this.ctx.runtimePaths?.dataDir;
      const directory = dataDir ? join(dataDir, "helm", "thinker") : process.cwd();
      if (dataDir) mkdirSync(directory, { recursive: true });
      this.workingDirectory = directory;
    }
    return this.workingDirectory;
  }

  private getTools(): BridgeToolDefinition[] {
    if (this.tools) return this.tools;
    const base = createHelmToolDefinitions(this.ctx, this.facade, this.runtime)
      .filter((tool) => THINKER_TOOL_NAMES.has(tool.name))
      .map((tool): BridgeToolDefinition => tool.name === "read_session"
        // Reading is never "Tim has seen it".
        ? { ...tool, handler: (args, extra) => tool.handler({ ...(args as object), markRead: false }, extra) }
        : tool);
    this.tools = [...base, this.readConversationTool(), this.publishTool()];
    return this.tools;
  }

  getSessionProfile(): SessionConfigProfile {
    const tools = this.getTools();
    return {
      toolNames: tools.map((tool) => tool.name),
      apply: (config) => {
        const settings = this.store.getSettings();
        return applyHelmSessionProfile(config, {
          tools,
          workingDirectory: this.getWorkingDirectory(),
          systemPrompt: buildThinkerSystemPrompt({
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            bridges: this.sources(settings).map((source) => ({ id: source.id, label: source.label })),
            autonomy: settings.autonomy,
          }),
        });
      },
      // Each turn thinks at the effort the run resolved for its model (none for a model without efforts).
      defaultTurnReasoningEffort: () => (this.active ? this.store.getRun(this.active.runId)?.effort ?? undefined : undefined),
    };
  }

  /** The latest messages of a conversation on any configured Bridge. Never marks it read. */
  async readConversation(bridge: unknown, sessionId: unknown, messages?: unknown): Promise<{ bridge: string; messages: Array<{ role: string; at?: string; content: string }> }> {
    const source = this.sources().find((candidate) => candidate.id === bridge);
    if (!source) throw new HelmError(`Unknown bridge "${String(bridge)}". Bridges: ${this.sources().map((candidate) => candidate.id).join(", ")}`, 400);
    if (typeof sessionId !== "string" || !sessionId.trim()) throw new HelmError("sessionId is required", 400);
    const count = Math.min(20, Math.max(1, Math.floor(Number(messages) || 6)));
    // Tool steps sit between messages; look further back when a busy run leaves too few.
    let list = await source.messages(sessionId.trim(), 120);
    if (list.length < count) list = await source.messages(sessionId.trim(), 400);
    return {
      bridge: source.id,
      messages: list.slice(-count).map((message) => ({
        role: message.role,
        ...(message.timestamp ? { at: message.timestamp } : {}),
        content: message.content.length > 3000 ? `${message.content.slice(0, 3000)}… (truncated)` : message.content,
      })),
    };
  }

  /** The Bridges Helm reads, by id and name. */
  listBridges(): Array<{ id: string; label: string }> {
    return this.sources().map((source) => ({ id: source.id, label: source.label }));
  }

  /** What one Bridge looks like now: its questions, replies, due items, tasks and running work. */
  async readBridge(bridge: unknown): Promise<ChatBridgeView> {
    const source = this.sources().find((candidate) => candidate.id === bridge);
    if (!source) throw new HelmError(`Unknown bridge "${String(bridge)}". Bridges: ${this.sources().map((candidate) => candidate.id).join(", ")}`, 400);
    return readBridgeForChat(source);
  }

  private readConversationTool(): BridgeToolDefinition {
    return defineBridgeTool("read_conversation", {
      description: "Read the latest messages of a conversation on any Bridge in the packet (\"local\" or a peer). Use when a reply's excerpt or a question is not enough to judge it. Does not mark it read.",
      parameters: {
        type: "object",
        properties: {
          bridge: { type: "string", description: "Bridge id from the packet." },
          sessionId: { type: "string", description: "The conversation's sessionId from the packet." },
          messages: { type: "number", description: "How many recent messages to return (default 6, max 20)." },
        },
        required: ["bridge", "sessionId"],
      },
      handler: async (args: any) => {
        try {
          return await this.readConversation(args.bridge, args.sessionId, args.messages);
        } catch (error) {
          return toolFailure(error instanceof Error ? error.message : String(error));
        }
      },
    });
  }

  private publishTool(): BridgeToolDefinition {
    return defineBridgeTool("helm_publish", {
      description: "Publish this run's brief and memory updates. Call exactly once at the end; if it returns errors, fix them and call again. Only the first successful call counts.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "Two or three plain sentences: how things stand and what matters most." },
          items: {
            type: "array",
            description: "At most 6 things that need Tim, most important first.",
            items: {
              type: "object",
              properties: {
                kind: { type: "string", enum: ["question", "decision", "due", "connects", "fyi"] },
                bridge: { type: "string" },
                title: { type: "string" },
                recommendation: { type: "string" },
                why: { type: "string" },
                evidence: { type: "array", items: { type: "object", properties: { label: { type: "string" }, sessionId: { type: "string" }, taskId: { type: "string" } } } },
                replyTo: { type: "object", properties: { sessionId: { type: "string" } } },
                actions: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      label: { type: "string" },
                      primary: { type: "boolean" },
                      type: { type: "string", enum: ["answer", "send", "tick", "close_tasks", "open"] },
                      sessionId: { type: "string" },
                      requestId: { type: "string" },
                      answer: { type: "string" },
                      message: { type: "string" },
                      actionId: { type: "string" },
                      taskId: { type: "string" },
                      taskIds: { type: "array", items: { type: "string" } },
                    },
                    required: ["label", "type"],
                  },
                },
              },
              required: ["kind", "bridge", "title", "recommendation"],
            },
          },
          proposals: { type: "array", items: { type: "object", properties: { bridge: { type: "string" }, text: { type: "string" }, actions: { type: "array", items: { type: "object" } } }, required: ["bridge", "text"] } },
          watching: { type: "array", items: { type: "object", properties: { bridge: { type: "string" }, text: { type: "string" }, taskId: { type: "string" } }, required: ["bridge", "text"] } },
          handled: { type: "array", items: { type: "object", properties: { bridge: { type: "string" }, sessionId: { type: "string" }, why: { type: "string" } }, required: ["bridge", "sessionId", "why"] } },
          memory: {
            type: "object",
            properties: {
              picture: { type: "string" },
              threads: { type: "array", items: { type: "object", properties: { bridge: { type: "string" }, taskId: { type: "string" }, text: { type: "string" } }, required: ["bridge", "taskId", "text"] } },
              removeThreads: { type: "array", items: { type: "string" } },
              people: { type: "array", items: { type: "object", properties: { key: { type: "string" }, text: { type: "string" }, source: { type: "string" } }, required: ["key", "text"] } },
              dates: { type: "array", items: { type: "object", properties: { key: { type: "string" }, text: { type: "string" }, source: { type: "string" } }, required: ["key", "text"] } },
              proposeRules: { type: "array", items: { type: "object", properties: { text: { type: "string" }, source: { type: "string" } }, required: ["text"] } },
              proposePriorities: { type: "array", items: { type: "object", properties: { text: { type: "string" }, source: { type: "string" } }, required: ["text"] } },
              confirm: { type: "array", items: { type: "string" } },
              drop: { type: "array", items: { type: "string" } },
            },
          },
        },
        required: ["summary", "items"],
      },
      handler: (args: any, invocation: BridgeToolInvocation) => this.publish(args, invocation),
    });
  }

  private async publish(args: unknown, invocation: BridgeToolInvocation) {
    const active = this.active;
    if (!active || active.fenced || !invocation.sessionId || active.sessionId !== invocation.sessionId || !active.packet) {
      return toolFailure("helm_publish only works inside the thinker run that is in progress.");
    }
    const run = this.store.getRun(active.runId);
    if (!run || run.status !== "running") return toolFailure("This run is no longer in progress.");
    if (run.briefJson) return toolFailure("This run already published its brief.");
    const memory = this.store.listMemory();
    const result = validatePublication(args, active.packet, memory);
    if (!result.ok) return toolFailure("The brief was not published. Fix these and call helm_publish again.", { detail: result.errors.join("\n") });
    const settings = this.store.getSettings();
    let changes: HelmMemoryChange[] = [];
    const published = this.store.transaction(() => {
      changes = this.applyMemory(result.memory);
      return this.store.publishRun(run.id, result.brief, changes);
    });
    if (!published) return toolFailure("This run already published its brief.");
    const handled = settings.autonomy === "routine" ? this.applyHandled(run.id, result.handled) : 0;
    return { success: true, items: result.brief.items.length, handled, memoryChanges: changes.length };
  }

  private applyMemory(ops: MemoryOp[]): HelmMemoryChange[] {
    const changes: HelmMemoryChange[] = [];
    for (const op of ops) {
      if (op.op === "drop") {
        const entry = this.store.getMemory(op.id);
        if (!entry || entry.author === "user") continue;
        this.store.updateMemory(op.id, { status: "forgotten" });
        changes.push({ op: "removed", kind: entry.kind, text: entry.text });
      } else if (op.op === "confirm") {
        const entry = this.store.updateMemory(op.id, { confirm: true });
        if (entry) changes.push({ op: "confirmed", kind: entry.kind, text: entry.text });
      } else if (op.op === "propose") {
        this.store.addMemory({ kind: op.kind, text: op.text, source: op.source, author: "helm", status: "proposed" });
        changes.push({ op: "proposed", kind: op.kind, text: op.text });
      } else {
        const existing = this.store.findByKey(op.kind, op.key);
        if (existing?.author === "user") continue;
        if (existing) {
          if (existing.text !== op.text) {
            this.store.updateMemory(existing.id, { text: op.text, source: op.source });
            changes.push({ op: "updated", kind: op.kind, text: op.kind === "picture" ? "Standing picture rewritten" : op.text });
          } else {
            this.store.updateMemory(existing.id, { confirm: true });
          }
        } else {
          this.store.addMemory({ kind: op.kind, key: op.key, text: op.text, source: op.source, author: "helm", status: "active" });
          changes.push({ op: "added", kind: op.kind, text: op.kind === "picture" ? "Standing picture written" : op.text });
        }
      }
    }
    return changes;
  }

  /** Marks FYI replies read on this Bridge, only through what the run saw, recording how to undo it. */
  private applyHandled(runId: string, plans: HandledPlan[]): number {
    let count = 0;
    for (const plan of plans) {
      if (plan.bridge !== "local") continue;
      const previous = this.ctx.readStateStore.getReadStateFor([plan.sessionId])[plan.sessionId] ?? null;
      if (previous && Date.parse(previous) >= Date.parse(plan.activityAt)) continue;
      const stored = this.ctx.readStateStore.markRead(plan.sessionId, plan.activityAt);
      this.store.addHandled({ runId, kind: "mark_read", bridge: plan.bridge, sessionId: plan.sessionId, title: plan.title, why: plan.why, previousReadAt: previous, readThrough: stored });
      count++;
    }
    if (count) this.emitReadStateChanged();
    return count;
  }

  // ── Runs ──────────────────────────────────────────────────

  getRunning(): HelmRunView | null {
    const run = this.active ? this.store.getRun(this.active.runId) : undefined;
    return run && run.status === "running" ? toRunView(run) : null;
  }

  /** Starts a run. Returns at once; the run carries on in the background. */
  async think(options: { trigger: HelmRunTrigger; rebuild?: boolean }): Promise<HelmRunView> {
    if (this.active) throw new HelmError("Helm is already looking", 409);
    const selection = await this.chooseModel();
    if (this.active) throw new HelmError("Helm is already looking", 409);
    const run = this.store.createRun({
      sessionId: randomUUID(),
      trigger: options.trigger,
      rebuild: options.rebuild === true,
      model: selection.model ?? null,
      effort: selection.effort ?? null,
    });
    this.active = { runId: run.id, sessionId: run.sessionId };
    console.log(`[helm-thinker] Run ${run.id.slice(0, 8)} started (${run.trigger}${run.rebuild ? ", rebuild" : ""}) on ${selection.model ?? "default model"} at ${selection.effort ?? "default"} effort`);
    void this.execute(run, selection).finally(() => {
      if (this.active?.runId === run.id) this.active = undefined;
      void this.retention().catch(() => undefined);
    });
    return toRunView(run);
  }

  private async execute(run: HelmRunRecord, selection: { model?: string; effort?: string; contextTier?: "default" | "long_context" }): Promise<void> {
    const started = Date.now();
    let feedbackIds: string[] = [];
    try {
      const lastDone = this.store.latestRun("done");
      const previousBrief = lastDone?.briefJson ? JSON.parse(lastDone.briefJson) as HelmBrief : undefined;
      const states = lastDone ? this.store.getItemStates(lastDone.id) : {};
      const feedback = this.store.pendingFeedback();
      feedbackIds = feedback.map((entry) => entry.id);
      const packet = await buildThinkerPacket({
        sources: this.sources(),
        now: this.now(),
        trigger: run.trigger,
        rebuild: run.rebuild,
        lastRunAt: lastDone?.startedAt ?? null,
        memory: this.store.listMemory(),
        feedback,
        previousItems: (previousBrief?.items ?? []).map((item) => ({ title: item.title, status: states[item.id]?.status ?? "open", outcome: states[item.id]?.outcome ?? null })),
      });
      if (this.active?.runId === run.id) this.active.packet = packet;
      const rendered = renderThinkerPacket(packet);
      this.store.setRunContext(run.id, { contextJson: rendered, changeCount: countChanges(packet), bridges: bridgeStatuses(packet) });
      if (!packet.bridges.some((bridge) => bridge.ok)) throw new Error(`No Bridge could be read: ${packet.bridges.map((bridge) => bridge.error).join("; ")}`);
      this.store.noteUse(packet.memory.filter((entry) => entry.status === "active" && (entry.kind === "rule" || entry.kind === "priority")).map((entry) => entry.id));

      await this.ctx.sessionManager.createSession({
        expectedSessionId: run.sessionId,
        ...(selection.model ? { model: selection.model } : {}),
        ...(selection.effort ? { reasoningEffort: selection.effort } : {}),
        ...(selection.contextTier ? { contextTier: selection.contextTier } : {}),
      });
      await this.turn(run.sessionId, buildThinkerPrompt(rendered), started);
      if (!this.store.getRun(run.id)?.briefJson) await this.turn(run.sessionId, THINKER_NUDGE, started);
      this.fence(run.id);
      const credits = await this.readCredits(run.sessionId);
      const published = !!this.store.getRun(run.id)?.briefJson;
      this.store.finishRun(run.id, published
        ? { status: "done", credits }
        : { status: "failed", error: "The run ended without publishing a brief.", credits });
      if (published) this.store.consumeFeedback(feedbackIds, run.id);
      console.log(`[helm-thinker] Run ${run.id.slice(0, 8)} ${published ? "done" : "failed"} in ${Math.round((Date.now() - started) / 1000)} s${credits !== null ? `, ${credits.toFixed(1)} credits` : ""}`);
    } catch (error) {
      this.fence(run.id);
      const message = error instanceof Error ? error.message : String(error);
      // A brief published before the run stalled has already changed memory and been shown: it stands.
      const published = !!this.store.getRun(run.id)?.briefJson;
      const credits = await this.readCredits(run.sessionId).catch(() => null);
      this.store.finishRun(run.id, published ? { status: "done", error: `Published, then: ${message}`, credits } : { status: "failed", error: message, credits });
      if (published) this.store.consumeFeedback(feedbackIds, run.id);
      console.warn(`[helm-thinker] Run ${run.id.slice(0, 8)} ${published ? "published but then" : ""} failed: ${message}`);
    }
  }

  private fence(runId: string): void {
    if (this.active?.runId === runId) this.active.fenced = true;
  }

  /** Sends one prompt and waits until the run's session is idle again. */
  private async turn(sessionId: string, prompt: string, startedAt: number): Promise<void> {
    const remaining = RUN_TIMEOUT_MS - (Date.now() - startedAt);
    if (remaining <= 0) throw new Error("The run took longer than 30 minutes.");
    let unsubscribe = () => {};
    let poll: NodeJS.Timeout | undefined;
    let timeout: NodeJS.Timeout | undefined;
    const sentAt = Date.now();
    const idle = new Promise<void>((resolve, reject) => {
      unsubscribe = this.ctx.globalBus.subscribe((event) => {
        if (event.type === "session:idle" && event.sessionId === sessionId) resolve();
      });
      // A missed idle event must not hang the run: check every 15 s once the turn has had time to start.
      poll = setInterval(() => {
        if (Date.now() - sentAt > 20_000 && !this.ctx.sessionManager.isSessionBusy(sessionId)) resolve();
      }, 15_000);
      timeout = setTimeout(() => {
        if (this.active?.sessionId === sessionId) this.active.fenced = true;
        void this.ctx.sessionManager.abortSession(sessionId).catch(() => undefined);
        reject(new Error("The run took longer than 30 minutes and was stopped."));
      }, remaining);
    });
    try {
      await sendChatMessage(this.ctx, sessionId, prompt, { queue: "none" });
      await idle;
    } finally {
      unsubscribe();
      if (poll) clearInterval(poll);
      if (timeout) clearTimeout(timeout);
    }
  }

  private async readCredits(sessionId: string): Promise<number | null> {
    try {
      const metrics = await this.ctx.sessionManager.getSessionUsageMetrics(sessionId);
      return typeof metrics.aiCredits === "number" ? Math.round(metrics.aiCredits * 10) / 10 : null;
    } catch {
      return null;
    }
  }

  private async retention(): Promise<void> {
    const now = this.now().getTime();
    const runs = this.store.listRuns(200);
    const keep = new Set(runs.slice(0, KEEP_RECENT_SESSIONS).map((run) => run.id));
    for (const run of runs) {
      if (keep.has(run.id) || run.sessionDeleted || run.status === "running") continue;
      if (now - Date.parse(run.startedAt) < KEEP_RUN_SESSIONS_MS) continue;
      try {
        await this.deleteSession(run.sessionId);
        this.store.markSessionDeleted(run.id);
      } catch {
        // Busy or mid-delete: try again next time. A session that is already gone deletes without error.
      }
    }
    // Only a run whose session is gone may be forgotten: its record is what hides the session from the chat lists.
    this.store.pruneRuns(new Date(now - KEEP_RUNS_MS).toISOString());
  }

  // ── Schedule ──────────────────────────────────────────────

  private schedule(options: { catchUp: boolean }): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.nextRunAt = null;
    const settings = this.store.getSettings();
    if (this.disposed || this.isPreview || !settings.enabled || settings.times.length === 0) return;
    const now = this.now();
    if (options.catchUp) {
      const slot = previousScheduledRun(settings.times, now);
      const latest = this.store.latestRun();
      if (slot && now.getTime() - slot.getTime() < CATCH_UP_MS && (!latest || Date.parse(latest.startedAt) < slot.getTime())) {
        setTimeout(() => void this.think({ trigger: "schedule", rebuild: isRebuildSlot(settings.times, slot, settings.rebuildWeekday) }).catch(() => undefined), 60_000).unref();
      }
    }
    const next = nextScheduledRun(settings.times, now);
    if (!next) return;
    this.nextRunAt = next;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.now().getTime() + 1000 >= next.getTime()) {
        const current = this.store.getSettings();
        void this.think({ trigger: "schedule", rebuild: isRebuildSlot(current.times, next, current.rebuildWeekday) }).catch((error) => {
          console.warn(`[helm-thinker] Scheduled run skipped: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
      this.schedule({ catchUp: false });
    }, Math.min(MAX_TIMER_MS, Math.max(1000, next.getTime() - now.getTime())));
    this.timer.unref();
  }

  // ── Brief ─────────────────────────────────────────────────

  private link(bridge: string, target: { sessionId?: string; taskId?: string }): string | undefined {
    const source = this.sources().find((candidate) => candidate.id === bridge);
    return source ? sourceLink(source, target) : undefined;
  }

  private withLinks(brief: HelmBrief): HelmBrief {
    const resolveAction = (action: HelmAction): HelmAction => action.do.type === "open"
      ? { ...action, url: this.link(action.do.bridge, action.do) }
      : action;
    return {
      ...brief,
      items: brief.items.map((item) => {
        const first = item.evidence[0]?.target ?? item.actions.find((action) => action.do.type === "open")?.do as { sessionId?: string; taskId?: string } | undefined;
        return {
          ...item,
          evidence: item.evidence.map((evidence) => ({ ...evidence, url: this.link(evidence.target.bridge, evidence.target) })),
          actions: item.actions.map(resolveAction),
          ...(first ? { url: this.link(item.bridge, first) } : {}),
        };
      }),
      proposals: brief.proposals.map((proposal) => ({ ...proposal, actions: proposal.actions.map(resolveAction) })),
      watching: brief.watching.map((watch) => ({ ...watch, ...(watch.taskId ? { url: this.link(watch.bridge, { taskId: watch.taskId }) } : {}) })),
    };
  }

  async getBrief(): Promise<HelmBriefResponse> {
    const settings = this.store.getSettings();
    const latest = this.store.latestRun();
    const done = this.store.latestRun("done");
    const brief = done?.briefJson ? this.withLinks(JSON.parse(done.briefJson) as HelmBrief) : null;
    const handled: HelmHandledView[] = done
      ? this.store.listHandled(done.id).map(({ previousReadAt: _p, readThrough: _r, runId: _id, ...entry }) => ({ ...entry, url: this.link(entry.bridge, { sessionId: entry.sessionId }) }))
      : [];
    let since = { questions: 0, replies: 0 };
    if (done) {
      try {
        const sessions = await this.facade.listSessions();
        const after = (iso?: string) => !!iso && Date.parse(iso) > Date.parse(done.startedAt);
        since = {
          questions: sessions.filter((session) => !session.archived && session.needsUserInput && after(session.lastActivityAt)).length,
          replies: sessions.filter((session) => !session.archived && session.unread && !session.needsUserInput && session.runState === "idle" && after(session.lastActivityAt)).length,
        };
      } catch {
        // Counts are a nicety.
      }
    }
    return {
      run: done ? toRunView(done) : null,
      brief,
      itemStates: done ? this.store.getItemStates(done.id) : {},
      handled,
      changes: done?.changesJson ? JSON.parse(done.changesJson) as HelmMemoryChange[] : [],
      proposed: this.store.listMemory().filter((entry) => entry.status === "proposed"),
      running: this.getRunning(),
      lastFailure: latest && latest.status === "failed" && (!done || latest.startedAt > done.startedAt) ? toRunView(latest) : null,
      nextRunAt: this.nextRunAt?.toISOString() ?? null,
      since,
      settings,
      preview: this.isPreview,
    };
  }

  listRuns(): HelmRunView[] {
    return this.store.listRuns(20).map(toRunView);
  }

  private briefFor(runId: string): { run: HelmRunRecord; brief: HelmBrief } {
    const run = this.store.getRun(runId);
    if (!run?.briefJson) throw new HelmError("That brief is no longer available", 404);
    return { run, brief: JSON.parse(run.briefJson) as HelmBrief };
  }

  /** Carries out an action Tim clicked, or sends his own words to an item's conversation. */
  async act(runId: string, itemId: string, input: { actionId?: unknown; text?: unknown }): Promise<{ ok: true; outcome: string }> {
    const { run, brief } = this.briefFor(runId);
    if (this.store.latestRun("done")?.id !== run.id) throw new HelmError("Helm has written a newer brief. Refresh to act on it.", 409);
    const item = brief.items.find((candidate) => candidate.id === itemId);
    const proposal = item ? undefined : brief.proposals.find((candidate) => candidate.id === itemId);
    if (!item && !proposal) throw new HelmError("That item is no longer in the brief", 404);
    const title = item?.title ?? proposal!.text;
    // Claimed before anything is sent, so a double click or a second tab can't act twice.
    if (!this.store.claimItem(run.id, itemId)) throw new HelmError("This has already been done", 409);
    let outcome: string;
    try {
      outcome = await this.carryOut(run.id, itemId, item, proposal, input);
    } catch (error) {
      this.store.setItemState(run.id, itemId, "open", null);
      throw error;
    }
    this.store.setItemState(run.id, itemId, "done", outcome);
    this.store.addFeedback({ runId: run.id, itemId, kind: "answered", note: outcome, itemTitle: title });
    return { ok: true, outcome };
  }

  private async carryOut(runId: string, itemId: string, item: HelmBriefItem | undefined, proposal: HelmProposal | undefined, input: { actionId?: unknown; text?: unknown }): Promise<string> {
    let outcome: string;
    if (typeof input.text === "string") {
      const words = input.text.trim();
      if (!item?.reply) throw new HelmError("This item has no conversation to reply to", 400);
      if (!words || words.length > 4000) throw new HelmError("Write a reply of up to 4000 characters", 400);
      const source = this.source(item.reply.bridge);
      if (item.reply.requestId) {
        const live = await source.input(item.reply.sessionId, "user_input", item.reply.requestId);
        if (live?.kind !== "user_input") throw new HelmError("That question is no longer waiting. Open the conversation to see what happened.", 409);
        const request = live.request as { choices?: string[]; allowFreeform?: boolean };
        const choice = request.choices?.find((candidate) => normalizeChoice(candidate) === normalizeChoice(words));
        if (!choice && request.allowFreeform === false) throw new HelmError(`The answer must be one of: ${request.choices?.join(", ")}`, 400);
        await source.answer(item.reply.sessionId, item.reply.requestId, choice ?? words, !choice);
        outcome = "Answered";
      } else {
        await source.send(item.reply.sessionId, words, `helm-${runId}-${itemId}-reply`);
        outcome = "Replied";
      }
    } else {
      const action = (item?.actions ?? proposal!.actions).find((candidate) => candidate.id === input.actionId);
      if (!action) throw new HelmError("That action is no longer available", 404);
      const what = action.do;
      const source = this.source(what.bridge);
      if (what.type === "answer") {
        const live = await source.input(what.sessionId, "user_input", what.requestId);
        if (live?.kind !== "user_input") throw new HelmError("That question is no longer waiting. Open the conversation to see what happened.", 409);
        await source.answer(what.sessionId, what.requestId, what.answer, what.wasFreeform);
        outcome = `Answered: ${what.answer}`;
      } else if (what.type === "send") {
        await source.send(what.sessionId, what.message, `helm-${runId}-${itemId}-${action.id}`);
        outcome = `Sent: ${action.label}`;
      } else if (what.type === "tick") {
        await source.tick(what.actionId);
        outcome = "Ticked off";
      } else {
        throw new HelmError("This action is carried out in the app", 400);
      }
    }
    return outcome;
  }

  feedback(runId: string, itemId: string, input: { kind?: unknown; note?: unknown }): void {
    const { run, brief } = this.briefFor(runId);
    const title = brief.items.find((item) => item.id === itemId)?.title ?? brief.proposals.find((proposal) => proposal.id === itemId)?.text;
    if (!title) throw new HelmError("That item is no longer in the brief", 404);
    const kind = input.kind;
    if (kind !== "not_for_helm" && kind !== "dismiss" && kind !== "done" && kind !== "reopen") throw new HelmError("kind must be not_for_helm, dismiss, done or reopen", 400);
    const note = typeof input.note === "string" && input.note.trim() ? input.note.trim().slice(0, 1000) : null;
    if (kind === "reopen") {
      this.store.setItemState(run.id, itemId, "open", null);
      return;
    }
    this.store.setItemState(run.id, itemId, kind === "done" ? "done" : "dismissed", kind === "not_for_helm" ? "Not for Helm" : kind === "done" ? "Done" : "Dismissed");
    this.store.addFeedback({ runId: run.id, itemId, kind, note, itemTitle: title });
  }

  undoHandled(id: string): HelmHandledView {
    const entry = this.store.getHandled(id);
    if (!entry) throw new HelmError("Not found", 404);
    if (entry.undoneAt) throw new HelmError("Already undone", 409);
    if (entry.bridge !== "local" || !entry.readThrough) throw new HelmError("This can't be undone here", 400);
    const restored = this.ctx.readStateStore.restoreRead(entry.sessionId, entry.previousReadAt, entry.readThrough);
    this.store.markHandledUndone(id);
    this.store.addFeedback({ runId: entry.runId, itemId: `handled:${id}`, kind: "undo", note: restored ? null : "Tim had already read it", itemTitle: `Marked read: ${entry.title}` });
    if (restored) this.emitReadStateChanged();
    const { previousReadAt: _p, readThrough: _r, runId: _id, ...view } = this.store.getHandled(id)!;
    return view;
  }

  // ── Memory (Tim's side) ───────────────────────────────────

  listMemory(): HelmMemoryEntry[] {
    return this.store.listMemory();
  }

  addMemory(input: { kind?: unknown; text?: unknown }, source = "Tim"): HelmMemoryEntry {
    const kinds: HelmMemoryKind[] = ["priority", "rule", "person", "date"];
    if (!kinds.includes(input.kind as HelmMemoryKind)) throw new HelmError("kind must be priority, rule, person or date", 400);
    const text = typeof input.text === "string" ? input.text.trim() : "";
    if (!text || text.length > 600) throw new HelmError("Write up to 600 characters", 400);
    const kind = input.kind as HelmMemoryKind;
    if (this.store.countActive(kind) >= HELM_MEMORY_LIMITS[kind]) throw new HelmError(`Helm keeps at most ${HELM_MEMORY_LIMITS[kind]} of these. Forget one first.`, 409);
    return this.store.addMemory({ kind: input.kind as HelmMemoryKind, text, source, author: "user", status: "active" });
  }

  updateMemory(id: string, input: { text?: unknown; status?: unknown }): HelmMemoryEntry {
    const entry = this.store.getMemory(id);
    if (!entry || entry.status === "forgotten") throw new HelmError("Not found", 404);
    if (input.status !== undefined && input.status !== "active" && input.status !== "forgotten") throw new HelmError("status must be active or forgotten", 400);
    let text: string | undefined;
    if (input.text !== undefined) {
      text = typeof input.text === "string" ? input.text.trim() : "";
      const max = entry.kind === "picture" ? 40_000 : 600;
      if (!text || text.length > max) throw new HelmError(`Write up to ${max} characters`, 400);
    }
    // Keeping or editing something Helm wrote makes it Tim's: later runs follow it and can't change it.
    // The standing picture stays Helm's so it keeps being rewritten.
    const takeOver = entry.kind !== "picture" && (text !== undefined || (input.status === "active" && entry.status === "proposed"));
    return this.store.updateMemory(id, {
      ...(text !== undefined ? { text } : {}),
      ...(input.status !== undefined ? { status: input.status as "active" | "forgotten" } : {}),
      ...(takeOver ? { author: "user" as const } : {}),
    })!;
  }
}
