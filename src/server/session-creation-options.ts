import { isCopilotContextTier, type CopilotContextTier } from "../shared/copilot-context.js";
import { isPromptProfileId, type PromptProfileId } from "../shared/prompt-profiles.js";
import type { AppContext } from "./app-context.js";
import { TaskAgentDefinitionValidationError } from "./task-agent-definition-store.js";

export interface SessionCreationOptions {
  model?: string;
  reasoningEffort?: string;
  contextTier?: CopilotContextTier;
  promptProfile?: PromptProfileId;
  agent?: string;
}

export async function resolveSessionCreationOptions(
  ctx: Pick<AppContext, "settingsStore" | "sessionManager" | "taskAgentDefinitionStore">,
  body: unknown,
  scope: { taskId?: string } = {},
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
  if (payload.agent !== undefined && payload.agent !== null && typeof payload.agent !== "string") {
    return { error: "agent must be a string", status: 400 };
  }
  if (payload.promptProfile !== undefined && payload.promptProfile !== null && !isPromptProfileId(payload.promptProfile)) {
    return { error: "promptProfile must be engineer, assistant, or monitor", status: 400 };
  }
  const promptProfile = isPromptProfileId(payload.promptProfile) ? payload.promptProfile : undefined;
  const model = typeof payload.model === "string" ? payload.model.trim() : "";
  const reasoningEffort = typeof payload.reasoningEffort === "string"
    ? payload.reasoningEffort.trim()
    : "";
  const contextTier = isCopilotContextTier(payload.contextTier)
    ? payload.contextTier
    : undefined;
  const agent = typeof payload.agent === "string" ? payload.agent.trim() : "";
  if (agent) {
    if (!scope.taskId) {
      return { error: "agent selection is only available for task sessions", status: 400 };
    }
    let definition;
    try {
      definition = ctx.taskAgentDefinitionStore
        ?.listTaskAgentDefinitions(scope.taskId)
        .find((candidate) => candidate.name === agent);
    } catch (error) {
      if (error instanceof TaskAgentDefinitionValidationError) {
        return { error: error.message, status: 400 };
      }
      throw error;
    }
    if (!definition) {
      return { error: `Agent definition is not available for this task: ${agent}`, status: 400 };
    }
    if (!definition.userInvocable) {
      return { error: `Agent definition cannot be selected for a new chat: ${agent}`, status: 400 };
    }
  }
  if (!model && !reasoningEffort && !contextTier) {
    return {
      options: {
        ...(agent ? { agent } : {}),
        ...(promptProfile ? { promptProfile } : {}),
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
      ...(agent ? { agent } : {}),
      ...(promptProfile ? { promptProfile } : {}),
    },
  };
}
