// Turns an ordinary Bridge session config into a Helm one: Helm's own instructions and only
// the tools that manage Bridge. Applied on create and on every resume, so a Helm
// conversation can never come back as a general-purpose coding session.
import type { AgentModelInfo } from "../agent-backend/types.js";
import type { BridgeToolDefinition } from "../agent-tools-mcp/server.js";
import { createNativeBridgeTools } from "../bridge-native-tools.js";
import { selectHelperModel } from "../helper-model.js";
import { resolveSupportedReasoningEffort } from "../../shared/reasoning-effort.js";
import { buildHelmSystemPrompt } from "./helm-prompt.js";

export interface HelmModelSelection {
  model?: string;
  reasoningEffort?: string;
}

function isModelEnabled(model: AgentModelInfo): boolean {
  const policy = (model as { policy?: { state?: string } }).policy;
  return !policy || policy.state === "enabled";
}

/**
 * Picks Helm's model: the requested one when available, otherwise the Bridge's helper model (the
 * cheapest one that can skip reasoning). Real work goes to worker sessions. The session starts at
 * the wanted effort (or the nearest the model supports) so its first turn doesn't need a switch;
 * every later turn sets its own.
 */
export function selectHelmModel(models: AgentModelInfo[], requested?: string, wantedEffort?: string): HelmModelSelection {
  const enabled = models.filter(isModelEnabled);
  const requestedModel = requested ? enabled.find((model) => model.id === requested) : undefined;
  const helperId = requestedModel ? undefined : selectHelperModel(enabled)?.model;
  const chosen = requestedModel ?? enabled.find((model) => model.id === helperId);
  if (!chosen) return requested ? { model: requested } : {};
  const reasoningEffort = resolveSupportedReasoningEffort(wantedEffort, chosen.supportedReasoningEfforts);
  return { model: chosen.id, ...(reasoningEffort ? { reasoningEffort } : {}) };
}

export interface HelmSessionProfileOptions {
  tools: readonly BridgeToolDefinition[];
  workingDirectory: string;
  timeZone?: string;
  defaultWorkModel?: string;
  /** The user's names list from Helm settings. */
  glossary?: string;
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
  "coauthorEnabled",
  "onPermissionRequest",
  "subagents",
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
        ...(options.glossary ? { glossary: options.glossary } : {}),
      }),
    },
  } as unknown as T;
}
