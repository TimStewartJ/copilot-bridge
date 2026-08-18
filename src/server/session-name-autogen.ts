import type { AgentModelInfo } from "./agent-backend/index.js";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { deleteCliSessionStoreRows } from "./cli-session-store.js";
import {
  buildSessionTitleSystemPrompt,
  buildSessionTitleUserPrompt,
  createDisposableTitleSessionId,
  extractGeneratedSessionTitle,
  isDisposableTitleSessionId,
  selectSessionTitleModel,
} from "./session-name-generator.js";
import {
  type WorkspaceSessionNameMetadata,
} from "./session-workspace-yaml.js";
import {
  isRestartCutoverInProgress,
  refreshRestartStateSync,
} from "./restart-controller.js";
import {
  buildSessionNameHelperBaseConfig,
  type SetSessionNameOptions,
} from "./session-name-rpc.js";
import { readSdkSessionEvents } from "./sdk-session-events.js";
import { isSdkAgentUserMessage } from "./sdk-event-identity.js";

const SESSION_NAME_GENERATION_RETRY_MS = 60 * 60 * 1000;
const TITLE_HELPER_TIMEOUT_MS = 30_000;

export interface SessionNameAutogeneratorDeps {
  listModels(): Promise<AgentModelInfo[]>;
  createSession(config: any): Promise<any>;
  deleteSession(sessionId: string): Promise<void>;
  getCopilotHome(): string;
  getSessionName(sessionId: string): Promise<string | undefined>;
  getSessionNameMetadata(sessionId: string): WorkspaceSessionNameMetadata | undefined;
  setSessionName(sessionId: string, name: string, opts?: SetSessionNameOptions): Promise<void>;
  recordSpan?: (name: string, duration: number, sessionId?: string, metadata?: Record<string, unknown>) => void;
  logger?: Pick<typeof console, "warn">;
}

export interface SessionAutoNameOptions {
  session?: any;
  userMessages?: string[];
  includeHistory?: boolean;
  replaceExistingName?: string | true;
}

function collectRecentUserMessages(events: any[]): string[] {
  const messages: string[] = [];
  for (const event of events) {
    if (event?.type !== "user.message") continue;
    if (isSdkAgentUserMessage(event)) continue;
    const data = event.data;
    if (data && typeof data === "object" && "source" in data) continue;
    const content = data?.content;
    if (typeof content === "string" && content.trim()) messages.push(content.trim());
  }
  return messages.slice(-20);
}

function normalizeUserMessages(messages: string[] | undefined): string[] {
  return (messages ?? [])
    .map((message) => message.trim())
    .filter(Boolean)
    .slice(-20);
}

function mergeRecentUserMessages(historyMessages: string[], providedMessages: string[]): string[] {
  const messages = [...historyMessages];
  for (const message of providedMessages) {
    if (messages[messages.length - 1] !== message) {
      messages.push(message);
    }
  }
  return messages.slice(-20);
}

