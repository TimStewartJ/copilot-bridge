import type { AppContext } from "../app-context.js";
import {
  defineBridgeTool,
  registerBridgeToolDefinitions,
} from "../agent-tools-mcp/adapter.js";
import type { BridgeToolDefinition, BridgeToolsMcpServer } from "../agent-tools-mcp/server.js";
import { toolFailure } from "../tool-results.js";

export interface RegisterManagementJobToolsOptions {
  hiddenTools?: ReadonlySet<string>;
}

function createManagementJobToolDefinitions(ctx: AppContext): BridgeToolDefinition[] {
  return [
    defineBridgeTool("management_job_status", {
      description:
        "Check the status of a background management job such as self_update, staging_preview, or staging_deploy. " +
        "Returns status, result/error, timestamps, and a sanitized log tail.",
      parameters: {
        type: "object",
        properties: {
          jobId: { type: "string", description: "Management job id returned by the queued tool." },
          logTailBytes: { type: "number", description: "Optional maximum log tail bytes. Defaults to 16384." },
        },
        required: ["jobId"],
      },
      handler: async (args: any) => {
        const jobId = String(args.jobId ?? "").trim();
        if (!jobId) {
          return toolFailure("Missing management job id.");
        }
        const store = ctx.managementJobStore;
        if (!store) {
          return toolFailure("Management job store is not available.");
        }
        const job = store.get(jobId);
        if (!job) {
          return toolFailure("Management job not found.", {
            detail: `No management job exists with id ${jobId}.`,
            toolTelemetry: { jobId },
          });
        }
        const maxBytes = Number.isInteger(args.logTailBytes) && args.logTailBytes > 0
          ? Math.min(Number(args.logTailBytes), 64 * 1024)
          : undefined;
        return {
          success: true,
          jobId: job.id,
          type: job.type,
          status: job.status,
          result: job.result,
          error: job.error,
          logTail: store.readLogTail(job, maxBytes),
          createdAt: job.createdAt,
          updatedAt: job.updatedAt,
          startedAt: job.startedAt,
          completedAt: job.completedAt,
          heartbeatAt: job.heartbeatAt,
          runnerPid: job.runnerPid,
          cancelRequestedAt: job.cancelRequestedAt,
        };
      },
    }),
  ];
}

export function registerManagementJobTools(
  server: BridgeToolsMcpServer,
  ctx: AppContext,
  options: RegisterManagementJobToolsOptions = {},
): void {
  const definitions = createManagementJobToolDefinitions(ctx)
    .filter((tool) => !options.hiddenTools?.has(tool.name));
  registerBridgeToolDefinitions(server, definitions);
}
