import type { DeferredPromptRunner } from "./deferred-prompt-runner.js";
import type { DeferredPromptStore } from "./deferred-prompt-store.js";
import { emitSessionDeferSummary } from "./defer-summary.js";
import type { GlobalBus } from "./global-bus.js";

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
