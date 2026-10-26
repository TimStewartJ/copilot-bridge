// Persistence for Helm's looks and memory: memory, runs (each with its brief), item states, feedback,
// handled items and settings. Helm-authored memory may be replaced by later runs; user-authored
// memory is only ever changed by the user.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "../../db.js";
import {
  HELM_THINKER_DEFAULTS,
  type HelmBridgeStatus,
  type HelmBrief,
  type HelmHandledView,
  type HelmItemState,
  type HelmItemStatus,
  type HelmMemoryAuthor,
  type HelmMemoryChange,
  type HelmMemoryEntry,
  type HelmMemoryKind,
  type HelmMemoryStatus,
  type HelmRunStatus,
  type HelmRunTrigger,
  type HelmRunView,
  type HelmThinkerSettings,
} from "../../../shared/helm-thinker.js";

export interface HelmRunRecord extends Omit<HelmRunView, "transcriptAvailable"> {
  contextJson: string | null;
  briefJson: string | null;
  changesJson: string | null;
  sessionDeleted: boolean;
}

export interface HelmFeedbackRecord {
  id: string;
  runId: string;
  itemId: string;
  kind: string;
  note: string | null;
  itemTitle: string | null;
  at: string;
}

export interface HelmHandledRecord extends HelmHandledView {
  runId: string;
  previousReadAt: string | null;
  readThrough: string | null;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function hydrateMemory(row: any): HelmMemoryEntry {
  return {
    id: row.id, kind: row.kind, key: row.key ?? null, text: row.text, source: row.source ?? null,
    author: row.author, status: row.status, createdAt: row.createdAt, updatedAt: row.updatedAt,
    confirmedAt: row.confirmedAt, uses: Number(row.uses) || 0,
  };
}

function hydrateRun(row: any): HelmRunRecord {
  return {
    id: row.id, sessionId: row.sessionId, trigger: row.trigger,
    rebuild: Number(row.rebuild) === 1, status: row.status, startedAt: row.startedAt, finishedAt: row.finishedAt ?? null,
    error: row.error ?? null, model: row.model ?? null, effort: row.effort ?? null,
    credits: typeof row.credits === "number" ? row.credits : null,
    changeCount: typeof row.changeCount === "number" ? row.changeCount : null,
    bridges: parseJson<HelmBridgeStatus[]>(row.bridgesJson, []),
    contextJson: row.contextJson ?? null, briefJson: row.briefJson ?? null, changesJson: row.changesJson ?? null,
    sessionDeleted: Number(row.sessionDeleted) === 1,
  };
}

export function toRunView(run: HelmRunRecord): HelmRunView {
  const { contextJson: _c, briefJson: _b, changesJson: _ch, sessionDeleted, ...view } = run;
  return { ...view, transcriptAvailable: !sessionDeleted };
}

function hydrateHandled(row: any): HelmHandledRecord {
  return {
    id: row.id, runId: row.runId, kind: row.kind, bridge: row.bridge, sessionId: row.sessionId, title: row.title,
    why: row.why, at: row.at, undoneAt: row.undoneAt ?? null, previousReadAt: row.previousReadAt ?? null,
    readThrough: row.readThrough ?? null,
  };
}

export function createHelmThinkerStore(db: DatabaseSync, now: () => Date = () => new Date()) {
  let runSessionIds: Set<string> | undefined;
  const iso = () => now().toISOString();

  function runIds(): Set<string> {
    runSessionIds ??= new Set((db.prepare("SELECT sessionId FROM helm_runs").all() as Array<{ sessionId: string }>).map((row) => row.sessionId));
    return runSessionIds;
  }

  // ── Settings ──────────────────────────────────────────────

  function getSettings(): HelmThinkerSettings {
    const row = db.prepare("SELECT value FROM helm_kv WHERE key = 'settings'").get() as { value: string } | undefined;
    return { ...HELM_THINKER_DEFAULTS, ...parseJson<Partial<HelmThinkerSettings>>(row?.value, {}) };
  }

  function updateSettings(patch: Partial<HelmThinkerSettings>): HelmThinkerSettings {
    const next = { ...getSettings(), ...patch };
    db.prepare("INSERT INTO helm_kv (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(next));
    return next;
  }

  // ── Memory ────────────────────────────────────────────────

  function listMemory(options: { includeForgotten?: boolean } = {}): HelmMemoryEntry[] {
    const rows = db.prepare(
      `SELECT * FROM helm_memory ${options.includeForgotten ? "" : "WHERE status != 'forgotten'"} ORDER BY kind, createdAt`,
    ).all();
    return rows.map(hydrateMemory);
  }

  function getMemory(id: string): HelmMemoryEntry | undefined {
    const row = db.prepare("SELECT * FROM helm_memory WHERE id = ?").get(id);
    return row ? hydrateMemory(row) : undefined;
  }

  function findByKey(kind: HelmMemoryKind, key: string): HelmMemoryEntry | undefined {
    const row = db.prepare("SELECT * FROM helm_memory WHERE kind = ? AND key = ? AND status != 'forgotten'").get(kind, key);
    return row ? hydrateMemory(row) : undefined;
  }

  function countActive(kind: HelmMemoryKind): number {
    const row = db.prepare("SELECT COUNT(*) AS n FROM helm_memory WHERE kind = ? AND status != 'forgotten'").get(kind) as { n: number };
    return Number(row.n) || 0;
  }

  function addMemory(entry: { kind: HelmMemoryKind; key?: string | null; text: string; source?: string | null; author: HelmMemoryAuthor; status: HelmMemoryStatus }): HelmMemoryEntry {
    const at = iso();
    const id = randomUUID();
    db.prepare(
      `INSERT INTO helm_memory (id, kind, key, text, source, author, status, createdAt, updatedAt, confirmedAt, uses)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    ).run(id, entry.kind, entry.key ?? null, entry.text, entry.source ?? null, entry.author, entry.status, at, at, at);
    return getMemory(id)!;
  }

  function updateMemory(id: string, patch: { text?: string; source?: string | null; status?: HelmMemoryStatus; author?: HelmMemoryAuthor; confirm?: boolean }): HelmMemoryEntry | undefined {
    const current = getMemory(id);
    if (!current) return undefined;
    const at = iso();
    db.prepare(
      `UPDATE helm_memory SET text = ?, source = ?, status = ?, author = ?, updatedAt = ?, confirmedAt = ? WHERE id = ?`,
    ).run(
      patch.text ?? current.text,
      patch.source === undefined ? current.source : patch.source,
      patch.status ?? current.status,
      patch.author ?? current.author,
      patch.text !== undefined || patch.status !== undefined ? at : current.updatedAt,
      patch.confirm || patch.text !== undefined || patch.author === "user" ? at : current.confirmedAt,
      id,
    );
    return getMemory(id);
  }

  function noteUse(ids: readonly string[]): void {
    if (ids.length === 0) return;
    db.prepare("UPDATE helm_memory SET uses = uses + 1 WHERE id IN (SELECT value FROM json_each(?))").run(JSON.stringify(ids));
  }

  // ── Runs ──────────────────────────────────────────────────

  function createRun(run: { sessionId: string; trigger: HelmRunTrigger; rebuild: boolean; model: string | null; effort: string | null }): HelmRunRecord {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO helm_runs (id, sessionId, trigger, rebuild, status, startedAt, model, effort)
       VALUES (?, ?, ?, ?, 'running', ?, ?, ?)`,
    ).run(id, run.sessionId, run.trigger, run.rebuild ? 1 : 0, iso(), run.model, run.effort);
    runIds().add(run.sessionId);
    return getRun(id)!;
  }

  function getRun(id: string): HelmRunRecord | undefined {
    const row = db.prepare("SELECT * FROM helm_runs WHERE id = ?").get(id);
    return row ? hydrateRun(row) : undefined;
  }

  function getRunBySession(sessionId: string): HelmRunRecord | undefined {
    const row = db.prepare("SELECT * FROM helm_runs WHERE sessionId = ?").get(sessionId);
    return row ? hydrateRun(row) : undefined;
  }

  function isRunSession(sessionId: string | undefined | null): boolean {
    return typeof sessionId === "string" && runIds().has(sessionId);
  }

  function listRuns(limit = 20): HelmRunRecord[] {
    return db.prepare("SELECT * FROM helm_runs ORDER BY startedAt DESC LIMIT ?").all(limit).map(hydrateRun);
  }

  function latestRun(status?: HelmRunStatus): HelmRunRecord | undefined {
    const row = status
      ? db.prepare("SELECT * FROM helm_runs WHERE status = ? ORDER BY startedAt DESC LIMIT 1").get(status)
      : db.prepare("SELECT * FROM helm_runs ORDER BY startedAt DESC LIMIT 1").get();
    return row ? hydrateRun(row) : undefined;
  }

  function setRunContext(id: string, context: { contextJson: string; changeCount: number; bridges: HelmBridgeStatus[] }): void {
    db.prepare("UPDATE helm_runs SET contextJson = ?, changeCount = ?, bridgesJson = ? WHERE id = ? AND status = 'running'")
      .run(context.contextJson, context.changeCount, JSON.stringify(context.bridges), id);
  }

  /** Records a publication. Only a running, not yet published run accepts one. */
  function publishRun(id: string, brief: HelmBrief, changes: HelmMemoryChange[]): boolean {
    const result = db.prepare(
      "UPDATE helm_runs SET briefJson = ?, changesJson = ? WHERE id = ? AND status = 'running' AND briefJson IS NULL",
    ).run(JSON.stringify(brief), JSON.stringify(changes), id);
    return Number(result.changes) === 1;
  }

  function finishRun(id: string, outcome: { status: Exclude<HelmRunStatus, "running">; error?: string | null; credits?: number | null }): void {
    db.prepare("UPDATE helm_runs SET status = ?, error = ?, credits = COALESCE(?, credits), finishedAt = ? WHERE id = ? AND status = 'running'")
      .run(outcome.status, outcome.error ?? null, outcome.credits ?? null, iso(), id);
  }

  function setRunCredits(id: string, credits: number): void {
    db.prepare("UPDATE helm_runs SET credits = ? WHERE id = ?").run(credits, id);
  }

  /** Runs left `running` by a stopped server can never finish. */
  function failInterruptedRuns(reason: string): number {
    const result = db.prepare("UPDATE helm_runs SET status = 'failed', error = ?, finishedAt = ? WHERE status = 'running'").run(reason, iso());
    return Number(result.changes) || 0;
  }

  function markSessionDeleted(id: string): void {
    db.prepare("UPDATE helm_runs SET sessionDeleted = 1 WHERE id = ?").run(id);
  }

  function pruneRuns(olderThan: string): void {
    const doomed = db.prepare("SELECT id, sessionId FROM helm_runs WHERE startedAt < ? AND status != 'running' AND sessionDeleted = 1").all(olderThan) as Array<{ id: string; sessionId: string }>;
    if (doomed.length === 0) return;
    const ids = JSON.stringify(doomed.map((row) => row.id));
    db.prepare("DELETE FROM helm_item_state WHERE runId IN (SELECT value FROM json_each(?))").run(ids);
    db.prepare("DELETE FROM helm_handled WHERE runId IN (SELECT value FROM json_each(?))").run(ids);
    db.prepare("DELETE FROM helm_feedback WHERE runId IN (SELECT value FROM json_each(?))").run(ids);
    db.prepare("DELETE FROM helm_runs WHERE id IN (SELECT value FROM json_each(?))").run(ids);
    for (const row of doomed) runIds().delete(row.sessionId);
  }

  // ── Items, feedback, handled ─────────────────────────────

  function setItemState(runId: string, itemId: string, status: HelmItemStatus, outcome: string | null): HelmItemState {
    const at = iso();
    db.prepare(
      `INSERT INTO helm_item_state (runId, itemId, status, outcome, updatedAt) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(runId, itemId) DO UPDATE SET status = excluded.status, outcome = excluded.outcome, updatedAt = excluded.updatedAt`,
    ).run(runId, itemId, status, outcome, at);
    return { itemId, status, outcome, updatedAt: at };
  }

  /** Marks an open item as being acted on. False when it was already done, dismissed or in progress. */
  function claimItem(runId: string, itemId: string): boolean {
    const result = db.prepare(
      `INSERT INTO helm_item_state (runId, itemId, status, outcome, updatedAt) VALUES (?, ?, 'pending', NULL, ?)
       ON CONFLICT(runId, itemId) DO UPDATE SET status = 'pending', updatedAt = excluded.updatedAt WHERE helm_item_state.status = 'open'`,
    ).run(runId, itemId, iso());
    return Number(result.changes) === 1;
  }

  function getItemStates(runId: string): Record<string, HelmItemState> {
    const rows = db.prepare("SELECT * FROM helm_item_state WHERE runId = ?").all(runId) as any[];
    return Object.fromEntries(rows.map((row) => [row.itemId, { itemId: row.itemId, status: row.status, outcome: row.outcome ?? null, updatedAt: row.updatedAt }]));
  }

  function addFeedback(feedback: { runId: string; itemId: string; kind: string; note?: string | null; itemTitle?: string | null }): void {
    db.prepare(
      "INSERT INTO helm_feedback (id, runId, itemId, kind, note, itemTitle, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(randomUUID(), feedback.runId, feedback.itemId, feedback.kind, feedback.note ?? null, feedback.itemTitle ?? null, iso());
  }

  function pendingFeedback(): HelmFeedbackRecord[] {
    return (db.prepare("SELECT * FROM helm_feedback WHERE consumedByRun IS NULL ORDER BY at LIMIT 100").all() as any[])
      .map((row) => ({ id: row.id, runId: row.runId, itemId: row.itemId, kind: row.kind, note: row.note ?? null, itemTitle: row.itemTitle ?? null, at: row.at }));
  }

  function consumeFeedback(ids: readonly string[], runId: string): void {
    if (ids.length === 0) return;
    db.prepare("UPDATE helm_feedback SET consumedByRun = ? WHERE id IN (SELECT value FROM json_each(?))").run(runId, JSON.stringify(ids));
  }

  function addHandled(entry: Omit<HelmHandledRecord, "id" | "at" | "undoneAt" | "url">): HelmHandledRecord {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO helm_handled (id, runId, kind, bridge, sessionId, title, why, previousReadAt, readThrough, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, entry.runId, entry.kind, entry.bridge, entry.sessionId, entry.title, entry.why, entry.previousReadAt, entry.readThrough, iso());
    return getHandled(id)!;
  }

  function getHandled(id: string): HelmHandledRecord | undefined {
    const row = db.prepare("SELECT * FROM helm_handled WHERE id = ?").get(id);
    return row ? hydrateHandled(row) : undefined;
  }

  function listHandled(runId: string): HelmHandledRecord[] {
    return (db.prepare("SELECT * FROM helm_handled WHERE runId = ? ORDER BY at").all(runId) as any[]).map(hydrateHandled);
  }

  function markHandledUndone(id: string): void {
    db.prepare("UPDATE helm_handled SET undoneAt = ? WHERE id = ? AND undoneAt IS NULL").run(iso(), id);
  }

  function transaction<T>(work: () => T): T {
    db.exec("BEGIN");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  return {
    getSettings, updateSettings,
    listMemory, getMemory, findByKey, countActive, addMemory, updateMemory, noteUse,
    createRun, getRun, getRunBySession, isRunSession, listRuns, latestRun, setRunContext, publishRun, finishRun,
    setRunCredits, failInterruptedRuns, markSessionDeleted, pruneRuns,
    setItemState, claimItem, getItemStates, addFeedback, pendingFeedback, consumeFeedback,
    addHandled, getHandled, listHandled, markHandledUndone,
    transaction,
  };
}

export type HelmThinkerStore = ReturnType<typeof createHelmThinkerStore>;
