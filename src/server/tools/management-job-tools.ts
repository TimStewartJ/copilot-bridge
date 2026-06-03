import type { AppContext } from "../app-context.js";
import {
  defineBridgeTool,
  registerBridgeToolDefinitions,
} from "../agent-tools-mcp/adapter.js";
import type { BridgeToolDefinition, BridgeToolsMcpServer } from "../agent-tools-mcp/server.js";
import { bridgeToolResult, getToolResultDisplayText, toolFailure, type BridgeToolNextAction } from "../tool-results.js";
import type { ManagementJob } from "../management-job-store.js";
import { formatManagementJobDeferGuidance } from "../management-job-tool-results.js";

export interface RegisterManagementJobToolsOptions {
  hiddenTools?: ReadonlySet<string>;
}

const MANAGEMENT_JOB_STALE_AFTER_MS = 5 * 60_000;
const TERMINAL_MANAGEMENT_JOB_STATUSES = new Set(["succeeded", "failed", "cancelled"]);

function isStaleRunningJob(job: ManagementJob, now = Date.now()): boolean {
  if (job.status !== "running") return false;
  const rawHeartbeat = job.heartbeatAt ?? job.startedAt;
  if (!rawHeartbeat) return true;
  const heartbeatAt = Date.parse(rawHeartbeat);
  return !Number.isFinite(heartbeatAt) || now - heartbeatAt >= MANAGEMENT_JOB_STALE_AFTER_MS;
}

function getJobResultSummary(job: ManagementJob): string | undefined {
  const displayText = getToolResultDisplayText(job.result);
  if (displayText) return displayText;
  if (!job.result || typeof job.result !== "object") return undefined;
  const result = job.result as { message?: unknown; previewUrl?: unknown; previewPath?: unknown; commitSha?: unknown };
  if (typeof result.message === "string" && result.message.trim()) return result.message.trim();
  if (typeof result.previewUrl === "string" && result.previewUrl.trim()) return `Preview is ready: ${result.previewUrl.trim()}`;
  if (typeof result.previewPath === "string" && result.previewPath.trim()) return `Preview is ready at ${result.previewPath.trim()}`;
  if (typeof result.commitSha === "string" && result.commitSha.trim()) return `Deployment completed at ${result.commitSha.trim()}.`;
  return undefined;
}

function getManagementJobContract(job: ManagementJob): {
  summary: string;
  terminal: boolean;
  toolNextAction: BridgeToolNextAction;
  retryable: boolean;
  pollAfterMs?: number;
  stalled?: boolean;
} {
  if (isStaleRunningJob(job)) {
    return {
      summary: `Management job ${job.id} (${job.type}) appears stalled. Stop checking status and report the stuck job to the user.`,
      terminal: true,
      toolNextAction: "respond",
      retryable: true,
      stalled: true,
    };
  }
  if (TERMINAL_MANAGEMENT_JOB_STATUSES.has(job.status)) {
    const outcome = job.status === "succeeded"
      ? "succeeded"
      : job.status === "failed" ? "failed" : "was cancelled";
    const resultSummary = job.status === "succeeded"
      ? getJobResultSummary(job)
      : job.error ?? getJobResultSummary(job);
    return {
      summary: [
        `Management job ${job.id} (${job.type}) ${outcome}. This status is terminal.`,
        resultSummary,
      ].filter(Boolean).join("\n"),
      terminal: true,
      toolNextAction: "respond",
      retryable: job.status !== "succeeded",
    };
  }
  return {
    summary:
      `Management job ${job.id} (${job.type}) is ${job.status}. ` +
      `Wait for the background runner; do not issue marker or no-op tools. ${formatManagementJobDeferGuidance(job.id, "status")}`,
    terminal: false,
    toolNextAction: "wait",
    retryable: false,
  };
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
        const contract = getManagementJobContract(job);
        return bridgeToolResult({
          success: true,
          ...contract,
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
        });
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
