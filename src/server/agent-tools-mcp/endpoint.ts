import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const BRIDGE_TOOLS_MCP_SERVER_NAME = "bridge-tools";
export const BRIDGE_TOOLS_SESSION_MCP_SERVER_NAME = "bridge-tools-session";
export const BRIDGE_MCP_ENDPOINT_ENV = "BRIDGE_MCP_ENDPOINT";

export interface BridgeToolsMcpEndpointOptions {
  dataDir?: string;
  pid?: number;
  platform?: NodeJS.Platform;
  sessionId?: string;
  tmpDir?: string;
}

function endpointSuffix(options: BridgeToolsMcpEndpointOptions): string {
  const pid = options.pid ?? process.pid;
  const dataDir = options.dataDir?.trim();
  const parts = [String(pid)];
  if (dataDir) parts.push(createHash("sha256").update(dataDir).digest("hex").slice(0, 8));
  if (options.sessionId) parts.push(createHash("sha256").update(options.sessionId).digest("hex").slice(0, 10));
  return parts.join("-");
}

export function createBridgeToolsMcpEndpoint(options: BridgeToolsMcpEndpointOptions = {}): string {
  const name = `copilot-bridge-mcp-${endpointSuffix(options)}`;
  if ((options.platform ?? process.platform) === "win32") {
    return `\\\\.\\pipe\\${name}`;
  }
  return join(options.tmpDir ?? tmpdir(), `${name}.sock`);
}

export function isWindowsNamedPipeEndpoint(endpoint: string): boolean {
  return endpoint.startsWith("\\\\.\\pipe\\") || endpoint.startsWith("\\\\?\\pipe\\");
}
