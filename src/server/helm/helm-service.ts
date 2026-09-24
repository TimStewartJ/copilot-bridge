// Helm: Bridge's orchestration manager. One current conversation, usable as typed chat or
// hands-free voice, backed by an ordinary Bridge session with the Helm profile.
//
// Context lifecycle: easy to reset, still resumable, never eternal.
// - "New conversation" starts clean; the previous one stays in recent history.
// - A conversation left idle long enough stops being current, so Helm opens fresh, with a
//   one-click way back to where you left off.
// - Recent conversations expire after a retention window unless the user keeps them.
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AppContext } from "../app-context.js";
import type { BridgeToolDefinition } from "../agent-tools-mcp/server.js";
import type { SessionConfigProfile } from "../session-manager.js";
import { parseWorkspaceYamlSessionName } from "../session-workspace-yaml.js";
import { applyHelmSessionProfile, selectHelmModel } from "./helm-session-profile.js";
import type { HelmConversationRecord, HelmStore } from "./helm-store.js";
import {
  createHelmToolDefinitions,
  type HelmBridgeFacade,
  type HelmHandsFreeHooks,
  type HelmToolRuntime,
} from "./helm-tools.js";

export const HELM_POLICY = {
  /** An idle conversation stops being current after this long, so Helm opens fresh. */
  freshAfterMs: 6 * 60 * 60_000,
  /** Conversations idle longer than this are deleted unless kept. */
  retainMs: 14 * 24 * 60 * 60_000,
  /** Most conversations retained (kept ones excluded). */
  maxConversations: 25,
  /** How often retention runs while the server is up. */
  pruneIntervalMs: 60 * 60_000,
} as const;

/** How a Helm turn is answered: in the chat, or out loud in hands-free. */
export type HelmTurnMode = "typed" | "spoken";

/**
 * Reasoning effort per mode, used when Settings don't say otherwise. Typed turns can afford to
 * think; spoken turns keep someone waiting in silence, so they think less. At xhigh the wait from
 * the end of speech to the first spoken word was 5.3 s at the median and up to 19 s (24 Sep 2026).
 */
export const HELM_DEFAULT_REASONING_EFFORTS: Record<HelmTurnMode, string> = { typed: "max", spoken: "medium" };

export interface HelmConversationView {
  sessionId: string;
  title: string | null;
  createdAt: string;
  lastActiveAt: string;
  turnCount: number;
  kept: boolean;
  busy: boolean;
  handsFree: boolean;
  /** When retention will delete it; absent for kept conversations. */
  expiresAt?: string;
}

export interface HelmStateView {
  current: HelmConversationView | null;
  /** The conversation to offer when Helm opened fresh: the most recent one with history. */
  resumable: HelmConversationView | null;
  recent: HelmConversationView[];
  policy: { freshAfterMs: number; retainMs: number; maxConversations: number };
  /** Effort each mode asks for right now (settings, else defaults). Models clamp to what they support. */
  reasoningEfforts: Record<HelmTurnMode, string>;
}

export class HelmError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface HelmServiceOptions {
  ctx: AppContext;
  store: HelmStore;
  facade: HelmBridgeFacade;
  /** Deletes a session and every Bridge-owned row that belongs to it. */
  deleteSession(sessionId: string): Promise<void>;
  now?: () => number;
}

export class HelmService implements HelmToolRuntime {
  private readonly ctx: AppContext;
  private readonly store: HelmStore;
  private readonly facade: HelmBridgeFacade;
  private readonly deleteSession: (sessionId: string) => Promise<void>;
  private readonly now: () => number;
  private tools?: BridgeToolDefinition[];
  private profile?: SessionConfigProfile;
  private workingDirectory?: string;
  private readonly handsFree = new Map<string, HelmHandsFreeHooks>();
  private readonly watched = new Map<string, Set<string>>();
  /** Session names, fed by title events; null means the session is known to be unnamed. */
  private readonly titles = new Map<string, string | null>();
  private readonly unsubscribeBus: () => void;
  private pruneTimer?: NodeJS.Timeout;
  private pruning?: Promise<number>;

