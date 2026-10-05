import { randomUUID } from "node:crypto";
import type { SyntheticTerminalOverlay } from "../shared/session-stream.js";
import type { DeferredPromptRunner } from "./deferred-prompt-runner.js";
import type { DeferredPromptStore } from "./deferred-prompt-store.js";
import { emitSessionDeferSummary } from "./defer-summary.js";
import type { GlobalBus } from "./global-bus.js";
import type { InterruptedRunStore } from "./interrupted-run-store.js";

export const RESTART_RECOVERY_CONTINUE_PROMPT = [
  "<bridge_notice>",
  "The Bridge restarted while you were working on the previous request.",
  "Your in-memory tool and sub-agent state was lost; the conversation history on disk is intact.",
  "Continue from where you left off. If the previous request was already complete, briefly confirm that and stop.",
  "</bridge_notice>",
].join("\n");

export interface InterruptedRun {
  sessionId: string;
  promptAccepted: boolean;
  attentionMode: "normal" | "quiet";
}

interface RestartResumeDeps {
  deferredPromptStore: DeferredPromptStore;
  deferredPromptRunner?: DeferredPromptRunner;
  globalBus: GlobalBus;
}

interface BootRecoveryDeps extends RestartResumeDeps {
  /** Tells the user, in the chat, about a run that is not resumed at once. */
  announce?: (sessionId: string, message: string) => void;
}

/** Matches the backend-recovery cooldown so work that keeps taking the server down cannot loop. */
export const BOOT_RESUME_COOLDOWN_MS = 10 * 60_000;

export interface BootRecoveryResult {
  /** Resumed now. */
  resumed: string[];
  /** Cut off again soon after a resume: resumed once more, when the cooldown has passed. */
  retryScheduled: Array<{ sessionId: string; resumeAt: string }>;
  /** Cut off again soon after that second resume: left for the user to continue. */
  gaveUp: string[];
  skippedQuiet: string[];
}

function resumeLaterMessage(waitMs: number): string {
  const minutes = Math.max(1, Math.round(waitMs / 60_000));
  return "The Bridge restarted again soon after it had resumed this chat. To keep a chat from taking the "
    + "server down in a loop, it was not resumed again at once. The Bridge will resume it in about "
    + `${minutes} minute${minutes === 1 ? "" : "s"}. Send a message to continue sooner.`;
}

export const RESTART_RESUME_GAVE_UP_MESSAGE =
  "The Bridge restarted again soon after it had resumed this chat for the second time. "
  + "It will not resume this chat again by itself. Send a message to continue.";

/** The notice a chat shows below its transcript for a run the Bridge did not resume at once. */
export function createNotResumedOverlay(message: string, now: Date = new Date()): SyntheticTerminalOverlay {
  const timestamp = now.toISOString();
  return { type: "error", runId: randomUUID(), timestamp, notice: { kind: "error", message, timestamp } };
}

function pendingRecoveryPrompts(store: DeferredPromptStore, sessionId: string) {
  return store.listForSession(sessionId).filter(
    (prompt) =>
      (prompt.status === "pending" || prompt.status === "running")
      && isRestartRecoveryPrompt(prompt.prompt),
  );
}

/**
 * Production boot only. A marker that survived to boot is a run cut off by a server kill or
 * crash, because graceful shutdown drives runs to idle and clears them. Never call this from a
 * staged preview backend: its copied database can carry markers for production sessions.
 *
 * A run is resumed at once unless it was resumed less than the cooldown ago: then the work may be
 * what takes the server down. Such a run is resumed once more when the cooldown has passed, and
 * the chat says so. If the server goes down again soon after that, the run is left for the user.
 */
