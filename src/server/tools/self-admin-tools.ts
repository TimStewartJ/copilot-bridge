import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { isBridgeSourceManagementAvailable } from "../distribution-mode.js";
import { clearRestartPending, triggerRestartPending } from "../restart-controller.js";
import { isRestartAlreadyInFlight } from "../restart-state.js";
import { writeRestartSignalFile, type RestartReleaseCandidate, type RestartValidationMode } from "../restart-signal.js";
import { bridgeToolResult, toolFailure } from "../tool-results.js";
import type { AppContext } from "../app-context.js";
import { queuedManagementJobResult } from "../management-job-tool-results.js";
import {
  defineBridgeTool,
  registerBridgeToolDefinitions,
} from "../agent-tools-mcp/adapter.js";
import type { BridgeToolDefinition, BridgeToolsMcpServer } from "../agent-tools-mcp/server.js";
import { BRIDGE_TOOLS_REPO_ROOT } from "./helpers.js";
import { ActiveManagementJobError } from "../management-job-store.js";

function getDataDir(ctx: AppContext): string {
  return ctx.runtimePaths?.dataDir ?? join(BRIDGE_TOOLS_REPO_ROOT, "data");
}

function getSignalFile(ctx: AppContext): string {
  return join(getDataDir(ctx), "restart.signal");
}

function isSourceManagementUnavailable(ctx: AppContext): boolean {
  return !isBridgeSourceManagementAvailable(ctx.runtimePaths?.env ?? process.env, BRIDGE_TOOLS_REPO_ROOT);
}

function requireManagementJobStore(ctx: AppContext) {
  if (!ctx.managementJobStore) {
    throw new Error("Management job store is not available.");
  }
  return ctx.managementJobStore;
}

function getActiveManagementJob(error: unknown) {
  if (error instanceof ActiveManagementJobError) return error.activeJob;
  if (typeof error === "object" && error !== null && (error as { name?: unknown }).name === "ActiveManagementJobError") {
    return (error as { activeJob?: unknown }).activeJob as ActiveManagementJobError["activeJob"] | undefined;
  }
  return undefined;
}

function cleanupFailedRestartSignal(signalFile: string): void {
  clearRestartPending();
  try { unlinkSync(signalFile); } catch {}
}

function writeRestartSignalOrRollback(
  signalFile: string,
  validationMode: RestartValidationMode,
  source: string,
  releaseCandidate?: RestartReleaseCandidate,
): number {
  const otherBusy = triggerRestartPending();
  try {
    writeRestartSignalFile(signalFile, { validationMode, source, releaseCandidate });
  } catch (error) {
    cleanupFailedRestartSignal(signalFile);
    throw error;
  }
  return otherBusy;
}

export interface RegisterSelfAdminToolsOptions {
  hiddenTools?: ReadonlySet<string>;
}

export function createSelfAdminToolDefinitions(ctx: AppContext): BridgeToolDefinition[] {
  return [
  defineBridgeTool("self_restart", {
    description: "Restart the Copilot Bridge server WITHOUT code changes (config reload, env changes, emergency restart). For deploying code changes, use staging_init → make changes → staging_deploy instead. The launcher will run operational restart checks, sync dependencies if needed, and swap processes without the full deploy validation gate unless source files changed. IMPORTANT: This session counts as active — after a successful restart signal, do not make further tool calls or you will block the restart. RESTRICTED: Only the primary session agent may call this tool. Sub-agents spawned via the task tool must NEVER call this.",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const signalFile = getSignalFile(ctx);
      if (isRestartAlreadyInFlight(getDataDir(ctx))) {
        return toolFailure("A restart is already pending. Wait for it to complete before restarting.");
      }
      const dataDir = getDataDir(ctx);
      if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

      let otherBusy = 0;
      try {
        otherBusy = writeRestartSignalOrRollback(signalFile, "operational", "self_restart");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return toolFailure("Restart signal could not be written.", {
          detail: `The bridge did not queue a restart because ${signalFile} could not be written.\n\n${message}`,
          sessionLog: `Failed to write restart signal ${signalFile}: ${message}`,
          toolTelemetry: { signalFile },
        });
      }

      const waitNote = otherBusy > 0
        ? ` ${otherBusy} other session(s) are active — the launcher will wait for them to finish (up to 60 min per busy-session check; sessions with no activity for 5 min are treated as stuck).`
        : "";
      return bridgeToolResult({
        success: true,
        terminal: true,
        toolNextAction: "respond",
        retryable: false,
        summary: `Restart signal sent.${waitNote} Stop issuing tools so the current session can become idle and the launcher can restart.`,
      });
    },
  }),
  defineBridgeTool("self_update", {
    description:
      "Pull the latest code from the remote repository and restart the server. " +
      "Use this to update the Copilot Bridge to the latest version without the full staging workflow. " +
      "Saves a rollback checkpoint before pulling so the launcher can sync dependencies, rebuild, health-check, and roll back if needed. " +
      "Returns immediately with a management job id and Bridge-monitored background status. " +
      "RESTRICTED: Only the primary session agent may call this tool. Sub-agents spawned via the task tool must NEVER call this.",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      if (isSourceManagementUnavailable(ctx)) {
        return toolFailure("Git self-update is unavailable in packaged release mode. Use the release update.ps1 script with a published package instead.");
      }

      const signalFile = getSignalFile(ctx);
      if (isRestartAlreadyInFlight(getDataDir(ctx))) {
        return toolFailure("A restart is already pending. Wait for it to complete before updating.");
      }

      const dataDir = getDataDir(ctx);
      if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

      try {
        const job = requireManagementJobStore(ctx).enqueue("self_update", {});
        return queuedManagementJobResult(job, "Self-update");
      } catch (error) {
        const activeJob = getActiveManagementJob(error);
        if (activeJob) {
          return toolFailure("A deploy/update management job is already active.", {
            detail: `Job ${activeJob.id} (${activeJob.type}) is ${activeJob.status}. Wait for it to finish before updating.`,
            toolTelemetry: { activeJobId: activeJob.id, activeJobType: activeJob.type },
          });
        }
        return toolFailure("Self-update could not be queued.", {
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    },
  }),
  ];
}

export function registerSelfAdminTools(
  server: BridgeToolsMcpServer,
  ctx: AppContext,
  options: RegisterSelfAdminToolsOptions = {},
): void {
  const definitions = createSelfAdminToolDefinitions(ctx)
    .filter((tool) => !options.hiddenTools?.has(tool.name));
  registerBridgeToolDefinitions(server, definitions);
}
