import { createHash } from "node:crypto";
import { isRecord } from "../shared/is-record.js";
import type { McpServerConfig } from "./mcp-config.js";

export interface PromptFingerprintConfig {
  systemMessage?: unknown;
  tools?: readonly unknown[];
  mcpServers?: Record<string, McpServerConfig>;
  excludedTools?: readonly string[];
  availableTools?: readonly string[];
  customAgents?: readonly unknown[];
  githubMcpToolConfig?: unknown;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex");
}

export function fingerprintPromptConfig(config: PromptFingerprintConfig) {
  const message = isRecord(config.systemMessage) ? config.systemMessage : {};
  return {
    systemMessage: hash(config.systemMessage),
    sections: hash(message.sections),
    content: hash(message.content),
    tools: hash({
      declarations: config.tools?.map((tool) => isRecord(tool)
        ? { name: tool.name, description: tool.description, parameters: tool.parameters }
        : null),
      // Transport addresses, credentials and execution settings are not prompt declarations.
      mcpToolSelection: Object.entries(config.mcpServers ?? {}).map(([name, server]) => ({ name, tools: server.tools })),
      excludedTools: config.excludedTools,
      availableTools: config.availableTools,
      customAgents: config.customAgents,
      githubMcpToolConfig: config.githubMcpToolConfig,
    }),
  };
}

type Fingerprint = ReturnType<typeof fingerprintPromptConfig>;

/** Runtime-internal event: only schema-confirmed scalar diagnostics, never request snapshots. */
export function normalizePromptCacheBreak(event: unknown): Record<string, unknown> | undefined {
  if (!isRecord(event) || event.type !== "prompt_cache_break" || !isRecord(event.data)) return undefined;
  const data = event.data;
  const result: Record<string, unknown> = {};
  for (const key of ["survivedTokens", "frontierTokens", "shortfallTokens", "rewriteMessageIndex"] as const) {
    const value = data[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) result[key] = value;
  }
  if (typeof data.retentionRatio === "number" && Number.isFinite(data.retentionRatio)
    && data.retentionRatio >= 0 && data.retentionRatio <= 1) result.retentionRatio = data.retentionRatio;
  if (typeof data.toolsReordered === "boolean") result.toolsReordered = data.toolsReordered;
  if (typeof data.primaryReason === "string" && data.primaryReason.length <= 256) {
    result.primaryReasonHash = hash(data.primaryReason);
  }
  for (const key of ["contributingReasons", "toolsAdded", "toolsRemoved", "toolsRedefined", "systemSegmentsChanged", "cacheConfigChangedFields"] as const) {
    if (Array.isArray(data[key])) result[`${key}Count`] = data[key].length;
  }
  return result;
}

/** Independent of the SDK handle cache; bounded and content-free. */
export class AppliedPromptFingerprints {
  private readonly latest = new Map<string, Fingerprint>();

  record(sessionId: string, config: PromptFingerprintConfig): Record<string, unknown> {
    const next = fingerprintPromptConfig(config);
    const previous = this.latest.get(sessionId);
    this.latest.delete(sessionId);
    this.latest.set(sessionId, next);
    if (this.latest.size > 10_000) this.latest.delete(this.latest.keys().next().value!);
    return {
      scope: "bridge_config_only",
      cacheBreakCandidate: Boolean(previous && (previous.systemMessage !== next.systemMessage || previous.tools !== next.tools)),
      comparison: previous ? "previous_applied" : "baseline",
      hashes: next,
      changedCategories: previous
        ? (Object.keys(next) as (keyof Fingerprint)[]).filter((key) => previous[key] !== next[key])
        : [],
    };
  }
}