export function queueBootRecoveryPrompts(
  deps: BootRecoveryDeps,
  markerStore: Pick<InterruptedRunStore, "list" | "clear" | "markResumed" | "markRetryScheduled">,
  now: Date = new Date(),
): BootRecoveryResult {
  const result: BootRecoveryResult = { resumed: [], retryScheduled: [], gaveUp: [], skippedQuiet: [] };
  const toResume: InterruptedRun[] = [];
  const announce = (sessionId: string, message: string) => {
    try {
      deps.announce?.(sessionId, message);
    } catch (error) {
      console.warn(`[restart-resume] [${sessionId.slice(0, 8)}] Could not put the notice in the chat:`, error);
    }
  };

  for (const marker of markerStore.list()) {
    const { sessionId } = marker;
    if (marker.attentionMode === "quiet") {
      // Defer loops fire again on their own; nothing else would ever clear this marker.
      markerStore.clear(sessionId);
      result.skippedQuiet.push(sessionId);
      continue;
    }
    const lastResumedAtMs = marker.lastResumedAt === null ? Number.NaN : Date.parse(marker.lastResumedAt);
    const sinceResumeMs = now.getTime() - lastResumedAtMs;
    if (!Number.isFinite(lastResumedAtMs) || sinceResumeMs >= BOOT_RESUME_COOLDOWN_MS) {
      toResume.push({ sessionId, promptAccepted: true, attentionMode: "normal" });
      continue;
    }

    if (marker.retryScheduled) {
      // The resume that was put off is still in the queue: this exit came before it was made.
      if (pendingRecoveryPrompts(deps.deferredPromptStore, sessionId).length > 0) {
        result.retryScheduled.push({ sessionId, resumeAt: marker.lastResumedAt! });
        continue;
      }
      if (sinceResumeMs >= 0) {
        // It was made, and the server went down again: the marker goes, so nothing resumes this run.
        markerStore.clear(sessionId);
        result.gaveUp.push(sessionId);
        announce(sessionId, RESTART_RESUME_GAVE_UP_MESSAGE);
        continue;
      }
    }

    const resumeAt = new Date(
      marker.retryScheduled ? lastResumedAtMs : lastResumedAtMs + BOOT_RESUME_COOLDOWN_MS,
    );
    deps.deferredPromptStore.create(sessionId, RESTART_RECOVERY_CONTINUE_PROMPT, resumeAt.toISOString());
    // The marker stays, stamped with the time of that resume: an exit soon after it finds the stamp.
    markerStore.markRetryScheduled(sessionId, resumeAt);
    emitSessionDeferSummary(deps.globalBus, sessionId, deps);
    result.retryScheduled.push({ sessionId, resumeAt: resumeAt.toISOString() });
    announce(sessionId, resumeLaterMessage(resumeAt.getTime() - now.getTime()));
  }

  if (toResume.length > 0) {
    queueRestartRecoveryPrompts(deps, toResume);
    for (const run of toResume) {
      // Stamp after queueing: the marker stays until the resumed run goes idle, so a second
      // kill inside the cooldown window finds the stamp and puts the next resume off.
      markerStore.markResumed(run.sessionId, now);
      result.resumed.push(run.sessionId);
    }
  }
  if (result.retryScheduled.length > 0) deps.deferredPromptRunner?.poke();
  return result;
}

/**
 * A run of the chat has ended in the ordinary way while a resume that was put off is still
 * waiting: the user continued it, so that resume would only repeat the request.
 */
export function cancelScheduledRestartResume(deps: RestartResumeDeps, sessionId: string): number {
  let cancelled = 0;
  for (const prompt of deps.deferredPromptStore.listForSession(sessionId)) {
    if (prompt.status === "pending" && isRestartRecoveryPrompt(prompt.prompt) && deps.deferredPromptStore.cancelById(prompt.id)) {
      cancelled += 1;
    }
  }
  if (cancelled > 0) emitSessionDeferSummary(deps.globalBus, sessionId, deps);
  return cancelled;
}

export function isRestartRecoveryPrompt(prompt: string): boolean {
  return prompt === RESTART_RECOVERY_CONTINUE_PROMPT;
}

export function queueRestartRecoveryPrompts(
  deps: RestartResumeDeps,
  interrupted: readonly InterruptedRun[],
): number {
  const sessionIds = [...new Set(interrupted
    .filter((run) => run.promptAccepted && run.attentionMode === "normal")
    .map((run) => run.sessionId))];
  const runAt = new Date().toISOString();

  for (const sessionId of sessionIds) {
    if (pendingRecoveryPrompts(deps.deferredPromptStore, sessionId).length === 0) {
      deps.deferredPromptStore.create(sessionId, RESTART_RECOVERY_CONTINUE_PROMPT, runAt);
    }
    emitSessionDeferSummary(deps.globalBus, sessionId, deps);
  }

  deps.deferredPromptRunner?.poke();
  return sessionIds.length;
}