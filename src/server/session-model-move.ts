import { randomUUID } from "node:crypto";
import {
  isCopilotContextTier,
  modelSupportsLongContext,
  modelUsesDynamicSelection,
  type CopilotContextTier,
  type CopilotModelContextMetadata,
} from "../shared/copilot-context.js";
import { isRecord } from "../shared/is-record.js";
import { resolveSupportedReasoningEffort } from "../shared/reasoning-effort.js";
import {
  SESSION_MODEL_MOVE_OUTCOMES,
  type SessionModelMoveCandidate,
  type SessionModelMoveJob,
  type SessionModelMoveOutcome,
  type SessionModelMovePlan,
  type SessionModelMoveRequest,
  type SessionModelMoveResult,
  type SessionModelUsage,
} from "../shared/session-model-move.js";
import { isCanonicalSessionId } from "./outbound-attachments.js";
import type { SessionModelSwitchResult } from "./session-manager.js";

/** Event-log reads for a few hundred chats take seconds; more readers would crowd other file I/O. */
const SCAN_CONCURRENCY = 8;
/**
 * A count is reused this long, so the form that shows it, a dry run and the move that follows read
 * the chats once. A stale entry is harmless: each chat's model is read again right before its switch.
 */
const USAGE_CACHE_MS = 60_000;
/** A dead runtime or a full session cache fails every chat the same way; stop instead of trying them all. */
const MAX_CONSECUTIVE_FAILURES = 3;

export interface SessionModelMoveSessionState {
  model?: string;
  reasoningEffort?: string;
  contextTier?: CopilotContextTier;
}

export interface SessionModelMoverDeps {
  /** Chats that are not archived, in the order a move should take them. */
  listSessions(): Promise<Array<{ sessionId: string; title?: string }>>;
  getSessionModelState(sessionId: string): Promise<SessionModelMoveSessionState>;
  isSessionBusy(sessionId: string): boolean;
  isSessionLoaded(sessionId: string): boolean;
  setSessionModel(
    sessionId: string,
    model: string,
    reasoningEffort?: string,
    contextTier?: CopilotContextTier,
    options?: { compactionDecision?: "compact" },
  ): Promise<SessionModelSwitchResult>;
  /** Unloads a chat the move had to load, so a long move does not leave every chat's processes running. */
  unloadSession(sessionId: string): Promise<unknown>;
  listModels(): Promise<readonly CopilotModelContextMetadata[]>;
  now?: () => number;
  createId?: () => string;
  /** Starts the background work. Tests pass their own to await the returned promise. */
  schedule?: (run: () => Promise<void>) => void;
}

/** The request cannot be carried out as written; the caller should fix it. */
export class SessionModelMoveRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionModelMoveRequestError";
  }
}

/** Only one move runs at a time, since each one loads and unloads chats in the shared runtime. */
export class SessionModelMoveInProgressError extends Error {
  constructor(readonly job: SessionModelMoveJob) {
    super(`A move from ${job.fromModel} to ${job.toModel} is already running`);
    this.name = "SessionModelMoveInProgressError";
  }
}

interface ScannedSession extends SessionModelMoveCandidate {
  model?: string;
}

/**
 * The effort a chat gets on the new model: the one asked for, otherwise its own when the new model
 * supports it, otherwise the nearest the new model has. Undefined leaves the choice to the switch,
 * which carries the chat's effort over.
 */
export function resolveMoveReasoningEffort(
  requested: string | undefined,
  current: string | undefined,
  target: CopilotModelContextMetadata | undefined,
): string | undefined {
  if (requested) return requested;
  if (!target || modelUsesDynamicSelection(target)) return undefined;
  return resolveSupportedReasoningEffort(current, target.supportedReasoningEfforts);
}

/** A chat on long context stays on it when the new model offers it, so the move does not force a compaction. */
export function resolveMoveContextTier(
  requested: CopilotContextTier | undefined,
  current: CopilotContextTier | undefined,
  target: CopilotModelContextMetadata | undefined,
): CopilotContextTier | undefined {
  if (requested) return requested;
  return current === "long_context" && modelSupportsLongContext(target) ? "long_context" : undefined;
}

function emptyCounts(): Record<SessionModelMoveOutcome, number> {
  return Object.fromEntries(SESSION_MODEL_MOVE_OUTCOMES.map((outcome) => [outcome, 0])) as Record<
    SessionModelMoveOutcome,
    number
  >;
}

