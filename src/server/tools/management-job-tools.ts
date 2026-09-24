import type { AppContext } from "../app-context.js";
import {
  defineBridgeTool,
  registerBridgeToolDefinitions,
} from "../agent-tools-mcp/adapter.js";
import type { BridgeToolDefinition, BridgeToolsMcpServer } from "../agent-tools-mcp/server.js";
import { bridgeToolResult, toolFailure, type BridgeToolNextAction } from "../tool-results.js";
import type { ManagementJob } from "../management-job-store.js";
import { managementJobWaitGuidance } from "../management-job-tool-results.js";
import {
  getManagementJobResultSummary,
  isFinalManagementJob,
  managementJobDeliveryId,
} from "../management-job-delivery.js";
import { isRecord } from "../../shared/is-record.js";
import { readActiveRelease } from "../release-slots.js";

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

function isDeployReleaseActive(job: ManagementJob, dataDir: string | undefined): boolean {
  if (job.type !== "staging_deploy" || !dataDir || !isRecord(job.result)) return false;
  const candidate = job.result.releaseCandidate;
  if (!isRecord(candidate) || typeof candidate.id !== "string" || typeof candidate.commitSha !== "string") return false;
  const active = readActiveRelease(dataDir);
  return active?.id === candidate.id && active.commitSha === candidate.commitSha;
}

function isAwaitingDeployActivation(job: ManagementJob, dataDir?: string): boolean {
  return job.type === "staging_deploy"
    && job.status === "succeeded"
    && isRecord(job.result)
    && !isDeployReleaseActive(job, dataDir)
    && (
      job.result.restartDeferred === true
      || (job.result.restartQueued === true && job.result.restartActivated !== true)
    );
}

function getManagementJobContract(job: ManagementJob, dataDir?: string, sessionId?: string): {
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
  if (isDeployReleaseActive(job, dataDir)) {
    return {
      summary: `Management job ${job.id} (${job.type}) activated release ${String((job.result as any).commitSha ?? "")}. The restart is complete.`,
      terminal: true,
      toolNextAction: "respond",
      retryable: false,
    };
  }
  if (isAwaitingDeployActivation(job, dataDir)) {
    return {
      summary: `Management job ${job.id} (${job.type}) is waiting for its shared batch restart to activate. ${managementJobWaitGuidance(job, sessionId ?? "")}`,
      terminal: false,
      toolNextAction: "wait",
      retryable: false,
    };
  }
  if (TERMINAL_MANAGEMENT_JOB_STATUSES.has(job.status)) {
    const outcome = job.status === "succeeded"
      ? "succeeded"
      : job.status === "failed" ? "failed" : "was cancelled";
    const resultSummary = job.status === "succeeded"
      ? getManagementJobResultSummary(job)
      : job.error ?? getManagementJobResultSummary(job);
    return {
      summary: [
        `Management job ${job.id} (${job.type}) ${outcome}. This status is terminal.`,
        resultSummary,
      ].filter(Boolean).join("\n"),
      terminal: true,
      toolNextAction: job.type === "staging_preview" && job.status === "succeeded"
        ? "proceed"
        : "respond",
      retryable: job.status !== "succeeded",
    };
  }
  return {
    summary:
      `Management job ${job.id} (${job.type}) is ${job.status}. ` +
      `Wait for the background runner; do not issue marker or no-op tools. ${managementJobWaitGuidance(job, sessionId ?? "")}`,
    terminal: false,
    toolNextAction: "wait",
    retryable: false,
  };
}

/**
 * Where the job's result stands for the session that queued it. When that session reads a final
 * status here, the result it would otherwise be sent is withdrawn: it already has it.
 */
function describeResultDelivery(
  ctx: AppContext,
  job: ManagementJob,
  sessionId: string | undefined,
): { status: string; error?: string } | undefined {
  if (!job.originSessionId) return undefined;
  if (sessionId === job.originSessionId && isFinalManagementJob(job)) {
    try {
      ctx.managementJobStore?.markResultSeen(job);
    } catch (error) {
      console.error(`[management-jobs] Could not withdraw the result of job ${job.id}:`, error);
    }
  }
  const delivery = ctx.deferredPromptStore?.get(managementJobDeliveryId(job.id));
  if (!delivery) return { status: isFinalManagementJob(job) ? "not-queued" : "waiting-for-job" };
  return {
    status: delivery.status,
    ...(delivery.lastError ? { error: delivery.lastError } : {}),
  };
}

const RESULT_DELIVERY_TEXT: Record<string, string> = {
  "waiting-for-job": "Bridge will send the final result to the session that queued this job when it finishes.",
  pending: "Bridge has queued the final result for the session that queued this job; it is sent once that session is idle.",
  running: "Bridge is sending the final result to the session that queued this job now.",
  completed: "The session that queued this job already has its final result.",
  cancelled: "The final result was not sent: the session that queued this job was archived.",
  "not-queued": "The final result was not queued for the session that queued this job (the session was archived).",
};

function describeResultDeliveryForAgent(delivery: { status: string; error?: string }): string {
  if (delivery.status === "failed") {
    return `Bridge could not send the final result to the session that queued this job${delivery.error ? `: ${delivery.error}` : "."}`;
  }
  return RESULT_DELIVERY_TEXT[delivery.status] ?? `Result delivery status: ${delivery.status}.`;
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
          jobId: { type: ["string", "number"], description: "Management job id returned by the queued tool." },
          logTailBytes: { type: "number", description: "Optional maximum log tail bytes. Defaults to 16384." },
        },
        required: ["jobId"],
      },
      handler: async (args: any, invocation) => {
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
        const contract = getManagementJobContract(job, ctx.runtimePaths?.dataDir, invocation.sessionId);
        const resultDelivery = describeResultDelivery(ctx, job, invocation.sessionId);
        return bridgeToolResult({
          success: true,
          ...contract,
          summary: resultDelivery
            ? `${contract.summary}\n${describeResultDeliveryForAgent(resultDelivery)}`
            : contract.summary,
          ...(resultDelivery ? { resultDelivery } : {}),
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
