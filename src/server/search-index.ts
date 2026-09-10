import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { readJsonlLines } from "./jsonl-lines.js";
import type {
  BridgeSearchRequest,
  BridgeSearchResponse,
  SearchChatHit,
  SearchDocHit,
  SearchMessageMatch,
  SearchTaskHit,
} from "../shared/search.js";
import type { DatabaseSync } from "./db.js";
import type { DocsIndex } from "./docs-index.js";
import {
  projectSearchableMessage,
  type SearchableMessage,
} from "./search-message-projection.js";
import { createPlainSearchSnippet, parseSearchQuery } from "./search-query.js";
import type { SessionMetaStore } from "./session-meta-store.js";
import type { SessionTitlesStore } from "./session-titles.js";
import type { Task, TaskStore } from "./task-store.js";

const RECONCILE_YIELD_INTERVAL = 8;
const RECONCILE_BATCH_SIZE = 24;
const FOREGROUND_INDEX_BYTE_BUDGET = 16 * 1024 * 1024;
const MESSAGE_INSERT_BATCH_SIZE = 500;
const CANDIDATE_VALIDATION_LIMIT = 100;
const CHAT_MATCHES_PER_SESSION = 5;

interface SearchSession {
  sessionId: string;
  summary?: string;
}

interface SearchIndexDeps {
  copilotHome: string;
  taskStore: TaskStore;
  sessionMetaStore: SessionMetaStore;
  sessionTitles: SessionTitlesStore;
  docsIndex?: DocsIndex;
  listSessions: () => Promise<SearchSession[]>;
  readSessionTitle?: (sessionId: string) => Promise<string | undefined>;
  yieldControl?: () => Promise<void>;
  foregroundByteBudget?: number;
}

interface SourceFingerprint {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  digest: string;
}