function snapshot(job: SessionModelMoveJob): SessionModelMoveJob {
  return { ...job, counts: { ...job.counts }, results: job.results.map((result) => ({ ...result })) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Checks the shape of a move request body. Whether the new model exists is the caller's check. */
export function parseSessionModelMoveRequest(
  body: unknown,
): { request: SessionModelMoveRequest } | { error: string } {
  if (!isRecord(body)) return { error: "A JSON body with fromModel and toModel is required" };
  const { fromModel, toModel, reasoningEffort, contextTier, compact, sessionIds, dryRun } = body;
  if (typeof fromModel !== "string" || !fromModel.trim()) return { error: "fromModel must be a non-empty string" };
  if (typeof toModel !== "string" || !toModel.trim()) return { error: "toModel must be a non-empty string" };
  if (fromModel.trim() === toModel.trim()) return { error: "fromModel and toModel must differ" };
  if (reasoningEffort !== undefined && (typeof reasoningEffort !== "string" || !reasoningEffort.trim())) {
    return { error: "reasoningEffort must be a non-empty string" };
  }
  if (contextTier !== undefined && !isCopilotContextTier(contextTier)) {
    return { error: "contextTier must be default or long_context" };
  }
  if (compact !== undefined && typeof compact !== "boolean") return { error: "compact must be a boolean" };
  if (dryRun !== undefined && typeof dryRun !== "boolean") return { error: "dryRun must be a boolean" };
  if (
    sessionIds !== undefined
    && (!Array.isArray(sessionIds) || sessionIds.length === 0 || !sessionIds.every(isCanonicalSessionId))
  ) {
    return { error: "sessionIds must be a non-empty array of session IDs" };
  }
  return {
    request: {
      fromModel: fromModel.trim(),
      toModel: toModel.trim(),
      ...(reasoningEffort ? { reasoningEffort: reasoningEffort.trim() } : {}),
      ...(contextTier ? { contextTier } : {}),
      ...(compact ? { compact } : {}),
      ...(sessionIds ? { sessionIds: sessionIds as string[] } : {}),
      ...(dryRun ? { dryRun } : {}),
    },
  };
}

export function createSessionModelMover(deps: SessionModelMoverDeps) {
  const now = deps.now ?? Date.now;
  const createId = deps.createId ?? randomUUID;
  const schedule = deps.schedule ?? ((run: () => Promise<void>) => { setImmediate(() => { void run(); }); });
  let job: SessionModelMoveJob | undefined;
  let usageScan: { at: number; scan: Promise<ScannedSession[]> } | undefined;

  async function scanSessions(): Promise<ScannedSession[]> {
    const sessions = await deps.listSessions();
    const scanned = new Array<ScannedSession>(sessions.length);
    let next = 0;
    const reader = async () => {
      for (let index = next++; index < sessions.length; index = next++) {
        const session = sessions[index]!;
        let state: SessionModelMoveSessionState = {};
        try {
          state = await deps.getSessionModelState(session.sessionId);
        } catch {
          // Counted as a chat whose model is unknown.
        }
        scanned[index] = {
          sessionId: session.sessionId,
          ...(session.title ? { title: session.title } : {}),
          busy: deps.isSessionBusy(session.sessionId),
          ...(state.model ? { model: state.model } : {}),
          ...(state.reasoningEffort ? { reasoningEffort: state.reasoningEffort } : {}),
          ...(state.contextTier ? { contextTier: state.contextTier } : {}),
        };
      }
    };
    await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, sessions.length) }, reader));
    return scanned;
  }

  function scanSessionsOnce(refresh: boolean): { at: number; scan: Promise<ScannedSession[]> } {
    if (!refresh && usageScan && now() - usageScan.at < USAGE_CACHE_MS) return usageScan;
    const entry = { at: now(), scan: scanSessions() };
    usageScan = entry;
    entry.scan.catch(() => {
      if (usageScan === entry) usageScan = undefined;
    });
    return entry;
  }

  /** Counts the chats that are not archived by the model they are on. */
  async function getUsage(options: { refresh?: boolean } = {}): Promise<SessionModelUsage> {
    const entry = scanSessionsOnce(options.refresh === true);
    const scanned = await entry.scan;
    const scannedAt = new Date(entry.at).toISOString();
    const byModel = new Map<string, { sessionCount: number; busyCount: number }>();
    let unknownCount = 0;
    for (const session of scanned) {
      if (!session.model) {
        unknownCount += 1;
        continue;
      }
      const entry = byModel.get(session.model) ?? { sessionCount: 0, busyCount: 0 };
      entry.sessionCount += 1;
      if (session.busy) entry.busyCount += 1;
      byModel.set(session.model, entry);
    }
    return {
      scannedAt,
      sessionCount: scanned.length,
      unknownCount,
      models: [...byModel]
        .map(([model, entry]) => ({ model, ...entry }))
        .sort((left, right) => right.sessionCount - left.sessionCount || left.model.localeCompare(right.model)),
    };
  }

  function normalizeRequest(request: SessionModelMoveRequest): SessionModelMoveRequest {
    const fromModel = request.fromModel.trim();
    const toModel = request.toModel.trim();
    if (!fromModel || !toModel) throw new SessionModelMoveRequestError("fromModel and toModel are required");
    if (fromModel === toModel) throw new SessionModelMoveRequestError("fromModel and toModel must differ");
    return { ...request, fromModel, toModel };
  }

  /** The chats on the old model as of the latest count. */
  async function findCandidates(request: SessionModelMoveRequest): Promise<ScannedSession[]> {
    const only = request.sessionIds ? new Set(request.sessionIds) : undefined;
    return (await scanSessionsOnce(false).scan)
      .filter((session) => session.model === request.fromModel && (!only || only.has(session.sessionId)));
  }

  async function plan(rawRequest: SessionModelMoveRequest): Promise<SessionModelMovePlan> {
    const request = normalizeRequest(rawRequest);
    const candidates = await findCandidates(request);
    return {
      dryRun: true,
      fromModel: request.fromModel,
      toModel: request.toModel,
      sessions: candidates.map(({ model: _model, ...candidate }) => candidate),
    };
  }

  function record(active: SessionModelMoveJob, result: SessionModelMoveResult): void {
    active.results.push(result);
    active.counts[result.outcome] += 1;
    active.processed += 1;
    active.updatedAt = new Date(now()).toISOString();
  }

  async function moveOne(
    active: SessionModelMoveJob,
    candidate: ScannedSession,
    target: CopilotModelContextMetadata | undefined,
  ): Promise<SessionModelMoveResult> {
    const { sessionId } = candidate;
    const base = { sessionId, ...(candidate.title ? { title: candidate.title } : {}) };
    if (deps.isSessionBusy(sessionId)) return { ...base, outcome: "busy" };

    // The scan can be minutes old by now, and the chat may have been switched by hand since.
    let state: SessionModelMoveSessionState;
    try {
      state = await deps.getSessionModelState(sessionId);
    } catch (error) {
      return { ...base, outcome: "failed", detail: `Its current model could not be read: ${errorMessage(error)}` };
    }
    if (state.model !== active.fromModel) {
      return {
        ...base,
        outcome: "changed",
        detail: state.model ? `Now on ${state.model}` : "Its current model could not be read",
      };
    }

    const previous = {
      ...(state.reasoningEffort ? { previousReasoningEffort: state.reasoningEffort } : {}),
      ...(state.contextTier ? { previousContextTier: state.contextTier } : {}),
    };
    const reasoningEffort = resolveMoveReasoningEffort(active.reasoningEffort, state.reasoningEffort, target);
    const contextTier = resolveMoveContextTier(active.contextTier, state.contextTier, target);
    const wasLoaded = deps.isSessionLoaded(sessionId);
    try {
      let result = await deps.setSessionModel(sessionId, active.toModel, reasoningEffort, contextTier);
      if (result.status === "confirmation_required") {
        const { currentTokens, targetLimit } = result.confirmation;
        if (!active.compact) {
          return {
            ...base,
            outcome: "needs-compaction",
            detail: `${currentTokens.toLocaleString("en-US")} tokens, and ${active.toModel} takes ${targetLimit.toLocaleString("en-US")}`,
          };
        }
        result = await deps.setSessionModel(sessionId, active.toModel, reasoningEffort, contextTier, {
          compactionDecision: "compact",
        });
      }
      if (result.status === "confirmation_required" || result.status === "cancelled") {
        return {
          ...base,
          outcome: "failed",
          detail: (result.status === "cancelled" ? result.warning : undefined) ?? "The runtime did not apply the switch",
        };
      }
      return { ...base, outcome: "moved", ...previous };
    } catch (error) {
      const message = errorMessage(error);
      // A turn that started between the check above and the switch.
      return /busy/i.test(message) ? { ...base, outcome: "busy" } : { ...base, outcome: "failed", detail: message };
    } finally {
      if (!wasLoaded) {
        await deps.unloadSession(sessionId).catch((error: unknown) => {
          console.warn(`[model-move] [${sessionId.slice(0, 8)}] Could not unload the chat: ${errorMessage(error)}`);
        });
      }
    }
  }

  async function run(active: SessionModelMoveJob, candidates: ScannedSession[]): Promise<void> {
    let target: CopilotModelContextMetadata | undefined;
    try {
      target = (await deps.listModels()).find((model) => model.id === active.toModel);
    } catch {
      // Without the catalog each chat's effort and context are carried over as they are.
    }

    let consecutiveFailures = 0;
    for (const candidate of candidates) {
      if (active.cancelRequested) {
        active.status = "cancelled";
        break;
      }
      active.currentSessionId = candidate.sessionId;
      let result: SessionModelMoveResult;
      try {
        result = await moveOne(active, candidate, target);
      } catch (error) {
        result = {
          sessionId: candidate.sessionId,
          ...(candidate.title ? { title: candidate.title } : {}),
          outcome: "failed",
          detail: errorMessage(error),
        };
      }
      record(active, result);
      consecutiveFailures = result.outcome === "failed" ? consecutiveFailures + 1 : 0;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && active.processed < active.total) {
        active.status = "stopped";
        active.stopReason = `${MAX_CONSECUTIVE_FAILURES} chats in a row failed. The last error: ${result.detail ?? "unknown"}`;
        break;
      }
    }

    if (active.status === "running") active.status = "completed";
    delete active.currentSessionId;
    active.completedAt = new Date(now()).toISOString();
    active.updatedAt = active.completedAt;
    usageScan = undefined;
    const { counts } = active;
    console.log(
      `[model-move] ${active.status}: ${active.fromModel} -> ${active.toModel}, ${counts.moved} moved, `
      + `${counts.busy} busy, ${counts["needs-compaction"]} need compaction, ${counts.changed} changed, `
      + `${counts.failed} failed, ${active.total - active.processed} not tried`,
    );
  }

  function getRunningJob(): SessionModelMoveJob | undefined {
    return job?.status === "running" ? job : undefined;
  }

  function assertNoMoveRunning(): void {
    const running = getRunningJob();
    if (running) throw new SessionModelMoveInProgressError(snapshot(running));
  }

  /** Starts a move and returns at once; `getJob` reports progress. */
  async function start(rawRequest: SessionModelMoveRequest): Promise<SessionModelMoveJob> {
    assertNoMoveRunning();
    const request = normalizeRequest(rawRequest);
    const candidates = await findCandidates(request);
    // Another request may have started a move while this one was reading the chats.
    assertNoMoveRunning();

    const startedAt = new Date(now()).toISOString();
    const active: SessionModelMoveJob = {
      id: createId(),
      status: candidates.length > 0 ? "running" : "completed",
      fromModel: request.fromModel,
      toModel: request.toModel,
      ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
      ...(request.contextTier ? { contextTier: request.contextTier } : {}),
      compact: request.compact === true,
      startedAt,
      updatedAt: startedAt,
      ...(candidates.length > 0 ? {} : { completedAt: startedAt }),
      total: candidates.length,
      processed: 0,
      counts: emptyCounts(),
      cancelRequested: false,
      results: [],
    };
    job = active;
    if (candidates.length > 0) {
      console.log(`[model-move] started: ${active.fromModel} -> ${active.toModel}, ${candidates.length} chat(s)`);
      schedule(() => run(active, candidates));
    }
    return snapshot(active);
  }

  function getJob(): SessionModelMoveJob | undefined {
    return job ? snapshot(job) : undefined;
  }

  /** Stops a running move after the chat it is switching; chats already moved stay moved. */
  function cancel(): SessionModelMoveJob | undefined {
    const running = getRunningJob();
    if (running) {
      running.cancelRequested = true;
      running.updatedAt = new Date(now()).toISOString();
    }
    return getJob();
  }

  return { getUsage, plan, start, getJob, cancel };
}

export type SessionModelMover = ReturnType<typeof createSessionModelMover>;
