// Turns an ordinary Bridge session config into a Helm one: Helm's own instructions and only
// the tools that manage Bridge. Applied on create and on every resume, so a Helm
// conversation can never come back as a general-purpose coding session.
import type { AgentModelInfo } from "../agent-backend/types.js";
import type { BridgeToolDefinition } from "../agent-tools-mcp/server.js";
import { createNativeBridgeTools } from "../bridge-native-tools.js";
import { resolveSupportedReasoningEffort } from "../../shared/reasoning-effort.js";
import { buildHelmSystemPrompt } from "./helm-prompt.js";

/** Cheap, fast models preferred for Helm, in order. Real work goes to worker sessions. */
export const PREFERRED_HELM_MODELS = ["gpt-6-luna", "gpt-5.6-luna", "mai-code-1.1-flash", "gpt-5.4-mini", "gpt-5-mini", "claude-haiku-4.5"];

export interface HelmModelSelection {
  model?: string;
  reasoningEffort?: string;
}

function isModelEnabled(model: AgentModelInfo): boolean {
  const policy = (model as { policy?: { state?: string } }).policy;
  return !policy || policy.state === "enabled";
}

/**
 * Picks Helm's model: the requested one when available, otherwise the first preferred fast model.
 * The session starts at the wanted effort (or the nearest the model supports) so its first turn
 * doesn't need a switch; every later turn sets its own.
 */
export function selectHelmModel(models: AgentModelInfo[], requested?: string, wantedEffort?: string): HelmModelSelection {
  const enabled = models.filter(isModelEnabled);
  const chosen = (requested ? enabled.find((model) => model.id === requested) : undefined)
    ?? PREFERRED_HELM_MODELS.map((id) => enabled.find((model) => model.id === id)).find(Boolean);
  if (!chosen) return requested ? { model: requested } : {};
  const reasoningEffort = resolveSupportedReasoningEffort(wantedEffort, chosen.supportedReasoningEfforts);
  return { model: chosen.id, ...(reasoningEffort ? { reasoningEffort } : {}) };
}

export interface HelmSessionProfileOptions {
  tools: readonly BridgeToolDefinition[];
  workingDirectory: string;
  timeZone?: string;
  defaultWorkModel?: string;
}

export const HELM_CLIENT_NAME = "Copilot Bridge Helm";

/**
 * The only fields Helm takes from the config an ordinary session would get: which session and
 * model it is, and how the runtime talks to Bridge. This is an allowlist on purpose. Ordinary
 * sessions keep gaining capabilities through new config fields (plugins, agents, MCP servers),
 * and a manager driven by speech on a small model must not inherit one just because nobody
 * remembered to strip it here: anything not named below is dropped.
 */
const KEPT_FROM_BASE_CONFIG = [
  "sessionId",
  "model",
  "reasoningEffort",
  "contextTier",
  "modelCapabilities",
  "streaming",
  "includeSubAgentStreamingEvents",
  "pendingInteractionEvents",
  "enableExperimentalMode",
  "memory",
  "onPermissionRequest",
] as const;

/**
 * Returns the Helm version of a session config. Identity, model and lifecycle fields chosen by
 * the session manager are kept; everything that shapes what the agent is and what it can touch
 * is Helm's own.
 */
export function applyHelmSessionProfile<T extends Record<string, unknown>>(base: T, options: HelmSessionProfileOptions): T {
  const tools = createNativeBridgeTools(options.tools);
  const kept = Object.fromEntries(
    KEPT_FROM_BASE_CONFIG.filter((key) => base[key] !== undefined).map((key) => [key, base[key]]),
  );
  return {
    ...kept,
    clientName: HELM_CLIENT_NAME,
    tools,
    availableTools: tools.map((tool) => tool.name),
    excludedTools: [],
    mcpServers: {},
    skillDirectories: [],
    instructionDirectories: [],
    enableConfigDiscovery: false,
    workingDirectory: options.workingDirectory,
    systemMessage: {
      mode: "replace",
      content: buildHelmSystemPrompt({
        timeZone: options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
        ...(options.defaultWorkModel ? { defaultWorkModel: options.defaultWorkModel } : {}),
      }),
    },
  } as unknown as T;
}
