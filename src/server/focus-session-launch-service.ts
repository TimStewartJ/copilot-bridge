import type { AppContext } from "./app-context.js";
import { createDeadline } from "./deadline.js";
import { captureProcessIdentity, getProcessIdentityStatus, type ProcessIdentity } from "./platform.js";
import { isRestartCutoverInProgress, refreshRestartState } from "./restart-controller.js";
import { FeedCardValidationError } from "./feed-store.js";
import { focusEnum, focusFingerprint, focusRecord, focusText, isOpenLifecycle } from "./focus-details-store.js";
import {
  FocusLaunchConflictError, isStartupRecoverableFocusLaunch,
  type FocusLaunchErrorStage, type FocusLaunchIdentity, type FocusSessionCreationOptions,
  type FocusSessionLaunch, type FocusSessionLaunchStore,
} from "./focus-session-launch-store.js";

export interface FocusLaunchRequest extends FocusLaunchIdentity {
  taskId?: string | null;
  prompt?: string;
}
export function parseFocusLaunchRequest(value: unknown): FocusLaunchRequest {
  const input = focusRecord(value, ["objectId", "activationId", "source", "taskId", "prompt"]);
  return {
    objectId: focusText(input.objectId, "objectId")!,
    activationId: focusText(input.activationId, "activationId")!,
    source: focusEnum(input.source, "source", ["launch_prompt", "discussion"] as const),
    ...(input.taskId === undefined ? {} : { taskId: focusText(input.taskId, "taskId", true) }),
    ...(input.prompt === undefined ? {} : { prompt: focusText(input.prompt, "prompt")! }),
  };
}

class FocusLaunchSubjectChangedError extends FocusLaunchConflictError {}
const activeLaunchClaims = new Set<string>();
type LaunchContext = Pick<AppContext, "sessionManager" | "taskStore" | "taskGroupStore" | "focusMutationCoordinator" | "focusAttentionStore">;
export interface FocusLaunchServiceOptions {
  getOwner?: () => Promise<ProcessIdentity | null>;
  getOwnerStatus?: (owner: ProcessIdentity) => Promise<"alive" | "exited" | "replaced" | "unknown">;
}
export interface FocusLaunchStartupRecoveryStats {
  selected: number;
  recovered: number;
  unrecovered: number;
  skippedPrepared: number;
  skippedInspectOnly: number;
  /** Eligible receipts beyond the first batch or deferred by restart cutover/read failure. */
  deferred: number;
  stopped: number;
  error: string | null;
}

