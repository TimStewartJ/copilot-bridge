// Grading the model A/B test's chats with Copilot's trajectory classifiers (taskAnalytics.classifyTrajectory).
// The user starts a run from Settings › Models; it sends each test chat's events.jsonl to the runtime,
// which runs its retrospective classifiers on GitHub's judge models (billed as AI credits), and keeps
// the categorical labels per chat. The labels are model-derived, untrusted measurements: the Bridge only
// counts them for the report and never decides anything from them.
import { open, stat } from "node:fs/promises";
import type { DatabaseSync } from "./db.js";
import type {
  AgentTrajectoryClassification,
  AgentTrajectoryClassifyRequest,
  AgentTrajectoryClassifyResult,
} from "./agent-backend/types.js";
import type { ModelAbTestAssignment } from "./model-ab-test.js";
import { scanJsonlRecords, withoutCarriageReturn } from "./jsonl-lines.js";
import {
  MODEL_AB_TEST_ARMS,
  type ModelAbTestArm,
  type ModelAbTestArmGrades,
  type ModelAbTestGradeSkipReason,
  type ModelAbTestGradingStatus,
  type ModelAbTestLabelCount,
} from "../shared/model-ab-test.js";

/**
 * Largest log a run sends. The whole log goes to the runtime as one JSON-RPC request on the stdio
 * channel every live chat shares, so a huge one is skipped instead.
 */
export const MODEL_AB_GRADE_MAX_LOG_BYTES = 32 * 1024 * 1024;
const MAX_LOG_LINE_BYTES = 16 * 1024 * 1024;
const MAX_DETAIL_CHARS = 500;

export interface ModelAbTestGrade {
  sessionId: string;
  testStartedAt: string;
  arm: ModelAbTestArm;
  status: "graded" | "skipped";
  reason?: ModelAbTestGradeSkipReason;
  /** Validation errors or the failure message, for the log; never transcript text. */
  detail?: string;
  gradedAt: string;
  trajectoryFingerprint?: string;
  eventCount: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  result?: AgentTrajectoryClassifyResult;
}

// ── Reading a chat's log ───────────────────────────────────────

export type ChatEventsRead =
  | { kind: "missing" }
  | { kind: "too-large"; bytes: number }
  | { kind: "ok"; events: unknown[]; malformedLines: number };

/** Every event of a chat's events.jsonl, streamed off the event loop's critical path; malformed lines are dropped. */
export async function readChatEventsForGrading(eventsPath: string, maxBytes = MODEL_AB_GRADE_MAX_LOG_BYTES): Promise<ChatEventsRead> {
  let size: number;
  try {
    size = (await stat(eventsPath)).size;
  } catch (error) {
    if (isNotFound(error)) return { kind: "missing" };
    throw error;
  }
  if (size > maxBytes) return { kind: "too-large", bytes: size };
  const events: unknown[] = [];
  let malformedLines = 0;
  const addRecord = (record: Buffer): void => {
    const line = withoutCarriageReturn(record).toString("utf-8").trim();
    if (!line) return;
    try {
      events.push(JSON.parse(line));
    } catch {
      malformedLines += 1;
    }
  };
  const file = await open(eventsPath, "r");
  try {
    // Reads only what was there when the run looked, so a chat still writing does not grow the request.
    const { trailing } = await scanJsonlRecords(file, addRecord, { end: size, maxRecordBytes: MAX_LOG_LINE_BYTES });
    if (trailing) addRecord(trailing.record);
  } finally {
    await file.close();
  }
  return events.length > 0 ? { kind: "ok", events, malformedLines } : { kind: "missing" };
}

