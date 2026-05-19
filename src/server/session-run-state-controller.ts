import type { getOrCreateBus } from "./event-bus.js";
import type { GlobalBus } from "./global-bus.js";
import type { UserInputCancelReason } from "./user-input-types.js";

export type SessionRunState = "busy" | "stalled" | "idle";
export type SessionRunKind = "message" | "fleet" | "restart-resume";

export type PromptDeliveryResult =
  | { status: "accepted" }
  | { status: "failed"; message: string };

export interface SessionRunRecord {
  state: Exclude<SessionRunState, "idle">;
  startedAt: number;
  lastEventAt: number;
  stalledAt?: number;
  runKind?: SessionRunKind;
  pendingPrompt?: string;
  promptAccepted?: boolean;
  preserveAcrossRestart?: boolean;
  restartSuspendReady?: boolean;
}

export interface SessionRunController {
  completion: Promise<void>;
  promptDelivery: Promise<PromptDeliveryResult>;
  isCompleted(): boolean;
  markPromptAccepted(): void;
  completeDone(content: string): void;
  completeError(message: string): void;
  completeAborted(content: string): void;
  completeShutdown(content: string): void;
  completePreservedForRestart(): void;
  wasPreservedForRestart(): boolean;
  awaitAbortConfirmation(delayMs: number, getContent: () => string): Promise<boolean>;
  clearAbortWait(): void;
}

export interface SessionActivity {
  id: string;
  state: Exclude<SessionRunState, "idle">;
  startedAt: number;
  lastEventAt: number;
  stalledAt?: number;
  elapsedMs: number;
  staleMs: number;
}

export const ABORT_CONFIRMATION_TIMEOUT_MS = 2_000;
const ASSISTANT_PREVIEW_MAX_LENGTH = 160;

type SessionEventBus = ReturnType<typeof getOrCreateBus>;

export interface SessionRunStateControllerDeps {
  globalBus: GlobalBus;
  isRestartPending(): boolean;
  syncRestartWaitingSessions(activeSessionCount: number): void;
  getActiveSessionCount?(): number;
  isSessionResuming?(sessionId: string): boolean;
  cancelPendingUserInputRequests(
    sessionId: string,
    reason: UserInputCancelReason,
    message?: string,
  ): void;
  promptDeliveryAbortedMessage: string;
  promptDeliveryShutdownMessage: string;
  logger?: Pick<Console, "warn">;
}

export class SessionRunStateController {
  private readonly sessionRuns = new Map<string, SessionRunRecord>();
  private readonly completedAssistantPreviews = new Map<string, string>();
  private readonly logger: Pick<Console, "warn">;

  constructor(private readonly deps: SessionRunStateControllerDeps) {
    this.logger = deps.logger ?? console;
  }

  getRunRecords(): Map<string, SessionRunRecord> {
    return this.sessionRuns;
  }

