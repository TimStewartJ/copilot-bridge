import type { GitHubMcpToolConfig } from "@github/copilot-sdk";
import type { McpServerConfig } from "./mcp-config.js";
import { resolveBridgeCopilotGitHubToken } from "./copilot-client-options.js";

// The SDK-reserved name makes the CLI host GitHub MCP and expose `web_search` as a top-level tool.
export const GITHUB_COPILOT_MCP_SERVER_NAME = "github-mcp-server";
export const GITHUB_COPILOT_MCP_WEB_SEARCH_TOOL = "web_search";
export const GITHUB_COPILOT_MCP_READONLY_URL = "https://api.githubcopilot.com/mcp/readonly";

export interface BuiltInMcpServerConfig {
  name: string;
  config: McpServerConfig;
}

export function buildGitHubCopilotMcpToolConfig(): GitHubMcpToolConfig {
  return {
    additionalTools: [GITHUB_COPILOT_MCP_WEB_SEARCH_TOOL],
  };
}

export function buildGitHubCopilotSearchMcpServer(
  clientEnv?: Record<string, string | undefined>,
): BuiltInMcpServerConfig | undefined {
  const token = resolveBridgeCopilotGitHubToken(clientEnv);
  if (!token) return undefined;

  return {
    name: GITHUB_COPILOT_MCP_SERVER_NAME,
    config: {
      type: "http",
      url: GITHUB_COPILOT_MCP_READONLY_URL,
      headers: {
        Authorization: `Bearer ${token}`,
        "X-MCP-Host": "copilot-bridge",
        "X-MCP-Readonly": "true",
        "X-MCP-Tools": GITHUB_COPILOT_MCP_WEB_SEARCH_TOOL,
      },
      tools: [GITHUB_COPILOT_MCP_WEB_SEARCH_TOOL],
    },
  };
}
