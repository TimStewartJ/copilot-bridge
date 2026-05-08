import { approveAll, type ModelInfo } from "@github/copilot-sdk";
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
  isRestartCutoverInProgress,
  refreshRestartStateSync,
} from "./restart-controller.js";
import type { SetSessionNameOptions } from "./session-name-rpc.js";

const SESSION_NAME_GENERATION_RETRY_MS = 60 * 60 * 1000;
const TITLE_HELPER_TIMEOUT_MS = 30_000;

export interface SessionNameAutogeneratorDeps {
  listModels(): Promise<ModelInfo[]>;
  createSession(config: any): Promise<any>;
  deleteSession(sessionId: string): Promise<void>;
  getCopilotHome(): string;
  getSessionName(sessionId: string): Promise<string | undefined>;
  setSessionName(sessionId: string, name: string, opts?: SetSessionNameOptions): Promise<void>;
  logger?: Pick<typeof console, "warn">;
}

function collectRecentUserMessages(events: any[]): string[] {
  const messages: string[] = [];
  for (const event of events) {
    if (event?.type !== "user.message") continue;
    const data = event.data;
    if (data && typeof data === "object" && "source" in data) continue;
    const content = data?.content;
    if (typeof content === "string" && content.trim()) messages.push(content.trim());
  }
  return messages.slice(-20);
}

export class SessionNameAutogenerator {
  private readonly generationPromises = new Map<string, Promise<void>>();
  private readonly generationLastAttempt = new Map<string, number>();

  constructor(private readonly deps: SessionNameAutogeneratorDeps) {}

  maybeAutoNameSession(
    sessionId: string,
    options: { session?: any; userMessages?: string[] } = {},
  ): void {
    if (isDisposableTitleSessionId(sessionId)) return;
    const existing = this.generationPromises.get(sessionId);
    if (existing) return;

    const lastAttempt = this.generationLastAttempt.get(sessionId);
    if (lastAttempt && Date.now() - lastAttempt < SESSION_NAME_GENERATION_RETRY_MS) return;

    const promise = this.generateAndSetMissingSessionName(sessionId, options)
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

  private async generateAndSetMissingSessionName(
    sessionId: string,
    options: { session?: any; userMessages?: string[] },
  ): Promise<void> {
    const existingName = options.session && typeof options.session.rpc?.name?.get === "function"
      ? (await options.session.rpc.name.get())?.name
      : await this.deps.getSessionName(sessionId);
    if (typeof existingName === "string" && existingName.trim()) return;

    let userMessages = (options.userMessages ?? []).map((message) => message.trim()).filter(Boolean).slice(-20);
    if (userMessages.length === 0 && options.session) {
      const events = await options.session.getMessages();
      userMessages = collectRecentUserMessages(events);
    }
    if (userMessages.length === 0) return;

    this.generationLastAttempt.set(sessionId, Date.now());
    const generatedName = await this.generateSessionName(userMessages);
    if (!generatedName) return;
    await this.deps.setSessionName(sessionId, generatedName, { session: options.session });
  }

  private async generateSessionName(userMessages: string[]): Promise<string | undefined> {
    if (isRestartCutoverInProgress(refreshRestartStateSync())) return undefined;

    const model = selectSessionTitleModel(await this.deps.listModels());
    if (!model) return undefined;

    const helperSessionId = createDisposableTitleSessionId();
    let helperSession: any | undefined;
    try {
      helperSession = await this.deps.createSession({
        sessionId: helperSessionId,
        clientName: "Copilot Bridge Title Helper",
        onPermissionRequest: approveAll,
        model,
        tools: [],
        availableTools: [],
        excludedTools: ["*"],
        mcpServers: {},
        enableConfigDiscovery: false,
        skillDirectories: [],
        instructionDirectories: [],
        systemMessage: { mode: "replace", content: buildSessionTitleSystemPrompt() },
        infiniteSessions: { enabled: false },
        enableSessionTelemetry: false,
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
    try {
      deleteCliSessionStoreRows(this.deps.getCopilotHome(), sessionId);
    } catch (error) {
      this.deps.logger?.warn(`[sdk] [${sessionId.slice(0, 8)}] Disposable title session DB cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export function createSessionNameAutogenerator(deps: SessionNameAutogeneratorDeps): SessionNameAutogenerator {
  return new SessionNameAutogenerator(deps);
}
