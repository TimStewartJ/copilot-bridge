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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

export function isMcpServerConfig(config: unknown): config is McpServerConfig {
  if (!isRecord(config)) return false;
  if (config.tools !== undefined && !isStringArray(config.tools)) return false;

  if (config.type === "http" || config.type === "sse") {
    return typeof config.url === "string"
      && config.url.trim().length > 0
      && (config.headers === undefined || isStringRecord(config.headers));
  }

  if (config.type !== undefined && config.type !== "local" && config.type !== "stdio") {
    return false;
  }

  return typeof config.command === "string"
    && config.command.trim().length > 0
    && isStringArray(config.args)
    && (config.env === undefined || isStringRecord(config.env));
}

export function assertMcpServerConfig(config: unknown): asserts config is McpServerConfig {
  if (!isMcpServerConfig(config)) {
    throw new Error("Invalid MCP server config");
  }
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (!isRecord(value)) return value;

  return Object.keys(value)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = canonicalizeJson(value[key]);
      return acc;
    }, {});
}

export function mcpServerConfigsEqual(a: McpServerConfig, b: McpServerConfig): boolean {
  return JSON.stringify(canonicalizeJson(a)) === JSON.stringify(canonicalizeJson(b));
}

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
