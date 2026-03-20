// Configuration for the Copilot Web Bridge

import { getMcpServers } from "./settings-store.js";

export const config = {
  // Web server
  web: {
    port: 3333,
  },

  /** MCP servers — reads from settings store (live-reloaded per session) */
  get sessionMcpServers() {
    return getMcpServers();
  },
};
