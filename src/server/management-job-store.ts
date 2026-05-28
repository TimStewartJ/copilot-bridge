import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, openSync, readSync, statSync, closeSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "./db.js";

export const MANAGEMENT_JOB_TYPES = ["self_update", "staging_preview", "staging_deploy"] as const;
export const MANAGEMENT_JOB_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;

export type ManagementJobType = typeof MANAGEMENT_JOB_TYPES[number];
export type ManagementJobStatus = typeof MANAGEMENT_JOB_STATUSES[number];

export interface ManagementJob {
  id: string;
  type: ManagementJobType;
  status: ManagementJobStatus;
  input: unknown;
  result?: unknown;
  error?: string;
  logPath?: string;
  runnerPid?: number;
  heartbeatAt?: string;
  cancelRequestedAt?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface ManagementJobStore {
  enqueue(type: ManagementJobType, input?: unknown): ManagementJob;
  get(id: string): ManagementJob | null;
  list(options?: ManagementJobListOptions): ManagementJob[];
  listActive(types?: readonly ManagementJobType[]): ManagementJob[];
  claimNext(options?: ClaimNextManagementJobOptions): ManagementJob | null;
  heartbeat(id: string, runnerPid?: number): void;
  succeed(id: string, result?: unknown): ManagementJob;
  fail(id: string, error: string, result?: unknown): ManagementJob;
  cancel(id: string, reason?: string): ManagementJob | null;
  readLogTail(jobOrId: ManagementJob | string, maxBytes?: number): string;
}

export interface CreateManagementJobStoreOptions {
  dataDir: string;
  now?: () => Date;
}

export interface ClaimNextManagementJobOptions {
  runnerPid?: number;
  staleAfterMs?: number;
}

export interface ManagementJobListOptions {
  types?: readonly ManagementJobType[];
  statuses?: readonly ManagementJobStatus[];
  limit?: number;
  order?: "created-desc" | "created-asc";
}

interface ManagementJobRow {
  id: string;
  type: string;
  status: string;
  input: string;
  result: string | null;
  error: string | null;
  logPath: string | null;
  runnerPid: number | null;
  heartbeatAt: string | null;
  cancelRequestedAt: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export class ActiveManagementJobError extends Error {
  readonly activeJob: ManagementJob;

  constructor(activeJob: ManagementJob) {
    super(`A ${activeJob.type} management job is already ${activeJob.status}.`);
    this.name = "ActiveManagementJobError";
    this.activeJob = activeJob;
  }
}

const ACTIVE_STATUSES: readonly ManagementJobStatus[] = ["queued", "running"];
const EXCLUSIVE_DEPLOY_TYPES: readonly ManagementJobType[] = ["self_update", "staging_deploy"];
export const DEFAULT_MANAGEMENT_JOB_STALE_AFTER_MS = 5 * 60_000;
export const DEFAULT_MANAGEMENT_JOB_LIST_LIMIT = 50;
export const MAX_MANAGEMENT_JOB_LIST_LIMIT = 200;
const DEFAULT_STALE_AFTER_MS = DEFAULT_MANAGEMENT_JOB_STALE_AFTER_MS;
const DEFAULT_LOG_TAIL_BYTES = 16 * 1024;

function nowIso(now: () => Date): string {
  return now().toISOString();
}

function jsonStringify(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function parseJson(value: string | null): unknown {
  if (value === null) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function optionalText(value: string | null): string | undefined {
  return value ?? undefined;
}

function optionalNumber(value: number | null): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function assertManagementJobType(value: string): ManagementJobType {
  if ((MANAGEMENT_JOB_TYPES as readonly string[]).includes(value)) return value as ManagementJobType;
  throw new Error(`Unknown management job type in database: ${value}`);
}

function assertManagementJobStatus(value: string): ManagementJobStatus {
  if ((MANAGEMENT_JOB_STATUSES as readonly string[]).includes(value)) return value as ManagementJobStatus;
  throw new Error(`Unknown management job status in database: ${value}`);
}

export function isManagementJobType(value: string): value is ManagementJobType {
  return (MANAGEMENT_JOB_TYPES as readonly string[]).includes(value);
}

export function isManagementJobStatus(value: string): value is ManagementJobStatus {
  return (MANAGEMENT_JOB_STATUSES as readonly string[]).includes(value);
}

export function getManagementJobStaleAfterMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.BRIDGE_MANAGEMENT_JOB_STALE_AFTER_MS);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MANAGEMENT_JOB_STALE_AFTER_MS;
}

function rowToJob(row: ManagementJobRow): ManagementJob {
  return {
    id: row.id,
    type: assertManagementJobType(row.type),
    status: assertManagementJobStatus(row.status),
    input: parseJson(row.input) ?? {},
    result: parseJson(row.result),
    error: optionalText(row.error),
    logPath: optionalText(row.logPath),
    runnerPid: optionalNumber(row.runnerPid),
    heartbeatAt: optionalText(row.heartbeatAt),
    cancelRequestedAt: optionalText(row.cancelRequestedAt),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    startedAt: optionalText(row.startedAt),
    completedAt: optionalText(row.completedAt),
  };
}

function runImmediateTransaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original error.
    }
    throw error;
  }
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(", ");
}

function normalizeManagementJobListLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_MANAGEMENT_JOB_LIST_LIMIT;
  return Math.min(MAX_MANAGEMENT_JOB_LIST_LIMIT, Math.max(1, Math.floor(limit)));
}

function validateListTypes(types: readonly ManagementJobType[] | undefined): readonly ManagementJobType[] | undefined {
  if (types === undefined) return undefined;
  for (const type of types) {
    if (!isManagementJobType(type)) throw new Error(`Unsupported management job type: ${String(type)}`);
  }
  return types;
}

function validateListStatuses(statuses: readonly ManagementJobStatus[] | undefined): readonly ManagementJobStatus[] | undefined {
  if (statuses === undefined) return undefined;
  for (const status of statuses) {
    if (!isManagementJobStatus(status)) throw new Error(`Unsupported management job status: ${String(status)}`);
  }
  return statuses;
}

function findActiveExclusiveJob(db: DatabaseSync): ManagementJob | null {
  const row = db.prepare(`
    SELECT *
    FROM management_jobs
    WHERE type IN (${placeholders(EXCLUSIVE_DEPLOY_TYPES)})
      AND status IN (${placeholders(ACTIVE_STATUSES)})
    ORDER BY createdAt ASC
    LIMIT 1
  `).get(...EXCLUSIVE_DEPLOY_TYPES, ...ACTIVE_STATUSES) as ManagementJobRow | undefined;
  return row ? rowToJob(row) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedPreviewTarget(input: unknown): { stagingDir: string; profile: string } {
  const record = isRecord(input) ? input : {};
  return {
    stagingDir: String(record.stagingDir ?? ""),
    profile: String(record.profile ?? "clone"),
  };
}

function findActivePreviewJob(db: DatabaseSync, input: unknown): ManagementJob | null {
  const target = normalizedPreviewTarget(input);
  if (!target.stagingDir) return null;
  const rows = db.prepare(`
    SELECT *
    FROM management_jobs
    WHERE type = 'staging_preview'
      AND status IN (${placeholders(ACTIVE_STATUSES)})
    ORDER BY createdAt ASC
  `).all(...ACTIVE_STATUSES) as unknown as ManagementJobRow[];
  const active = rows
    .map(rowToJob)
    .find((job) => {
      const activeTarget = normalizedPreviewTarget(job.input);
      return activeTarget.stagingDir === target.stagingDir
        && activeTarget.profile === target.profile;
    });
  return active ?? null;
}

function getJobRow(db: DatabaseSync, id: string): ManagementJobRow | undefined {
  return db.prepare("SELECT * FROM management_jobs WHERE id = ?").get(id) as ManagementJobRow | undefined;
}

function createLogPath(dataDir: string, id: string): string {
  return join(dataDir, "management-jobs", "logs", `${id}.log`);
}

function readFileTail(path: string, maxBytes: number): string {
  if (!existsSync(path)) return "";
  let fd: number | undefined;
  try {
    const stat = statSync(path);
    const bytesToRead = Math.min(maxBytes, stat.size);
    const start = Math.max(0, stat.size - bytesToRead);
    const buffer = Buffer.alloc(bytesToRead);
    fd = openSync(path, "r");
    readSync(fd, buffer, 0, bytesToRead, start);
    return buffer.toString("utf-8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close errors while reading a best-effort tail.
      }
    }
  }
}