  constructor(options: HelmServiceOptions) {
    this.ctx = options.ctx;
    this.store = options.store;
    this.facade = options.facade;
    this.deleteSession = options.deleteSession;
    this.now = options.now ?? Date.now;
    this.unsubscribeBus = this.ctx.globalBus.subscribe((event) => {
      if (!event.sessionId || !this.store.isHelmSession(event.sessionId)) return;
      if (event.type === "session:idle") {
        this.store.touch(event.sessionId, new Date(this.now()).toISOString());
      } else if (event.type === "session:title" && typeof event.title === "string") {
        this.titles.set(event.sessionId, event.title.trim() || null);
      }
    });
  }

  /** Starts background retention. Separate from construction so tests stay timer-free. */
  startRetention(): void {
    if (this.pruneTimer) return;
    this.pruneTimer = setInterval(() => void this.prune().catch(() => undefined), HELM_POLICY.pruneIntervalMs);
    this.pruneTimer.unref();
    void this.prune().catch(() => undefined);
  }

  dispose(): void {
    this.unsubscribeBus();
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.pruneTimer = undefined;
  }

  isHelmSession(sessionId: string | undefined | null): boolean {
    return this.store.isHelmSession(sessionId);
  }

  // ── Session profile ────────────────────────────────────────────

  private getTools(): BridgeToolDefinition[] {
    this.tools ??= createHelmToolDefinitions(this.ctx, this.facade, this);
    return this.tools;
  }

  private getWorkingDirectory(): string {
    if (!this.workingDirectory) {
      const dataDir = this.ctx.runtimePaths?.dataDir;
      const directory = dataDir ? join(dataDir, "helm") : process.cwd();
      if (dataDir) mkdirSync(directory, { recursive: true });
      this.workingDirectory = directory;
    }
    return this.workingDirectory;
  }

  getSessionProfile(): SessionConfigProfile {
    if (!this.profile) {
      const tools = this.getTools();
      this.profile = {
        toolNames: tools.map((tool) => tool.name),
        apply: (config) => applyHelmSessionProfile(config, {
          tools,
          workingDirectory: this.getWorkingDirectory(),
          defaultWorkModel: this.ctx.settingsStore.getSettings().model,
          glossary: this.ctx.settingsStore.getSettings().helm?.glossary,
        }),
        // Anything that isn't a hands-free turn (chat, a transcribed recording) is answered in the chat.
        defaultTurnReasoningEffort: () => this.getTurnReasoningEffort("typed"),
      };
    }
    return this.profile;
  }

  /** The effort a turn in this mode asks for. Read per turn, so a settings change applies to the next message. */
  getTurnReasoningEffort(mode: HelmTurnMode): string {
    const settings = this.ctx.settingsStore.getSettings().helm;
    const configured = mode === "spoken" ? settings?.spokenReasoningEffort : settings?.typedReasoningEffort;
    return configured ?? HELM_DEFAULT_REASONING_EFFORTS[mode];
  }

  // ── Hands-free binding and watched sessions (HelmToolRuntime) ──

  /** Registers the live voice conversation of a Helm session. Returns an unbind function. */
  bindHandsFree(helmSessionId: string, hooks: HelmHandsFreeHooks): () => void {
    this.handsFree.set(helmSessionId, hooks);
    return () => {
      if (this.handsFree.get(helmSessionId) === hooks) this.handsFree.delete(helmSessionId);
    };
  }

  getHandsFreeHooks(helmSessionId: string | undefined): HelmHandsFreeHooks | undefined {
    return helmSessionId ? this.handsFree.get(helmSessionId) : undefined;
  }

  watchSession(helmSessionId: string | undefined, sessionId: string): void {
    if (!helmSessionId || helmSessionId === sessionId) return;
    let sessions = this.watched.get(helmSessionId);
    if (!sessions) {
      sessions = new Set();
      this.watched.set(helmSessionId, sessions);
    }
    sessions.add(sessionId);
  }

