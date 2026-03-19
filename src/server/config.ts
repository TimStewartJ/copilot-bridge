// Configuration for the Copilot Web Bridge

export const config = {
  // Web server
  web: {
    port: 3333,
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
} as const;
