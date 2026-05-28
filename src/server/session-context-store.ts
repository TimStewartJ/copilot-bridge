import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import type { DatabaseSync } from "./db.js";
import {
  type SessionContextAttribution,
  type SessionContextCapabilities,
  type SessionContextCapability,
  type SessionContextEvent,
  type SessionContextProvenance,
  type SessionContextResponse,
  type SessionContextSummary,
  type SessionContextTokenUsage,
  type SessionContextTurn,
} from "../shared/session-context.js";
import {
  normalizePersistedSessionContextEvent,
  type NormalizedSessionContextEvent,
} from "./session-context-normalizer.js";

const DEFAULT_CONTEXT_EVENT_LIMIT = 200;
const MAX_CONTEXT_EVENT_LIMIT = 500;
const ZERO_CAPABILITIES: SessionContextCapabilities = {
  contextWindow: "unavailable",
  modelUsage: "unavailable",
  compaction: "unavailable",
  truncation: "unavailable",
};

export interface RecordSessionContextTurnStart {
  sessionId: string;
  provider: string;
  providerSessionId?: string | null;
  providerTurnId?: string | null;
  bridgeTurnId: string;
  attribution?: Exclude<SessionContextAttribution, "session_overhead">;
  startedAt?: string | null;
  model?: string | null;
}

export interface RecordSessionContextTurnEnd {
  sessionId: string;
  bridgeTurnId: string;
  endedAt?: string | null;
  model?: string | null;
}

export interface BackfillSessionContextOptions {
  sessionId: string;
  provider?: string;
  providerSessionId?: string | null;
  eventsPath: string;
}

export interface BackfillSessionContextEventsOptions {
  sessionId: string;
  provider?: string;
  providerSessionId?: string | null;
  events: readonly unknown[];
}

interface SummaryRow {
  sessionId: string;
  provider: string;
  providerSessionId: string | null;
  updatedAt: string;
  currentModel: string | null;
  latestBridgeTurnId: string | null;
  latestSnapshotAt: string | null;
  contextWindow: number | null;
  tokensUsed: number | null;
  tokensRemaining: number | null;
  usageRatio: number | null;
  modelUsageJson: string | null;
  provenanceJson: string | null;
  contextWindowCapability: SessionContextCapability;
  modelUsageCapability: SessionContextCapability;
  snapshotCount: number;
  compactionCount: number;
  truncationCount: number;
  shutdownCount: number;
  lastSnapshotHash: string | null;
}

interface EventRow {
  id: number;
  sessionId: string;
  provider: string;
  providerSessionId: string | null;
  providerEventId: string | null;
  providerTurnId: string | null;
  bridgeTurnId: string | null;
  attribution: SessionContextAttribution;
  type: SessionContextEvent["type"];
  occurredAt: string;
  model: string | null;
  contextWindow: number | null;
  tokensUsed: number | null;
  tokensRemaining: number | null;
  usageRatio: number | null;
  modelUsageJson: string | null;
  provenanceJson: string | null;
  metadataJson: string | null;
}

interface TurnRow {
  sessionId: string;
  bridgeTurnId: string;
  provider: string;
  providerSessionId: string | null;
  providerTurnId: string | null;
  attribution: Exclude<SessionContextAttribution, "session_overhead">;
  startedAt: string | null;
  endedAt: string | null;
  latestEventAt: string | null;
  model: string | null;
}

type HydratedSummary = SessionContextSummary & {
  contextWindowCapability: SessionContextCapability;
  modelUsageCapability: SessionContextCapability;
  lastSnapshotHash: string | null;
};

function nowIso(): string {
  return new Date().toISOString();
}

function clampLimit(limit?: number): number {
  if (!Number.isFinite(limit) || limit === undefined) return DEFAULT_CONTEXT_EVENT_LIMIT;
  return Math.max(1, Math.min(MAX_CONTEXT_EVENT_LIMIT, Math.floor(limit)));
}

function sanitizeCapability(value: unknown): SessionContextCapability {
  return value === "exact" || value === "partial" ? value : "unavailable";
}

function normalizeProvider(provider?: string): string {
  return provider?.trim() || "copilot";
}

