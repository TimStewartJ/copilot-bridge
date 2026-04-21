export interface McpServerConfigBase {
  tools?: string[];
}

export interface LocalMcpServerConfig extends McpServerConfigBase {
  type?: "local" | "stdio";
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface RemoteMcpServerConfig extends McpServerConfigBase {
  type: "http" | "sse";
  url: string;
  headers?: Record<string, string>;
}

export type McpServerConfig = LocalMcpServerConfig | RemoteMcpServerConfig;

export function getMcpServerTransport(config: McpServerConfig): "local" | "http" | "sse" {
  if (config.type === "http" || config.type === "sse") return config.type;
  return "local";
}

export function isRemoteMcpServerConfig(config: McpServerConfig): config is RemoteMcpServerConfig {
  return config.type === "http" || config.type === "sse";
}

export function isLocalMcpServerConfig(config: McpServerConfig): config is LocalMcpServerConfig {
  return !isRemoteMcpServerConfig(config);
}
