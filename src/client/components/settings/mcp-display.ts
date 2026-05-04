import type { McpServerConfig } from "../../api";
import { getMcpServerTransport, isLocalMcpServerConfig } from "../../../mcp-config";

export function summarizeMcpServerConfig(config: McpServerConfig): string {
  const transport = getMcpServerTransport(config);
  if (isLocalMcpServerConfig(config)) {
    const command = [config.command, ...config.args].filter(Boolean).join(" ");
    return `${transport}: ${command}`;
  }
  return `${transport}: ${config.url}`;
}
