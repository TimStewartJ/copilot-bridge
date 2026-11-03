import { isCopilotContextTier, type CopilotContextTier } from "../shared/copilot-context.js";
import { isPlaybookName } from "../shared/workflow-vocabulary.js";
import type { AppContext } from "./app-context.js";

export interface SessionCreationOptions {
  model?: string;
  reasoningEffort?: string;
  contextTier?: CopilotContextTier;
  /** A playbook name, or "none" for the direct path. */
  playbook?: string;
}

export async function resolveSessionCreationOptions(
  ctx: Pick<AppContext, "settingsStore" | "sessionManager">,
  body: unknown,
): Promise<{ options?: SessionCreationOptions; error?: string; status?: number }> {
  const payload = body && typeof body === "object"
    ? body as Record<string, unknown>
    : {};
  if (payload.model !== undefined && payload.model !== null && typeof payload.model !== "string") {
    return { error: "model must be a string", status: 400 };
  }
  if (
    payload.reasoningEffort !== undefined
    && payload.reasoningEffort !== null
    && typeof payload.reasoningEffort !== "string"
  ) {
    return { error: "reasoningEffort must be a string", status: 400 };
  }
  if (payload.contextTier !== undefined && !isCopilotContextTier(payload.contextTier)) {
    return { error: "contextTier must be default or long_context", status: 400 };
  }
  if (payload.playbook !== undefined && payload.playbook !== null && payload.playbook !== "" && !isPlaybookName(payload.playbook)) {
    return { error: "playbook must be a playbook name", status: 400 };
  }
  const playbook = isPlaybookName(payload.playbook) ? payload.playbook : undefined;
  const model = typeof payload.model === "string" ? payload.model.trim() : "";
  const reasoningEffort = typeof payload.reasoningEffort === "string"
    ? payload.reasoningEffort.trim()
    : "";
  const contextTier = isCopilotContextTier(payload.contextTier)
    ? payload.contextTier
    : undefined;
  if (!model && !reasoningEffort && !contextTier) {
    return {
      options: {
        ...(playbook ? { playbook } : {}),
      },
    };
  }

  const targetModelId = model || ctx.settingsStore.getSettings().model;
  if (!targetModelId) {
    return {
      error: "A model is required to set reasoning effort or context for a new session",
      status: 400,
    };
  }
  const validation = await ctx.sessionManager.validateModelSelection({
    model: targetModelId,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(contextTier ? { contextTier } : {}),
  });
  if (!validation.ok) {
    return { error: validation.error, status: 400 };
  }
  return {
    options: {
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(contextTier ? { contextTier } : {}),
      ...(playbook ? { playbook } : {}),
    },
  };
}
