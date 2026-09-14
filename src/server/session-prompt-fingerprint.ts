import { createHash } from "node:crypto";
import { isRecord } from "../shared/is-record.js";
import type { McpServerConfig } from "./mcp-config.js";
import type { TelemetryStore } from "./telemetry-store.js";

const processStartedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();
export const promptProcessMetadata = { processStartedAt, processId: process.pid };

export function safePromptCorrelationId(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : undefined;
}

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
  for (const key of ["id", "agentId"] as const) {
    const value = safePromptCorrelationId(event[key]);
    if (value) {
      result[key === "id" ? "providerEventId" : key] = value;
    }
  }
  for (const key of ["modelFrom", "modelTo", "agentName"] as const) {
    if (typeof data[key] === "string" && data[key].length <= 256) result[`${key}Hash`] = hash(data[key]);
  }
  for (const key of ["survivedTokens", "frontierTokens", "shortfallTokens", "rewriteMessageIndex"] as const) {
    const value = data[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) result[key] = value;
  }
  if (typeof data.retentionRatio === "number" && Number.isFinite(data.retentionRatio)
    && data.retentionRatio >= 0 && data.retentionRatio <= 1) result.retentionRatio = data.retentionRatio;
  if (typeof data.toolsReordered === "boolean") result.toolsReordered = data.toolsReordered;
  if (typeof data.primaryReason === "string" && data.primaryReason.length <= 256) {
    result.primaryReasonHash = hash(data.primaryReason);
    // The installed runtime schema declares an open string, not an enum.
    result.primaryReasonCategory = "unknown";
  }
  for (const key of ["contributingReasons", "toolsAdded", "toolsRemoved", "toolsRedefined", "systemSegmentsChanged", "cacheConfigChangedFields"] as const) {
    if (Array.isArray(data[key])) result[`${key}Count`] = data[key].length;
  }
  return result;
}

/**
 * Independent of the SDK handle cache; bounded and content-free. On a cold
 * comparison, reuse the latest retained applied span (including legacy hashes).
 * Normal telemetry pruning bounds persistence; pruned sessions start a baseline.
 */
export class AppliedPromptFingerprints {
  private readonly latest = new Map<string, Fingerprint>();

  constructor(private readonly store?: Pick<TelemetryStore, "querySpans">) {}

  record(sessionId: string, config: PromptFingerprintConfig): Record<string, unknown> {
    const next = fingerprintPromptConfig(config);
    let previous = this.latest.get(sessionId);
    let previousRead: string | undefined;
    if (!previous && this.store) {
      try {
        const metadata = this.store.querySpans({ sessionId, name: "session.prompt.applied", source: "server", limit: 1 })[0]?.metadata;
        const hashes = isRecord(metadata) && metadata.scope === "bridge_config_only" ? metadata.hashes : undefined;
        if (isRecord(hashes) && Object.keys(next).every((key) =>
          typeof hashes[key] === "string" && /^[a-f0-9]{64}$/.test(hashes[key]))) {
          previous = {
            systemMessage: String(hashes.systemMessage), sections: String(hashes.sections),
            content: String(hashes.content), tools: String(hashes.tools),
          };
          previousRead = "persisted";
        } else if (metadata != null) {
          previousRead = "invalid_metadata";
        }
      } catch {
        // Like recordSpan, optional telemetry must not fail handle acceptance.
        console.warn("[telemetry] Failed to read previous applied prompt fingerprint");
        previousRead = "unavailable";
      }
    }
    this.latest.delete(sessionId);
    this.latest.set(sessionId, next);
    if (this.latest.size > 10_000) this.latest.delete(this.latest.keys().next().value!);
    return {
      scope: "bridge_config_only",
      ...promptProcessMetadata,
      ...(previousRead ? { previousRead } : {}),
      cacheBreakCandidate: Boolean(previous && (previous.systemMessage !== next.systemMessage || previous.tools !== next.tools)),
      comparison: previous ? "previous_applied" : "baseline",
      hashes: next,
      changedCategories: previous
        ? (Object.keys(next) as (keyof Fingerprint)[]).filter((key) => previous[key] !== next[key])
        : [],
    };
  }
}
