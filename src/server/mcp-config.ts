import { isRecord } from "../shared/is-record.js";

export interface McpServerConfigBase {
  tools?: string[];
}

export type McpExecutionScope = "auto" | "shared" | "session";
export type McpExecutionMode = "direct" | "shared" | "session";

export interface LocalMcpServerConfig extends McpServerConfigBase {
  type?: "local" | "stdio";
  command: string;
  args: string[];
  env?: Record<string, string>;
  workingDirectory?: string;
  /**
   * Bridge-owned execution intent. This is removed before forwarding the
   * configuration to the Copilot runtime.
   */
  executionScope?: McpExecutionScope;
}

export interface RemoteMcpServerConfig extends McpServerConfigBase {
  type: "http" | "sse";
  url: string;
  headers?: Record<string, string>;
  oauthClientId?: string;
  oauthPublicClient?: boolean;
  oauthGrantType?: "authorization_code" | "client_credentials";
  auth?: {
    redirectPort?: number;
  };
}

export type McpServerConfig = LocalMcpServerConfig | RemoteMcpServerConfig;

export interface McpExecutionClassification {
  requestedScope: McpExecutionScope;
  desiredMode: McpExecutionMode;
  effectiveMode: McpExecutionMode;
  shareCandidate: boolean;
  reason: string;
}

export interface McpExecutionClassifierOptions {
  sharedBrokerAvailable?: boolean;
  sharingVerified?: boolean;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

function isMcpExecutionScope(value: unknown): value is McpExecutionScope {
  return value === "auto" || value === "shared" || value === "session";
}

export function isMcpServerConfig(config: unknown): config is McpServerConfig {
  if (!isRecord(config)) return false;
  if (config.tools !== undefined && !isStringArray(config.tools)) return false;

  if (config.type === "http" || config.type === "sse") {
    return typeof config.url === "string"
      && config.url.trim().length > 0
      && (config.headers === undefined || isStringRecord(config.headers))
      && config.executionScope === undefined
      && (config.oauthClientId === undefined || typeof config.oauthClientId === "string")
      && (config.oauthPublicClient === undefined || typeof config.oauthPublicClient === "boolean")
      && (
        config.oauthGrantType === undefined
        || config.oauthGrantType === "authorization_code"
        || config.oauthGrantType === "client_credentials"
      )
      && (
        config.auth === undefined
        || (
          isRecord(config.auth)
          && (
            config.auth.redirectPort === undefined
            || (
              typeof config.auth.redirectPort === "number"
              && Number.isInteger(config.auth.redirectPort)
              && config.auth.redirectPort > 0
              && config.auth.redirectPort <= 65_535
            )
          )
        )
      );
  }

  if (config.type !== undefined && config.type !== "local" && config.type !== "stdio") {
    return false;
  }

  return typeof config.command === "string"
    && config.command.trim().length > 0
    && isStringArray(config.args)
    && (config.env === undefined || isStringRecord(config.env))
    && (config.workingDirectory === undefined || typeof config.workingDirectory === "string")
    && (config.executionScope === undefined || isMcpExecutionScope(config.executionScope));
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

function getStaticSharingBlocker(config: LocalMcpServerConfig): string | undefined {
  if (config.workingDirectory?.trim()) {
    return "A configured working directory may carry workspace-specific state.";
  }
  if (config.env && Object.keys(config.env).length > 0) {
    return "Custom environment variables may carry session-specific identity or secrets.";
  }
  return undefined;
}

export function classifyMcpServerExecution(
  config: McpServerConfig,
  options: McpExecutionClassifierOptions = {},
): McpExecutionClassification {
  if (isRemoteMcpServerConfig(config)) {
    return {
      requestedScope: "auto",
      desiredMode: "direct",
      effectiveMode: "direct",
      shareCandidate: false,
      reason: "Remote HTTP and SSE servers already run outside individual Bridge sessions.",
    };
  }

  const requestedScope = config.executionScope ?? "auto";
  if (requestedScope === "session") {
    return {
      requestedScope,
      desiredMode: "session",
      effectiveMode: "session",
      shareCandidate: false,
      reason: "Session isolation was selected explicitly.",
    };
  }

  const blocker = getStaticSharingBlocker(config);
  if (blocker && requestedScope === "auto") {
    return {
      requestedScope,
      desiredMode: "session",
      effectiveMode: "session",
      shareCandidate: false,
      reason: `${blocker} This server remains session-isolated.`,
    };
  }

  const shareCandidate = true;
  const desiredMode = "shared";
  if (!options.sharedBrokerAvailable) {
    return {
      requestedScope,
      desiredMode,
      effectiveMode: "session",
      shareCandidate,
      reason: requestedScope === "shared"
        ? blocker
          ? `Shared execution is requested for a server with session-sensitive configuration. ${blocker} It remains session-isolated until the broker can validate and key that configuration safely.`
          : "Shared execution is requested. It remains session-isolated until the shared MCP broker is available."
        : "This server is eligible for broker validation. It remains session-isolated until the shared MCP broker is available.",
    };
  }
  if (!options.sharingVerified) {
    return {
      requestedScope,
      desiredMode,
      effectiveMode: "session",
      shareCandidate,
      reason: "The shared broker is available, but capability and identity validation has not approved this server.",
    };
  }
  return {
    requestedScope,
    desiredMode,
    effectiveMode: "shared",
    shareCandidate,
    reason: requestedScope === "shared"
      ? "Shared execution was selected explicitly and passed broker validation."
      : "Automatic policy selected shared execution after broker validation.",
  };
}

export function toRuntimeMcpServerConfig(config: McpServerConfig): McpServerConfig {
  if (isRemoteMcpServerConfig(config) || config.executionScope === undefined) return config;
  const runtimeConfig = { ...config };
  delete runtimeConfig.executionScope;
  return runtimeConfig;
}

export function toRuntimeMcpServerConfigs(
  configs: Record<string, McpServerConfig>,
): Record<string, McpServerConfig> {
  return Object.fromEntries(
    Object.entries(configs).map(([name, config]) => [name, toRuntimeMcpServerConfig(config)]),
  );
}
