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

/** Matches the backend-recovery cooldown so work that keeps taking the server down cannot loop. */
export const BOOT_RESUME_COOLDOWN_MS = 10 * 60_000;

export interface BootRecoveryResult {
  resumed: string[];
  skippedCooldown: string[];
  skippedQuiet: string[];
}

/**
 * Production boot only. A marker that survived to boot is a run cut off by a server kill or
 * crash, because graceful shutdown drives runs to idle and clears them. Never call this from a
 * staged preview backend: its copied database can carry markers for production sessions.
 */
export function queueBootRecoveryPrompts(
  deps: RestartResumeDeps,
  markerStore: Pick<InterruptedRunStore, "list" | "clear" | "markResumed">,
  now: Date = new Date(),
): BootRecoveryResult {
  const result: BootRecoveryResult = { resumed: [], skippedCooldown: [], skippedQuiet: [] };
  const toResume: InterruptedRun[] = [];

  for (const marker of markerStore.list()) {
    if (marker.attentionMode === "quiet") {
      // Defer loops fire again on their own; nothing else would ever clear this marker.
      markerStore.clear(marker.sessionId);
      result.skippedQuiet.push(marker.sessionId);
      continue;
    }
    const lastResumedAtMs = marker.lastResumedAt === null ? Number.NaN : Date.parse(marker.lastResumedAt);
    if (Number.isFinite(lastResumedAtMs) && now.getTime() - lastResumedAtMs < BOOT_RESUME_COOLDOWN_MS) {
      markerStore.clear(marker.sessionId);
      result.skippedCooldown.push(marker.sessionId);
      continue;
    }
    toResume.push({ sessionId: marker.sessionId, promptAccepted: true, attentionMode: "normal" });
  }

  if (toResume.length > 0) {
    queueRestartRecoveryPrompts(deps, toResume);
    for (const run of toResume) {
      // Stamp after queueing: the marker stays until the resumed run goes idle, so a second
      // kill inside the cooldown window finds the stamp and stops instead of resuming again.
      markerStore.markResumed(run.sessionId, now);
      result.resumed.push(run.sessionId);
    }
  }
  return result;
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
    const alreadyQueued = deps.deferredPromptStore.listForSession(sessionId).some(
      (prompt) =>
        (prompt.status === "pending" || prompt.status === "running")
        && isRestartRecoveryPrompt(prompt.prompt),
    );
    if (!alreadyQueued) {
      deps.deferredPromptStore.create(sessionId, RESTART_RECOVERY_CONTINUE_PROMPT, runAt);
    }
    emitSessionDeferSummary(deps.globalBus, sessionId, deps);
  }

  deps.deferredPromptRunner?.poke();
  return sessionIds.length;
}
