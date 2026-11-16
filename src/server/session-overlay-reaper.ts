import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AppContext } from "./app-context.js";
import type { BridgeSessionState } from "./bridge-session-state-store.js";

const DEFAULT_MINIMUM_AGE_MS = 24 * 60 * 60 * 1000;

export type SessionOverlayReaperReason =
  | "exists_in_cli_catalog"
  | "exists_on_disk"
  | "cli_catalog_unavailable"
  | "task_link"
  | "trigger_reference"
  | "trigger_run_history"
  | "outbox_message"
  | "trigger"
  | "active_session"
  | "pending_user_input"
  | "event_bus"
  | "too_recent"
  | "invalid_updated_at";

export interface SessionOverlayReaperRow {
  sessionId: string;
  decision: "reap" | "retain";
  reasons: SessionOverlayReaperReason[];
  existsInCliCatalog: boolean;
  existsOnDisk: boolean;
  updatedAt: string;
  fields: string[];
}

export interface SessionOverlayReaperReport {
  dryRun: boolean;
  minimumAgeMs: number;
  scanned: number;
  retained: number;
  wouldReap: number;
  reaped: number;
  skippedDuringApply: number;
  reasonCounts: Record<string, number>;
  rows: SessionOverlayReaperRow[];
  deletedTriggerRuns: {
    wouldDelete: number;
    deleted: number;
  };
}

export interface SessionOverlayReaperOptions {
  dryRun?: boolean;
  cleanupDeletedTriggerRuns?: boolean;
  minimumAgeMs?: number;
}

interface ReaperReferences {
  cliCatalogAvailable: boolean;
  cliSessionIds: Set<string>;
  taskSessionIds: Set<string>;
  triggerSessionIds: Set<string>;
  triggerRunSessionIds: Set<string>;
  activeSessionIds: Set<string>;
}

export function getCopilotHome(ctx: AppContext): string {
  return ctx.copilotHome ?? ctx.runtimePaths?.copilotHome ?? join(homedir(), ".copilot");
}

function sessionExistsOnDisk(ctx: AppContext, sessionId: string): boolean {
  return existsSync(join(getCopilotHome(ctx), "session-state", sessionId));
}

function summarizeFields(state: BridgeSessionState): string[] {
  const fields: string[] = [];
  if (state.archived) fields.push("archived");
  if (state.archivedAt) fields.push("archivedAt");
  if (state.titleOverride) fields.push("titleOverride");
  if (state.titleOverrideUpdatedAt) fields.push("titleOverrideUpdatedAt");
  if (state.pinnedCwd) fields.push("pinnedCwd");
  if (state.pinnedCwdUpdatedAt) fields.push("pinnedCwdUpdatedAt");
  if (state.triggeredBy) fields.push("triggeredBy");
  if (state.scheduleId) fields.push("scheduleId");
  if (state.scheduleName) fields.push("scheduleName");
  if (state.lastVisibleActivityAt) fields.push("lastVisibleActivityAt");
  if (state.lastAttentionAt) fields.push("lastAttentionAt");
  if (state.hiddenReason) fields.push("hiddenReason");
  if (state.hiddenAt) fields.push("hiddenAt");
  if (state.pendingAutoName) fields.push("pendingAutoName");
  if (state.pendingAutoNameReplaceTitle) fields.push("pendingAutoNameReplaceTitle");
  return fields;
}

async function getReferences(ctx: AppContext): Promise<ReaperReferences> {
  const catalogSessions = await ctx.cliSessionCatalog?.listSessions();
  const taskSessionIds = new Set<string>();
  for (const task of ctx.taskStore.listTasks()) {
    for (const sessionId of task.sessionIds) taskSessionIds.add(sessionId);
  }

  const triggerSessionIds = new Set<string>();
  for (const trigger of ctx.triggerStore?.list({ includeInactive: true }) ?? []) {
    if (trigger.lastSessionId) triggerSessionIds.add(trigger.lastSessionId);
  }
  const sessionManager = ctx.sessionManager as unknown as {
    getActiveSessions?: () => string[];
  };

  return {
    cliCatalogAvailable: catalogSessions !== undefined,
    cliSessionIds: new Set((catalogSessions ?? []).map((session) => session.sessionId)),
    taskSessionIds,
    triggerSessionIds,
    triggerRunSessionIds: new Set(ctx.triggerStore?.listRunSessionIds() ?? []),
    activeSessionIds: new Set(sessionManager.getActiveSessions?.() ?? []),
  };
}

