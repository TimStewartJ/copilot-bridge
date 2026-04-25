// Configuration for the Copilot Web Bridge

import type { McpServerConfig } from "./mcp-config.js";
import { resolveBridgePort } from "./port-config.js";

/** Settings getter — set by index.ts after DB init */
let _getMcpServers: (() => Record<string, McpServerConfig>) | null = null;

export function setMcpServersGetter(fn: () => Record<string, McpServerConfig>): void {
  _getMcpServers = fn;
}

export const config = {
  // Web server
  web: {
    port: resolveBridgePort(),
  },

  /** MCP servers — reads from settings store (live-reloaded per session) */
  get sessionMcpServers() {
    if (!_getMcpServers) return {};
    return _getMcpServers();
  },
};