function normalizeComparableName(name: string | undefined): string | undefined {
  const normalized = name?.trim().replace(/^["']+|["']+$/g, "").replace(/\s+/g, " ");
  return normalized || undefined;
}

function hasExplicitSessionName(
  metadata: WorkspaceSessionNameMetadata | undefined,
  replaceExistingName?: string,
): boolean {
  const effectiveName = normalizeComparableName(metadata?.effectiveName);
  return !!effectiveName
    && metadata?.userNamed !== false
    && effectiveName !== replaceExistingName;
}

export class SessionNameAutogenerator {
  private readonly generationPromises = new Map<string, Promise<void>>();
  private readonly generationLastAttempt = new Map<string, number>();

  constructor(private readonly deps: SessionNameAutogeneratorDeps) {}

  private recordSpan(name: string, start: number, sessionId?: string, metadata?: Record<string, unknown>): void {
    this.deps.recordSpan?.(name, Date.now() - start, sessionId, metadata);
  }

  private trackGeneration(sessionId: string, work: () => Promise<void>): void {
    const promise = work()
      .catch((error) => {
        this.deps.logger?.warn(`[sdk] [${sessionId.slice(0, 8)}] Session auto-name skipped: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        if (this.generationPromises.get(sessionId) === promise) {
          this.generationPromises.delete(sessionId);
        }
      });
    this.generationPromises.set(sessionId, promise);
  }

  maybeAutoNameSession(
    sessionId: string,
    options: SessionAutoNameOptions = {},
  ): void {
    if (isDisposableTitleSessionId(sessionId)) return;
    const replacesExistingName = options.replaceExistingName !== undefined;
    const existing = this.generationPromises.get(sessionId);
    if (existing) {
      if (!replacesExistingName) return;
      this.trackGeneration(sessionId, async () => {
        await existing;
        await this.generateAndSetMissingSessionName(sessionId, options);
      });
      return;
    }

    const lastAttempt = this.generationLastAttempt.get(sessionId);
    if (!replacesExistingName && lastAttempt && Date.now() - lastAttempt < SESSION_NAME_GENERATION_RETRY_MS) return;

    this.trackGeneration(
      sessionId,
      () => this.generateAndSetMissingSessionName(sessionId, options),
    );
  }

  private async generateAndSetMissingSessionName(
    sessionId: string,
    options: SessionAutoNameOptions,
  ): Promise<void> {
    const start = Date.now();
    const existingMetadata = this.deps.getSessionNameMetadata(sessionId);
    let currentNameAtStart: string | undefined;
    if (options.replaceExistingName === true) {
      const currentName = options.session && typeof options.session.getName === "function"
        ? (await options.session.getName())?.name
        : await this.deps.getSessionName(sessionId);
      currentNameAtStart = normalizeComparableName(currentName);
    }
    const replaceExistingName = typeof options.replaceExistingName === "string"
      ? normalizeComparableName(options.replaceExistingName)
      : options.replaceExistingName === true
        ? currentNameAtStart ?? normalizeComparableName(existingMetadata?.effectiveName)
        : undefined;
    if (hasExplicitSessionName(existingMetadata, replaceExistingName)) {
      this.recordSpan("session.name.autogen", start, sessionId, { result: "skipped_existing" });
      return;
    }
    if (replaceExistingName) {
      const currentName = currentNameAtStart ?? (
        options.session && typeof options.session.getName === "function"
          ? (await options.session.getName())?.name
          : await this.deps.getSessionName(sessionId)
      );
      if (normalizeComparableName(currentName) !== replaceExistingName) {
        this.recordSpan("session.name.autogen", start, sessionId, { result: "skipped_existing" });
        return;
      }
    }
    const providedUserMessages = normalizeUserMessages(options.userMessages);
    if (!existingMetadata?.effectiveName && providedUserMessages.length === 0) {
      const existingName = options.session && typeof options.session.getName === "function"
        ? (await options.session.getName())?.name
        : await this.deps.getSessionName(sessionId);
      if (typeof existingName === "string" && existingName.trim()) {
        this.recordSpan("session.name.autogen", start, sessionId, { result: "skipped_existing" });
        return;
      }
    }

    let userMessages = providedUserMessages;
    let historyMessageCount: number | undefined;
    let historyReadFailed = false;
    if (options.session && options.includeHistory !== false) {
      if (typeof options.session.getEvents === "function") {
        try {
          const events = await readSdkSessionEvents(options.session);
          const historyMessages = collectRecentUserMessages(events);
          historyMessageCount = historyMessages.length;
          userMessages = mergeRecentUserMessages(historyMessages, providedUserMessages);
        } catch (error) {
          if (providedUserMessages.length === 0) throw error;
          historyReadFailed = true;
          this.deps.logger?.warn(`[sdk] [${sessionId.slice(0, 8)}] Session auto-name history unavailable; using live prompt only: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else if (userMessages.length === 0) {
        this.recordSpan("session.name.autogen", start, sessionId, {
          result: "skipped_no_messages",
          reason: "session_events_unavailable",
        });
        return;
      }
    }
    if (userMessages.length === 0) {
      this.recordSpan("session.name.autogen", start, sessionId, { result: "skipped_no_messages" });
      return;
    }

    this.generationLastAttempt.set(sessionId, Date.now());
    const generatedName = await this.generateSessionName(userMessages);
    if (!generatedName) {
      this.recordSpan("session.name.autogen", start, sessionId, { result: "skipped_no_title" });
      return;
    }
    if (hasExplicitSessionName(this.deps.getSessionNameMetadata(sessionId), replaceExistingName)) {
      this.recordSpan("session.name.autogen", start, sessionId, { result: "skipped_existing_after_generation" });
      return;
    }
    if (replaceExistingName) {
      const currentName = options.session && typeof options.session.getName === "function"
        ? (await options.session.getName())?.name
        : await this.deps.getSessionName(sessionId);
      if (normalizeComparableName(currentName) !== replaceExistingName) {
        this.recordSpan("session.name.autogen", start, sessionId, { result: "skipped_existing_after_generation" });
        return;
      }
    }
    await this.deps.setSessionName(sessionId, generatedName, { session: options.session });
    this.recordSpan("session.name.autogen", start, sessionId, {
      result: "generated",
      messageCount: userMessages.length,
      providedMessageCount: providedUserMessages.length || undefined,
      historyMessageCount,
      historyReadFailed: historyReadFailed || undefined,
    });
  }

  private async generateSessionName(userMessages: string[]): Promise<string | undefined> {
    if (isRestartCutoverInProgress(refreshRestartStateSync())) return undefined;

    const model = selectSessionTitleModel(await this.deps.listModels());
    if (!model) return undefined;

    const helperSessionId = createDisposableTitleSessionId();
    let helperSession: any | undefined;
    try {
      helperSession = await this.deps.createSession({
        ...buildSessionNameHelperBaseConfig(),
        sessionId: helperSessionId,
        clientName: "Copilot Bridge Title Helper",
        model,
        systemMessage: { mode: "replace", content: buildSessionTitleSystemPrompt() },
        infiniteSessions: { enabled: false },
        enableSessionTelemetry: false,
        enableSessionStore: false,
      });
      const response = await helperSession.sendAndWait(
        { prompt: buildSessionTitleUserPrompt(userMessages), attachments: [] },
        TITLE_HELPER_TIMEOUT_MS,
      );
      return extractGeneratedSessionTitle(response?.data?.content);
    } finally {
      try { await helperSession?.disconnect?.(); } catch { /* best-effort */ }
      await this.cleanupDisposableTitleSession(helperSessionId);
    }
  }

  private async cleanupDisposableTitleSession(sessionId: string): Promise<void> {
    try {
      await this.deps.deleteSession(sessionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/not found/i.test(message)) {
        this.deps.logger?.warn(`[sdk] [${sessionId.slice(0, 8)}] Disposable title session delete failed: ${message}`);
      }
    }
    await rm(join(this.deps.getCopilotHome(), "session-state", sessionId), { recursive: true, force: true });
    // Defensive for legacy/pre-flag rows: disconnect/delete flush SDK tracking before returning.
    const start = Date.now();
    try {
      deleteCliSessionStoreRows(this.deps.getCopilotHome(), sessionId);
      this.recordSpan("session.name.cleanup", start, sessionId, { result: "ok" });
    } catch (error) {
      this.recordSpan("session.name.cleanup", start, sessionId, {
        result: "error",
        error: error instanceof Error ? error.message : String(error),
      });
      this.deps.logger?.warn(`[sdk] [${sessionId.slice(0, 8)}] Disposable title session DB cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export function createSessionNameAutogenerator(deps: SessionNameAutogeneratorDeps): SessionNameAutogenerator {
  return new SessionNameAutogenerator(deps);
}