export function createFocusSessionLaunchService(
  ctx: LaunchContext, store: FocusSessionLaunchStore, options: FocusLaunchServiceOptions = {},
) {
  const inFlight = new Map<string, Promise<FocusSessionLaunch>>();
  let startupRecovery: Promise<FocusLaunchStartupRecoveryStats> | undefined;
  let owner: ProcessIdentity | undefined;
  let accepting = true;

  async function getOwner(): Promise<ProcessIdentity> {
    if (!owner) {
      const observed = await (options.getOwner?.() ?? captureProcessIdentity(process.pid, createDeadline(5_000)));
      if (!observed) throw new Error("Cannot establish process identity for a safe Focus launch claim");
      owner = observed;
    }
    return owner;
  }
  function currentSubject(identity: FocusLaunchIdentity) {
    const object = ctx.focusMutationCoordinator.getAny(identity.objectId);
    if (!object || object.activationId !== identity.activationId || !isOpenLifecycle(object.lifecycle)) {
      throw new FocusLaunchSubjectChangedError("This Focus episode is no longer open/current; its launch receipt remains inspectable");
    }
    return object;
  }
  function assertDestination(taskId: string | null): string | null {
    if (taskId === null) return null;
    const task = ctx.taskStore.getTask(taskId);
    if (!task || task.status !== "active" || task.muted) {
      throw new FeedCardValidationError("Focus session destination must be an active, unmuted task or explicit taskId:null");
    }
    return task.title;
  }
  function resolveTaskId(input: FocusLaunchRequest, routeTaskId?: string | null): string | null {
    if (routeTaskId !== undefined && input.taskId !== undefined && input.taskId !== routeTaskId) {
      throw new FocusLaunchConflictError("Focus launch taskId must match the session-creation route");
    }
    if (routeTaskId !== undefined) return routeTaskId;
    if (input.taskId !== undefined) return input.taskId;
    const existing = store.find(input);
    if (existing) return existing.taskId;
    const object = currentSubject(input);
    if (input.source === "launch_prompt" && object.action?.taskId !== undefined) return object.action.taskId;
    if (object.taskState === "active") return object.taskId;
    if (object.taskState === "global") return null;
    throw new FeedCardValidationError("This Focus source has no visible default destination; supply an active taskId or explicit taskId:null");
  }
  function prepare(
    inputValue: FocusLaunchRequest, creationOptions?: FocusSessionCreationOptions, routeTaskId?: string | null,
  ) {
    const input = parseFocusLaunchRequest(inputValue);
    const existing = store.find(input);
    const taskId = resolveTaskId(input, routeTaskId);
    if (existing) {
      const fingerprint = focusFingerprint({
        prompt: input.prompt ?? existing.prompt, taskId, creationOptions: creationOptions ?? existing.creationOptions,
      });
      if (fingerprint !== existing.promptFingerprint) {
        throw new FocusLaunchConflictError("This episode/source already has a launch with different prompt, destination or session options");
      }
      return { receipt: existing, created: false };
    }
    const object = currentSubject(input);
    const taskTitle = assertDestination(taskId);
    if (input.source === "launch_prompt" && !object.action) throw new FeedCardValidationError("This object has no launch prompt");
    const prompt = input.prompt ?? (input.source === "launch_prompt"
      ? object.action!.prompt
      : `Discuss this ${object.objectType}: ${object.title}\n\n${object.body ?? ""}\n\nFocus object: ${object.id}\nEpisode: ${object.activationId}`);
    const resolvedOptions = creationOptions ?? {};
    return store.prepare({
      ...input, objectType: object.objectType, objectTitle: object.title, taskId, taskTitle, prompt,
      creationOptions: resolvedOptions, promptFingerprint: focusFingerprint({ prompt, taskId, creationOptions: resolvedOptions }),
    });
  }
  function record(receipt: FocusSessionLaunch, reason: string) {
    ctx.focusAttentionStore.record({
      eventType: "session_launch", objectId: receipt.objectId, objectType: receipt.objectType, activationId: receipt.activationId,
      actor: "user", reason, details: { receiptId: receipt.id, status: receipt.status, sessionId: receipt.sessionId, error: receipt.error },
    });
  }
  async function createSession(receipt: FocusSessionLaunch, token: string): Promise<{ sessionId: string }> {
    const sessionOptions = {
      ...receipt.creationOptions, expectedSessionId: receipt.expectedSessionId,
      onCreateStarting: () => {
        currentSubject(receipt);
        assertDestination(receipt.taskId);
        store.markDispatched(receipt.id, token);
      },
    };
    if (receipt.taskId === null) return ctx.sessionManager.createSession(sessionOptions);
    const task = ctx.taskStore.getTask(receipt.taskId);
    if (!task) throw new FeedCardValidationError("Focus launch destination task was deleted");
    const group = task.groupId ? ctx.taskGroupStore.getGroup(task.groupId) : undefined;
    return ctx.sessionManager.createTaskSession(
      task.id, task.title, task.workItems, task.pullRequests.map((pr) => `${pr.repoName || pr.repoId} PR #${pr.prId}`),
      task.notes, task.cwd, undefined, group?.notes?.trim() ? { groupName: group.name, notes: group.notes } : null,
      sessionOptions,
    );
  }

  async function run(id: string, recoverCreatedOnly: boolean): Promise<FocusSessionLaunch> {
    let receipt = store.requireReceipt(id);
    // A queued startup candidate may have changed since the bounded scan.
    if (recoverCreatedOnly && !isStartupRecoverableFocusLaunch(receipt)) return receipt;
    if (receipt.status === "ready" || receipt.status === "superseded"
      || (receipt.status === "unknown" && receipt.errorStage === "prompt")) return receipt;
    const currentOwner = await getOwner();
    if (receipt.ownerToken) {
      if (receipt.ownerPid === null || receipt.ownerStartMarker === null) {
        throw new FocusLaunchConflictError("Focus launch ownership is incomplete; refusing to duplicate session creation");
      }
      const identity = { pid: receipt.ownerPid, startMarker: receipt.ownerStartMarker };
      if (identity.pid === currentOwner.pid && identity.startMarker === currentOwner.startMarker) {
        if (activeLaunchClaims.has(receipt.ownerToken)) return store.requireReceipt(id);
      } else {
        const status = await (options.getOwnerStatus?.(identity) ?? getProcessIdentityStatus(identity, createDeadline(5_000)));
        if (status === "alive" || status === "unknown") return store.requireReceipt(id);
      }
    }
    if (recoverCreatedOnly && !accepting) return store.requireReceipt(id);
    const claimed = store.claim(receipt, currentOwner);
    if (!claimed) return store.requireReceipt(id);
    receipt = claimed;
    const token = claimed.ownerToken!;
    activeLaunchClaims.add(token);
    let stage: FocusLaunchErrorStage = receipt.sessionId ? "link" : "creation";
    try {
      currentSubject(receipt);
      assertDestination(receipt.taskId);
      if (!receipt.sessionId) {
        const presence = await ctx.sessionManager.getSessionCreationState(receipt.expectedSessionId);
        if (presence === "pending") {
          return store.fail(id, token, "unknown", "creation", "The expected session is still pending; inspect or reconcile this receipt without creating another session");
        }
        if (presence === "present") receipt = store.markCreated(id, token, receipt.expectedSessionId);
        else {
          // Absence cannot disprove a dispatched RPC still executing in the old
          // backend. Never blindly replay that ambiguous external creation.
          if (receipt.creationDispatchedAt !== null) {
            return store.fail(id, token, "unknown", "creation", "Session creation was dispatched but its result is unknown; no duplicate creation was attempted");
          }
          currentSubject(receipt);
          assertDestination(receipt.taskId);
          const result = await createSession(receipt, token);
          receipt = store.markCreated(id, token, result.sessionId);
        }
      }
      stage = "link";
      currentSubject(receipt);
      assertDestination(receipt.taskId);
      if (receipt.taskId) ctx.taskStore.linkSession(receipt.taskId, receipt.sessionId!);
      // Session launch acknowledges an active episode, preserving any existing
      // Action handoff. Launching does not create a handoff or resolve the source.
      ctx.focusMutationCoordinator.linkLaunchedSession(receipt.objectId, receipt.sessionId!, receipt.activationId, "user");
      receipt = store.markLinked(id, token);
      stage = "prompt";
      if (receipt.promptStatus !== "pending") {
        return store.fail(id, token, "unknown", stage, "Initial prompt delivery is unconfirmed; inspect the existing session instead of replaying it");
      }
      if (!ctx.sessionManager.isSessionWarm(receipt.sessionId!)) await ctx.sessionManager.warmSession(receipt.sessionId!);
      currentSubject(receipt);
      assertDestination(receipt.taskId);
      receipt = store.claimPrompt(id, token);
      await ctx.sessionManager.startWorkAndWaitForDelivery(receipt.sessionId!, receipt.prompt, undefined, {
        clientMessageId: `focus-launch:${receipt.id}`,
      });
      receipt = store.complete(id, token);
      record(receipt, "launch-ready");
      return receipt;
    } catch (error) {
      const latest = store.requireReceipt(id);
      if (latest.ownerToken !== token) throw error;
      const ambiguous = (stage === "creation" && latest.creationDispatchedAt !== null)
        || (stage === "prompt" && latest.promptStatus !== "pending");
      receipt = store.fail(id, token, error instanceof FocusLaunchSubjectChangedError ? "superseded" : ambiguous ? "unknown" : "failed",
        stage, error instanceof Error ? error.message : String(error));
      console.warn(`[focus-launch] ${id} ${stage}: ${receipt.error}`);
      record(receipt, "launch-failed");
      return receipt;
    } finally {
      activeLaunchClaims.delete(token);
    }
  }

  function startOperation(id: string, recoverCreatedOnly = false): Promise<FocusSessionLaunch> {
    if (!accepting) return Promise.reject(new Error("Focus session launch service is shutting down"));
    const existing = inFlight.get(id);
    if (existing) return existing;
    const operation = run(id, recoverCreatedOnly).finally(() => {
      if (inFlight.get(id) === operation) inFlight.delete(id);
    });
    inFlight.set(id, operation);
    return operation;
  }
  async function recoverStartup(): Promise<FocusLaunchStartupRecoveryStats> {
    const stats: FocusLaunchStartupRecoveryStats = {
      selected: 0, recovered: 0, unrecovered: 0, skippedPrepared: 0, skippedInspectOnly: 0,
      deferred: 0, stopped: 0, error: null,
    };
    if (!accepting) return stats;
    try {
      const { receipts, ...skipped } = store.getStartupRecoveryBatch();
      Object.assign(stats, skipped, { selected: receipts.length });
      for (const [index, candidate] of receipts.entries()) {
        if (!accepting) {
          stats.stopped = receipts.length - index;
          break;
        }
        const restarting = isRestartCutoverInProgress(await refreshRestartState());
        if (!accepting) {
          stats.stopped = receipts.length - index;
          break;
        }
        if (restarting) {
          stats.deferred += receipts.length - index;
          break;
        }
        try {
          const receipt = await startOperation(candidate.id, true);
          if (receipt.status === "ready") stats.recovered += 1;
          else stats.unrecovered += 1;
        } catch (error) {
          stats.unrecovered += 1;
          console.warn(`[focus-launch] Startup recovery ${candidate.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } catch (error) {
      stats.error = error instanceof Error ? error.message : String(error);
      stats.deferred += stats.selected - stats.recovered - stats.unrecovered;
      console.warn(`[focus-launch] Startup recovery failed: ${stats.error}`);
    }
    if (stats.selected || stats.skippedPrepared || stats.skippedInspectOnly || stats.error) {
      console.log(`[focus-launch] Startup recovery: ${JSON.stringify(stats)}`);
    }
    return stats;
  }
  function reconcileStartup(): Promise<FocusLaunchStartupRecoveryStats> {
    // One owned pass after SDK readiness, never an unbounded retry loop. Keeping
    // this promise lets shutdown stop queued candidates and drain current work.
    startupRecovery ??= Promise.resolve().then(recoverStartup);
    return startupRecovery;
  }
  return {
    prepare, resolveTaskId, start: (id: string) => startOperation(id), reconcileStartup,
    get: store.get, find: store.find, list: store.list,
    stop: () => { accepting = false; },
    drain: async () => {
      const outcomes = await Promise.allSettled([startupRecovery, ...inFlight.values()]);
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") throw outcome.reason;
      }
    },
  };
}
export type FocusSessionLaunchService = ReturnType<typeof createFocusSessionLaunchService>;