  createRunController(
    sessionId: string,
    bus: SessionEventBus,
  ): SessionRunController {
    let completed = false;
    let preservedForRestart = false;
    let abortFallbackTimer: ReturnType<typeof setTimeout> | undefined;
    let abortFallbackPromise: Promise<boolean> | null = null;
    let resolveCompletion!: () => void;
    let resolvePromptDelivery!: (result: PromptDeliveryResult) => void;
    let resolveAbortFallback: ((fired: boolean) => void) | undefined;

    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    const promptDelivery = new Promise<PromptDeliveryResult>((resolve) => {
      resolvePromptDelivery = resolve;
    });
    let promptDeliverySettled = false;

    const settleAbortFallback = (fired: boolean) => {
      const resolver = resolveAbortFallback;
      resolveAbortFallback = undefined;
      abortFallbackPromise = null;
      resolver?.(fired);
    };

    const clearAbortWait = () => {
      if (abortFallbackTimer) {
        clearTimeout(abortFallbackTimer);
        abortFallbackTimer = undefined;
      }
      settleAbortFallback(false);
    };
    const settlePromptDelivery = (result: PromptDeliveryResult) => {
      if (promptDeliverySettled) return;
      promptDeliverySettled = true;
      resolvePromptDelivery(result);
    };

    const finish = (emitTerminal?: (timestamp: string) => void): boolean => {
      if (completed) return false;
      completed = true;
      clearAbortWait();
      emitTerminal?.(new Date().toISOString());
      resolveCompletion();
      return true;
    };

    return {
      completion,
      promptDelivery,
      isCompleted: () => completed,
      markPromptAccepted: () => {
        const current = this.sessionRuns.get(sessionId);
        if (current) this.sessionRuns.set(sessionId, { ...current, promptAccepted: true });
        settlePromptDelivery({ status: "accepted" });
      },
      completeDone: (content) => {
        const preview = normalizeAssistantPreview(content);
        if (preview) this.completedAssistantPreviews.set(sessionId, preview);
        settlePromptDelivery({ status: "accepted" });
        finish((timestamp) => {
          this.deps.cancelPendingUserInputRequests(
            sessionId,
            "session_ended",
            "Session operation completed before the user input request was answered",
          );
          bus.emit({ type: "done", content, timestamp });
        });
      },
      completeError: (message) => {
        this.completedAssistantPreviews.delete(sessionId);
        settlePromptDelivery({ status: "failed", message });
        finish((timestamp) => {
          this.deps.cancelPendingUserInputRequests(sessionId, "error", message);
          bus.emit({ type: "error", message, timestamp });
        });
      },
      completeAborted: (content) => {
        this.completedAssistantPreviews.delete(sessionId);
        settlePromptDelivery({ status: "failed", message: this.deps.promptDeliveryAbortedMessage });
        finish((timestamp) => {
          this.deps.cancelPendingUserInputRequests(sessionId, "session_ended", this.deps.promptDeliveryAbortedMessage);
          bus.emit({ type: "aborted", content, timestamp });
        });
      },
      completeShutdown: (content) => {
        this.completedAssistantPreviews.delete(sessionId);
        settlePromptDelivery({ status: "failed", message: this.deps.promptDeliveryShutdownMessage });
        finish((timestamp) => {
          this.deps.cancelPendingUserInputRequests(sessionId, "session_ended", this.deps.promptDeliveryShutdownMessage);
          bus.emit({ type: "shutdown", content, timestamp });
        });
      },
      completePreservedForRestart: () => {
        this.completedAssistantPreviews.delete(sessionId);
        preservedForRestart = true;
        settlePromptDelivery({ status: "accepted" });
        finish();
      },
      wasPreservedForRestart: () => preservedForRestart,
      awaitAbortConfirmation: (delayMs, getContent) => {
        if (completed) return Promise.resolve(false);
        if (abortFallbackPromise) return abortFallbackPromise;
        abortFallbackPromise = new Promise<boolean>((resolve) => {
          resolveAbortFallback = resolve;
          abortFallbackTimer = setTimeout(() => {
            abortFallbackTimer = undefined;
            abortFallbackPromise = null;
            resolveAbortFallback = undefined;
            if (completed) {
              resolve(false);
              return;
            }
            this.logger.warn(`[sdk] [${sessionId.slice(0, 8)}] 🛑 Abort not confirmed after ${delayMs}ms — resolving locally`);
            resolve(finish((timestamp) => {
              this.deps.cancelPendingUserInputRequests(sessionId, "session_ended", this.deps.promptDeliveryAbortedMessage);
              bus.emit({ type: "aborted", content: getContent(), timestamp });
            }));
          }, delayMs);
        });
        return abortFallbackPromise;
      },
      clearAbortWait,
    };
  }

