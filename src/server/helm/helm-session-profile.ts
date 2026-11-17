// Helm chat = ordinary chat + Helm tools; brief looks get only Helm's prompt and read-only tools.
import type { BridgeToolDefinition } from "../agent-tools-mcp/server.js";
import { createNativeBridgeTools } from "../bridge-native-tools.js";
import { BUILT_IN_GITHUB_MCP_SERVER } from "../built-in-mcp-servers.js";

export interface HelmSessionProfileOptions {
  tools: readonly BridgeToolDefinition[];
  workingDirectory: string;
  systemPrompt: string;
}

export const HELM_CLIENT_NAME = "Copilot Bridge Helm";

/** Allowlist on purpose: new session config fields (plugins, MCP) must not reach looks unasked. */
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
  "fusionContextTokens",
] as const;

/** A look's locked config: keeps identity, model and lifecycle; everything else is Helm's. */
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

/** ask_user forms can't work hands-free, and Helm chat has no playbooks. */
export const HELM_CHAT_EXCLUDED_TOOLS = ["ask_user", "playbook_select", "verify_complete"] as const;

/** Adds Helm's tools to a chat and hides playbook skills, which need tools Helm lacks. */
export function applyHelmChatProfile<T extends Record<string, unknown>>(
  base: T,
  options: { tools: readonly BridgeToolDefinition[]; playbookSkills?: readonly string[] },
): T {
  const own = createNativeBridgeTools(options.tools);
  const ownNames = new Set(own.map((tool) => tool.name));
  const baseTools = Array.isArray(base.tools) ? (base.tools as Array<{ name: string }>).filter((tool) => !ownNames.has(tool.name)) : [];
  const excluded = Array.isArray(base.excludedTools) ? (base.excludedTools as string[]) : [];
  const disabledSkills = [...new Set([
    ...(Array.isArray(base.disabledSkills) ? (base.disabledSkills as string[]) : []),
    ...(options.playbookSkills ?? []),
  ])];
  return {
    ...base,
    clientName: HELM_CLIENT_NAME,
    tools: [...baseTools, ...own],
    excludedTools: [...new Set([...excluded, ...HELM_CHAT_EXCLUDED_TOOLS])],
    ...(disabledSkills.length > 0 ? { disabledSkills } : {}),
  } as unknown as T;
}
