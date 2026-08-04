// Single source of truth for "restart/deploy lifecycle work is in flight".
//
// Three surfaces used to answer this question their own way: the restart route
// hand-rolled an active-job lookup next to isRestartAlreadyInFlight(), the
// management-job enqueue path combined a process-local isRestartPending() with
// a bare existsSync(SIGNAL_FILE), and hibernate-on-idle asked nothing at all —
// so the host could suspend mid-cutover. They are one predicate over two
// durable records: the management-job store (a queued/running self_update or
// staging_deploy always ends in a cutover) and the on-disk restart state.
//
// The restart-signal write/rollback pair lives here too. It was copied into
// three modules, and it is the write side of the same predicate: it is what
// makes isRestartAlreadyInFlight() start returning true.

import { unlinkSync } from "node:fs";
import { clearRestartPending, triggerRestartPending } from "./restart-controller.js";
import { isRestartAlreadyInFlight } from "./restart-state.js";
import {
  writeRestartSignalFile,
  type RestartReleaseCandidate,
  type RestartValidationMode,
} from "./restart-signal.js";
import { bridgeToolResult, toolFailure, type BridgeToolControlMetadata } from "./tool-results.js";
import type { ToolResultObject } from "@github/copilot-sdk";
import type { ManagementJob, ManagementJobType } from "./management-job-store.js";

/**
 * Job types that end in a process cutover. An active one owns the lifecycle:
 * nothing else may queue a restart, and the device must not hibernate.
 */
export const LIFECYCLE_EXCLUSIVE_JOB_TYPES: readonly ManagementJobType[] = [
  "self_update",
  "staging_deploy",
];

export type LifecycleBusyState =
  | { reason: "management_job"; job: ManagementJob }
  | { reason: "restart_in_flight" };

/** The slice of ManagementJobStore this predicate needs, so tests can pass a stub. */
export interface LifecycleJobLookup {
  listActive(types?: readonly ManagementJobType[]): ManagementJob[];
}

export interface LifecycleBusyLookup {
  dataDir?: string | null;
  managementJobStore?: LifecycleJobLookup | null;
}

/**
 * Returns why restart/deploy work is in flight, or null when the lifecycle is
 * free. The management-job store is consulted first so callers can name the
 * specific job; a job that has already written its restart signal is reported
 * as the job rather than as a bare pending restart.
 */
export function findLifecycleBusyState(lookup: LifecycleBusyLookup): LifecycleBusyState | null {
  const job = lookup.managementJobStore?.listActive(LIFECYCLE_EXCLUSIVE_JOB_TYPES)[0];
  if (job) return { reason: "management_job", job };
  if (lookup.dataDir && isRestartAlreadyInFlight(lookup.dataDir)) {
    return { reason: "restart_in_flight" };
  }
  return null;
}

/** Sentence-leading description, e.g. "A staging_deploy management job is running". */
export function describeLifecycleBusyState(state: LifecycleBusyState): string {
  return state.reason === "management_job"
    ? `A ${state.job.type} management job is ${state.job.status}`
    : "A restart is already pending";
}

function lifecycleBusyTelemetry(state: LifecycleBusyState): Record<string, unknown> {
  return state.reason === "management_job"
    ? { busyReason: state.reason, activeJobId: state.job.id, activeJobType: state.job.type }
    : { busyReason: state.reason };
}

export type LifecycleBusyToolFailure =
  & ToolResultObject
  & BridgeToolControlMetadata
  & { content: [{ type: "text"; text: string }]; message: string; isError: boolean }
  & Record<string, unknown>;

/**
 * Lifecycle-busy failure with a protocol-level Bridge tool contract.
 *
 * Tells the agent (via terminal + nextAction:"respond" + retryable:false in
 * both the structured fields and the model-visible text) to end its turn
 * rather than polling/sleeping/retrying. Polling keeps the session "active"
 * which itself blocks the launcher's restart cutover — a deadlock the prior
 * "Wait for it to complete" wording inadvertently encouraged.
 */
export function lifecycleBusyToolFailure(options: {
  busy: LifecycleBusyState;
  /** What the user can re-invoke afterwards, e.g. "the deploy". */
  retryTarget: string;
  toolTelemetry?: Record<string, unknown>;
}): LifecycleBusyToolFailure {
  const busyText = describeLifecycleBusyState(options.busy);
  const summary = `${busyText} — end your turn so it can complete.`;
  const detail =
    `${busyText}; this session's continued tool calls are themselves one of the restart blockers. ` +
    "Respond to the user and do not poll, sleep, or retry. " +
    `The user can re-invoke ${options.retryTarget} after it finishes.`;
  return bridgeToolResult({
    ...toolFailure(summary, {
      detail,
      sessionLog: detail,
      toolTelemetry: { ...lifecycleBusyTelemetry(options.busy), ...options.toolTelemetry },
    }),
    isError: true,
    summary,
    terminal: true,
    toolNextAction: "respond" as const,
    retryable: false,
  });
}

export function cleanupFailedRestartSignal(signalFile: string): void {
  clearRestartPending();
  try {
    unlinkSync(signalFile);
  } catch {
    // Best-effort cleanup after a failed signal write.
  }
}

/**
 * Mark the restart pending, then write the signal file. A failed write rolls
 * the pending state back so a restart the launcher will never see cannot leave
 * the server wedged in "restart pending" forever.
 */
export function writeRestartSignalOrRollback(
  signalFile: string,
  validationMode: RestartValidationMode = "deploy",
  source = "staging_deploy",
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