function isNotFound(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

// ── Store ──────────────────────────────────────────────────────

interface GradeRow {
  sessionId: string;
  testStartedAt: string;
  arm: string;
  status: string;
  reason: string | null;
  detail: string | null;
  gradedAt: string;
  trajectoryFingerprint: string | null;
  eventCount: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  result: string | null;
}

const SKIP_REASONS: readonly ModelAbTestGradeSkipReason[] = ["missing", "too-large", "invalid", "error"];

function fromRow(row: GradeRow): ModelAbTestGrade | undefined {
  if (row.arm !== "a" && row.arm !== "b") return undefined;
  if (row.status !== "graded" && row.status !== "skipped") return undefined;
  const reason = SKIP_REASONS.find((candidate) => candidate === row.reason);
  let result: AgentTrajectoryClassifyResult | undefined;
  if (row.result) {
    try {
      result = JSON.parse(row.result) as AgentTrajectoryClassifyResult;
    } catch {
      result = undefined;
    }
  }
  return {
    sessionId: row.sessionId,
    testStartedAt: row.testStartedAt,
    arm: row.arm,
    status: row.status,
    ...(reason ? { reason } : {}),
    ...(row.detail ? { detail: row.detail } : {}),
    gradedAt: row.gradedAt,
    ...(row.trajectoryFingerprint ? { trajectoryFingerprint: row.trajectoryFingerprint } : {}),
    eventCount: row.eventCount,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cachedInputTokens: row.cachedInputTokens,
    ...(result ? { result } : {}),
  };
}

export function createModelAbGradeStore(db: DatabaseSync) {
  const upsert = db.prepare(
    `INSERT INTO model_ab_grades
       (sessionId, testStartedAt, arm, status, reason, detail, gradedAt, trajectoryFingerprint,
        eventCount, inputTokens, outputTokens, cachedInputTokens, result)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(sessionId) DO UPDATE SET
       testStartedAt = excluded.testStartedAt, arm = excluded.arm, status = excluded.status,
       reason = excluded.reason, detail = excluded.detail, gradedAt = excluded.gradedAt,
       trajectoryFingerprint = excluded.trajectoryFingerprint, eventCount = excluded.eventCount,
       inputTokens = excluded.inputTokens, outputTokens = excluded.outputTokens,
       cachedInputTokens = excluded.cachedInputTokens, result = excluded.result`,
  );
  const forTest = db.prepare("SELECT * FROM model_ab_grades WHERE testStartedAt = ? ORDER BY gradedAt");

  function save(grade: ModelAbTestGrade): void {
    upsert.run(
      grade.sessionId,
      grade.testStartedAt,
      grade.arm,
      grade.status,
      grade.reason ?? null,
      grade.detail ?? null,
      grade.gradedAt,
      grade.trajectoryFingerprint ?? null,
      grade.eventCount,
      grade.inputTokens,
      grade.outputTokens,
      grade.cachedInputTokens,
      grade.result ? JSON.stringify(grade.result) : null,
    );
  }

  function listForTest(testStartedAt: string): ModelAbTestGrade[] {
    return (forTest.all(testStartedAt) as unknown as GradeRow[])
      .map(fromRow)
      .filter((grade): grade is ModelAbTestGrade => grade !== undefined);
  }

  return { save, listForTest };
}

export type ModelAbGradeStore = ReturnType<typeof createModelAbGradeStore>;

// ── Report ─────────────────────────────────────────────────────

/** Broadest first: a session or task row measures the chat's work as a whole, a turn or prompt row a part of it. */
const SCOPE_RANK: Readonly<Record<string, number>> = { session: 4, task: 3, turn: 2, prompt: 1 };
const scopeRank = (scope: string): number => SCOPE_RANK[scope] ?? 0;

/**
 * Label counts per arm. Each classifier is counted at the broadest scope it reported anywhere in the
 * test, the same scope for both arms: session if it judges whole chats, else task, turn or prompt, so a
 * chat with many turns weighs more only for classifiers that only judge turns. Within that scope a unit
 * counts once (session snapshots share a unit id; the latest is kept), and only successful rows count:
 * declined, abandoned and failed rows have no labels to compare.
 */
export function summarizeModelAbGrades(grades: readonly ModelAbTestGrade[]): Record<ModelAbTestArm, ModelAbTestArmGrades> {
  const graded = grades.filter((grade) => grade.status === "graded" && grade.result);
  const scopeByClassifier = new Map<string, string>();
  for (const grade of graded) {
    for (const row of grade.result!.classifications) {
      const current = scopeByClassifier.get(row.classifier);
      if (current === undefined || scopeRank(row.scope) > scopeRank(current)) scopeByClassifier.set(row.classifier, row.scope);
    }
  }

  const summary = {} as Record<ModelAbTestArm, ModelAbTestArmGrades>;
  for (const arm of MODEL_AB_TEST_ARMS) {
    const counts = new Map<string, ModelAbTestLabelCount>();
    const armGrades: ModelAbTestArmGrades = { graded: 0, notGraded: {}, labels: [], judgeTokens: 0 };
    for (const grade of grades) {
      if (grade.arm !== arm) continue;
      armGrades.judgeTokens += grade.inputTokens + grade.outputTokens;
      if (grade.status !== "graded" || !grade.result) {
        const reason = grade.reason ?? "error";
        armGrades.notGraded[reason] = (armGrades.notGraded[reason] ?? 0) + 1;
        continue;
      }
      armGrades.graded += 1;
      const latestByUnit = new Map<string, AgentTrajectoryClassification>();
      for (const row of grade.result.classifications) {
        if (row.scope !== scopeByClassifier.get(row.classifier)) continue;
        const key = `${row.classifier}\u0000${row.unitId}`;
        const kept = latestByUnit.get(key);
        if (!kept || row.ordinal >= kept.ordinal) latestByUnit.set(key, row);
      }
      for (const row of latestByUnit.values()) {
        if (row.status !== "success") continue;
        for (const [label, value] of Object.entries(row.labels)) {
          if (typeof value !== "string") continue;
          const key = `${row.classifier}\u0000${label}\u0000${value}`;
          const entry = counts.get(key) ?? { classifier: row.classifier, scope: row.scope, label, value, count: 0 };
          entry.count += 1;
          counts.set(key, entry);
        }
      }
    }
    armGrades.labels = [...counts.values()].sort((left, right) =>
      left.classifier.localeCompare(right.classifier) || left.label.localeCompare(right.label) || left.value.localeCompare(right.value));
    summary[arm] = armGrades;
  }
  return summary;
}

// ── Grading run ────────────────────────────────────────────────

export interface ModelAbTestGraderDeps {
  store: Pick<ModelAbGradeStore, "save" | "listForTest">;
  listAssignments: (testStartedAt: string) => readonly Pick<ModelAbTestAssignment, "sessionId" | "arm">[];
  classify: (request: AgentTrajectoryClassifyRequest) => Promise<AgentTrajectoryClassifyResult>;
  readEvents: (sessionId: string) => Promise<ChatEventsRead>;
  now?: () => Date;
  logger?: Pick<Console, "log" | "warn">;
}

export type ModelAbTestGradingStart = "started" | "running" | "nothing";

interface GradingRun {
  testStartedAt: string;
  total: number;
  done: number;
  running: boolean;
  finishedAt?: string;
  promise: Promise<void>;
}

function tokenTotals(result: AgentTrajectoryClassifyResult): Pick<ModelAbTestGrade, "inputTokens" | "outputTokens" | "cachedInputTokens"> {
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  for (const row of result.classifications) {
    inputTokens += row.inputTokens ?? 0;
    outputTokens += row.outputTokens ?? 0;
    cachedInputTokens += row.cachedInputTokens ?? 0;
  }
  return { inputTokens, outputTokens, cachedInputTokens };
}

const hasRetryableRows = (result: AgentTrajectoryClassifyResult): boolean =>
  result.classifications.some((row) => row.status === "failed" || row.status === "abandoned");

/**
 * One grading run at a time, chats one after another. A run lives in memory: a restart ends it, and
 * every chat it finished is already saved.
 */
export function createModelAbTestGrader(deps: ModelAbTestGraderDeps) {
  const now = deps.now ?? (() => new Date());
  const logger = deps.logger ?? console;
  let run: GradingRun | undefined;

  /** Chats a run would grade: all of them on a regrade, otherwise those with no grade or a failed attempt. */
  function pending(testStartedAt: string, regrade: boolean) {
    const assignments = deps.listAssignments(testStartedAt);
    if (regrade) return [...assignments];
    const grades = new Map(deps.store.listForTest(testStartedAt).map((grade) => [grade.sessionId, grade]));
    return assignments.filter((assignment) => {
      const grade = grades.get(assignment.sessionId);
      return !grade || (grade.status === "skipped" && grade.reason === "error");
    });
  }

  async function gradeChat(
    testStartedAt: string,
    assignment: Pick<ModelAbTestAssignment, "sessionId" | "arm">,
    previous: ModelAbTestGrade | undefined,
  ): Promise<void> {
    const base = { sessionId: assignment.sessionId, testStartedAt, arm: assignment.arm, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
    // A regrade that cannot grade the chat now keeps the grade it had.
    const keptGrade = previous?.status === "graded" && previous.result ? previous : undefined;
    const skip = (reason: ModelAbTestGradeSkipReason, eventCount: number, detail?: string): void => {
      if (keptGrade) return;
      deps.store.save({ ...base, status: "skipped", reason, ...(detail ? { detail: detail.slice(0, MAX_DETAIL_CHARS) } : {}), gradedAt: now().toISOString(), eventCount });
    };

    const read = await deps.readEvents(assignment.sessionId);
    if (read.kind === "missing") return skip("missing", 0);
    if (read.kind === "too-large") return skip("too-large", 0, `${read.bytes} bytes`);
    const eventCount = read.events.length;
    try {
      let previousResult: AgentTrajectoryClassifyResult | undefined;
      if (keptGrade?.trajectoryFingerprint) {
        // Validation is free and returns the log's fingerprint: an unchanged log keeps its grade and
        // retries only the classifiers that failed on it.
        const check = await deps.classify({ events: read.events, validateOnly: true });
        if (check.validation && !check.validation.valid) return skip("invalid", eventCount, check.validation.errors.join("; "));
        if (check.trajectoryFingerprint === keptGrade.trajectoryFingerprint) {
          if (!hasRetryableRows(keptGrade.result!)) return;
          previousResult = keptGrade.result;
        }
      }
      const result = await deps.classify({ events: read.events, ...(previousResult ? { previousResult } : {}) });
      if (result.validation && !result.validation.valid) return skip("invalid", eventCount, result.validation.errors.join("; "));
      const { validation: _validation, ...kept } = result;
      deps.store.save({
        ...base,
        ...tokenTotals(result),
        status: "graded",
        gradedAt: now().toISOString(),
        ...(result.trajectoryFingerprint ? { trajectoryFingerprint: result.trajectoryFingerprint } : {}),
        eventCount,
        result: kept,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[model-ab-grading] [${assignment.sessionId.slice(0, 8)}] Could not grade this chat: ${message}`);
      skip("error", eventCount, message);
    }
  }

  async function runAll(current: GradingRun, chats: ReturnType<typeof pending>): Promise<void> {
    const previous = new Map(deps.store.listForTest(current.testStartedAt).map((grade) => [grade.sessionId, grade]));
    for (const assignment of chats) {
      try {
        await gradeChat(current.testStartedAt, assignment, previous.get(assignment.sessionId));
      } catch (error) {
        logger.warn(`[model-ab-grading] [${assignment.sessionId.slice(0, 8)}] Grading stopped on this chat: ${error instanceof Error ? error.message : String(error)}`);
      }
      current.done += 1;
    }
  }

  function start(testStartedAt: string, options: { regrade?: boolean } = {}): ModelAbTestGradingStart {
    if (run?.running) return "running";
    const chats = pending(testStartedAt, options.regrade === true);
    if (chats.length === 0) return "nothing";
    const current: GradingRun = { testStartedAt, total: chats.length, done: 0, running: true, promise: Promise.resolve() };
    run = current;
    logger.log(`[model-ab-grading] Grading ${chats.length} chat(s)${options.regrade ? " again" : ""}`);
    current.promise = runAll(current, chats).finally(() => {
      current.running = false;
      current.finishedAt = now().toISOString();
      logger.log(`[model-ab-grading] Graded ${current.done} of ${current.total} chat(s)`);
    });
    return "started";
  }

  function status(testStartedAt: string): ModelAbTestGradingStatus {
    const current = run?.testStartedAt === testStartedAt ? run : undefined;
    return {
      running: current?.running ?? false,
      total: current?.total ?? 0,
      done: current?.done ?? 0,
      ungraded: pending(testStartedAt, false).length,
      ...(current?.finishedAt ? { finishedAt: current.finishedAt } : {}),
    };
  }

  /** Resolves when the current run, if any, has finished. */
  function settled(): Promise<void> {
    return run?.promise ?? Promise.resolve();
  }

  return { start, status, settled };
}

export type ModelAbTestGrader = ReturnType<typeof createModelAbTestGrader>;
