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

export function createTelemetryStore(db: DatabaseSync) {
  function recordSpan(span: {
    name: string;
    sessionId?: string;
    duration: number;
    metadata?: Record<string, unknown>;
    source: "server" | "client";
  }): void {
    db.prepare(`
      INSERT INTO telemetry_spans (name, sessionId, duration, metadata, source, createdAt)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      span.name,
      span.sessionId ?? null,
      span.duration,
      span.metadata ? JSON.stringify(span.metadata) : null,
      span.source,
      new Date().toISOString(),
    );
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

  /** Get aggregate stats grouped by span name */
  function getStats(opts: { since?: string } = {}): Array<{
    name: string;
    count: number;
    avg: number;
    min: number;
    max: number;
    p50: number;
    p95: number;
  }> {
    const since = opts.since ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const rows = db.prepare(`
      SELECT name, duration FROM telemetry_spans WHERE createdAt >= ? ORDER BY name, duration
    `).all(since) as any[];

    // Group by name
    const groups = new Map<string, number[]>();
    for (const row of rows) {
      const arr = groups.get(row.name) ?? [];
      arr.push(row.duration);
      groups.set(row.name, arr);
    }

    return Array.from(groups.entries()).map(([name, durations]) => {
      durations.sort((a, b) => a - b);
      const count = durations.length;
      const sum = durations.reduce((a, b) => a + b, 0);
      return {
        name,
        count,
        avg: Math.round(sum / count),
        min: durations[0],
        max: durations[count - 1],
        p50: durations[Math.floor(count * 0.5)],
        p95: durations[Math.min(count - 1, Math.floor(count * 0.95))],
      };
    });
  }

  /** Remove entries older than the given number of days */
  function pruneOldSpans(days: number = 7): number {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const result = db.prepare("DELETE FROM telemetry_spans WHERE createdAt < ?").run(cutoff);
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

  return { recordSpan, querySpans, getStats, pruneOldSpans };
}

export type TelemetryStore = ReturnType<typeof createTelemetryStore>;
