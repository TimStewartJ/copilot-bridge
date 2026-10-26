// Two shapes of Helm session. Helm's chat is an ordinary Bridge chat (Assistant profile, with its
// shell, skills, MCP servers and Bridge tools) plus Helm's own tools; its role and guidance reach
// the ordinary prompt through the profile's config options. The looks that write the brief are
// locked down: Helm's instructions and read-only tools only, applied on create and on every resume.
import type { BridgeToolDefinition } from "../agent-tools-mcp/server.js";
import { createNativeBridgeTools } from "../bridge-native-tools.js";
import { BUILT_IN_GITHUB_MCP_SERVER } from "../built-in-mcp-servers.js";

export interface HelmSessionProfileOptions {
  tools: readonly BridgeToolDefinition[];
  workingDirectory: string;
  systemPrompt: string;
}

export const HELM_CLIENT_NAME = "Copilot Bridge Helm";

/**
 * The only fields a look takes from the config an ordinary session would get: which session and
 * model it is, and how the runtime talks to Bridge. This is an allowlist on purpose. Ordinary
 * sessions keep gaining capabilities through new config fields (plugins, agents, MCP servers),
 * and an unattended run that reads every Bridge must not inherit one just because nobody
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
 * Returns the locked config of a look. Identity, model and lifecycle fields chosen by the session
 * manager are kept; everything that shapes what the agent is and what it can touch is Helm's own.
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
    // A look uses none of GitHub's tools; the runtime would still connect them on the first prompt.
    disabledMcpServers: [BUILT_IN_GITHUB_MCP_SERVER],
    skillDirectories: [],
    instructionDirectories: [],
    enableConfigDiscovery: false,
    workingDirectory: options.workingDirectory,
    systemMessage: { mode: "replace", content: options.systemPrompt },
  } as unknown as T;
}

/**
 * Built-in tools Helm's chat goes without. ask_user shows a form, and hands-free has no way to
 * speak one or take its answer; Helm asks its questions in its reply instead.
 */
export const HELM_CHAT_EXCLUDED_TOOLS = ["ask_user"] as const;

/** Adds Helm's own tools to an ordinary chat's config. */
export function applyHelmChatProfile<T extends Record<string, unknown>>(base: T, options: { tools: readonly BridgeToolDefinition[] }): T {
  const own = createNativeBridgeTools(options.tools);
  const ownNames = new Set(own.map((tool) => tool.name));
  const baseTools = Array.isArray(base.tools) ? (base.tools as Array<{ name: string }>).filter((tool) => !ownNames.has(tool.name)) : [];
  const excluded = Array.isArray(base.excludedTools) ? (base.excludedTools as string[]) : [];
  return {
    ...base,
    clientName: HELM_CLIENT_NAME,
    tools: [...baseTools, ...own],
    excludedTools: [...new Set([...excluded, ...HELM_CHAT_EXCLUDED_TOOLS])],
  } as unknown as T;
}
