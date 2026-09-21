import { join } from "node:path";
import { isBridgeSourceManagementAvailable } from "../distribution-mode.js";
import { requestRestart, RESTART_WHEN_IDLE_NOTE } from "../restart-signal.js";
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

export interface RegisterSelfAdminToolsOptions {
  hiddenTools?: ReadonlySet<string>;
}

export function createSelfAdminToolDefinitions(ctx: AppContext): BridgeToolDefinition[] {
  return [
  defineBridgeTool("self_restart", {
    description: "Restart the Copilot Bridge server WITHOUT code changes (config reload, env changes). For deploying code changes, use staging_init → make changes → staging_deploy instead. The restart is a background request: the launcher swaps the server the next time every session and management job is idle, this session included, and nothing is blocked while it waits. Asking again while a restart is pending joins that restart. RESTRICTED: Only the primary session agent may call this tool. Sub-agents spawned via the task tool must NEVER call this.",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      try {
        await requestRestart(getDataDir(ctx), { validationMode: "operational", source: "self_restart" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return toolFailure("Restart could not be requested.", {
          detail: `The restart signal could not be written in ${getDataDir(ctx)}.\n\n${message}`,
          sessionLog: `Failed to write the restart signal in ${getDataDir(ctx)}: ${message}`,
        });
      }
      ctx.globalBus.emit({ type: "server:restart-changed" });
      return bridgeToolResult({
        success: true,
        toolNextAction: "proceed",
        summary: `Restart requested. ${RESTART_WHEN_IDLE_NOTE}`,
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

      try {
        const job = requireManagementJobStore(ctx).enqueue("self_update", {});
        return queuedManagementJobResult(job, "Self-update");
      } catch (error) {
        const activeJob = getActiveManagementJob(error);
        if (activeJob) {
          return toolFailure(`A ${activeJob.type} management job is ${activeJob.status}.`, {
            detail:
              `Job ${activeJob.id} changes the same checkout as a self-update. `
              + "Ask for the update again once that job has finished.",
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