function hasPendingUserInput(ctx: AppContext, sessionId: string): boolean {
  const sessionManager = ctx.sessionManager as unknown as {
    getPendingUserInputCount?: (sessionId: string) => number;
  };
  return (sessionManager.getPendingUserInputCount?.(sessionId) ?? 0) > 0;
}

function classifyState(
  ctx: AppContext,
  state: BridgeSessionState,
  refs: ReaperReferences,
  cutoff: number,
): SessionOverlayReaperRow {
  const reasons: SessionOverlayReaperReason[] = [];
  const sessionId = state.sessionId;
  const existsInCliCatalog = refs.cliSessionIds.has(sessionId);
  const existsOnDisk = sessionExistsOnDisk(ctx, sessionId);
  const updatedAtMs = Date.parse(state.updatedAt);

  if (existsInCliCatalog) reasons.push("exists_in_cli_catalog");
  if (existsOnDisk) reasons.push("exists_on_disk");
  if (!refs.cliCatalogAvailable && !existsOnDisk) reasons.push("cli_catalog_unavailable");
  if (refs.taskSessionIds.has(sessionId)) reasons.push("task_link");
  if (refs.triggerSessionIds.has(sessionId)) reasons.push("trigger_reference");
  if (refs.triggerRunSessionIds.has(sessionId)) reasons.push("trigger_run_history");
  if (ctx.deferredPromptStore?.hasActiveForSession(sessionId)) reasons.push("outbox_message");
  if (ctx.triggerStore?.hasActiveForSession(sessionId)) reasons.push("trigger");
  if (refs.activeSessionIds.has(sessionId)) reasons.push("active_session");
  if (hasPendingUserInput(ctx, sessionId)) reasons.push("pending_user_input");
  if (ctx.eventBusRegistry.hasBus(sessionId)) reasons.push("event_bus");
  if (!Number.isFinite(updatedAtMs)) {
    reasons.push("invalid_updated_at");
  } else if (updatedAtMs > cutoff) {
    reasons.push("too_recent");
  }

  return {
    sessionId,
    decision: reasons.length === 0 ? "reap" : "retain",
    reasons,
    existsInCliCatalog,
    existsOnDisk,
    updatedAt: state.updatedAt,
    fields: summarizeFields(state),
  };
}

function countReasons(rows: SessionOverlayReaperRow[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    for (const reason of row.reasons) {
      counts[reason] = (counts[reason] ?? 0) + 1;
    }
  }
  return counts;
}

export async function runSessionOverlayReaper(
  ctx: AppContext,
  options: SessionOverlayReaperOptions = {},
): Promise<SessionOverlayReaperReport> {
  const dryRun = options.dryRun ?? true;
  const minimumAgeMs = options.minimumAgeMs ?? DEFAULT_MINIMUM_AGE_MS;
  const cutoff = Date.now() - minimumAgeMs;
  const states = Object.values(ctx.bridgeSessionStateStore.listStates());
  const refs = await getReferences(ctx);
  const rows = states
    .map((state) => classifyState(ctx, state, refs, cutoff))
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  const reaperRows = rows.filter((row) => row.decision === "reap");
  let reaped = 0;
  let skippedDuringApply = 0;

  if (!dryRun) {
    for (const row of reaperRows) {
      const current = ctx.bridgeSessionStateStore.getState(row.sessionId);
      if (!current || current.updatedAt !== row.updatedAt) {
        skippedDuringApply += 1;
        continue;
      }

      const refreshedRefs = await getReferences(ctx);
      const refreshed = classifyState(ctx, current, refreshedRefs, cutoff);
      if (refreshed.decision !== "reap") {
        skippedDuringApply += 1;
        continue;
      }

      ctx.bridgeSessionStateStore.deleteState(row.sessionId);
      reaped += 1;
    }
  }

  const wouldDeleteTriggerRuns = ctx.triggerStore?.countRunsForDeletedTriggers() ?? 0;
  const deletedTriggerRuns = !dryRun && options.cleanupDeletedTriggerRuns === true
    ? ctx.triggerStore?.deleteRunsForDeletedTriggers() ?? 0
    : 0;

  return {
    dryRun,
    minimumAgeMs,
    scanned: rows.length,
    retained: rows.length - reaperRows.length,
    wouldReap: reaperRows.length,
    reaped,
    skippedDuringApply,
    reasonCounts: countReasons(rows),
    rows,
    deletedTriggerRuns: {
      wouldDelete: wouldDeleteTriggerRuns,
      deleted: deletedTriggerRuns,
    },
  };
}
