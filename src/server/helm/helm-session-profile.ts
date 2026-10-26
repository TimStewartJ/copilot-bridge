// Turns an ordinary Bridge session config into a Helm one: Helm's own instructions and only
// the tools that manage Bridge. Applied on create and on every resume, so a Helm
// conversation can never come back as a general-purpose coding session.
import type { BridgeToolDefinition } from "../agent-tools-mcp/server.js";
import { createNativeBridgeTools } from "../bridge-native-tools.js";
import { BUILT_IN_GITHUB_MCP_SERVER } from "../built-in-mcp-servers.js";
import { buildHelmSystemPrompt } from "./helm-prompt.js";

export interface HelmSessionProfileOptions {
  tools: readonly BridgeToolDefinition[];
  workingDirectory: string;
  timeZone?: string;
  defaultWorkModel?: string;
  /** The user's names list from Helm settings. */
  glossary?: string;
  /** Replaces Helm's conversational instructions (the looks that write the brief have their own). */
  systemPrompt?: string;
}

export const HELM_CLIENT_NAME = "Copilot Bridge Helm";

/**
 * The only fields Helm takes from the config an ordinary session would get: which session and
 * model it is, and how the runtime talks to Bridge. This is an allowlist on purpose. Ordinary
 * sessions keep gaining capabilities through new config fields (plugins, agents, MCP servers),
 * and a manager that acts on what it reads and hears must not inherit one just because nobody
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
    // Helm's tools are its own; the runtime would still connect GitHub's on the first prompt of a
    // call and hold Helm's first reply back by more than a second.
    disabledMcpServers: [BUILT_IN_GITHUB_MCP_SERVER],
    skillDirectories: [],
    instructionDirectories: [],
    enableConfigDiscovery: false,
    workingDirectory: options.workingDirectory,
    systemMessage: {
      mode: "replace",
      content: options.systemPrompt ?? buildHelmSystemPrompt({
        timeZone: options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
        ...(options.defaultWorkModel ? { defaultWorkModel: options.defaultWorkModel } : {}),
        ...(options.glossary ? { glossary: options.glossary } : {}),
      }),
    },
  } as unknown as T;
}