  isWatched(helmSessionId: string, sessionId: string): boolean {
    return this.watched.get(helmSessionId)?.has(sessionId) === true;
  }

  // ── Conversations ──────────────────────────────────────────────

  /** The session's own name (set by auto-naming or a rename), read once and then kept current by title events. */
  private async resolveTitle(sessionId: string): Promise<string | null> {
    const cached = this.titles.get(sessionId);
    if (cached !== undefined) return cached;
    let title: string | null = null;
    try {
      const copilotHome = this.ctx.copilotHome ?? join(homedir(), ".copilot");
      const content = await readFile(join(copilotHome, "session-state", sessionId, "workspace.yaml"), "utf8");
      title = parseWorkspaceYamlSessionName(content)?.trim() || null;
    } catch {
      title = null;
    }
    // A title event may have landed while the file was being read; it is newer.
    if (!this.titles.has(sessionId) && title) this.titles.set(sessionId, title);
    return this.titles.get(sessionId) ?? title;
  }

  private async view(record: HelmConversationRecord): Promise<HelmConversationView> {
    const expiresAt = record.kept ? undefined : new Date(Date.parse(record.lastActiveAt) + HELM_POLICY.retainMs).toISOString();
    return {
      sessionId: record.sessionId,
      title: await this.resolveTitle(record.sessionId),
      createdAt: record.createdAt,
      lastActiveAt: record.lastActiveAt,
      turnCount: record.turnCount,
      kept: record.kept,
      busy: this.ctx.sessionManager.isSessionBusy(record.sessionId),
      handsFree: this.handsFree.has(record.sessionId),
      ...(expiresAt ? { expiresAt } : {}),
    };
  }

  private isInUse(sessionId: string): boolean {
    return this.handsFree.has(sessionId) || this.ctx.sessionManager.isSessionBusy(sessionId);
  }

  /** Lets a conversation that has sat idle stop being current, so Helm opens fresh. */
  private retireStaleCurrent(): void {
    const current = this.store.getCurrent();
    if (!current || this.isInUse(current.sessionId)) return;
    if (this.now() - Date.parse(current.lastActiveAt) > HELM_POLICY.freshAfterMs) this.store.setCurrent(null);
  }

  async getState(): Promise<HelmStateView> {
    this.retireStaleCurrent();
    const records = this.store.list();
    const current = records.find((record) => record.isCurrent);
    const others = records.filter((record) => record !== current);
    const resumable = current ? undefined : others.find((record) => record.turnCount > 0);
    return {
      current: current ? await this.view(current) : null,
      resumable: resumable ? await this.view(resumable) : null,
      recent: await Promise.all(others.map((record) => this.view(record))),
      policy: {
        freshAfterMs: HELM_POLICY.freshAfterMs,
        retainMs: HELM_POLICY.retainMs,
        maxConversations: HELM_POLICY.maxConversations,
      },
      reasoningEfforts: { typed: this.getTurnReasoningEffort("typed"), spoken: this.getTurnReasoningEffort("spoken") },
    };
  }

  async getConversation(sessionId: string): Promise<HelmConversationView | undefined> {
    const record = this.store.get(sessionId);
    return record ? this.view(record) : undefined;
  }

  /** Turns the user has taken in a conversation; zero means it is still fresh. */
  getTurnCount(sessionId: string): number {
    return this.store.get(sessionId)?.turnCount ?? 0;
  }