  setSessionRunState(
    sessionId: string,
    state: SessionRunState,
    opts: { now?: number; lastEventAt?: number; emitIdle?: boolean } = {},
  ): void {
    const current = this.sessionRuns.get(sessionId);
    const now = opts.now ?? Date.now();

    if (state === "idle") {
      if (!current) return;
      this.sessionRuns.delete(sessionId);
      const assistantPreview = this.completedAssistantPreviews.get(sessionId);
      this.completedAssistantPreviews.delete(sessionId);
      if (opts.emitIdle !== false) {
        this.deps.globalBus.emit({
          type: "session:idle",
          sessionId,
          ...(assistantPreview ? { assistantPreview } : {}),
        });
      }
      if (this.deps.isRestartPending()) {
        this.deps.syncRestartWaitingSessions(this.getActiveSessionCount());
      }
      return;
    }

    if (state === "busy" && !current) {
      this.completedAssistantPreviews.delete(sessionId);
    }

    const next: SessionRunRecord = {
      state,
      startedAt: current?.startedAt ?? now,
      lastEventAt: opts.lastEventAt ?? current?.lastEventAt ?? now,
      stalledAt: state === "stalled" ? current?.stalledAt ?? now : undefined,
      runKind: current?.runKind,
      pendingPrompt: current?.pendingPrompt,
      promptAccepted: current?.promptAccepted,
      preserveAcrossRestart: current?.preserveAcrossRestart,
      restartSuspendReady: current?.restartSuspendReady,
    };
    this.sessionRuns.set(sessionId, next);

    if (current?.state === state) return;

    this.deps.globalBus.emit({ type: state === "stalled" ? "session:stalled" : "session:busy", sessionId });
    if (this.deps.isRestartPending() && !current) {
      this.deps.syncRestartWaitingSessions(this.getActiveSessionCount());
    }
  }

  setSessionRunMetadata(
    sessionId: string,
    metadata: Partial<Pick<SessionRunRecord,
      "runKind" | "pendingPrompt" | "promptAccepted" | "preserveAcrossRestart" | "restartSuspendReady"
    >>,
  ): void {
    const current = this.sessionRuns.get(sessionId);
    if (!current) return;
    this.sessionRuns.set(sessionId, {
      ...current,
      ...metadata,
    });
  }

  private getActiveSessionCount(): number {
    return this.deps.getActiveSessionCount?.() ?? this.sessionRuns.size;
  }

  touchSessionRun(sessionId: string, at = Date.now()): void {
    const current = this.sessionRuns.get(sessionId);
    if (!current) return;
    if (current.state === "stalled") {
      this.setSessionRunState(sessionId, "busy", { now: at, lastEventAt: at });
      return;
    }
    current.lastEventAt = at;
  }

  touchSessionRunIfNewer(sessionId: string, at: number): void {
    const current = this.sessionRuns.get(sessionId);
    if (current && current.lastEventAt < at) {
      current.lastEventAt = at;
    }
  }

  hasSessionRun(sessionId: string): boolean {
    return this.sessionRuns.has(sessionId);
  }

  isSessionBusy(sessionId: string): boolean {
    return this.getSessionRunState(sessionId) !== "idle";
  }

  getSessionRunState(sessionId: string): SessionRunState {
    const active = this.sessionRuns.get(sessionId);
    if (active) return active.state;
    return this.deps.isSessionResuming?.(sessionId) ? "busy" : "idle";
  }

  isSessionStalled(sessionId: string): boolean {
    return this.getSessionRunState(sessionId) === "stalled";
  }

  hasActiveTurns(): boolean {
    return this.sessionRuns.size > 0;
  }

  getActiveSessions(): string[] {
    return Array.from(this.sessionRuns.keys());
  }

  getSessionActivity(): SessionActivity[] {
    const now = Date.now();
    return Array.from(this.sessionRuns.entries()).map(([id, a]) => ({
      id,
      state: a.state,
      startedAt: a.startedAt,
      lastEventAt: a.lastEventAt,
      stalledAt: a.stalledAt,
      elapsedMs: now - a.startedAt,
      staleMs: now - a.lastEventAt,
    }));
  }
}

function normalizeAssistantPreview(content: string): string | undefined {
  const paragraph = stripPreviewMarkdown(content)
    .split(/\r?\n\s*\r?\n/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .find((part) => part.length > 0);
  const normalized = paragraph?.trim() ?? "";
  if (!normalized || normalized === "(no response)") return undefined;
  const chars = Array.from(normalized);
  if (chars.length <= ASSISTANT_PREVIEW_MAX_LENGTH) return normalized;
  return `${chars.slice(0, ASSISTANT_PREVIEW_MAX_LENGTH - 3).join("").trimEnd()}...`;
}

function stripPreviewMarkdown(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/[*_~]{1,3}/g, "");
}
