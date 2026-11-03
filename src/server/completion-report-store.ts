import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "./db.js";
import {
  isCompletionStatus,
  type CompletionEvidence,
  type CompletionReport,
} from "../shared/completion-report.js";

export const MAX_COMPLETION_REPORT_LIST_LIMIT = 20;

function parseList<T>(json: unknown): T[] {
  if (typeof json !== "string") return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function hydrate(row: any): CompletionReport {
  return {
    id: String(row.id),
    sessionId: String(row.sessionId),
    ...(row.taskId ? { taskId: String(row.taskId) } : {}),
    ...(row.playbook ? { playbook: String(row.playbook) } : {}),
    ...(row.playbookLabel ? { playbookLabel: String(row.playbookLabel) } : {}),
    status: isCompletionStatus(row.status) ? row.status : "partial",
    summary: String(row.summary),
    evidence: parseList<CompletionEvidence>(row.evidenceJson),
    unverified: parseList<string>(row.unverifiedJson),
    notes: parseList<string>(row.notesJson),
    createdAt: String(row.createdAt),
  };
}

/** The evidence reports `verify_complete` recorded, per chat and per task. */
export function createCompletionReportStore(db: DatabaseSync) {
  function add(report: Omit<CompletionReport, "id" | "createdAt" | "notes"> & { createdAt?: string; notes?: string[] }): CompletionReport {
    const id = randomUUID();
    const createdAt = report.createdAt ?? new Date().toISOString();
    db.prepare(`
      INSERT INTO completion_reports
        (id, sessionId, taskId, playbook, playbookLabel, status, summary, evidenceJson, unverifiedJson, notesJson, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, report.sessionId, report.taskId ?? null, report.playbook ?? null, report.playbookLabel ?? null,
      report.status, report.summary, JSON.stringify(report.evidence), JSON.stringify(report.unverified), JSON.stringify(report.notes ?? []), createdAt,
    );
    return hydrate(db.prepare("SELECT * FROM completion_reports WHERE id = ?").get(id));
  }

  function clampLimit(limit: number | undefined): number {
    return Math.max(1, Math.min(limit ?? MAX_COMPLETION_REPORT_LIST_LIMIT, MAX_COMPLETION_REPORT_LIST_LIMIT));
  }

  /** Newest first. */
  function listForSession(sessionId: string, limit?: number): CompletionReport[] {
    return (db.prepare(`
      SELECT * FROM completion_reports WHERE sessionId = ? ORDER BY createdAt DESC, rowid DESC LIMIT ?
    `).all(sessionId, clampLimit(limit)) as any[]).map(hydrate);
  }

  /** Newest first. */
  function listForTask(taskId: string, limit?: number): CompletionReport[] {
    return (db.prepare(`
      SELECT * FROM completion_reports WHERE taskId = ? ORDER BY createdAt DESC, rowid DESC LIMIT ?
    `).all(taskId, clampLimit(limit)) as any[]).map(hydrate);
  }

  return { add, listForSession, listForTask };
}

export type CompletionReportStore = ReturnType<typeof createCompletionReportStore>;