function normalizeUsageRatio(value: number | null | undefined): number | null {
  if (value === undefined || value === null || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(1, value));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashStable(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function encodeJson(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "object" && Object.keys(value as Record<string, unknown>).length === 0) return null;
  return JSON.stringify(value);
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function parseTokenUsage(value: string | null): SessionContextTokenUsage | null {
  return parseJsonObject(value) as SessionContextTokenUsage | null;
}

function parseProvenance(value: string | null): SessionContextProvenance | null {
  return parseJsonObject(value) as SessionContextProvenance | null;
}

function selectLatestTokenUsage(
  current: SessionContextTokenUsage | null,
  next: SessionContextTokenUsage | null | undefined,
): SessionContextTokenUsage | null {
  if (next === undefined || next === null) return current;
  return next;
}

function mergeCapability(current: SessionContextCapability, next?: SessionContextCapability): SessionContextCapability {
  if (!next || next === "unavailable") return current;
  if (next === "exact" || current !== "exact") return next;
  return current;
}

function deriveCapabilities(summary: (SessionContextSummary & {
  contextWindowCapability?: SessionContextCapability;
  modelUsageCapability?: SessionContextCapability;
}) | null): SessionContextCapabilities {
  if (!summary) return { ...ZERO_CAPABILITIES };
  return {
    contextWindow: sanitizeCapability(summary.contextWindowCapability),
    modelUsage: sanitizeCapability(summary.modelUsageCapability),
    compaction: summary.compactionCount > 0 ? "marker" : "unavailable",
    truncation: summary.truncationCount > 0 ? "marker" : "unavailable",
  } as SessionContextCapabilities;
}

function hydrateSummary(row: SummaryRow | undefined): HydratedSummary | null {
  if (!row) return null;
  return {
    sessionId: row.sessionId,
    provider: row.provider,
    providerSessionId: row.providerSessionId,
    updatedAt: row.updatedAt,
    currentModel: row.currentModel,
    latestBridgeTurnId: row.latestBridgeTurnId,
    latestSnapshotAt: row.latestSnapshotAt,
    contextWindow: row.contextWindow,
    tokensUsed: row.tokensUsed,
    tokensRemaining: row.tokensRemaining,
    usageRatio: normalizeUsageRatio(row.usageRatio),
    modelUsage: parseTokenUsage(row.modelUsageJson),
    provenance: parseProvenance(row.provenanceJson),
    snapshotCount: row.snapshotCount,
    compactionCount: row.compactionCount,
    truncationCount: row.truncationCount,
    shutdownCount: row.shutdownCount,
    contextWindowCapability: sanitizeCapability(row.contextWindowCapability),
    modelUsageCapability: sanitizeCapability(row.modelUsageCapability),
    lastSnapshotHash: row.lastSnapshotHash,
  };
}

function publicSummary(summary: HydratedSummary | null): SessionContextSummary | null {
  if (!summary) return null;
  const {
    contextWindowCapability: _contextWindowCapability,
    modelUsageCapability: _modelUsageCapability,
    lastSnapshotHash: _lastSnapshotHash,
    ...result
  } = summary;
  return result;
}

function hydrateEvent(row: EventRow): SessionContextEvent {
  return {
    id: row.id,
    sessionId: row.sessionId,
    provider: row.provider,
    providerSessionId: row.providerSessionId,
    providerEventId: row.providerEventId,
    providerTurnId: row.providerTurnId,
    bridgeTurnId: row.bridgeTurnId,
    attribution: row.attribution,
    type: row.type,
    occurredAt: row.occurredAt,
    model: row.model,
    contextWindow: row.contextWindow,
    tokensUsed: row.tokensUsed,
    tokensRemaining: row.tokensRemaining,
    usageRatio: normalizeUsageRatio(row.usageRatio),
    modelUsage: parseTokenUsage(row.modelUsageJson),
    provenance: parseProvenance(row.provenanceJson),
    metadata: parseJsonObject(row.metadataJson),
  };
}

function mergeProvenance(
  current: SessionContextProvenance | null | undefined,
  next: SessionContextProvenance | null | undefined,
): SessionContextProvenance | null {
  const merged: SessionContextProvenance = { ...(current ?? {}) };
  for (const [field, provenance] of Object.entries(next ?? {}) as Array<[
    keyof SessionContextProvenance,
    NonNullable<SessionContextProvenance[keyof SessionContextProvenance]>,
  ]>) {
    if (provenance) merged[field] = provenance;
  }
  return Object.keys(merged).length > 0 ? merged : null;
}

function hydrateTurn(row: TurnRow): SessionContextTurn {
  return {
    sessionId: row.sessionId,
    bridgeTurnId: row.bridgeTurnId,
    provider: row.provider,
    providerSessionId: row.providerSessionId,
    providerTurnId: row.providerTurnId,
    attribution: row.attribution,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    latestEventAt: row.latestEventAt,
    model: row.model,
  };
}

function createSnapshotHash(event: NormalizedSessionContextEvent): string {
  return hashStable({
    bridgeTurnId: event.bridgeTurnId ?? null,
    attribution: event.attribution,
    model: event.model ?? null,
    contextWindow: event.contextWindow ?? null,
    tokensUsed: event.tokensUsed ?? null,
    tokensRemaining: event.tokensRemaining ?? null,
    usageRatio: normalizeUsageRatio(event.usageRatio ?? null),
    modelUsage: event.modelUsage ?? null,
    provenance: event.provenance ?? null,
  });
}

function createDedupeKey(event: NormalizedSessionContextEvent, snapshotHash?: string): string {
  if (event.dedupeKey) return event.dedupeKey;
  if (event.providerEventId) return `provider:${event.provider}:${event.providerEventId}`;
  if (event.type === "context_snapshot" && snapshotHash) {
    return `snapshot:${event.bridgeTurnId ?? "session"}:${snapshotHash}`;
  }
  return `${event.type}:${event.occurredAt}:${hashStable({
    bridgeTurnId: event.bridgeTurnId ?? null,
    providerTurnId: event.providerTurnId ?? null,
    model: event.model ?? null,
    metadata: event.metadata ?? null,
    modelUsage: event.modelUsage ?? null,
  })}`;
}

export function createSessionContextStore(db: DatabaseSync) {
  const selectSummary = db.prepare("SELECT * FROM session_context_summary WHERE sessionId = ?");
  const upsertSummary = db.prepare(`
    INSERT INTO session_context_summary (
      sessionId, provider, providerSessionId, updatedAt, currentModel, latestBridgeTurnId, latestSnapshotAt,
      contextWindow, tokensUsed, tokensRemaining, usageRatio, modelUsageJson, provenanceJson,
      contextWindowCapability, modelUsageCapability, snapshotCount, compactionCount, truncationCount,
      shutdownCount, lastSnapshotHash
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sessionId) DO UPDATE SET
      provider = excluded.provider,
      providerSessionId = excluded.providerSessionId,
      updatedAt = excluded.updatedAt,
      currentModel = excluded.currentModel,
      latestBridgeTurnId = excluded.latestBridgeTurnId,
      latestSnapshotAt = excluded.latestSnapshotAt,
      contextWindow = excluded.contextWindow,
      tokensUsed = excluded.tokensUsed,
      tokensRemaining = excluded.tokensRemaining,
      usageRatio = excluded.usageRatio,
      modelUsageJson = excluded.modelUsageJson,
      provenanceJson = excluded.provenanceJson,
      contextWindowCapability = excluded.contextWindowCapability,
      modelUsageCapability = excluded.modelUsageCapability,
      snapshotCount = excluded.snapshotCount,
      compactionCount = excluded.compactionCount,
      truncationCount = excluded.truncationCount,
      shutdownCount = excluded.shutdownCount,
      lastSnapshotHash = excluded.lastSnapshotHash
  `);
  const insertEvent = db.prepare(`
    INSERT OR IGNORE INTO session_context_events (
      sessionId, provider, providerSessionId, providerEventId, providerTurnId, bridgeTurnId,
      attribution, type, occurredAt, model, contextWindow, tokensUsed, tokensRemaining, usageRatio,
      modelUsageJson, provenanceJson, metadataJson, dedupeKey, snapshotHash, contextWindowCapability,
      modelUsageCapability, createdAt
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const upsertTurnStart = db.prepare(`
    INSERT INTO session_context_turns (
      sessionId, bridgeTurnId, provider, providerSessionId, providerTurnId, attribution,
      startedAt, endedAt, latestEventAt, model, createdAt, updatedAt
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
    ON CONFLICT(sessionId, bridgeTurnId) DO UPDATE SET
      provider = excluded.provider,
      providerSessionId = COALESCE(excluded.providerSessionId, session_context_turns.providerSessionId),
      providerTurnId = COALESCE(excluded.providerTurnId, session_context_turns.providerTurnId),
      attribution = excluded.attribution,
      startedAt = COALESCE(session_context_turns.startedAt, excluded.startedAt),
      latestEventAt = excluded.latestEventAt,
      model = COALESCE(excluded.model, session_context_turns.model),
      updatedAt = excluded.updatedAt
  `);
  const updateTurnEnd = db.prepare(`
    UPDATE session_context_turns
    SET endedAt = COALESCE(?, endedAt),
      latestEventAt = COALESCE(?, latestEventAt),
      model = COALESCE(?, model),
      updatedAt = ?
    WHERE sessionId = ? AND bridgeTurnId = ?
  `);
  const updateTurnLatest = db.prepare(`
    UPDATE session_context_turns
    SET latestEventAt = ?, model = COALESCE(?, model), updatedAt = ?
    WHERE sessionId = ? AND bridgeTurnId = ?
  `);
  const selectEvents = db.prepare(`
    SELECT *
    FROM (
      SELECT *
      FROM session_context_events
      WHERE sessionId = ?
      ORDER BY occurredAt DESC, id DESC
      LIMIT ?
    )
    ORDER BY occurredAt ASC, id ASC
  `);
  const selectTurns = db.prepare(`
    SELECT *
    FROM (
      SELECT *
      FROM session_context_turns
      WHERE sessionId = ?
      ORDER BY COALESCE(startedAt, latestEventAt, updatedAt) DESC, bridgeTurnId DESC
      LIMIT ?
    )
    ORDER BY COALESCE(startedAt, latestEventAt, updatedAt) ASC, bridgeTurnId ASC
  `);
  const selectBackfill = db.prepare("SELECT * FROM session_context_backfills WHERE sessionId = ?");
  const upsertBackfill = db.prepare(`
    INSERT INTO session_context_backfills (sessionId, provider, providerSessionId, eventsPath, fileSize, mtimeMs, backfilledAt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sessionId) DO UPDATE SET
      provider = excluded.provider,
      providerSessionId = excluded.providerSessionId,
      eventsPath = excluded.eventsPath,
      fileSize = excluded.fileSize,
      mtimeMs = excluded.mtimeMs,
      backfilledAt = excluded.backfilledAt
  `);

  function getSummaryInternal(sessionId: string) {
    return hydrateSummary(selectSummary.get(sessionId) as SummaryRow | undefined);
  }

  function shouldSkipBackfillForProvider(sessionId: string, provider: string): boolean {
    const current = getSummaryInternal(sessionId);
    return current !== null && current.provider !== provider;
  }

  function writeSummary(summary: HydratedSummary | null): SessionContextSummary | null {
    if (!summary) return null;
    upsertSummary.run(
      summary.sessionId,
      summary.provider,
      summary.providerSessionId,
      summary.updatedAt,
      summary.currentModel,
      summary.latestBridgeTurnId,
      summary.latestSnapshotAt,
      summary.contextWindow,
      summary.tokensUsed,
      summary.tokensRemaining,
      summary.usageRatio,
      encodeJson(summary.modelUsage),
      encodeJson(summary.provenance),
      summary.contextWindowCapability,
      summary.modelUsageCapability,
      summary.snapshotCount,
      summary.compactionCount,
      summary.truncationCount,
      summary.shutdownCount,
      summary.lastSnapshotHash,
    );
    return publicSummary(summary);
  }

  function createInitialSummary(event: NormalizedSessionContextEvent): HydratedSummary {
    return {
      sessionId: event.sessionId,
      provider: normalizeProvider(event.provider),
      providerSessionId: event.providerSessionId ?? null,
      updatedAt: event.occurredAt,
      currentModel: null,
      latestBridgeTurnId: null,
      latestSnapshotAt: null,
      contextWindow: null,
      tokensUsed: null,
      tokensRemaining: null,
      usageRatio: null,
      modelUsage: null,
      provenance: null,
      snapshotCount: 0,
      compactionCount: 0,
      truncationCount: 0,
      shutdownCount: 0,
      contextWindowCapability: "unavailable",
      modelUsageCapability: "unavailable",
      lastSnapshotHash: null,
    };
  }

  function mergeSummary(
    current: HydratedSummary | null,
    event: NormalizedSessionContextEvent,
    snapshotHash: string | null,
  ): HydratedSummary {
    const summary = current ?? createInitialSummary(event);
    const isSnapshot = event.type === "context_snapshot";
    return {
      ...summary,
      provider: normalizeProvider(event.provider),
      providerSessionId: event.providerSessionId ?? summary.providerSessionId,
      updatedAt: event.occurredAt,
      currentModel: event.model ?? summary.currentModel,
      latestBridgeTurnId: event.bridgeTurnId ?? summary.latestBridgeTurnId,
      latestSnapshotAt: isSnapshot ? event.occurredAt : summary.latestSnapshotAt,
      contextWindow: event.contextWindow ?? summary.contextWindow,
      tokensUsed: event.tokensUsed ?? summary.tokensUsed,
      tokensRemaining: event.tokensRemaining ?? summary.tokensRemaining,
      usageRatio: normalizeUsageRatio(event.usageRatio ?? summary.usageRatio),
      modelUsage: selectLatestTokenUsage(summary.modelUsage, event.modelUsage),
      provenance: mergeProvenance(summary.provenance, event.provenance),
      snapshotCount: summary.snapshotCount + (isSnapshot ? 1 : 0),
      compactionCount: summary.compactionCount + (event.type === "compaction" ? 1 : 0),
      truncationCount: summary.truncationCount + (event.type === "truncation" ? 1 : 0),
      shutdownCount: summary.shutdownCount + (event.type === "shutdown" ? 1 : 0),
      contextWindowCapability: mergeCapability(summary.contextWindowCapability, event.contextWindowCapability),
      modelUsageCapability: mergeCapability(summary.modelUsageCapability, event.modelUsageCapability),
      lastSnapshotHash: snapshotHash ?? summary.lastSnapshotHash,
    };
  }

  function recordTurnStart(input: RecordSessionContextTurnStart): void {
    const at = input.startedAt ?? nowIso();
    const provider = normalizeProvider(input.provider);
    upsertTurnStart.run(
      input.sessionId,
      input.bridgeTurnId,
      provider,
      input.providerSessionId ?? null,
      input.providerTurnId ?? null,
      input.attribution ?? "turn",
      at,
      at,
      input.model ?? null,
      at,
      at,
    );
  }

  function recordTurnEnd(input: RecordSessionContextTurnEnd): void {
    const at = input.endedAt ?? nowIso();
    updateTurnEnd.run(at, at, input.model ?? null, at, input.sessionId, input.bridgeTurnId);
  }

  function touchTurnFromEvent(event: NormalizedSessionContextEvent): void {
    if (!event.bridgeTurnId || event.attribution === "session_overhead") return;
    recordTurnStart({
      sessionId: event.sessionId,
      provider: event.provider,
      providerSessionId: event.providerSessionId,
      providerTurnId: event.providerTurnId,
      bridgeTurnId: event.bridgeTurnId,
      attribution: event.attribution,
      startedAt: event.occurredAt,
      model: event.model,
    });
    updateTurnLatest.run(event.occurredAt, event.model ?? null, event.occurredAt, event.sessionId, event.bridgeTurnId);
  }

  function recordContextEvent(event: NormalizedSessionContextEvent): SessionContextSummary | null {
    const provider = normalizeProvider(event.provider);
    const normalizedEvent: NormalizedSessionContextEvent = {
      ...event,
      provider,
      providerSessionId: event.providerSessionId ?? null,
      bridgeTurnId: event.bridgeTurnId ?? null,
      providerEventId: event.providerEventId ?? null,
      providerTurnId: event.providerTurnId ?? null,
      model: event.model ?? null,
      contextWindow: event.contextWindow ?? null,
      tokensUsed: event.tokensUsed ?? null,
      tokensRemaining: event.tokensRemaining ?? null,
      usageRatio: normalizeUsageRatio(event.usageRatio ?? null),
      modelUsage: event.modelUsage ?? null,
      provenance: event.provenance ?? null,
      contextWindowCapability: event.contextWindowCapability ?? "unavailable",
      modelUsageCapability: event.modelUsageCapability ?? "unavailable",
      metadata: event.metadata ?? null,
    };
    const snapshotHash = normalizedEvent.type === "context_snapshot"
      ? createSnapshotHash(normalizedEvent)
      : null;
    const current = getSummaryInternal(normalizedEvent.sessionId);
    if (snapshotHash && current?.lastSnapshotHash === snapshotHash) return null;

    const dedupeKey = createDedupeKey(normalizedEvent, snapshotHash ?? undefined);
    const result = insertEvent.run(
      normalizedEvent.sessionId,
      provider,
      normalizedEvent.providerSessionId ?? null,
      normalizedEvent.providerEventId ?? null,
      normalizedEvent.providerTurnId ?? null,
      normalizedEvent.bridgeTurnId ?? null,
      normalizedEvent.attribution,
      normalizedEvent.type,
      normalizedEvent.occurredAt,
      normalizedEvent.model ?? null,
      normalizedEvent.contextWindow ?? null,
      normalizedEvent.tokensUsed ?? null,
      normalizedEvent.tokensRemaining ?? null,
      normalizedEvent.usageRatio ?? null,
      encodeJson(normalizedEvent.modelUsage),
      encodeJson(normalizedEvent.provenance),
      encodeJson(normalizedEvent.metadata),
      dedupeKey,
      snapshotHash,
      normalizedEvent.contextWindowCapability ?? "unavailable",
      normalizedEvent.modelUsageCapability ?? "unavailable",
      nowIso(),
    ) as { changes?: number };
    if ((result.changes ?? 0) === 0) return null;

    touchTurnFromEvent(normalizedEvent);
    return writeSummary(mergeSummary(current, normalizedEvent, snapshotHash));
  }

  function getSummary(sessionId: string): SessionContextSummary | null {
    return publicSummary(getSummaryInternal(sessionId));
  }

  function getSessionContext(sessionId: string, options: { limit?: number } = {}): SessionContextResponse {
    const limit = clampLimit(options.limit);
    const summaryInternal = getSummaryInternal(sessionId);
    const summary = publicSummary(summaryInternal);
    const provider = summary?.provider ?? "copilot";
    const turns = (selectTurns.all(sessionId, limit) as unknown as TurnRow[]).map(hydrateTurn);
    const events = (selectEvents.all(sessionId, limit) as unknown as EventRow[]).map(hydrateEvent);
    return {
      provider,
      summary,
      turns,
      events,
      capabilities: deriveCapabilities(summaryInternal),
    };
  }

  function backfillSessionContextEvents({
    sessionId,
    provider = "copilot",
    providerSessionId = sessionId,
    events,
  }: BackfillSessionContextEventsOptions): void {
    const normalizedProvider = normalizeProvider(provider);
    if (shouldSkipBackfillForProvider(sessionId, normalizedProvider)) return;
    db.exec("BEGIN");
    try {
      for (const event of events) {
        const normalized = normalizePersistedSessionContextEvent(event, {
          sessionId,
          provider: normalizedProvider,
          providerSessionId,
        });
        if (normalized) recordContextEvent(normalized);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  async function backfillSessionContextFromEventsFile({
    sessionId,
    provider = "copilot",
    providerSessionId = sessionId,
    eventsPath,
  }: BackfillSessionContextOptions): Promise<void> {
    const normalizedProvider = normalizeProvider(provider);
    if (shouldSkipBackfillForProvider(sessionId, normalizedProvider)) return;
    let stats: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stats = await fs.stat(eventsPath);
      if (!stats.isFile()) return;
    } catch {
      return;
    }
    const previous = selectBackfill.get(sessionId) as {
      eventsPath: string;
      fileSize: number;
      mtimeMs: number;
    } | undefined;
    if (
      previous?.eventsPath === eventsPath
      && previous.fileSize === stats.size
      && previous.mtimeMs === stats.mtimeMs
    ) {
      return;
    }

    let raw: string;
    try {
      raw = await fs.readFile(eventsPath, "utf-8");
    } catch {
      return;
    }

    const events: unknown[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed) as unknown);
      } catch {
        continue;
      }
    }
    backfillSessionContextEvents({ sessionId, provider: normalizedProvider, providerSessionId, events });
    upsertBackfill.run(
      sessionId,
      normalizedProvider,
      providerSessionId ?? null,
      eventsPath,
      stats.size,
      stats.mtimeMs,
      nowIso(),
    );
  }

  return {
    recordTurnStart,
    recordTurnEnd,
    recordContextEvent,
    getSummary,
    getSessionContext,
    backfillSessionContextEvents,
    backfillSessionContextFromEventsFile,
  };
}

export type SessionContextStore = ReturnType<typeof createSessionContextStore>;
export { DEFAULT_CONTEXT_EVENT_LIMIT, MAX_CONTEXT_EVENT_LIMIT };
