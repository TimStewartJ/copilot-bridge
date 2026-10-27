// Helm: Bridge's orchestration manager. One current conversation, usable as typed chat or
// hands-free voice, backed by an ordinary Bridge session with the Helm profile.
//
// Context lifecycle: easy to reset, still resumable, never eternal.
// - "New conversation" starts clean; the previous one stays in recent history.
// - A conversation left idle long enough stops being current, so Helm opens fresh, with a
//   one-click way back to where you left off.
// - Recent conversations expire after a retention window unless the user keeps them.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AppContext } from "../app-context.js";
import {
  HELM_SETTINGS_DEFAULTS,
  isHelmLegacySettingKey,
  validateHelmSettingsPatch,
  type HelmLegacySettings,
  type HelmSettingsResponse,
  type UnifiedHelmSettings,
} from "../../shared/helm-settings.js";
import { KOKORO_VOICES } from "../voice/voice-catalog.js";
import type { BridgeToolDefinition } from "../agent-tools-mcp/server.js";
import type { SessionConfigProfile } from "../session-manager.js";
import { parseWorkspaceYamlSessionName } from "../session-workspace-yaml.js";
import { ensureNeutralWorkspaceDir } from "../neutral-workspace.js";
import { pathsEqual } from "../path-utils.js";
import { hasActiveDeferredWork } from "../schedule-session-retention.js";
import { buildHelmChatGuidance, HELM_CHAT_ROLE } from "./helm-prompt.js";
import { applyHelmChatProfile, HELM_CHAT_EXCLUDED_TOOLS } from "./helm-session-profile.js";
import { chooseHelmModel } from "./helm-model.js";
import type { HelmConversationRecord, HelmStore } from "./helm-store.js";
import {
  createHelmToolDefinitions,
  HELM_TOOL_NAMES,
  type HelmBridgeFacade,
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

/** Effort for a Helm conversation or look when neither the Helm role nor the user's default says. */
export const HELM_FALLBACK_REASONING_EFFORT = "high";

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
  /** The gateway uses persistent Helm voice settings when startup overrides are omitted. */
  settingsSchemaVersion: 1;
  current: HelmConversationView | null;
  /** The conversation to offer when Helm opened fresh: the most recent one with history. */
  resumable: HelmConversationView | null;
  recent: HelmConversationView[];
  policy: { freshAfterMs: number; retainMs: number; maxConversations: number };
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
  /** Conversations hands-free is speaking for, with how many connections. */
  private readonly handsFree = new Map<string, number>();
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

  /**
   * Conversations from before Helm's chat became an ordinary chat were pinned to data/helm, which
   * can sit inside the Bridge's own checkout and would load its repository instructions. Moves
   * them to the Bridge workspace new conversations get. Returns how many moved.
   */
  moveLegacyWorkspaces(): number {
    const dataDir = this.ctx.runtimePaths?.dataDir;
    const workspace = this.ctx.runtimePaths ? ensureNeutralWorkspaceDir(this.ctx.runtimePaths) : undefined;
    if (!dataDir || !workspace) return 0;
    const legacy = join(dataDir, "helm");
    let moved = 0;
    for (const record of this.store.list()) {
      const pinned = this.ctx.sessionWorkspaceStore.getWorkspace(record.sessionId)?.cwd;
      if (pinned && pathsEqual(pinned, legacy)) {
        this.ctx.sessionWorkspaceStore.setWorkspace(record.sessionId, workspace);
        moved++;
      }
    }
    if (moved > 0) console.log(`[helm] Moved ${moved} conversation${moved === 1 ? "" : "s"} to the Bridge workspace`);
    return moved;
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

  async getSettings(): Promise<HelmSettingsResponse> {
    const [models, modelsError] = await this.listHelmModels();
    const { legacy, ...stored } = this.ctx.settingsStore.getSettings().helm ?? {};
    return {
      schemaVersion: 1,
      settings: { ...HELM_SETTINGS_DEFAULTS, ...stored, ...legacy },
      voices: KOKORO_VOICES.map(({ id, name }) => ({ id, name })),
      ...(models ? { models } : { modelsError }),
    };
  }

  /**
   * Saves hands-free settings and the names list. The retired model and effort keys (sent by Tether)
   * are kept as written and returned by reads, so its check that a write took passes; nothing reads them.
   */
  async patchSettings(input: unknown): Promise<HelmSettingsResponse> {
    let patch: Partial<UnifiedHelmSettings>;
    try {
      patch = validateHelmSettingsPatch(input);
    } catch (error) {
      throw new HelmError(error instanceof Error ? error.message : String(error), 400);
    }
    if (patch.voice !== undefined && !KOKORO_VOICES.some(({ id }) => id === patch.voice)) throw new HelmError("Unknown Helm voice", 400);
    const stored = this.ctx.settingsStore.getSettings().helm;
    const legacy: HelmLegacySettings = { ...stored?.legacy };
    const current: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (isHelmLegacySettingKey(key)) Object.assign(legacy, { [key]: value });
      else current[key] = value;
    }
    this.ctx.settingsStore.updateSettings({
      helm: { ...stored, ...current, ...(Object.keys(legacy).length ? { legacy } : {}) },
    });
    return this.getSettings();
  }

  private async listHelmModels(): Promise<[{ id: string; name: string }[] | undefined, string | undefined]> {
    try {
      const models = await this.ctx.sessionManager.listModels();
      return [models.filter((model) => !model.policy || model.policy.state === "enabled").map(({ id, name }) => ({ id, name: name || id })), undefined];
    } catch {
      return [undefined, "Model choices are temporarily unavailable. Try again later."];
    }
  }

  // ── Session profile ────────────────────────────────────────────

  /** Helm's own tools. The chat already has the Bridge's task, docs and schedule tools as an ordinary chat. */
  private getTools(): BridgeToolDefinition[] {
    const own = new Set<string>(HELM_TOOL_NAMES);
    this.tools ??= createHelmToolDefinitions(this.ctx, this.facade, this).filter((tool) => own.has(tool.name));
    return this.tools;
  }

  getSessionProfile(): SessionConfigProfile {
    if (!this.profile) {
      const tools = this.getTools();
      const excluded = new Set<string>(HELM_CHAT_EXCLUDED_TOOLS);
      this.profile = {
        expectedToolNames: (bridgeToolNames) => [...new Set([...bridgeToolNames, ...tools.map((tool) => tool.name)])].filter((name) => !excluded.has(name)),
        configOptions: () => {
          const settings = this.ctx.settingsStore.getSettings();
          return {
            promptProfile: "assistant",
            promptRole: HELM_CHAT_ROLE,
            extraGuidance: buildHelmChatGuidance({
              timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              ...(settings.model ? { defaultWorkModel: settings.model } : {}),
              ...(settings.helm?.glossary ? { glossary: settings.helm.glossary } : {}),
            }),
          };
        },
        apply: (config) => applyHelmChatProfile(config, { tools }),
      };
    }
    return this.profile;
  }

  // ── Hands-free binding and watched sessions (HelmToolRuntime) ──

  /** Marks a Helm conversation as having hands-free on, so it isn't retired or deleted meanwhile. Returns an unbind function. */
  bindHandsFree(helmSessionId: string): () => void {
    this.handsFree.set(helmSessionId, (this.handsFree.get(helmSessionId) ?? 0) + 1);
    let bound = true;
    return () => {
      if (!bound) return;
      bound = false;
      const count = (this.handsFree.get(helmSessionId) ?? 1) - 1;
      if (count > 0) this.handsFree.set(helmSessionId, count);
      else this.handsFree.delete(helmSessionId);
    };
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

  /** Deferred work or a result still on its way: deleting the conversation would cancel or lose it. */
  private hasPendingWork(sessionId: string): boolean {
    const { deferredPromptStore, deferLoopStore } = this.ctx;
    if (!deferredPromptStore && !deferLoopStore) return false;
    return hasActiveDeferredWork(sessionId, { deferredPromptStore, deferLoopStore })
      || (deferredPromptStore?.listDeliveriesForSession(sessionId)
        .some((delivery) => delivery.status === "pending" || delivery.status === "running") ?? false);
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
      settingsSchemaVersion: 1,
      current: current ? await this.view(current) : null,
      resumable: resumable ? await this.view(resumable) : null,
      recent: await Promise.all(others.map((record) => this.view(record))),
      policy: {
        freshAfterMs: HELM_POLICY.freshAfterMs,
        retainMs: HELM_POLICY.retainMs,
        maxConversations: HELM_POLICY.maxConversations,
      },
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
    const selection = chooseHelmModel(this.ctx.settingsStore.getSettings(), models, {
      ...(options.model?.trim() ? { requested: options.model.trim() } : {}),
      fallbackEffort: HELM_FALLBACK_REASONING_EFFORT,
    });
    const sessionId = randomUUID();
    // Registered before creation so the session is built with the Helm profile from its first config.
    this.store.create(sessionId, new Date(this.now()).toISOString());
    try {
      await this.ctx.sessionManager.createSession({
        expectedSessionId: sessionId,
        ...(selection.model ? { model: selection.model } : {}),
        ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
        ...(selection.contextTier ? { contextTier: selection.contextTier } : {}),
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
    const candidates = this.store.list().filter((record) => !record.kept && !record.isCurrent
      && !this.isInUse(record.sessionId) && !this.hasPendingWork(record.sessionId));
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