interface IndexedSessionRow {
  sessionId: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  digest: string;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && ((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "ENOTDIR");
}

function runTransaction(db: DatabaseSync, operation: () => void): void {
  db.exec("BEGIN");
  try {
    operation();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function resolveSessionTitle(
  session: SearchSession,
  sessionTitles: SessionTitlesStore,
  indexedTitle?: string,
): string {
  return sessionTitles.getTitle(session.sessionId)?.trim()
    || session.summary?.trim()
    || indexedTitle?.trim()
    || "Untitled chat";
}

function taskMap(tasks: readonly Task[]): Map<string, Task> {
  return new Map(tasks.map((task) => [task.id, task]));
}

export function createSearchIndex(db: DatabaseSync, deps: SearchIndexDeps) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_indexed_sessions (
      sessionId TEXT PRIMARY KEY,
      size INTEGER NOT NULL,
      mtimeMs REAL NOT NULL,
      ctimeMs REAL NOT NULL DEFAULT -1,
      digest TEXT NOT NULL,
      indexedAt TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS search_chat_titles USING fts5(
      sessionId UNINDEXED,
      title
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS search_chat_messages USING fts5(
      sessionId UNINDEXED,
      sourceEventId UNINDEXED,
      role UNINDEXED,
      timestamp UNINDEXED,
      content
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS search_tasks USING fts5(
      taskId UNINDEXED,
      title,
      notes
    );
    CREATE TABLE IF NOT EXISTS search_index_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS search_quarantined_sessions (
      sessionId TEXT PRIMARY KEY,
      reason TEXT NOT NULL,
      quarantinedAt TEXT NOT NULL
    );
  `);
  db.exec(`
    CREATE TEMP TABLE IF NOT EXISTS search_pending_messages (
      sourceEventId TEXT NOT NULL,
      role TEXT NOT NULL,
      timestamp TEXT,
      content TEXT NOT NULL
    );
  `);
  const indexedSessionColumns = db.prepare("PRAGMA table_info(search_indexed_sessions)").all() as Array<{ name?: string }>;
  if (!indexedSessionColumns.some((column) => column.name === "ctimeMs")) {
    db.exec("ALTER TABLE search_indexed_sessions ADD COLUMN ctimeMs REAL NOT NULL DEFAULT -1");
  }

  let activeWrite: Promise<string[]> | null = null;
  let pendingSessionIds: string[] = [];
  let sweepErrors: string[] = [];
  let backgroundScheduled = false;
  let sweepSessions: SearchSession[] = [];
  let stopped = false;
  const deferredChangedSessionIds = new Set<string>();

  async function yieldControl(): Promise<void> {
    if (deps.yieldControl) {
      await deps.yieldControl();
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  function insertPendingMessages(messages: readonly SearchableMessage[]): void {
    if (messages.length === 0) return;
    runTransaction(db, () => {
      const insert = db.prepare(`
        INSERT INTO search_pending_messages(sourceEventId, role, timestamp, content)
        VALUES (?, ?, ?, ?)
      `);
      for (const message of messages) {
        insert.run(message.sourceEventId, message.role, message.timestamp ?? null, message.content);
      }
    });
  }

  async function stageStableSession(sessionId: string): Promise<SourceFingerprint | null> {
    const eventsPath = join(deps.copilotHome, "session-state", sessionId, "events.jsonl");
    let before: Awaited<ReturnType<typeof stat>>;
    try {
      before = await stat(eventsPath);
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }

    db.exec("DELETE FROM search_pending_messages");
    const hash = createHash("sha256");
    const pending: SearchableMessage[] = [];
    let lineNumber = 0;
    try {
      for await (const line of readJsonlLines(eventsPath)) {
        if (stopped) throw new Error("Search indexing stopped");
        lineNumber += 1;
        hash.update(line);
        hash.update("\n");
        if (!line.trim()) continue;
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch (error) {
          throw new Error(
            `malformed event JSON at line ${lineNumber}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        const message = projectSearchableMessage(event);
        if (message) pending.push(message);
        if (pending.length >= MESSAGE_INSERT_BATCH_SIZE) {
          insertPendingMessages(pending);
          pending.length = 0;
          await yieldControl();
        }
      }
      insertPendingMessages(pending);
    } catch (error) {
      db.exec("DELETE FROM search_pending_messages");
      throw error;
    }

    const after = await stat(eventsPath);
    if (stopped) throw new Error("Search indexing stopped");
    if (
      before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error("event log changed while it was being indexed");
    }

    return {
      size: after.size,
      mtimeMs: after.mtimeMs,
      ctimeMs: after.ctimeMs,
      digest: hash.digest("hex"),
    };
  }

  function updateSessionTitle(sessionId: string, title: string): void {
    runTransaction(db, () => {
      db.prepare("DELETE FROM search_chat_titles WHERE sessionId = ?").run(sessionId);
      db.prepare("INSERT INTO search_chat_titles(sessionId, title) VALUES (?, ?)").run(sessionId, title);
    });
  }

  function replaceSession(
    session: SearchSession,
    title: string,
    fingerprint: SourceFingerprint | null,
  ): void {
    runTransaction(db, () => {
      db.prepare("DELETE FROM search_chat_titles WHERE sessionId = ?").run(session.sessionId);
      db.prepare("DELETE FROM search_chat_messages WHERE sessionId = ?").run(session.sessionId);
      db.prepare("DELETE FROM search_quarantined_sessions WHERE sessionId = ?").run(session.sessionId);
      db.prepare("INSERT INTO search_chat_titles(sessionId, title) VALUES (?, ?)").run(session.sessionId, title);

      if (fingerprint) {
        db.prepare(`
          INSERT INTO search_chat_messages(sessionId, sourceEventId, role, timestamp, content)
          SELECT ?, sourceEventId, role, timestamp, content
          FROM search_pending_messages
        `).run(session.sessionId);
        db.prepare(`
          INSERT INTO search_indexed_sessions(sessionId, size, mtimeMs, ctimeMs, digest, indexedAt)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(sessionId) DO UPDATE SET
            size=excluded.size,
            mtimeMs=excluded.mtimeMs,
            ctimeMs=excluded.ctimeMs,
            digest=excluded.digest,
            indexedAt=excluded.indexedAt
        `).run(
          session.sessionId,
          fingerprint.size,
          fingerprint.mtimeMs,
          fingerprint.ctimeMs,
          fingerprint.digest,
          new Date().toISOString(),
        );
      } else {
        db.prepare(`
          INSERT INTO search_indexed_sessions(sessionId, size, mtimeMs, ctimeMs, digest, indexedAt)
          VALUES (?, -1, -1, -1, '', ?)
          ON CONFLICT(sessionId) DO UPDATE SET
            size=-1,
            mtimeMs=-1,
            ctimeMs=-1,
            digest='',
            indexedAt=excluded.indexedAt
        `).run(session.sessionId, new Date().toISOString());
      }
      db.exec("DELETE FROM search_pending_messages");
    });
  }

  function readCursor(): string | undefined {
    const row = db.prepare(
      "SELECT value FROM search_index_state WHERE key = 'sessionCursor'",
    ).get() as { value?: string } | undefined;
    return row?.value;
  }

  function writeCursor(sessionId: string): void {
    db.prepare(`
      INSERT INTO search_index_state(key, value) VALUES ('sessionCursor', ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value
    `).run(sessionId);
  }

  function rotateAfterCursor(sessionIds: readonly string[]): string[] {
    const cursor = readCursor();
    if (!cursor) return [...sessionIds];
    const index = sessionIds.indexOf(cursor);
    return index < 0
      ? [...sessionIds]
      : [...sessionIds.slice(index + 1), ...sessionIds.slice(0, index + 1)];
  }

  function reconcileTasks(tasks: readonly Task[]): void {
    runTransaction(db, () => {
      db.exec("DELETE FROM search_tasks");
      const insert = db.prepare("INSERT INTO search_tasks(taskId, title, notes) VALUES (?, ?, ?)");
      for (const task of tasks) insert.run(task.id, task.title, task.notes);
    });
  }

  function prioritizedSessionIds(request?: BridgeSearchRequest): string[] {
    if (request?.scope === "session" && request.sessionId) return [request.sessionId];
    if (request?.scope === "task" && request.taskId) return deps.taskStore.listSessionIdsForTask(request.taskId);
    return [];
  }

  function scheduleBackgroundReconcile(): void {
    if (stopped || backgroundScheduled || activeWrite || pendingSessionIds.length === 0) return;
    backgroundScheduled = true;
    setImmediate(() => {
      backgroundScheduled = false;
      if (stopped) return;
      if (activeWrite || pendingSessionIds.length === 0) {
        scheduleBackgroundReconcile();
        return;
      }
      activeWrite = performReconcileBatch(undefined, false, false).catch((error) => {
        sweepErrors.push(`background reconciliation: ${error instanceof Error ? error.message : String(error)}`);
        return [...sweepErrors];
      });
      void activeWrite.finally(() => {
        activeWrite = null;
        scheduleBackgroundReconcile();
      });
    });
  }

  async function performReconcileBatch(
    request?: BridgeSearchRequest,
    startNewSweep = false,
    foreground = false,
  ): Promise<string[]> {
    let sessions: SearchSession[];
    const reuseSweepCatalog = !startNewSweep && pendingSessionIds.length > 0 && sweepSessions.length > 0;
    if (reuseSweepCatalog) {
      sessions = sweepSessions;
    } else {
      try {
        sessions = await deps.listSessions();
      } catch (error) {
        sweepErrors = [`chat catalog: ${error instanceof Error ? error.message : String(error)}`];
        return sweepErrors;
      }
      if (startNewSweep) sweepSessions = sessions;
    }
    if (stopped) return [...sweepErrors];

    const indexedRows = db.prepare(
      "SELECT sessionId, size, mtimeMs, ctimeMs, digest FROM search_indexed_sessions",
    ).all() as unknown as IndexedSessionRow[];
    const indexed = new Map(indexedRows.map((row) => [row.sessionId, row]));
    const currentIds = new Set(sessions.map((session) => session.sessionId));

    if (!reuseSweepCatalog) {
      runTransaction(db, () => {
        for (const row of indexedRows) {
          if (currentIds.has(row.sessionId)) continue;
          db.prepare("DELETE FROM search_chat_titles WHERE sessionId = ?").run(row.sessionId);
          db.prepare("DELETE FROM search_chat_messages WHERE sessionId = ?").run(row.sessionId);
          db.prepare("DELETE FROM search_indexed_sessions WHERE sessionId = ?").run(row.sessionId);
          db.prepare("DELETE FROM search_quarantined_sessions WHERE sessionId = ?").run(row.sessionId);
        }
      });
    }

    const unindexedIds = sessions
      .filter((session) => !indexed.has(session.sessionId))
      .map((session) => session.sessionId);
    const shouldStartSweep = startNewSweep && pendingSessionIds.length === 0;
    if (shouldStartSweep) {
      sweepErrors = [];
      const priority = prioritizedSessionIds(request);
      pendingSessionIds = [
        ...new Set([
          ...priority,
          ...unindexedIds,
          ...rotateAfterCursor(sessions.map((session) => session.sessionId)),
        ]),
      ];
    } else if (pendingSessionIds.length > 0) {
      const priority = prioritizedSessionIds(request);
      if (priority.length > 0) {
        const prioritySet = new Set(priority);
        pendingSessionIds = [
          ...priority.filter((sessionId) => currentIds.has(sessionId)),
          ...pendingSessionIds.filter((sessionId) => !prioritySet.has(sessionId)),
        ];
      }
    }
    pendingSessionIds = pendingSessionIds.filter((sessionId) => currentIds.has(sessionId));

    const sessionMap = new Map(sessions.map((session) => [session.sessionId, session]));
    const batchIds = pendingSessionIds.splice(0, RECONCILE_BATCH_SIZE);
    let foregroundBytes = 0;
    for (let index = 0; index < batchIds.length; index += 1) {
      if (stopped) break;
      const session = sessionMap.get(batchIds[index]!);
      if (!session) continue;
      try {
        const previous = indexed.get(session.sessionId);
        const titleRow = db.prepare(
          "SELECT title FROM search_chat_titles WHERE sessionId = ? LIMIT 1",
        ).get(session.sessionId) as { title?: string } | undefined;
        const title = deps.sessionTitles.getTitle(session.sessionId)?.trim()
          || (await deps.readSessionTitle?.(session.sessionId))?.trim()
          || session.summary?.trim()
          || titleRow?.title?.trim()
          || "Untitled chat";
        const eventsPath = join(deps.copilotHome, "session-state", session.sessionId, "events.jsonl");
        let currentStat: Awaited<ReturnType<typeof stat>> | null;
        try {
          currentStat = await stat(eventsPath);
        } catch (error) {
          if (!isMissingFile(error)) throw error;
          currentStat = null;
        }

        if (!currentStat && previous?.size === -1) {
          if (titleRow?.title !== title) updateSessionTitle(session.sessionId, title);
          clearQuarantine(session.sessionId);
        } else if (
          currentStat
          && previous?.size === currentStat.size
          && previous.mtimeMs === currentStat.mtimeMs
          && previous.ctimeMs === currentStat.ctimeMs
        ) {
          if (titleRow?.title !== title) updateSessionTitle(session.sessionId, title);
          clearQuarantine(session.sessionId);
        } else {
          if (
            foreground
            && currentStat
            && foregroundBytes + currentStat.size > (deps.foregroundByteBudget ?? FOREGROUND_INDEX_BYTE_BUDGET)
          ) {
            deferredChangedSessionIds.add(session.sessionId);
            const remaining = batchIds.slice(index + 1);
            pendingSessionIds.unshift(...remaining);
            if (request?.scope === "task" || request?.scope === "session") {
              pendingSessionIds.unshift(session.sessionId);
            } else {
              pendingSessionIds.push(session.sessionId);
            }
            break;
          }
          replaceSession(session, title, await stageStableSession(session.sessionId));
          if (currentStat) foregroundBytes += currentStat.size;
          deferredChangedSessionIds.delete(session.sessionId);
        }
      } catch (error) {
        if (stopped) break;
        sweepErrors.push(`chat ${session.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      }
      writeCursor(session.sessionId);
      if ((index + 1) % RECONCILE_YIELD_INTERVAL === 0) await yieldControl();
    }

    if (pendingSessionIds.length === 0) sweepSessions = [];
    scheduleBackgroundReconcile();
    return [...sweepErrors];
  }

  function reconcile(request?: BridgeSearchRequest): Promise<string[]> {
    if (stopped) return Promise.reject(new Error("Search index is shut down"));
    if (activeWrite) {
      const priority = prioritizedSessionIds(request);
      if (priority.length > 0) {
        const prioritySet = new Set(priority);
        pendingSessionIds = [
          ...priority,
          ...pendingSessionIds.filter((sessionId) => !prioritySet.has(sessionId)),
        ];
      }
      return Promise.resolve([...sweepErrors]);
    }
    activeWrite = performReconcileBatch(request, true, true).catch((error) => {
      sweepErrors.push(`foreground reconciliation: ${error instanceof Error ? error.message : String(error)}`);
      return [...sweepErrors];
    });
    return activeWrite.finally(() => {
      activeWrite = null;
      scheduleBackgroundReconcile();
    });
  }

  function quarantineSession(sessionId: string, reason: string): void {
    db.prepare(`
      INSERT INTO search_quarantined_sessions(sessionId, reason, quarantinedAt)
      VALUES (?, ?, ?)
      ON CONFLICT(sessionId) DO UPDATE SET reason=excluded.reason, quarantinedAt=excluded.quarantinedAt
    `).run(sessionId, reason, new Date().toISOString());
    deferredChangedSessionIds.add(sessionId);
    if (!pendingSessionIds.includes(sessionId)) pendingSessionIds.push(sessionId);
  }

  function clearQuarantine(sessionId: string): void {
    db.prepare("DELETE FROM search_quarantined_sessions WHERE sessionId = ?").run(sessionId);
    deferredChangedSessionIds.delete(sessionId);
  }

  async function validateCandidateSessions(sessionIds: readonly string[]): Promise<string[]> {
    const errors: string[] = [];
    const indexedStatement = db.prepare(`
      SELECT size, mtimeMs, ctimeMs
      FROM search_indexed_sessions
      WHERE sessionId = ?
    `);
    for (const sessionId of sessionIds.slice(0, CANDIDATE_VALIDATION_LIMIT)) {
      try {
        const source = await stat(join(deps.copilotHome, "session-state", sessionId, "events.jsonl"));
        // A streaming writer may promote a new projection while stat is pending.
        const indexed = indexedStatement.get(sessionId) as Pick<IndexedSessionRow, "size" | "mtimeMs" | "ctimeMs"> | undefined;
        if (!indexed) continue;
        if (
          indexed.size !== source.size
          || indexed.mtimeMs !== source.mtimeMs
          || indexed.ctimeMs !== source.ctimeMs
        ) {
          quarantineSession(sessionId, "source metadata changed");
        } else {
          clearQuarantine(sessionId);
        }
      } catch (error) {
        const indexed = indexedStatement.get(sessionId) as Pick<IndexedSessionRow, "size" | "mtimeMs" | "ctimeMs"> | undefined;
        if (!indexed) continue;
        if (isMissingFile(error) && indexed.size === -1) continue;
        const reason = isMissingFile(error)
          ? "source event log is missing"
          : `source metadata check failed: ${error instanceof Error ? error.message : String(error)}`;
        quarantineSession(sessionId, reason);
        if (!isMissingFile(error)) errors.push(`chat ${sessionId}: ${reason}`);
      }
    }
    scheduleBackgroundReconcile();
    return errors;
  }

  async function searchChats(
    request: BridgeSearchRequest,
    fts: string,
    keywords: readonly string[],
    sessions: readonly SearchSession[],
    tasks: readonly Task[],
  ): Promise<{ result: { items: SearchChatHit[]; total: number }; errors: string[] }> {
    const allowedSessionIds = request.scope === "session"
      ? [request.sessionId!]
      : request.scope === "task"
        ? deps.taskStore.listSessionIdsForTask(request.taskId!)
        : sessions.map((session) => session.sessionId);
    if (allowedSessionIds.length === 0) return { result: { items: [], total: 0 }, errors: [] };

    const placeholders = allowedSessionIds.map(() => "?").join(", ");
    const params = [fts, ...allowedSessionIds, fts, ...allowedSessionIds];
    const hitsSql = `
      WITH hits AS (
        SELECT sessionId, min(rank) AS score
        FROM search_chat_messages
        WHERE search_chat_messages MATCH ?
          AND sessionId IN (${placeholders})
          AND NOT EXISTS (
            SELECT 1 FROM search_quarantined_sessions quarantined
            WHERE quarantined.sessionId = search_chat_messages.sessionId
          )
        GROUP BY sessionId
        UNION ALL
        SELECT sessionId, min(rank) AS score
        FROM search_chat_titles
        WHERE search_chat_titles MATCH ?
          AND sessionId IN (${placeholders})
          AND NOT EXISTS (
            SELECT 1 FROM search_quarantined_sessions quarantined
            WHERE quarantined.sessionId = search_chat_titles.sessionId
          )
        GROUP BY sessionId
      ),
      grouped AS (
        SELECT sessionId, min(score) AS score FROM hits GROUP BY sessionId
      )
    `;
    const candidateRows = request.scope === "session"
      ? db.prepare(`
          ${hitsSql}
          SELECT sessionId FROM grouped
          ORDER BY score, sessionId
          LIMIT 1
        `).all(...params) as Array<{ sessionId: string }>
      : db.prepare(`
          ${hitsSql}
          SELECT sessionId FROM grouped
          ORDER BY score, sessionId
          LIMIT ? OFFSET ?
        `).all(...params, CANDIDATE_VALIDATION_LIMIT, request.offset!) as Array<{ sessionId: string }>;
    const errors = await validateCandidateSessions(candidateRows.map((row) => row.sessionId));

    const count = db.prepare(`${hitsSql} SELECT count(*) AS total FROM grouped`).get(...params) as { total?: number };
    const validatedIds = new Set(candidateRows.map((row) => row.sessionId));
    const currentRows = request.scope === "session"
      ? db.prepare(`
          ${hitsSql}
          SELECT sessionId FROM grouped
          ORDER BY score, sessionId
          LIMIT 1
        `).all(...params) as Array<{ sessionId: string }>
      : db.prepare(`
          ${hitsSql}
          SELECT sessionId FROM grouped
          ORDER BY score, sessionId
          LIMIT ? OFFSET ?
        `).all(...params, CANDIDATE_VALIDATION_LIMIT, request.offset!) as Array<{ sessionId: string }>;
    const rows = currentRows
      .filter((row) => validatedIds.has(row.sessionId))
      .slice(0, request.scope === "session" ? 1 : request.limit!);

    const sessionMap = new Map(sessions.map((session) => [session.sessionId, session]));
    const tasksById = taskMap(tasks);
    const items = rows.map(({ sessionId }): SearchChatHit => {
      const messageLimit = request.scope === "session" ? request.limit! : CHAT_MATCHES_PER_SESSION;
      const messageOffset = request.scope === "session" ? request.offset! : 0;
      const matches = db.prepare(`
        SELECT sourceEventId, role, timestamp, content
        FROM search_chat_messages
        WHERE search_chat_messages MATCH ? AND sessionId = ?
        ORDER BY rank, rowid
        LIMIT ? OFFSET ?
      `).all(fts, sessionId, messageLimit, messageOffset) as Array<{
        sourceEventId: string;
        role: "user" | "assistant";
        timestamp?: string | null;
        content: string;
      }>;
      const matchCountRow = db.prepare(`
        SELECT count(*) AS total
        FROM search_chat_messages
        WHERE search_chat_messages MATCH ? AND sessionId = ?
      `).get(fts, sessionId) as { total?: number };
      const linkedTask = tasksById.get(
        tasks.find((task) => task.sessionIds.includes(sessionId))?.id ?? "",
      );
      const indexedTitle = db.prepare(
        "SELECT title FROM search_chat_titles WHERE sessionId = ? LIMIT 1",
      ).get(sessionId) as { title?: string } | undefined;
      const title = resolveSessionTitle(
        sessionMap.get(sessionId) ?? { sessionId },
        deps.sessionTitles,
        indexedTitle?.title,
      );
      return {
        sessionId,
        title,
        ...(linkedTask ? { taskId: linkedTask.id, taskTitle: linkedTask.title } : {}),
        archived: deps.sessionMetaStore.isArchived(sessionId),
        matches: matches.map((match): SearchMessageMatch => ({
          sourceEventId: match.sourceEventId,
          role: match.role,
          ...(match.timestamp ? { timestamp: match.timestamp } : {}),
          snippet: createPlainSearchSnippet(match.content, keywords),
        })),
        matchCount: matchCountRow.total ?? 0,
      };
    });
    return {
      result: {
        items,
        total: request.scope === "session" ? Math.min(count.total ?? 0, 1) : count.total ?? 0,
      },
      errors,
    };
  }

  function searchTasks(
    request: BridgeSearchRequest,
    fts: string,
    keywords: readonly string[],
    tasks: readonly Task[],
  ): { items: SearchTaskHit[]; total: number } {
    if (request.scope === "session") return { items: [], total: 0 };
    reconcileTasks(tasks);
    const scopedTaskIds = request.scope === "task" ? [request.taskId!] : tasks.map((task) => task.id);
    if (scopedTaskIds.length === 0) return { items: [], total: 0 };
    const placeholders = scopedTaskIds.map(() => "?").join(", ");
    const params = [fts, ...scopedTaskIds];
    const count = db.prepare(`
      SELECT count(*) AS total FROM search_tasks
      WHERE search_tasks MATCH ? AND taskId IN (${placeholders})
    `).get(...params) as { total?: number };
    const rows = db.prepare(`
      SELECT taskId, title, notes FROM search_tasks
      WHERE search_tasks MATCH ? AND taskId IN (${placeholders})
      ORDER BY rank, taskId
      LIMIT ? OFFSET ?
    `).all(...params, request.limit!, request.offset!) as Array<{ taskId: string; title: string; notes: string }>;
    const tasksById = taskMap(tasks);
    return {
      total: count.total ?? 0,
      items: rows.map((row) => ({
        taskId: row.taskId,
        title: row.title,
        snippet: createPlainSearchSnippet(
          keywords.some((keyword) => row.notes.toLocaleLowerCase().includes(keyword.toLocaleLowerCase()))
            ? row.notes
            : row.title,
          keywords,
        ),
        archived: tasksById.get(row.taskId)?.status === "archived",
      })),
    };
  }

  async function search(request: BridgeSearchRequest): Promise<BridgeSearchResponse> {
    if (stopped) throw new Error("Search index is shut down");
    const errors = [...sweepErrors];
    const indexedBefore = (db.prepare(
      "SELECT count(*) AS total FROM search_indexed_sessions",
    ).get() as { total?: number }).total ?? 0;
    const foregroundAvailable = activeWrite === null;
    const reconciliation = request.refreshOnly ? Promise.resolve([]) : reconcile(request);
    const includesChat = request.kind === "all" || request.kind === "chat";
    if (foregroundAvailable && includesChat && indexedBefore === 0) {
      await reconciliation;
    } else {
      void reconciliation.catch((error) => {
        sweepErrors.push(`search reconciliation: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    const sessions = await deps.listSessions().catch((error) => {
      errors.push(`chat catalog: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    });
    const tasks = deps.taskStore.listTasks();
    const parsed = parseSearchQuery(request.q);

    const chatSearch = request.kind === "task" || request.kind === "doc"
      ? { result: { items: [], total: 0 }, errors: [] }
      : await searchChats(request, parsed.fts, parsed.keywords, sessions, tasks);
    errors.push(...chatSearch.errors);
    let taskResults: { items: SearchTaskHit[]; total: number } = { items: [], total: 0 };
    if (request.kind !== "chat" && request.kind !== "doc") {
      try {
        taskResults = searchTasks(request, parsed.fts, parsed.keywords, deps.taskStore.listTasks());
      } catch (error) {
        errors.push(`tasks: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    let docs: { items: SearchDocHit[]; total: number } = { items: [], total: 0 };
    if (
      request.scope === "global"
      && request.kind !== "chat"
      && request.kind !== "task"
      && deps.docsIndex
    ) {
      try {
        const result = deps.docsIndex.search(request.q, request.limit, request.offset);
        docs = {
          total: result.total,
          items: result.results.map((item) => ({
            path: item.path,
            title: item.title,
            snippet: item.snippet.replace(/<\/?mark>/g, ""),
          })),
        };
      } catch (error) {
        errors.push(`docs: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const indexedSessions = (db.prepare(
      "SELECT count(*) AS total FROM search_indexed_sessions",
    ).get() as { total?: number }).total ?? 0;
    errors.push(...sweepErrors);
    return {
      chats: chatSearch.result,
      tasks: taskResults,
      docs,
      coverage: {
        reconciling: activeWrite !== null || backgroundScheduled || pendingSessionIds.length > 0,
        state: errors.length > 0
          ? "partial"
          : indexedSessions < sessions.length || deferredChangedSessionIds.size > 0
            ? "indexing"
            : "ready",
        indexedSessions,
        totalSessions: sessions.length,
        errors: [...new Set(errors)],
      },
    };
  }

  async function waitForIdle(): Promise<void> {
    while (true) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (activeWrite) await activeWrite;
      if (!activeWrite && !backgroundScheduled && pendingSessionIds.length === 0) return;
    }
  }

  async function shutdown(): Promise<void> {
    stopped = true;
    pendingSessionIds = [];
    await waitForIdle();
  }

  return { search, reconcile, waitForIdle, shutdown };
}

export type SearchIndex = ReturnType<typeof createSearchIndex>;