  /** Starts a new conversation and makes it current. The previous one stays in recent history. */
  async createConversation(options: { model?: string } = {}): Promise<HelmConversationView> {
    const previous = this.store.getCurrent();
    const models = await this.ctx.sessionManager.listModels().catch(() => []);
    const selection = selectHelmModel(models, options.model?.trim() || undefined, this.getTurnReasoningEffort("typed"));
    const sessionId = randomUUID();
    // Registered before creation so the session is built with the Helm profile from its first config.
    this.store.create(sessionId, new Date(this.now()).toISOString());
    try {
      await this.ctx.sessionManager.createSession({
        expectedSessionId: sessionId,
        ...(selection.model ? { model: selection.model } : {}),
        ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
      });
    } catch (error) {
      this.store.remove(sessionId);
      if (previous) this.store.setCurrent(previous.sessionId);
      throw error;
    }
    if (previous && previous.turnCount === 0 && !this.isInUse(previous.sessionId)) {
      void this.removeConversation(previous.sessionId).catch(() => undefined);
    }
    return this.view(this.store.get(sessionId)!);
  }

  /** Clears the current conversation so the next message starts a new one. Nothing is deleted. */
  startFresh(): Promise<HelmStateView> {
    const current = this.store.getCurrent();
    this.store.setCurrent(null);
    if (current && current.turnCount === 0 && !this.isInUse(current.sessionId)) {
      void this.removeConversation(current.sessionId).catch(() => undefined);
    }
    return this.getState();
  }

  async resumeConversation(sessionId: string): Promise<HelmConversationView> {
    const record = this.store.get(sessionId);
    if (!record) throw new HelmError("Helm conversation not found", 404);
    this.store.setCurrent(sessionId);
    this.store.touch(sessionId, new Date(this.now()).toISOString());
    return this.view(this.store.get(sessionId)!);
  }

  async setKept(sessionId: string, kept: boolean): Promise<HelmConversationView> {
    const record = this.store.setKept(sessionId, kept);
    if (!record) throw new HelmError("Helm conversation not found", 404);
    return this.view(record);
  }

  recordTurn(sessionId: string): void {
    if (this.store.isHelmSession(sessionId)) this.store.recordTurn(sessionId, new Date(this.now()).toISOString());
  }

  async deleteConversation(sessionId: string): Promise<void> {
    if (!this.store.get(sessionId)) throw new HelmError("Helm conversation not found", 404);
    if (this.handsFree.has(sessionId)) throw new HelmError("Leave hands-free before deleting this conversation", 409);
    if (this.ctx.sessionManager.isSessionBusy(sessionId)) throw new HelmError("Helm is still replying in this conversation", 409);
    await this.removeConversation(sessionId);
  }

  private async removeConversation(sessionId: string): Promise<void> {
    try {
      await this.deleteSession(sessionId);
    } finally {
      // The row goes even if the backend delete failed: the session is locally gone either way,
      // and a dangling row would keep resurrecting an unusable conversation.
      this.store.remove(sessionId);
      this.watched.delete(sessionId);
      this.titles.delete(sessionId);
    }
  }

  /** Deletes conversations past retention. Returns how many were removed. */
  prune(): Promise<number> {
    this.pruning ??= this.runPrune().finally(() => {
      this.pruning = undefined;
    });
    return this.pruning;
  }

  private async runPrune(): Promise<number> {
    const now = this.now();
    const candidates = this.store.list().filter((record) => !record.kept && !record.isCurrent && !this.isInUse(record.sessionId));
    const expired = new Set<string>();
    for (const record of candidates) {
      const idleMs = now - Date.parse(record.lastActiveAt);
      if (idleMs > HELM_POLICY.retainMs || (record.turnCount === 0 && idleMs > 60_000)) expired.add(record.sessionId);
    }
    const surviving = candidates.filter((record) => !expired.has(record.sessionId));
    for (const record of surviving.slice(HELM_POLICY.maxConversations)) expired.add(record.sessionId);
    let removed = 0;
    for (const sessionId of expired) {
      try {
        await this.removeConversation(sessionId);
        removed++;
      } catch (error) {
        console.warn(`[helm] Could not delete expired conversation ${sessionId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (removed > 0) console.log(`[helm] Retention removed ${removed} conversation${removed === 1 ? "" : "s"}`);
    return removed;
  }
}
