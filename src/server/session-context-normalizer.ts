import {
  type SessionContextAttribution,
  type SessionContextCapability,
  type SessionContextEventType,
  type SessionContextProvenance,
  type SessionContextTokenUsage,
} from "../shared/session-context.js";

export interface NormalizedSessionContextEvent {
  sessionId: string;
  provider: string;
  providerSessionId?: string | null;
  providerEventId?: string | null;
  providerTurnId?: string | null;
  bridgeTurnId?: string | null;
  attribution: SessionContextAttribution;
  type: SessionContextEventType;
  occurredAt: string;
  model?: string | null;
  contextWindow?: number | null;
  tokensUsed?: number | null;
  tokensRemaining?: number | null;
  usageRatio?: number | null;
  modelUsage?: SessionContextTokenUsage | null;
  provenance?: SessionContextProvenance | null;
  contextWindowCapability?: SessionContextCapability;
  modelUsageCapability?: SessionContextCapability;
  metadata?: Record<string, unknown> | null;
  dedupeKey?: string;
}

export interface SessionContextNormalizationOptions {
  sessionId: string;
  provider: string;
  providerSessionId?: string | null;
  bridgeTurnId?: string | null;
  providerTurnId?: string | null;
  attribution?: SessionContextAttribution;
  now?: () => string;
}

const USAGE_EVENT_TYPES = new Set([
  "usage_info",
  "usage.info",
  "session.usage_info",
  "session.usage",
  "context.usage",
]);

const COMPACTION_EVENT_TYPES = new Set([
  "session.compaction",
  "session.compacted",
  "session.context_compacted",
  "context.compaction",
  "context.compacted",
]);

const TRUNCATION_EVENT_TYPES = new Set([
  "history_truncated",
  "history.truncated",
  "session.history_truncated",
  "session.history.truncated",
  "context.truncated",
]);

const TIMESTAMP_KEYS = ["timestamp", "createdAt", "occurredAt", "time"];
const PROVIDER_EVENT_ID_KEYS = ["id", "eventId", "event_id"];
const PROVIDER_TURN_ID_KEYS = ["providerTurnId", "turnId", "turn_id", "requestId", "request_id"];
const MODEL_KEYS = ["model", "modelId", "model_id", "selectedModel", "newModel"];
const CONTEXT_WINDOW_KEYS = ["contextWindow", "context_window", "contextWindowTokens", "tokenLimit", "maxContextTokens", "maxInputTokens"];
const TOKENS_USED_KEYS = ["tokensUsed", "usedTokens", "contextTokens", "currentTokens", "currentContextTokens", "totalContextTokens"];
const TOKENS_REMAINING_KEYS = ["tokensRemaining", "remainingTokens", "remainingContextTokens"];
const USAGE_RATIO_KEYS = ["usageRatio", "contextUsageRatio"];

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function firstString(record: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function firstNumber(record: Record<string, unknown> | undefined, keys: readonly string[]): number | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const numberValue = toNonNegativeNumber(record[key]);
    if (numberValue !== undefined) return numberValue;
  }
  return undefined;
}

function firstRatio(record: Record<string, unknown> | undefined, keys: readonly string[]): number | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const ratio = toRatio(record[key]);
    if (ratio !== undefined) return ratio;
  }
  return undefined;
}

function toNonNegativeNumber(value: unknown): number | undefined {
  const numberValue = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(numberValue) || numberValue < 0) return undefined;
  return Math.floor(numberValue);
}

function toRatio(value: unknown): number | undefined {
  const numberValue = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(numberValue) || numberValue < 0) return undefined;
  return Math.max(0, Math.min(1, numberValue));
}

