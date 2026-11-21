// Grades chats with Copilot's trajectory classifiers; labels are untrusted, only ever counted.
import { open, stat } from "node:fs/promises";
import type { DatabaseSync } from "./db.js";
import type {
  AgentTrajectoryClassification,
  AgentTrajectoryClassifyRequest,
  AgentTrajectoryClassifyResult,
} from "./agent-backend/types.js";
import { scanJsonlRecords, withoutCarriageReturn } from "./jsonl-lines.js";
import { isAutopilotContinuationEvent } from "./event-transform.js";
import { isCustomContinuationMessage } from "./custom-autopilot.js";
import { isRecord } from "../shared/is-record.js";
import { isUnlistedSessionId } from "./unlisted-sessions.js";
import { isCanonicalSessionId } from "./outbound-attachments.js";
import type {
  ChatGradeSkipReason,
  ChatGradesChat,
  ChatGradesClassifier,
  ChatGradesFilters,
  ChatGradesModelOption,
  ChatGradesReport,
  ChatGradesRunStatus,
  ChatGradesExcerpt,
  ChatGradesUnit,
  ChatGradesUnitChat,
  ChatGradesUnits,
  ChatGradesView,
} from "../shared/chat-grades.js";

/** Largest log sent: it goes as one JSON-RPC request on the stdio channel all live chats share. */
export const CHAT_GRADE_MAX_LOG_BYTES = 32 * 1024 * 1024;
const MAX_LOG_LINE_BYTES = 16 * 1024 * 1024;
const MAX_DETAIL_CHARS = 500;
/** Chats graded at once: each is one long request with several judge calls of its own. */
const GRADING_CONCURRENCY = 2;
const LOG_CHECK_CONCURRENCY = 16;
/** Most chats one filter may name. */
export const CHAT_GRADES_MAX_SESSION_IDS = 200;
/** Most chats one units request may read excerpts from; each log is read and parsed whole. */
export const CHAT_GRADES_MAX_EXCERPT_CHATS = 20;
const EXCERPT_MAX_LOG_BYTES = 8 * 1024 * 1024;
const EXCERPT_CHARS = 600;

export interface ChatGrade {
  sessionId: string;
  status: "graded" | "skipped";
  reason?: ChatGradeSkipReason;
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

/** Every event of a chat's events.jsonl, streamed; malformed lines are dropped. */
export async function readChatEventsForGrading(eventsPath: string, maxBytes = CHAT_GRADE_MAX_LOG_BYTES): Promise<ChatEventsRead> {
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
    // Stops at the size seen at start, so a chat still writing does not grow the request.
    const { trailing } = await scanJsonlRecords(file, addRecord, { end: size, maxRecordBytes: MAX_LOG_LINE_BYTES });
    if (trailing) addRecord(trailing.record);
  } finally {
    await file.close();
  }
  return events.length > 0 ? { kind: "ok", events, malformedLines } : { kind: "missing" };
}

