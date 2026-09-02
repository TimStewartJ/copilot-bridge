import type { McpServerConfig } from "../../api";
import {
  classifyMcpServerExecution,
  getMcpServerTransport,
  isLocalMcpServerConfig,
} from "../../../mcp-config";

export function summarizeMcpServerConfig(config: McpServerConfig): string {
  const transport = getMcpServerTransport(config);
  if (isLocalMcpServerConfig(config)) {
    const command = [config.command, ...config.args].filter(Boolean).join(" ");
    return `${transport}: ${command}`;
  }
  return `${transport}: ${config.url}`;
}

export function summarizeMcpServerExecution(config: McpServerConfig): string {
  const classification = classifyMcpServerExecution(config);
  if (classification.effectiveMode === "direct") return "direct";
  if (classification.effectiveMode === "shared") return "shared";
  if (classification.desiredMode === "shared") {
    return classification.requestedScope === "shared"
      ? "session isolated (shared requested)"
      : "session isolated (auto candidate)";
  }
  return classification.requestedScope === "session"
    ? "session isolated (explicit)"
    : "session isolated";
}
