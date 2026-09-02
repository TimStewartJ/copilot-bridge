import { join, relative } from "node:path";
import type { AppContext } from "../app-context.js";
import {
  defineSessionBridgeTool,
  registerBridgeToolDefinitions,
} from "../agent-tools-mcp/adapter.js";
import type { BridgeToolDefinition, BridgeToolsMcpServer } from "../agent-tools-mcp/server.js";
import { readGitWorktreeStatus } from "../git-worktree-status.js";
import { isPathAtOrUnder } from "../path-utils.js";
import { bridgeToolResult, toolFailure, toolFailureWithContext } from "../tool-results.js";

export interface RegisterGitWorktreeToolsOptions {
  hiddenTools?: ReadonlySet<string>;
}

interface WorkspaceUpdate {
  from: string;
  to: string;
}

function releaseDestination(worktreePath: string, mainWorktreePath: string, cwd: string): string {
  const relativePath = relative(worktreePath, cwd);
  return relativePath ? join(mainWorktreePath, relativePath) : mainWorktreePath;
}

function workspaceUpdate(
  worktreePath: string,
  mainWorktreePath: string,
  cwd: string | undefined,
): WorkspaceUpdate | null {
  const trimmed = cwd?.trim();
  if (!trimmed || !isPathAtOrUnder(worktreePath, trimmed)) return null;
  return {
    from: trimmed,
    to: releaseDestination(worktreePath, mainWorktreePath, trimmed),
  };
}

export function createGitWorktreeToolDefinitions(ctx: AppContext): BridgeToolDefinition[] {
  return [
    defineSessionBridgeTool("git_worktree_release", {
      description:
        "Release a linked Git worktree from Bridge task and session workspace references without deleting files or changing Git. " +
        "Repoints matching references to the repository's main worktree. After releasing the invoking session, end the current turn before removing the worktree externally.",
      parameters: {
        type: "object",
        properties: {
          worktreePath: {
            type: "string",
            description: "Path inside the linked worktree to release. Defaults to the invoking session's effective workspace.",
          },
        },
      },
      handler: async (args: any, invocation) => {
        const explicitPath = typeof args.worktreePath === "string" ? args.worktreePath.trim() : "";
        const currentSessionCwd = explicitPath
          ? undefined
          : ctx.sessionManager.getEffectiveSessionCwd(invocation.sessionId);
        const requestedPath = explicitPath || currentSessionCwd;
        if (!requestedPath) {
          return toolFailure(
            "worktreePath is required when the invoking session has no effective workspace.",
          );
        }

        const status = await readGitWorktreeStatus(requestedPath);
        if (status.status === "not_repo") {
          return toolFailure(`Path is not inside a Git worktree: ${requestedPath}`);
        }
        if (status.status === "unavailable") {
          return toolFailure("Git worktree status is unavailable.", {
            detail: status.error,
            toolTelemetry: { requestedPath },
          });
        }
        if (status.workspaceKind === "main") {
          return toolFailure("The main Git worktree cannot be released.", {
            detail: `Resolved main worktree: ${status.worktreePath}`,
            toolTelemetry: { requestedPath, worktreePath: status.worktreePath },
          });
        }

        const taskUpdates = ctx.taskStore.listTasks()
          .map((task) => {
            const update = workspaceUpdate(status.worktreePath, status.repoRoot, task.cwd);
            return update ? { task, update } : null;
          })
          .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

        const pinnedWorkspaces = ctx.sessionWorkspaceStore.listWorkspaces();
        const candidateSessionIds = new Set<string>([
          invocation.sessionId,
          ...Object.keys(pinnedWorkspaces),
        ]);
        for (const { task } of taskUpdates) {
          for (const sessionId of task.sessionIds) candidateSessionIds.add(sessionId);
        }

        const sessionUpdates = new Map<string, WorkspaceUpdate>();
        for (const sessionId of candidateSessionIds) {
          const pinnedCwd = pinnedWorkspaces[sessionId]?.cwd;
          const effectiveCwd = pinnedCwd ?? ctx.sessionManager.getEffectiveSessionCwd(sessionId);
          const update = workspaceUpdate(status.worktreePath, status.repoRoot, effectiveCwd);
          if (update) sessionUpdates.set(sessionId, update);
        }

        const blockedSessionIds = [...sessionUpdates.keys()].filter(
          (sessionId) =>
            sessionId !== invocation.sessionId
            && ctx.sessionManager.isSessionBusy(sessionId),
        );
        if (blockedSessionIds.length > 0) {
          return toolFailureWithContext(
            "Worktree references cannot be released while another affected session is busy.",
            {
              worktreePath: status.worktreePath,
              mainWorktreePath: status.repoRoot,
              blockedSessionIds,
            },
            {
              detail: "Wait for the listed sessions to become idle, then call git_worktree_release again. No references were changed.",
              toolTelemetry: {
                worktreePath: status.worktreePath,
                blockedSessionCount: blockedSessionIds.length,
              },
            },
          );
        }

        for (const [sessionId, update] of sessionUpdates) {
          ctx.sessionManager.setSessionWorkspace(sessionId, update.to, {
            allowDuringActiveTurn: sessionId === invocation.sessionId,
          });
        }
        for (const { task, update } of taskUpdates) {
          ctx.taskStore.updateTask(task.id, { cwd: update.to });
        }

        const invokingSessionReleased = sessionUpdates.has(invocation.sessionId);
        const changed = taskUpdates.length > 0 || sessionUpdates.size > 0;
        const requiresTurnBoundary = sessionUpdates.size > 0;
        const baseSummary = changed
          ? `Released linked worktree ${status.worktreePath} from ${taskUpdates.length} task(s) and ${sessionUpdates.size} session(s). Git and files were not changed.`
          : `No Bridge task or session workspace references use linked worktree ${status.worktreePath}. Git and files were not changed.`;
        const summary = requiresTurnBoundary
          ? `${baseSummary} End this turn before removing the worktree so affected session handles can be evicted.`
          : baseSummary;

        return bridgeToolResult({
          success: true,
          changed,
          terminal: requiresTurnBoundary,
          toolNextAction: requiresTurnBoundary ? "respond" : "proceed",
          summary,
          worktreePath: status.worktreePath,
          mainWorktreePath: status.repoRoot,
          invokingSessionReleased,
          tasks: taskUpdates.map(({ task, update }) => ({
            taskId: task.id,
            title: task.title,
            from: update.from,
            to: update.to,
          })),
          sessions: [...sessionUpdates].map(([sessionId, update]) => ({
            sessionId,
            from: update.from,
            to: update.to,
          })),
        });
      },
    }),
  ];
}

export function registerGitWorktreeTools(
  server: BridgeToolsMcpServer,
  ctx: AppContext,
  options: RegisterGitWorktreeToolsOptions = {},
): void {
  const definitions = createGitWorktreeToolDefinitions(ctx)
    .filter((tool) => !options.hiddenTools?.has(tool.name));
  registerBridgeToolDefinitions(server, definitions);
}
