import { isToolErrorResult, getToolResultDisplayText } from "./tool-results.js";
import { runSelfUpdateJob } from "./self-update-job.js";
import {
  runStagingDeployJob,
  runStagingPreviewJob,
  type StagingDeployJobInput,
  type StagingPreviewJobInput,
} from "./staging-tools.js";
import type { ManagementJob } from "./management-job-store.js";

export interface ManagementJobDispatchOptions {
  log?: (message: string) => void;
}

export class ManagementJobExecutionError extends Error {
  readonly result: unknown;

  constructor(message: string, result: unknown) {
    super(message);
    this.name = "ManagementJobExecutionError";
    this.result = result;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stagingPreviewInput(value: unknown): StagingPreviewJobInput {
  const record = asRecord(value);
  return {
    stagingDir: String(record.stagingDir ?? ""),
    validate: record.validate !== false,
    profile: typeof record.profile === "string" ? record.profile : undefined,
  };
}

function stagingDeployInput(value: unknown): StagingDeployJobInput {
  const record = asRecord(value);
  return {
    stagingDir: String(record.stagingDir ?? ""),
    message: String(record.message ?? ""),
  };
}

function throwIfFailureResult(result: unknown): void {
  if (
    (typeof result === "object" && result !== null && (result as { success?: unknown }).success === false)
    || isToolErrorResult(result)
  ) {
    throw new ManagementJobExecutionError(
      getToolResultDisplayText(result) ?? "Management job failed.",
      result,
    );
  }
}

export async function dispatchManagementJob(
  job: ManagementJob,
  options: ManagementJobDispatchOptions = {},
): Promise<unknown> {
  let result: unknown;
  switch (job.type) {
    case "self_update":
      result = await runSelfUpdateJob(job.input, { log: options.log });
      break;
    case "staging_preview":
      result = await runStagingPreviewJob(stagingPreviewInput(job.input), {
        log: options.log,
        startBackend: false,
        registerInProcess: false,
      });
      break;
    case "staging_deploy":
      result = await runStagingDeployJob(stagingDeployInput(job.input), { log: options.log });
      break;
    default:
      throw new Error(`Unsupported management job type: ${(job as { type?: unknown }).type}`);
  }
  throwIfFailureResult(result);
  return result;
}
