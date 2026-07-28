// Telemetry store — records performance spans for profiling

import type { DatabaseSync } from "./db.js";

export interface TelemetrySpan {
  id: number;
  name: string;
  sessionId: string | null;
  duration: number;
  metadata: Record<string, unknown> | null;
  source: "server" | "client";
  createdAt: string;
}

export interface RecordableTelemetrySpan {
  name: string;
  sessionId?: string;
  duration: number;
  metadata?: Record<string, unknown>;
  source: "server" | "client";
  ingestKey?: string;
}

export function createTelemetryStore(db: DatabaseSync) {
  const insertSpan = db.prepare(`
      INSERT INTO telemetry_spans (name, sessionId, duration, metadata, source, createdAt)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
  const insertIngestKey = db.prepare(`
      INSERT OR IGNORE INTO telemetry_ingest_keys (id, createdAt)
      VALUES (?, ?)
    `);
  const pruneIngestKeys = db.prepare("DELETE FROM telemetry_ingest_keys WHERE createdAt < ?");

  function recordSpan(span: RecordableTelemetrySpan): void {
    recordSpans([span]);
  }

  function recordSpans(spans: RecordableTelemetrySpan[]): void {
    if (spans.length === 0) return;

    db.exec("BEGIN");
    try {
      for (const span of spans) {
        const createdAt = new Date().toISOString();
        if (span.ingestKey) {
          const result = insertIngestKey.run(span.ingestKey, createdAt) as { changes?: number };
          if ((result.changes ?? 0) === 0) continue;
        }
        insertSpan.run(
          span.name,
          span.sessionId ?? null,
          span.duration,
          span.metadata ? JSON.stringify(span.metadata) : null,
          span.source,
          createdAt,
        );
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  function querySpans(opts: {
    name?: string;
    sessionId?: string;
    source?: "server" | "client";
    limit?: number;
    since?: string;
  } = {}): TelemetrySpan[] {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (opts.name) {
      conditions.push("name = ?");
      params.push(opts.name);
    }
    if (opts.sessionId) {
      conditions.push("sessionId = ?");
      params.push(opts.sessionId);
    }
    if (opts.source) {
      conditions.push("source = ?");
      params.push(opts.source);
    }
    if (opts.since) {
      conditions.push("createdAt >= ?");
      params.push(opts.since);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = opts.limit ?? 200;

    const rows = db.prepare(
      `SELECT * FROM telemetry_spans ${where} ORDER BY createdAt DESC LIMIT ?`,
    ).all(...params, limit) as any[];

    return rows.map(hydrate);
  }

  /** Remove entries older than the given number of days */
  function pruneOldSpans(days: number = 7): number {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const result = db.prepare("DELETE FROM telemetry_spans WHERE createdAt < ?").run(cutoff);
    pruneIngestKeys.run(cutoff);
    return (result as any).changes ?? 0;
  }

  function hydrate(row: any): TelemetrySpan {
    return {
      id: row.id,
      name: row.name,
      sessionId: row.sessionId,
      duration: row.duration,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
      source: row.source,
      createdAt: row.createdAt,
    };
  }

  return { recordSpan, recordSpans, querySpans, pruneOldSpans };
}

export type TelemetryStore = ReturnType<typeof createTelemetryStore>;
