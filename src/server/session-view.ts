import type { AppContext } from "./app-context.js";
import type { Task } from "./task-store.js";
import type { SessionWorkspace } from "./session-workspace-store.js";
import {
  resolveAvailableWorkspaceCwdAsync,
  type WorkspaceAvailability,
  type WorkspaceAvailabilityLookup,
} from "./session-workspace-availability.js";
import { getNeutralWorkspaceDir, isImplicitHostCwd, isNeutralWorkspaceCwd } from "./neutral-workspace.js";

export type SessionWorkspaceSource = "session_workspace" | "workspace_yaml" | "task" | "bridge_workspace" | "none";
export type SessionWorkspaceWarningCode = "missing_workspace" | "missing_pinned_workspace" | "cleared_pinned_workspace";

export interface SessionWorkspaceWarningPayload {
  code: SessionWorkspaceWarningCode;
  message: string;
}

export interface SessionWorkspaceSummaryPayload {
  effectiveCwd?: string;
  taskCwd?: string;
  sessionOverride?: { cwd: string; updatedAt: string };
  overridesTaskWorkspace: boolean;
  warnings?: SessionWorkspaceWarningPayload[];
}

export type SessionWorkspaceSummaryWithSource = SessionWorkspaceSummaryPayload & { source: SessionWorkspaceSource };

export function getPersistedRunNotice(ctx: AppContext, sessionId: string) {
  const terminal = ctx.sessionMetaStore.getTerminalOverlay(sessionId);
  if (!terminal?.notice) return undefined;
  return {
    ...terminal.notice,
    ...(terminal.type === "error" && terminal.notice.kind === "error"
      ? { retryRunId: terminal.terminalSourceEventId ? terminal.runId : undefined }
      : {}),
  };
}

export function getSessionStatus(ctx: AppContext, sessionId: string) {
  const runState = ctx.sessionManager.getSessionRunState(sessionId);
  const pendingUserInputCount = ctx.sessionManager.getPendingUserInputCount(sessionId);
  const runNotice = runState === "idle" ? getPersistedRunNotice(ctx, sessionId) : undefined;
  return {
    runState,
    pendingUserInputCount,
    needsUserInput: pendingUserInputCount > 0,
    backgroundAgents: ctx.sessionManager.getBackgroundAgentsSummary(sessionId),
    ...(runNotice ? { runNotice } : {}),
    ...(ctx.sessionManager.getSessionAgentMode(sessionId) === "autopilot" ? { agentMode: "autopilot" as const } : {}),
  };
}

export function normalizeWorkspacePathForComparison(cwd: string): string {
  const normalized = cwd.trim().replace(/\\/g, "/");
  if (normalized === "/" || /^[A-Za-z]:\/$/.test(normalized)) return normalized.toLowerCase();
  return normalized.replace(/\/+$/, "").toLowerCase();
}

export function composeSessionWorkspaceSummary(
  ctx: AppContext,
  sessionId: string,
  resolved: {
    sessionOverride: SessionWorkspace | undefined;
    overrideAvailability: WorkspaceAvailability | undefined;
    recordedCwd: string | undefined;
    taskCwd: string | undefined;
  },
): SessionWorkspaceSummaryWithSource {
  const { sessionOverride, overrideAvailability, recordedCwd, taskCwd } = resolved;
  const warnings: SessionWorkspaceWarningPayload[] = [];
  if (sessionOverride && overrideAvailability && !overrideAvailability.available && overrideAvailability.clearStalePin) {
    ctx.sessionWorkspaceStore?.deleteWorkspace(sessionId);
    warnings.push({
      code: "cleared_pinned_workspace",
      message: `Pinned session workspace was cleared because it is no longer available: ${overrideAvailability.cwd}`,
    });
  }
  const overrideCwd = overrideAvailability?.available ? overrideAvailability.cwd : undefined;
  const explicitRecordedCwd = isImplicitHostCwd(recordedCwd, ctx.runtimePaths) ? undefined : recordedCwd;
  const effectiveCwd = overrideCwd ?? explicitRecordedCwd ?? taskCwd ?? getNeutralWorkspaceDir(ctx.runtimePaths);
  const source: SessionWorkspaceSource = isNeutralWorkspaceCwd(effectiveCwd, ctx.runtimePaths)
    ? "bridge_workspace"
    : overrideCwd ? "session_workspace" : explicitRecordedCwd ? "workspace_yaml" : taskCwd ? "task" : "none";
  return {
    effectiveCwd,
    taskCwd,
    sessionOverride: sessionOverride && overrideCwd
      ? { cwd: sessionOverride.cwd, updatedAt: sessionOverride.updatedAt }
      : undefined,
    overridesTaskWorkspace: !!overrideCwd && !!taskCwd
      && normalizeWorkspacePathForComparison(overrideCwd) !== normalizeWorkspacePathForComparison(taskCwd),
    ...(warnings.length > 0 ? { warnings } : {}),
    source,
  };
}

export async function buildSessionWorkspaceSummaryForList(
  ctx: AppContext,
  sessionId: string,
  inputs: {
    sessionOverride: SessionWorkspace | undefined;
    recordedCwd: string | undefined;
    task: Pick<Task, "cwd"> | null | undefined;
    getAvailability: WorkspaceAvailabilityLookup;
  },
): Promise<SessionWorkspaceSummaryWithSource> {
  // The list displays a neutral workspace without recreating it during a read.
  const getAvailability: WorkspaceAvailabilityLookup = async (cwd) => isNeutralWorkspaceCwd(cwd ?? undefined, ctx.runtimePaths)
    ? { cwd: cwd!.trim(), available: true, clearStalePin: false }
    : await inputs.getAvailability(cwd);
  const [overrideAvailability, recordedCwd, taskCwd] = await Promise.all([
    getAvailability(inputs.sessionOverride?.cwd),
    resolveAvailableWorkspaceCwdAsync(inputs.recordedCwd, getAvailability),
    resolveAvailableWorkspaceCwdAsync(inputs.task?.cwd ?? undefined, inputs.getAvailability),
  ]);
  return composeSessionWorkspaceSummary(ctx, sessionId, {
    sessionOverride: inputs.sessionOverride, overrideAvailability, recordedCwd, taskCwd,
  });
}