/** Whether a chat has an events.jsonl to grade. */
export async function hasChatEventsLog(eventsPath: string): Promise<boolean> {
  try {
    return (await stat(eventsPath)).isFile();
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

// ── Store ──────────────────────────────────────────────────────

interface GradeRow {
  sessionId: string;
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

const SKIP_REASONS: readonly ChatGradeSkipReason[] = ["missing", "too-large", "invalid", "error"];

function fromRow(row: GradeRow): ChatGrade | undefined {
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

export function createChatGradeStore(db: DatabaseSync) {
  const upsert = db.prepare(
    `INSERT INTO chat_grades
       (sessionId, status, reason, detail, gradedAt, trajectoryFingerprint,
        eventCount, inputTokens, outputTokens, cachedInputTokens, result)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(sessionId) DO UPDATE SET
       status = excluded.status, reason = excluded.reason, detail = excluded.detail,
       gradedAt = excluded.gradedAt, trajectoryFingerprint = excluded.trajectoryFingerprint,
       eventCount = excluded.eventCount, inputTokens = excluded.inputTokens,
       outputTokens = excluded.outputTokens, cachedInputTokens = excluded.cachedInputTokens,
       result = excluded.result`,
  );
  const forSessions = db.prepare("SELECT * FROM chat_grades WHERE sessionId IN (SELECT value FROM json_each(?))");

  function save(grade: ChatGrade): void {
    upsert.run(
      grade.sessionId,
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

  function listFor(sessionIds: readonly string[]): ChatGrade[] {
    if (sessionIds.length === 0) return [];
    return (forSessions.all(JSON.stringify(sessionIds)) as unknown as GradeRow[])
      .map(fromRow)
      .filter((grade): grade is ChatGrade => grade !== undefined);
  }

  return { save, listFor };
}

export type ChatGradeStore = ReturnType<typeof createChatGradeStore>;

// ── Choosing chats ─────────────────────────────────────────────

export interface ChatGradeUsageSession {
  sessionId: string;
  models: readonly { model: string; outputTokens: number; totalTokens: number }[];
  /** Local days (YYYY-MM-DD) the chat recorded work on. */
  days?: readonly { date: string }[];
}

export interface ChatGradeCandidate {
  sessionId: string;
  /** The model that did most of the chat's work: the most output tokens, sub-agents included. */
  model: string;
  /** The chat's last active day in the range, or "" when the usage has no dates. */
  date: string;
}

export function mainModelOf(models: ChatGradeUsageSession["models"]): string | undefined {
  let best: ChatGradeUsageSession["models"][number] | undefined;
  for (const row of models) {
    if (!best
      || row.outputTokens > best.outputTokens
      || (row.outputTokens === best.outputTokens && row.totalTokens > best.totalTokens)
      || (row.outputTokens === best.outputTokens && row.totalTokens === best.totalTokens && row.model < best.model)) {
      best = row;
    }
  }
  return best?.model;
}

export interface ChatGradeSelection {
  /** Chats in the date range, by model, before the model filter; the models the filter offers. */
  modelCounts: Map<string, number>;
  matching: ChatGradeCandidate[];
}

/** Chats with a log active in range, user-started unless `includeScheduled`, model in `models`. */
export async function selectChatsForGrading(input: {
  sessions: readonly ChatGradeUsageSession[];
  scheduled: ReadonlySet<string>;
  hasEventsLog: (sessionId: string) => Promise<boolean>;
  filters: ChatGradesFilters;
}): Promise<ChatGradeSelection> {
  const { from, to, includeScheduled } = input.filters;
  const bounded = Boolean(from || to);
  const inRange: ChatGradeCandidate[] = [];
  for (const session of input.sessions) {
    if (isUnlistedSessionId(session.sessionId)) continue;
    if (!includeScheduled && input.scheduled.has(session.sessionId)) continue;
    const model = mainModelOf(session.models);
    if (!model) continue;
    const days = (session.days ?? [])
      .map((day) => day.date)
      .filter((date) => (!from || date >= from) && (!to || date <= to))
      .sort();
    if (bounded && days.length === 0) continue;
    inRange.push({ sessionId: session.sessionId, model, date: days.at(-1) ?? "" });
  }

  const withLog: ChatGradeCandidate[] = [];
  for (let start = 0; start < inRange.length; start += LOG_CHECK_CONCURRENCY) {
    const batch = inRange.slice(start, start + LOG_CHECK_CONCURRENCY);
    const exists = await Promise.all(batch.map((candidate) => input.hasEventsLog(candidate.sessionId).catch(() => false)));
    batch.forEach((candidate, index) => { if (exists[index]) withLog.push(candidate); });
  }

  const modelCounts = new Map<string, number>();
  for (const candidate of withLog) modelCounts.set(candidate.model, (modelCounts.get(candidate.model) ?? 0) + 1);
  const models = new Set(input.filters.models ?? []);
  const ids = input.filters.sessionIds ? new Set(input.filters.sessionIds) : undefined;
  const matching = withLog
    .filter((candidate) => models.size === 0 || models.has(candidate.model))
    .filter((candidate) => !ids || ids.has(candidate.sessionId));
  return { modelCounts, matching };
}

// ── Report ─────────────────────────────────────────────────────

const SCOPE_RANK: Readonly<Record<string, number>> = { session: 4, task: 3, turn: 2, prompt: 1 };
const scopeRank = (scope: string): number => SCOPE_RANK[scope] ?? 0;

/** A taxonomy classifier's top level. */
const TAXONOMY_TOP_KEY = "l1";

/** Keys about the judgment, not the thing judged; charted only when nothing else exists. */
const JUDGMENT_DETAIL_KEYS: ReadonlySet<string> = new Set(["confidence", "prompt_id"]);
/** A classifier's yes/no style answer, as task_completion_criteria reports it. */
const VERDICT_KEY = "verdict";

/** Chart key: the classifier's last word, else `l1`, else `verdict`, else first non-detail key. */
export function chartLabelKey(classifier: string, keys: Iterable<string>): string | undefined {
  const sorted = [...new Set(keys)].sort();
  const lastWord = classifier.split("_").at(-1);
  return sorted.find((key) => key === lastWord)
    ?? sorted.find((key) => key === TAXONOMY_TOP_KEY)
    ?? sorted.find((key) => key === VERDICT_KEY)
    ?? sorted.find((key) => !JUDGMENT_DETAIL_KEYS.has(key))
    ?? sorted[0];
}

export interface ChatGradeReportChat extends ChatGradeCandidate {
  title: string;
}

interface CountedUnit {
  classifier: string;
  labels: Record<string, string>;
}

/** Label counts per classifier and model at its broadest reported scope; each unit once, if ok. */
export function buildChatGradesReport(chats: readonly ChatGradeReportChat[], grades: readonly ChatGrade[]): ChatGradesReport {
  const gradeById = new Map(grades.map((grade) => [grade.sessionId, grade]));
  const graded = chats.flatMap((chat) => {
    const grade = gradeById.get(chat.sessionId);
    return grade?.status === "graded" && grade.result ? [{ chat, rows: grade.result.classifications }] : [];
  });

  const scopeByClassifier = new Map<string, string>();
  for (const { rows } of graded) {
    for (const row of rows) {
      const current = scopeByClassifier.get(row.classifier);
      if (current === undefined || scopeRank(row.scope) > scopeRank(current)) scopeByClassifier.set(row.classifier, row.scope);
    }
  }

  const unitsByChat = new Map<string, CountedUnit[]>();
  const keysByClassifier = new Map<string, Set<string>>();
  for (const { chat, rows } of graded) {
    const latestByUnit = new Map<string, AgentTrajectoryClassification>();
    for (const row of rows) {
      if (row.scope !== scopeByClassifier.get(row.classifier)) continue;
      const key = `${row.classifier}\u0000${row.unitId}`;
      const kept = latestByUnit.get(key);
      if (!kept || row.ordinal >= kept.ordinal) latestByUnit.set(key, row);
    }
    const units: CountedUnit[] = [];
    for (const row of latestByUnit.values()) {
      if (row.status !== "success") continue;
      const labels = Object.fromEntries(Object.entries(row.labels).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
      if (Object.keys(labels).length === 0) continue;
      units.push({ classifier: row.classifier, labels });
      const keys = keysByClassifier.get(row.classifier) ?? new Set<string>();
      for (const key of Object.keys(labels)) keys.add(key);
      keysByClassifier.set(row.classifier, keys);
    }
    unitsByChat.set(chat.sessionId, units);
  }

  const chartKeys = new Map<string, string>();
  for (const [classifier, keys] of keysByClassifier) {
    const key = chartLabelKey(classifier, keys);
    if (key) chartKeys.set(classifier, key);
  }

  interface SeriesAccumulator { chats: number; units: number; judgeTokens: number; values: Map<string, number> }
  const series = new Map<string, Map<string, SeriesAccumulator>>();
  const accumulator = (classifier: string, model: string): SeriesAccumulator => {
    const byModel = series.get(classifier) ?? new Map<string, SeriesAccumulator>();
    series.set(classifier, byModel);
    const entry = byModel.get(model) ?? { chats: 0, units: 0, judgeTokens: 0, values: new Map<string, number>() };
    byModel.set(model, entry);
    return entry;
  };

  const reportChats: ChatGradesChat[] = [];
  for (const { chat, rows } of graded) {
    for (const row of rows) {
      if (!chartKeys.has(row.classifier)) continue;
      accumulator(row.classifier, chat.model).judgeTokens += (row.inputTokens ?? 0) + (row.outputTokens ?? 0);
    }
    const labels: Record<string, string[]> = {};
    for (const unit of unitsByChat.get(chat.sessionId) ?? []) {
      const key = chartKeys.get(unit.classifier);
      const value = key ? unit.labels[key] : undefined;
      if (value === undefined) continue;
      const entry = accumulator(unit.classifier, chat.model);
      entry.units += 1;
      entry.values.set(value, (entry.values.get(value) ?? 0) + 1);
      const values = labels[unit.classifier] ?? [];
      if (!values.includes(value)) values.push(value);
      labels[unit.classifier] = values;
    }
    for (const classifier of Object.keys(labels)) accumulator(classifier, chat.model).chats += 1;
    reportChats.push({ sessionId: chat.sessionId, title: chat.title, model: chat.model, date: chat.date, labels });
  }

  const classifiers: ChatGradesClassifier[] = [...series.entries()]
    .map(([classifier, byModel]) => ({
      classifier,
      scope: scopeByClassifier.get(classifier) ?? "",
      label: chartKeys.get(classifier) ?? "",
      models: [...byModel.entries()]
        .filter(([, entry]) => entry.units > 0)
        .map(([model, entry]) => ({
          model,
          chats: entry.chats,
          units: entry.units,
          judgeTokens: entry.judgeTokens,
          values: [...entry.values.entries()]
            .map(([value, count]) => ({ value, count }))
            .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value)),
        }))
        .sort((left, right) => left.model.localeCompare(right.model)),
    }))
    .filter((classifier) => classifier.models.length > 0)
    .sort((left, right) => left.classifier.localeCompare(right.classifier));
  reportChats.sort((left, right) => right.date.localeCompare(left.date) || left.sessionId.localeCompare(right.sessionId));
  return { classifiers, chats: reportChats };
}

// ── Units ──────────────────────────────────────────────────────

const stringEntries = (values: Record<string, string | undefined>): Record<string, string> =>
  Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => typeof entry[1] === "string"));

const numberEntries = (values: Record<string, number | undefined>): Record<string, number> =>
  Object.fromEntries(Object.entries(values).filter((entry): entry is [string, number] => typeof entry[1] === "number"));

/** Every unit of each graded chat: the latest row per classifier, scope and unit. */
export function buildChatGradeUnits(grades: readonly ChatGrade[]): ChatGradesUnit[] {
  const units: ChatGradesUnit[] = [];
  for (const grade of grades) {
    if (grade.status !== "graded" || !grade.result) continue;
    const latest = new Map<string, AgentTrajectoryClassification>();
    for (const row of grade.result.classifications) {
      const key = `${row.classifier}\u0000${row.scope}\u0000${row.unitId}`;
      const kept = latest.get(key);
      if (!kept || row.ordinal >= kept.ordinal) latest.set(key, row);
    }
    for (const row of latest.values()) {
      units.push({
        sessionId: grade.sessionId,
        classifier: row.classifier,
        classifierVersion: row.classifierVersion,
        scope: row.scope,
        unitId: row.unitId,
        ordinal: row.ordinal,
        ...(row.anchorEventId ? { anchorEventId: row.anchorEventId } : {}),
        status: row.status,
        labels: stringEntries(row.labels),
        metrics: numberEntries(row.metrics),
        textTruncated: row.textTruncated,
        unresolvedBoundaries: row.unresolvedBoundaries,
        ...(row.model ? { judgeModel: row.model } : {}),
      });
    }
  }
  return units.sort((left, right) =>
    left.sessionId.localeCompare(right.sessionId)
    || left.classifier.localeCompare(right.classifier)
    || scopeRank(right.scope) - scopeRank(left.scope)
    || left.ordinal - right.ordinal);
}

interface MessageEvent { id: string; type: "user" | "agent"; content: string }

/** Bridge's keep-going prompt is graded as an Autopilot continuation, not a person's prompt. */
function asGradedEvent(event: unknown): unknown {
  if (!isCustomContinuationMessage(event) || !isRecord(event) || !isRecord(event.data)) return event;
  return { ...event, data: { ...event.data, isAutopilotContinuation: true } };
}

function messageEvent(event: unknown): MessageEvent | undefined {
  if (!event || typeof event !== "object") return undefined;
  const record = event as { type?: unknown; id?: unknown; agentId?: unknown; data?: unknown };
  if (typeof record.id !== "string" || (typeof record.agentId === "string" && record.agentId)) return undefined;
  const data = (record.data ?? {}) as { content?: unknown; parentToolCallId?: unknown };
  if (typeof data.parentToolCallId === "string" && data.parentToolCallId) return undefined;
  const content = typeof data.content === "string" ? data.content.trim() : "";
  // A keep-going prompt is not the person's turn: the reply runs on to the run's real end.
  if (record.type === "user.message" && isAutopilotContinuationEvent(event)) return undefined;
  if (record.type === "user.message") return { id: record.id, type: "user", content };
  if (record.type === "assistant.message" && content) return { id: record.id, type: "agent", content };
  return undefined;
}

const clip = (text: string): string => (text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS - 1)}\u2026` : text);

/** For anchors that are user messages: that message and the agent's last reply before the next. */
export function excerptsFor(events: readonly unknown[], anchorIds: ReadonlySet<string>): Map<string, ChatGradesExcerpt> {
  const messages = events.map(messageEvent).filter((message): message is MessageEvent => message !== undefined);
  const excerpts = new Map<string, ChatGradesExcerpt>();
  messages.forEach((message, index) => {
    if (message.type !== "user" || !anchorIds.has(message.id)) return;
    let agent = "";
    for (const next of messages.slice(index + 1)) {
      if (next.type === "user") break;
      agent = next.content;
    }
    excerpts.set(message.id, { user: clip(message.content), agent: clip(agent) });
  });
  return excerpts;
}

// ── Grading run ────────────────────────────────────────────────

export interface ChatGraderDeps {
  store: Pick<ChatGradeStore, "save" | "listFor">;
  classify: (request: AgentTrajectoryClassifyRequest) => Promise<AgentTrajectoryClassifyResult>;
  readEvents: (sessionId: string) => Promise<ChatEventsRead>;
  now?: () => Date;
  logger?: Pick<Console, "log" | "warn">;
  concurrency?: number;
}

export type ChatGradingStart = "started" | "running" | "nothing";

interface GradingRun extends ChatGradesRunStatus {
  promise: Promise<void>;
}

function tokenTotals(result: AgentTrajectoryClassifyResult): Pick<ChatGrade, "inputTokens" | "outputTokens" | "cachedInputTokens"> {
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

/** One run at a time, a few chats at once; in memory: a restart ends it, saved grades stay. */
export function createChatGrader(deps: ChatGraderDeps) {
  const now = deps.now ?? (() => new Date());
  const logger = deps.logger ?? console;
  const concurrency = Math.max(1, deps.concurrency ?? GRADING_CONCURRENCY);
  let run: GradingRun | undefined;

  /** Chats a run would grade: all on a regrade, else those with no grade or a failed attempt. */
  function pending(sessionIds: readonly string[], regrade: boolean): string[] {
    if (regrade) return [...sessionIds];
    const grades = new Map(deps.store.listFor(sessionIds).map((grade) => [grade.sessionId, grade]));
    return sessionIds.filter((sessionId) => {
      const grade = grades.get(sessionId);
      return !grade || (grade.status === "skipped" && grade.reason === "error");
    });
  }

  async function gradeChat(sessionId: string, previous: ChatGrade | undefined): Promise<void> {
    const base = { sessionId, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
    // A regrade that cannot grade the chat now keeps the grade it had.
    const keptGrade = previous?.status === "graded" && previous.result ? previous : undefined;
    const skip = (reason: ChatGradeSkipReason, eventCount: number, detail?: string): void => {
      if (keptGrade) return;
      deps.store.save({ ...base, status: "skipped", reason, ...(detail ? { detail: detail.slice(0, MAX_DETAIL_CHARS) } : {}), gradedAt: now().toISOString(), eventCount });
    };

    const read = await deps.readEvents(sessionId);
    if (read.kind === "missing") return skip("missing", 0);
    if (read.kind === "too-large") return skip("too-large", 0, `${read.bytes} bytes`);
    const eventCount = read.events.length;
    try {
      let previousResult: AgentTrajectoryClassifyResult | undefined;
      const events = read.events.map(asGradedEvent);
      if (keptGrade?.trajectoryFingerprint) {
        // Validation is free: an unchanged log keeps its grade and retries only failed classifiers.
        const check = await deps.classify({ events, validateOnly: true });
        if (check.validation && !check.validation.valid) return skip("invalid", eventCount, check.validation.errors.join("; "));
        if (check.trajectoryFingerprint === keptGrade.trajectoryFingerprint) {
          if (!hasRetryableRows(keptGrade.result!)) return;
          previousResult = keptGrade.result;
        }
      }
      const result = await deps.classify({ events, ...(previousResult ? { previousResult } : {}) });
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
      logger.warn(`[chat-grading] [${sessionId.slice(0, 8)}] Could not grade this chat: ${message}`);
      skip("error", eventCount, message);
    }
  }

  async function runAll(current: GradingRun, sessionIds: readonly string[]): Promise<void> {
    const previous = new Map(deps.store.listFor(sessionIds).map((grade) => [grade.sessionId, grade]));
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < sessionIds.length) {
        const sessionId = sessionIds[next++]!;
        try {
          await gradeChat(sessionId, previous.get(sessionId));
        } catch (error) {
          logger.warn(`[chat-grading] [${sessionId.slice(0, 8)}] Grading stopped on this chat: ${error instanceof Error ? error.message : String(error)}`);
        }
        current.done += 1;
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, sessionIds.length) }, worker));
  }

  function start(sessionIds: readonly string[], options: { regrade?: boolean } = {}): ChatGradingStart {
    if (run?.running) return "running";
    const chats = pending(sessionIds, options.regrade === true);
    if (chats.length === 0) return "nothing";
    const current: GradingRun = { total: chats.length, done: 0, running: true, promise: Promise.resolve() };
    run = current;
    logger.log(`[chat-grading] Grading ${chats.length} chat(s)${options.regrade ? " again" : ""}`);
    current.promise = runAll(current, chats).finally(() => {
      current.running = false;
      current.finishedAt = now().toISOString();
      logger.log(`[chat-grading] Graded ${current.done} of ${current.total} chat(s)`);
    });
    return "started";
  }

  function status(): ChatGradesRunStatus {
    return {
      running: run?.running ?? false,
      total: run?.total ?? 0,
      done: run?.done ?? 0,
      ...(run?.finishedAt ? { finishedAt: run.finishedAt } : {}),
    };
  }

  /** Resolves when the current run, if any, has finished. */
  function settled(): Promise<void> {
    return run?.promise ?? Promise.resolve();
  }

  return { start, status, pending, settled };
}

export type ChatGrader = ReturnType<typeof createChatGrader>;

// ── The view and runs the API serves ───────────────────────────

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Filters from a query or body; `models` may be repeated or comma-joined. */
export function parseChatGradesFilters(source: Record<string, unknown>): { filters: ChatGradesFilters } | { error: string } {
  const day = (value: unknown): string | undefined | null => {
    if (value === undefined || value === null || value === "") return undefined;
    return typeof value === "string" && DAY_PATTERN.test(value) && Number.isFinite(Date.parse(value)) ? value : null;
  };
  const from = day(source.from);
  const to = day(source.to);
  if (from === null || to === null) return { error: "Give dates as YYYY-MM-DD." };
  const rawModels = source.models;
  const models = (Array.isArray(rawModels) ? rawModels : [rawModels])
    .flatMap((value) => (typeof value === "string" ? value.split(",") : []))
    .map((value) => value.trim())
    .filter(Boolean);
  const includeScheduled = source.includeScheduled === true || source.includeScheduled === "true" || source.includeScheduled === "1";
  const rawIds = source.sessionIds;
  const idValues = Array.isArray(rawIds) ? rawIds : [rawIds];
  const sessionIds = [...new Set(idValues
    .flatMap((value) => (typeof value === "string" ? value.split(",") : []))
    .map((value) => value.trim())
    .filter(Boolean))];
  // A present but empty list must not widen to every chat: a run would grade them all.
  const badIds = rawIds !== undefined && (sessionIds.length === 0 || idValues.some((value) => typeof value !== "string"));
  if (badIds || sessionIds.some((id) => !isCanonicalSessionId(id))) return { error: "Give chats by their full chat ID." };
  if (sessionIds.length > CHAT_GRADES_MAX_SESSION_IDS) {
    return { error: `Name at most ${CHAT_GRADES_MAX_SESSION_IDS} chats at once.` };
  }
  return {
    filters: {
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(models.length > 0 ? { models: [...new Set(models)] } : {}),
      includeScheduled,
      ...(sessionIds.length > 0 ? { sessionIds } : {}),
    },
  };
}

export interface ChatGradesServiceDeps {
  store: Pick<ChatGradeStore, "listFor">;
  grader: Pick<ChatGrader, "start" | "status" | "pending">;
  /** Every chat's usage row (copilot-usage.ts), for its main model and active days. */
  readUsageSessions: () => Promise<readonly ChatGradeUsageSession[]>;
  /** Of these chats, the ones a trigger or schedule started. */
  scheduledSessionIds: (sessionIds: readonly string[]) => ReadonlySet<string>;
  hasEventsLog: (sessionId: string) => Promise<boolean>;
  chatTitles: (sessionIds: readonly string[]) => Promise<ReadonlyMap<string, string>>;
  /** Model id to the catalog's name. */
  modelNames: () => Promise<ReadonlyMap<string, string>>;
  /** Each chat's playbook and linked task, when it has them. */
  chatContext: (sessionIds: readonly string[]) => ReadonlyMap<string, Pick<ChatGradesUnitChat, "playbook" | "taskId" | "taskTitle">>;
  readEvents: (sessionId: string, maxBytes: number) => Promise<ChatEventsRead>;
}

export function createChatGradesService(deps: ChatGradesServiceDeps) {
  async function select(filters: ChatGradesFilters): Promise<ChatGradeSelection> {
    const sessions = await deps.readUsageSessions();
    return selectChatsForGrading({
      sessions,
      scheduled: deps.scheduledSessionIds(sessions.map((session) => session.sessionId)),
      hasEventsLog: deps.hasEventsLog,
      filters,
    });
  }

  async function view(filters: ChatGradesFilters): Promise<ChatGradesView> {
    const [{ modelCounts, matching }, names] = await Promise.all([select(filters), deps.modelNames().catch(() => new Map<string, string>())]);
    const ids = matching.map((chat) => chat.sessionId);
    const grades = deps.store.listFor(ids);
    const gradedIds = grades.filter((grade) => grade.status === "graded" && grade.result).map((grade) => grade.sessionId);
    const titles = await deps.chatTitles(gradedIds);
    const gradedSet = new Set(gradedIds);
    const models: ChatGradesModelOption[] = [...modelCounts.entries()]
      .map(([id, chats]) => ({ id, name: names.get(id) ?? id, chats }))
      .sort((left, right) => right.chats - left.chats || left.name.localeCompare(right.name));
    return {
      matching: matching.length,
      graded: gradedIds.length,
      ungraded: deps.grader.pending(ids, false).length,
      skipped: grades.filter((grade) => grade.status === "skipped" && grade.reason !== "error").length,
      models,
      run: deps.grader.status(),
      report: buildChatGradesReport(
        matching.filter((chat) => gradedSet.has(chat.sessionId)).map((chat) => ({ ...chat, title: titles.get(chat.sessionId) ?? "" })),
        grades,
      ),
    };
  }

  /** Graded chats' units with their Bridge context; excerpts need named chats. */
  async function units(filters: ChatGradesFilters, options: { excerpts?: boolean } = {}): Promise<ChatGradesUnits> {
    const { matching } = await select(filters);
    const grades = deps.store.listFor(matching.map((chat) => chat.sessionId))
      .filter((grade) => grade.status === "graded" && grade.result);
    const gradedIds = new Set(grades.map((grade) => grade.sessionId));
    const graded = matching.filter((chat) => gradedIds.has(chat.sessionId));
    const ids = graded.map((chat) => chat.sessionId);
    const [titles, context, scheduled] = [await deps.chatTitles(ids), deps.chatContext(ids), deps.scheduledSessionIds(ids)];
    const chats: ChatGradesUnitChat[] = graded.map((chat) => ({
      sessionId: chat.sessionId,
      title: titles.get(chat.sessionId) ?? "",
      model: chat.model,
      date: chat.date,
      scheduled: scheduled.has(chat.sessionId),
      ...context.get(chat.sessionId),
    }));
    const all = buildChatGradeUnits(grades);
    if (options.excerpts) {
      for (const sessionId of ids.slice(0, CHAT_GRADES_MAX_EXCERPT_CHATS)) {
        const anchors = new Set(all.flatMap((unit) => (unit.sessionId === sessionId && unit.anchorEventId ? [unit.anchorEventId] : [])));
        if (anchors.size === 0) continue;
        const read = await deps.readEvents(sessionId, EXCERPT_MAX_LOG_BYTES).catch(() => undefined);
        if (read?.kind !== "ok") {
          const chat = chats.find((entry) => entry.sessionId === sessionId);
          if (chat) chat.excerpts = read?.kind === "too-large" ? "too-large" : "unreadable";
          continue;
        }
        const excerpts = excerptsFor(read.events, anchors);
        for (const unit of all) {
          const excerpt = unit.sessionId === sessionId && unit.anchorEventId ? excerpts.get(unit.anchorEventId) : undefined;
          if (excerpt) unit.excerpt = excerpt;
        }
      }
    }
    return { chats, units: all };
  }

  async function startRun(filters: ChatGradesFilters, regrade: boolean): Promise<ChatGradingStart> {
    const { matching } = await select(filters);
    return deps.grader.start(matching.map((chat) => chat.sessionId), { regrade });
  }

  return { view, units, startRun, status: () => deps.grader.status() };
}

export type ChatGradesService = ReturnType<typeof createChatGradesService>;
