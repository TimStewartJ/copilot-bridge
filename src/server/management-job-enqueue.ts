import { existsSync } from "node:fs";
import {
  ActiveManagementJobError,
  isManagementJobType,
  type ManagementJob,
  type ManagementJobStore,
  type ManagementJobType,
} from "./management-job-store.js";
import type { AppContext } from "./app-context.js";
import { isBridgeSourceManagementAvailable } from "./distribution-mode.js";
import { isRestartPending } from "./restart-controller.js";
import { SIGNAL_FILE, resolvePreviewProfile } from "./staging-preview-shared.js";
import { BRIDGE_TOOLS_REPO_ROOT } from "./tools/helpers.js";

export class ManagementJobEnqueueError extends Error {
  readonly statusCode: number;
  readonly activeJob?: ManagementJob;

  constructor(message: string, statusCode: number, activeJob?: ManagementJob) {
    super(message);
    this.name = "ManagementJobEnqueueError";
    this.statusCode = statusCode;
    this.activeJob = activeJob;
  }
}

export interface ManagementJobEnqueueRequest {
  type: string;
  input?: unknown;
}

export interface ManagementJobEnqueueResult {
  job: ManagementJob;
  reused: boolean;
}

// Types whose duplicate enqueue is satisfied by an already-active job with
// the same inputs (see previewInputsReusable for the staging_preview match).
const REUSE_ELIGIBLE_TYPES: readonly ManagementJobType[] = ["self_update", "staging_preview"];

interface NormalizedRequest {
  type: ManagementJobType;
  input: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ManagementJobEnqueueError(`${field} must be a non-empty string.`, 400);
  }
  return value;
}

function requireExistingStagingDir(input: Record<string, unknown>): string {
  const stagingDir = requireString(input.stagingDir, "stagingDir");
  if (!existsSync(stagingDir)) {
    throw new ManagementJobEnqueueError(`Staging directory not found: ${stagingDir}.`, 400);
  }
  return stagingDir;
}

function normalizeRequest(req: ManagementJobEnqueueRequest): NormalizedRequest {
  if (typeof req.type !== "string" || req.type.trim() === "") {
    throw new ManagementJobEnqueueError("type is required.", 400);
  }
  if (!isManagementJobType(req.type)) {
    throw new ManagementJobEnqueueError(`Unsupported management job type "${req.type}".`, 400);
  }
  if (req.input !== undefined && !isRecord(req.input)) {
    throw new ManagementJobEnqueueError("input must be an object.", 400);
  }
  const rawInput = (req.input ?? {}) as Record<string, unknown>;

  switch (req.type) {
    case "self_update": {
      // self_update accepts no fields today; ignore extras to remain
      // forward-compatible with the dispatcher.
      return { type: req.type, input: {} };
    }
    case "staging_preview": {
      const stagingDir = requireExistingStagingDir(rawInput);
      let validate = true;
      if (rawInput.validate !== undefined) {
        if (typeof rawInput.validate !== "boolean") {
          throw new ManagementJobEnqueueError("validate must be a boolean.", 400);
        }
        validate = rawInput.validate;
      }
      const profile = resolvePreviewProfile(
        typeof rawInput.profile === "string" ? rawInput.profile : undefined,
      );
      return { type: req.type, input: { stagingDir, validate, profile } };
    }
    case "staging_deploy": {
      const stagingDir = requireExistingStagingDir(rawInput);
      const message = requireString(rawInput.message, "message");
      return { type: req.type, input: { stagingDir, message } };
    }
  }
}

function previewInputsReusable(active: ManagementJob, requested: Record<string, unknown>): boolean {
  if (!isRecord(active.input)) return false;
  if (active.input.stagingDir !== requested.stagingDir) return false;
  if (active.input.profile !== requested.profile) return false;
  // Require exact validate equality. A validate:true caller cannot accept a
  // validate:false job (no gate), and a validate:false caller should not be
  // tied to a validate:true job that may fail validation and surface as the
  // caller's result.
  const activeValidate = active.input.validate !== false;
  const requestedValidate = requested.validate !== false;
  if (activeValidate !== requestedValidate) return false;
  return true;
}

function isReusableMatch(
  active: ManagementJob,
  type: ManagementJobType,
  input: Record<string, unknown>,
): boolean {
  if (active.type !== type) return false;
  if (type === "self_update") return true;
  if (type === "staging_preview") return previewInputsReusable(active, input);
  return false;
}

function findReusableJob(
  store: ManagementJobStore,
  type: ManagementJobType,
  input: Record<string, unknown>,
): ManagementJob | null {
  if (!REUSE_ELIGIBLE_TYPES.includes(type)) return null;
  return store.listActive([type]).find((job) => isReusableMatch(job, type, input)) ?? null;
}

function applyPreflightGuards(ctx: AppContext, type: ManagementJobType): void {
  if (type === "self_update") {
    const env = ctx.runtimePaths?.env ?? process.env;
    if (!isBridgeSourceManagementAvailable(env, BRIDGE_TOOLS_REPO_ROOT)) {
      throw new ManagementJobEnqueueError(
        "Git self-update is unavailable in packaged release mode.",
        409,
      );
    }
  }
  if (isRestartPending() || existsSync(SIGNAL_FILE)) {
    throw new ManagementJobEnqueueError("A restart is already pending.", 409);
  }
}

export function enqueueManagementJob(
  ctx: AppContext,
  request: ManagementJobEnqueueRequest,
): ManagementJobEnqueueResult {
  const store = ctx.managementJobStore;
  if (!store) {
    throw new ManagementJobEnqueueError("Management job store is not available.", 503);
  }

  const { type, input } = normalizeRequest(request);

  // Check for a reusable active job BEFORE restart-pending so a duplicate
  // request does not get masked by a pending restart that the active job
  // itself initiated.
  const reusable = findReusableJob(store, type, input);
  if (reusable) return { job: reusable, reused: true };

  applyPreflightGuards(ctx, type);

  try {
    return { job: store.enqueue(type, input), reused: false };
  } catch (error) {
    if (error instanceof ActiveManagementJobError) {
      // Race: another caller enqueued between findReusableJob and store.enqueue.
      if (isReusableMatch(error.activeJob, type, input)) {
        return { job: error.activeJob, reused: true };
      }
      throw new ManagementJobEnqueueError(error.message, 409, error.activeJob);
    }
    throw error;
  }
}