export function sanitizeManagementJobLogTail(value: string): string {
  return value
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "�");
}

export function createManagementJobStore(
  db: DatabaseSync,
  options: CreateManagementJobStoreOptions,
): ManagementJobStore {
  const now = options.now ?? (() => new Date());
  const logDir = join(options.dataDir, "management-jobs", "logs");

  const store: ManagementJobStore = {
    enqueue(type, input = {}) {
      return runImmediateTransaction(db, () => {
        if (EXCLUSIVE_DEPLOY_TYPES.includes(type)) {
          const active = findActiveExclusiveJob(db);
          if (active) throw new ActiveManagementJobError(active);
        } else if (type === "staging_preview") {
          const active = findActivePreviewJob(db, input);
          if (active) throw new ActiveManagementJobError(active);
        }

        const id = randomUUID();
        const timestamp = nowIso(now);
        const logPath = createLogPath(options.dataDir, id);
        mkdirSync(logDir, { recursive: true });
        db.prepare(`
          INSERT INTO management_jobs (
            id, type, status, input, logPath, createdAt, updatedAt
          )
          VALUES (?, ?, 'queued', ?, ?, ?, ?)
        `).run(id, type, jsonStringify(input), logPath, timestamp, timestamp);
        const row = getJobRow(db, id);
        if (!row) throw new Error(`Failed to read enqueued management job ${id}`);
        return rowToJob(row);
      });
    },

    get(id) {
      const row = getJobRow(db, id);
      return row ? rowToJob(row) : null;
    },

    list(options = {}) {
      const types = validateListTypes(options.types);
      const statuses = validateListStatuses(options.statuses);
      if (types?.length === 0 || statuses?.length === 0) return [];

      const limit = normalizeManagementJobListLimit(options.limit);
      const order = options.order ?? "created-desc";
      if (order !== "created-desc" && order !== "created-asc") {
        throw new Error(`Unsupported management job list order: ${String(order)}`);
      }

      const clauses: string[] = [];
      const params: Array<string | number> = [];
      if (types) {
        clauses.push(`type IN (${placeholders(types)})`);
        params.push(...types);
      }
      if (statuses) {
        clauses.push(`status IN (${placeholders(statuses)})`);
        params.push(...statuses);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const direction = order === "created-asc" ? "ASC" : "DESC";
      const rows = db.prepare(`
        SELECT *
        FROM management_jobs
        ${where}
        ORDER BY createdAt ${direction}
        LIMIT ?
      `).all(...params, limit) as unknown as ManagementJobRow[];
      return rows.map(rowToJob);
    },

    listActive(types = MANAGEMENT_JOB_TYPES) {
      const rows = db.prepare(`
        SELECT *
        FROM management_jobs
        WHERE type IN (${placeholders(types)})
          AND status IN (${placeholders(ACTIVE_STATUSES)})
        ORDER BY createdAt ASC
      `).all(...types, ...ACTIVE_STATUSES) as unknown as ManagementJobRow[];
      return rows.map(rowToJob);
    },

    claimNext(claimOptions = {}) {
      const staleAfterMs = claimOptions.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
      const cutoff = new Date(now().getTime() - staleAfterMs).toISOString();
      const runnerPid = claimOptions.runnerPid ?? process.pid;
      return runImmediateTransaction(db, () => {
        const row = db.prepare(`
          SELECT *
          FROM management_jobs
          WHERE status = 'queued'
             OR (
               status = 'running'
               AND (heartbeatAt IS NULL OR heartbeatAt < ?)
             )
          ORDER BY
            CASE status WHEN 'queued' THEN 0 ELSE 1 END,
            createdAt ASC
          LIMIT 1
        `).get(cutoff) as ManagementJobRow | undefined;
        if (!row) return null;

        const timestamp = nowIso(now);
        db.prepare(`
          UPDATE management_jobs
          SET status = 'running',
              runnerPid = ?,
              heartbeatAt = ?,
              startedAt = COALESCE(startedAt, ?),
              updatedAt = ?
          WHERE id = ?
            AND status IN ('queued', 'running')
        `).run(runnerPid, timestamp, timestamp, timestamp, row.id);
        const claimed = getJobRow(db, row.id);
        if (!claimed) throw new Error(`Failed to read claimed management job ${row.id}`);
        return rowToJob(claimed);
      });
    },

    heartbeat(id, runnerPid = process.pid) {
      const timestamp = nowIso(now);
      db.prepare(`
        UPDATE management_jobs
        SET heartbeatAt = ?,
            runnerPid = ?,
            updatedAt = ?
        WHERE id = ?
          AND status = 'running'
      `).run(timestamp, runnerPid, timestamp, id);
    },

    succeed(id, result = {}) {
      const timestamp = nowIso(now);
      db.prepare(`
        UPDATE management_jobs
        SET status = 'succeeded',
            result = ?,
            error = NULL,
            completedAt = ?,
            updatedAt = ?,
            heartbeatAt = ?
        WHERE id = ?
      `).run(jsonStringify(result), timestamp, timestamp, timestamp, id);
      const row = getJobRow(db, id);
      if (!row) throw new Error(`Failed to read completed management job ${id}`);
      return rowToJob(row);
    },

    fail(id, error, result = undefined) {
      const timestamp = nowIso(now);
      db.prepare(`
        UPDATE management_jobs
        SET status = 'failed',
            result = ?,
            error = ?,
            completedAt = ?,
            updatedAt = ?,
            heartbeatAt = ?
        WHERE id = ?
      `).run(result === undefined ? null : jsonStringify(result), error, timestamp, timestamp, timestamp, id);
      const row = getJobRow(db, id);
      if (!row) throw new Error(`Failed to read failed management job ${id}`);
      return rowToJob(row);
    },

    cancel(id, reason = "cancelled") {
      return runImmediateTransaction(db, () => {
        const row = getJobRow(db, id);
        if (!row) return null;
        const job = rowToJob(row);
        const timestamp = nowIso(now);
        if (job.status === "queued") {
          db.prepare(`
            UPDATE management_jobs
            SET status = 'cancelled',
                error = ?,
                cancelRequestedAt = ?,
                completedAt = ?,
                updatedAt = ?
            WHERE id = ?
          `).run(reason, timestamp, timestamp, timestamp, id);
        } else if (job.status === "running") {
          db.prepare(`
            UPDATE management_jobs
            SET cancelRequestedAt = ?,
                updatedAt = ?
            WHERE id = ?
          `).run(timestamp, timestamp, id);
        }
        const updated = getJobRow(db, id);
        return updated ? rowToJob(updated) : null;
      });
    },

    readLogTail(jobOrId, maxBytes = DEFAULT_LOG_TAIL_BYTES) {
      const job = typeof jobOrId === "string" ? store.get(jobOrId) : jobOrId;
      if (!job?.logPath) return "";
      return sanitizeManagementJobLogTail(readFileTail(job.logPath, maxBytes));
    },
  };
  return store;
}