function normalizeTimestampFrom(record: Record<string, unknown> | undefined, now: () => string): string {
  for (const key of TIMESTAMP_KEYS) {
    const value = record?.[key];
    if (typeof value !== "string") continue;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return now();
}

function normalizeTimestamp(event: Record<string, unknown>, data: Record<string, unknown> | undefined, now: () => string): string {
  return normalizeTimestampFrom(data, () => normalizeTimestampFrom(event, now));
}

function getProviderEventId(event: Record<string, unknown>, data: Record<string, unknown> | undefined): string | undefined {
  return firstString(event, PROVIDER_EVENT_ID_KEYS) ?? firstString(data, PROVIDER_EVENT_ID_KEYS);
}

function getProviderTurnId(event: Record<string, unknown>, data: Record<string, unknown> | undefined): string | undefined {
  return firstString(data, PROVIDER_TURN_ID_KEYS) ?? firstString(event, PROVIDER_TURN_ID_KEYS);
}

export function getProviderTurnIdFromEvent(event: unknown): string | undefined {
  const eventRecord = asRecord(event);
  if (!eventRecord) return undefined;
  return getProviderTurnId(eventRecord, asRecord(eventRecord.data));
}

function getModel(data: Record<string, unknown> | undefined): string | undefined {
  const nestedUsage = asRecord(data?.usage) ?? asRecord(data?.modelUsage);
  return firstString(data, MODEL_KEYS) ?? firstString(nestedUsage, MODEL_KEYS);
}

function readTokenUsage(source: Record<string, unknown> | undefined): SessionContextTokenUsage | null {
  if (!source) return null;
  const usage: SessionContextTokenUsage = {};
  const requests = firstNumber(source, ["requests", "requestCount", "count"]);
  const inputTokens = firstNumber(source, ["inputTokens", "input_tokens", "promptTokens", "prompt_tokens"]);
  const outputTokens = firstNumber(source, ["outputTokens", "output_tokens", "completionTokens", "completion_tokens"]);
  const cacheReadTokens = firstNumber(source, ["cacheReadTokens", "cache_read_tokens", "cachedInputTokens", "cached_input_tokens"]);
  const cacheWriteTokens = firstNumber(source, ["cacheWriteTokens", "cache_write_tokens"]);
  const reasoningTokens = firstNumber(source, ["reasoningTokens", "reasoning_tokens"]);
  const explicitTotalTokens = firstNumber(source, ["totalTokens", "total_tokens"]);

  if (requests !== undefined) usage.requests = requests;
  if (inputTokens !== undefined) usage.inputTokens = inputTokens;
  if (outputTokens !== undefined) usage.outputTokens = outputTokens;
  if (cacheReadTokens !== undefined) usage.cacheReadTokens = cacheReadTokens;
  if (cacheWriteTokens !== undefined) usage.cacheWriteTokens = cacheWriteTokens;
  if (reasoningTokens !== undefined) usage.reasoningTokens = reasoningTokens;
  if (explicitTotalTokens !== undefined) {
    usage.totalTokens = explicitTotalTokens;
  } else {
    const totalTokens = [
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      reasoningTokens,
    ].reduce<number>((sum, value) => sum + (value ?? 0), 0);
    if (totalTokens > 0) usage.totalTokens = totalTokens;
  }

  return Object.keys(usage).length > 0 ? usage : null;
}

function extractTokenUsage(data: Record<string, unknown> | undefined): SessionContextTokenUsage | null {
  if (!data) return null;
  return readTokenUsage(asRecord(data.usage))
    ?? readTokenUsage(asRecord(data.tokenUsage))
    ?? readTokenUsage(asRecord(data.modelUsage))
    ?? readTokenUsage(data);
}

function addTokenUsage(target: SessionContextTokenUsage, source: SessionContextTokenUsage | null): void {
  if (!source) return;
  for (const key of ["requests", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens", "totalTokens"] as const) {
    const value = source[key];
    if (value !== undefined) {
      target[key] = (target[key] ?? 0) + value;
    }
  }
}

function extractModelMetricsUsage(modelMetrics: Record<string, unknown> | undefined): {
  modelUsage: SessionContextTokenUsage | null;
  model: string | null;
  modelCount: number;
} {
  if (!modelMetrics) return { modelUsage: null, model: null, modelCount: 0 };
  const aggregate: SessionContextTokenUsage = {};
  const models = Object.keys(modelMetrics).filter((model) => model.trim());
  for (const model of models) {
    const metrics = asRecord(modelMetrics[model]);
    const usage = readTokenUsage(asRecord(metrics?.usage)) ?? readTokenUsage(metrics);
    const requestCount = readTokenUsage(asRecord(metrics?.requests));
    addTokenUsage(aggregate, usage);
    if (requestCount?.requests !== undefined) {
      aggregate.requests = (aggregate.requests ?? 0) + requestCount.requests;
    }
  }
  return {
    modelUsage: Object.keys(aggregate).length > 0 ? aggregate : null,
    model: models.length === 1 ? models[0] : null,
    modelCount: models.length,
  };
}

function extractContextUsage(data: Record<string, unknown> | undefined, modelUsage: SessionContextTokenUsage | null): {
  contextWindow: number | null;
  tokensUsed: number | null;
  tokensRemaining: number | null;
  usageRatio: number | null;
  capability: SessionContextCapability;
  provenance: SessionContextProvenance | null;
} {
  const contextRecord = asRecord(data?.context) ?? asRecord(data?.contextWindow) ?? data;
  const contextWindow = firstNumber(contextRecord, CONTEXT_WINDOW_KEYS) ?? null;
  const explicitTokensUsed = firstNumber(contextRecord, TOKENS_USED_KEYS);
  const derivedTokensUsed = explicitTokensUsed ?? (
    contextWindow !== null && modelUsage
      ? (modelUsage.inputTokens ?? 0) + (modelUsage.cacheReadTokens ?? 0) + (modelUsage.cacheWriteTokens ?? 0)
      : undefined
  );
  const tokensUsed = derivedTokensUsed !== undefined ? derivedTokensUsed : null;
  const explicitTokensRemaining = firstNumber(contextRecord, TOKENS_REMAINING_KEYS);
  const tokensRemaining = explicitTokensRemaining !== undefined
    ? explicitTokensRemaining
    : contextWindow !== null && tokensUsed !== null
      ? Math.max(0, contextWindow - tokensUsed)
      : null;
  const explicitRatio = firstRatio(contextRecord, USAGE_RATIO_KEYS);
  const rawRatio = explicitRatio !== undefined
    ? explicitRatio
    : contextWindow !== null && tokensUsed !== null && contextWindow > 0
      ? tokensUsed / contextWindow
      : undefined;
  const usageRatio = rawRatio !== undefined ? Math.max(0, Math.min(1, rawRatio)) : null;
  const capability: SessionContextCapability = contextWindow !== null && explicitTokensUsed !== undefined
    ? "exact"
    : contextWindow !== null || tokensUsed !== null
      ? "partial"
      : "unavailable";
  const provenance: SessionContextProvenance = {};
  if (contextWindow !== null) {
    provenance.contextWindow = { source: "live", confidence: "exact" };
  }
  if (tokensUsed !== null) {
    provenance.tokensUsed = {
      source: "live",
      confidence: explicitTokensUsed !== undefined ? "exact" : "partial",
    };
  }
  if (tokensRemaining !== null) {
    provenance.tokensRemaining = {
      source: "live",
      confidence: explicitTokensRemaining !== undefined ? "exact" : capability,
    };
  }
  return {
    contextWindow,
    tokensUsed,
    tokensRemaining,
    usageRatio,
    capability,
    provenance: Object.keys(provenance).length > 0 ? provenance : null,
  };
}

function getUsageAttribution(
  data: Record<string, unknown> | undefined,
  fallback: SessionContextAttribution | undefined,
): SessionContextAttribution {
  if (fallback) return fallback;
  if (typeof data?.parentToolCallId === "string" || data?.isSubAgent === true || data?.subagent === true) {
    return "subagent_turn";
  }
  return "turn";
}

function metadataFromKeys(record: Record<string, unknown> | undefined, keys: readonly string[]): Record<string, unknown> | null {
  if (!record) return null;
  const metadata: Record<string, unknown> = {};
  for (const key of keys) {
    const value = record[key];
    if (
      typeof value === "string"
      || typeof value === "number"
      || typeof value === "boolean"
      || value === null
    ) {
      metadata[key] = value;
    }
  }
  return Object.keys(metadata).length > 0 ? metadata : null;
}

export function normalizeLiveSessionContextEvent(
  event: unknown,
  options: SessionContextNormalizationOptions,
): NormalizedSessionContextEvent | null {
  const eventRecord = asRecord(event);
  if (!eventRecord || typeof eventRecord.type !== "string") return null;
  const eventType = eventRecord.type;
  const data = asRecord(eventRecord.data) ?? eventRecord;
  const now = options.now ?? (() => new Date().toISOString());
  const providerEventId = getProviderEventId(eventRecord, data);
  const providerTurnId = options.providerTurnId ?? getProviderTurnId(eventRecord, data);
  const occurredAt = normalizeTimestamp(eventRecord, data, now);

  if (USAGE_EVENT_TYPES.has(eventType)) {
    const modelUsage = extractTokenUsage(data);
    const contextUsage = extractContextUsage(data, modelUsage);
    if (!modelUsage && contextUsage.capability === "unavailable") return null;
    const attribution = getUsageAttribution(data, options.attribution);
    return {
      sessionId: options.sessionId,
      provider: options.provider,
      providerSessionId: options.providerSessionId,
      providerEventId,
      providerTurnId,
      bridgeTurnId: attribution === "session_overhead" ? null : options.bridgeTurnId,
      attribution,
      type: "context_snapshot",
      occurredAt,
      model: getModel(data) ?? null,
      ...contextUsage,
      contextWindowCapability: contextUsage.capability,
      modelUsage,
      provenance: {
        ...(contextUsage.provenance ?? {}),
        ...(modelUsage ? { modelUsage: { source: "live" as const, confidence: "exact" as const } } : {}),
      },
      modelUsageCapability: modelUsage ? "exact" : "unavailable",
      metadata: metadataFromKeys(data, ["requestId", "toolCallId", "parentToolCallId"]),
    };
  }

  return normalizeSessionContextMarker(eventRecord, data, {
    ...options,
    providerEventId,
    providerTurnId,
    occurredAt,
  });
}

interface MarkerOptions extends SessionContextNormalizationOptions {
  providerEventId?: string;
  providerTurnId?: string;
  occurredAt: string;
}

function normalizeSessionContextMarker(
  eventRecord: Record<string, unknown>,
  data: Record<string, unknown> | undefined,
  options: MarkerOptions,
): NormalizedSessionContextEvent | null {
  const eventType = String(eventRecord.type);
  if (eventType === "session.shutdown") {
    const metrics = extractModelMetricsUsage(asRecord(data?.modelMetrics));
    return {
      sessionId: options.sessionId,
      provider: options.provider,
      providerSessionId: options.providerSessionId,
      providerEventId: options.providerEventId,
      providerTurnId: options.providerTurnId,
      bridgeTurnId: null,
      attribution: "session_overhead",
      type: "shutdown",
      occurredAt: options.occurredAt,
      model: metrics.model,
      modelUsage: metrics.modelUsage,
      provenance: metrics.modelUsage
        ? { modelUsage: { source: "backfill", confidence: "exact" } }
        : null,
      modelUsageCapability: metrics.modelUsage ? "exact" : "unavailable",
      metadata: {
        ...(typeof data?.shutdownType === "string" ? { shutdownType: data.shutdownType } : {}),
        ...(metrics.modelCount > 0 ? { modelCount: metrics.modelCount } : {}),
      },
    };
  }

  if (COMPACTION_EVENT_TYPES.has(eventType)) {
    return {
      sessionId: options.sessionId,
      provider: options.provider,
      providerSessionId: options.providerSessionId,
      providerEventId: options.providerEventId,
      providerTurnId: options.providerTurnId,
      bridgeTurnId: null,
      attribution: "session_overhead",
      type: "compaction",
      occurredAt: options.occurredAt,
      model: getModel(data) ?? null,
      metadata: metadataFromKeys(data, ["reason", "strategy", "eventsRemoved"]),
    };
  }

  if (TRUNCATION_EVENT_TYPES.has(eventType)) {
    return {
      sessionId: options.sessionId,
      provider: options.provider,
      providerSessionId: options.providerSessionId,
      providerEventId: options.providerEventId,
      providerTurnId: options.providerTurnId,
      bridgeTurnId: null,
      attribution: "session_overhead",
      type: "truncation",
      occurredAt: options.occurredAt,
      metadata: metadataFromKeys(data, ["eventId", "eventsRemoved", "candidateEventsToRemove", "reason"]),
    };
  }

  return null;
}

export function normalizePersistedSessionContextEvent(
  event: unknown,
  options: SessionContextNormalizationOptions,
): NormalizedSessionContextEvent | null {
  const eventRecord = asRecord(event);
  if (!eventRecord || typeof eventRecord.type !== "string") return null;
  const data = asRecord(eventRecord.data);
  const now = options.now ?? (() => new Date().toISOString());
  return normalizeSessionContextMarker(eventRecord, data, {
    ...options,
    providerEventId: getProviderEventId(eventRecord, data),
    providerTurnId: getProviderTurnId(eventRecord, data),
    occurredAt: normalizeTimestamp(eventRecord, data, now),
  });
}

export function createSessionContextTruncationMarker(options: {
  sessionId: string;
  provider: string;
  providerSessionId?: string | null;
  occurredAt?: string;
  eventId?: string;
  eventsRemoved?: number;
  candidateEventsToRemove?: number;
  reason?: string;
}): NormalizedSessionContextEvent {
  const metadata: Record<string, unknown> = {};
  if (options.eventId) metadata.eventId = options.eventId;
  if (options.eventsRemoved !== undefined) metadata.eventsRemoved = options.eventsRemoved;
  if (options.candidateEventsToRemove !== undefined) metadata.candidateEventsToRemove = options.candidateEventsToRemove;
  if (options.reason) metadata.reason = options.reason;
  return {
    sessionId: options.sessionId,
    provider: options.provider,
    providerSessionId: options.providerSessionId,
    bridgeTurnId: null,
    attribution: "session_overhead",
    type: "truncation",
    occurredAt: options.occurredAt ?? new Date().toISOString(),
    metadata,
    dedupeKey: `truncation:${options.eventId ?? "unknown"}:${options.eventsRemoved ?? "unknown"}`,
  };
}
