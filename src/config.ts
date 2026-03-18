// Configuration for the Copilot Teams Bridge

export const config = {
  // Teams channel to watch
  teams: {
    teamId: "EXAMPLE-TEAM-GUID",
    channelId:
      "EXAMPLE-CHANNEL-ID",
  },

  // Polling settings
  polling: {
    intervalMs: 5_000,
  },

  // Teams MCP server settings
  teamsMcp: {
    port: 5555,
    baseUrl: "http://localhost:5555",
  },

  // MCP servers to attach to Copilot sessions (for agent tool access)
  sessionMcpServers: {
    ado: {
      command: "mcp-remote",
      args: [
        "mcp",
        "remote",
        "--url",
        "https://mcp.dev.azure.com/my-org",
        "--header",
        "X-MCP-Auth: true",
      ],
      tools: ["*" as const],
    },
  },

  // Optional: only process messages starting with this prefix (empty = all messages)
  messagePrefix: "",
} as const;
