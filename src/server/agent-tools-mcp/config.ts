import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveBridgeControlRoot } from "../control-root.js";
import type { McpServerConfig } from "../mcp-config.js";
import type { BridgeDistributionMode } from "../distribution-mode.js";
import {
  BRIDGE_MCP_ENDPOINT_ENV,
  BRIDGE_TOOLS_MCP_SERVER_NAME,
  BRIDGE_TOOLS_SESSION_MCP_SERVER_NAME,
} from "./endpoint.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolveBridgeControlRoot(join(__dirname, "..", "..", ".."));

export interface BridgeToolsMcpServerConfigOptions {
  endpoint: string;
  name?: string;
  toolNames: readonly string[];
  distributionMode?: BridgeDistributionMode;
}

function resolveShimArgs(distributionMode: BridgeDistributionMode | undefined): string[] {
  if (distributionMode === "release") {
    const distShimPath = join(__dirname, "shim.js");
    if (!existsSync(distShimPath)) {
      throw new Error(`Bridge MCP shim not found at ${distShimPath}`);
    }
    return [distShimPath];
  }

  const sourceShimPath = join(REPO_ROOT, "src", "server", "agent-tools-mcp", "shim.ts");
  if (!existsSync(sourceShimPath)) {
    throw new Error(`Bridge MCP shim source not found at ${sourceShimPath}`);
  }
  return ["--import", "tsx", sourceShimPath];
}

export function buildBridgeToolsMcpServerConfig(
  options: BridgeToolsMcpServerConfigOptions,
): { name: string; config: McpServerConfig } | undefined {
  const tools = [...options.toolNames];
  if (tools.length === 0) return undefined;

  return {
    name: options.name ?? BRIDGE_TOOLS_MCP_SERVER_NAME,
    config: {
      type: "stdio",
      command: process.execPath,
      args: resolveShimArgs(options.distributionMode),
      env: {
        [BRIDGE_MCP_ENDPOINT_ENV]: options.endpoint,
      },
      workingDirectory: REPO_ROOT,
      tools,
    },
  };
}

export function buildBridgeToolsSessionMcpServerConfig(
  options: Omit<BridgeToolsMcpServerConfigOptions, "name">,
): { name: string; config: McpServerConfig } | undefined {
  return buildBridgeToolsMcpServerConfig({
    ...options,
    name: BRIDGE_TOOLS_SESSION_MCP_SERVER_NAME,
  });
}
