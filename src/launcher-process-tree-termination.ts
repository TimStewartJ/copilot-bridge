import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import {
  deadlineExpired,
  settleByDeadline,
  sleepUntilDeadline,
  type Deadline,
} from "./server/deadline.js";
import {
  terminateProcessTree,
  type ProcessIdentity,
  type ProcessTreeSnapshot,
  type ProcessTreeTerminationResult,
} from "./server/platform.js";

export const PROCESS_TREE_TERMINATION_REQUEST = "bridge-process-tree-termination-request";
export const PROCESS_TREE_TERMINATION_RESULT = "bridge-process-tree-termination-result";
export const PROCESS_TREE_TERMINATION_ACK = "bridge-process-tree-termination-ack";
export const PROCESS_TREE_TERMINATION_HELPER_MODE = "--bridge-process-tree-termination-helper";

export type ProcessTreeTerminationRequest = {
  type: typeof PROCESS_TREE_TERMINATION_REQUEST;
  root: ProcessIdentity;
  deadlineUnixMs: number;
};

export type ProcessTreeTerminationResponse = {
  type: typeof PROCESS_TREE_TERMINATION_RESULT;
  attempts: number;
  result: ProcessTreeTerminationResult;
};

export type ProcessTreeTerminationHelperLaunch = {
  command: string;
  args: string[];
  cwd: string;
};

type FixpointDependencies = {
  terminateProcessTree: typeof terminateProcessTree;
  waitBeforeRetry: typeof sleepUntilDeadline;
};

type ExternalHelperDependencies = {
  spawn: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => ChildProcess;
};

const defaultFixpointDependencies: FixpointDependencies = {
  terminateProcessTree,
  waitBeforeRetry: sleepUntilDeadline,
};

const defaultExternalHelperDependencies: ExternalHelperDependencies = {
  spawn,
};

function identityKey(identity: ProcessIdentity): string {
  return `${identity.pid}:${identity.startMarker}`;
}

function addIdentity(
  identities: Map<string, ProcessIdentity>,
  identity: ProcessIdentity,
): void {
  identities.set(identityKey(identity), identity);
}

function addSnapshot(
  identities: Map<string, ProcessIdentity>,
  snapshot: ProcessTreeSnapshot | undefined,
): void {
  if (!snapshot) return;
  addIdentity(identities, snapshot.root);
  for (const descendant of snapshot.descendants) addIdentity(identities, descendant);
}

function aggregateSnapshot(
  root: ProcessIdentity,
  identities: Map<string, ProcessIdentity>,
): ProcessTreeSnapshot {
  return {
    root,
    descendants: [...identities.values()].filter((identity) => identityKey(identity) !== identityKey(root)),
  };
}

function deadlineFailure(
  root: ProcessIdentity,
  identities: Map<string, ProcessIdentity>,
  lastFailure?: ProcessTreeTerminationResult,
): ProcessTreeTerminationResult {
  return {
    ok: false,
    status: "deadline-exceeded",
    root,
    snapshot: aggregateSnapshot(root, identities),
    ...(lastFailure && !lastFailure.ok && lastFailure.survivors
      ? { survivors: lastFailure.survivors }
      : {}),
    ...(lastFailure && !lastFailure.ok && lastFailure.error
      ? { error: lastFailure.error }
      : {}),
  };
}

export function isProcessTreeTerminationRequest(
  message: unknown,
): message is ProcessTreeTerminationRequest {
  if (!message || typeof message !== "object") return false;
  const candidate = message as Partial<ProcessTreeTerminationRequest>;
  return candidate.type === PROCESS_TREE_TERMINATION_REQUEST
    && Number.isSafeInteger(candidate.root?.pid)
    && (candidate.root?.pid ?? 0) > 0
    && typeof candidate.root?.startMarker === "string"
    && candidate.root.startMarker.length > 0
    && typeof candidate.deadlineUnixMs === "number"
    && Number.isFinite(candidate.deadlineUnixMs);
}

function isProcessTreeTerminationResponse(
  message: unknown,
  root: ProcessIdentity,
): message is ProcessTreeTerminationResponse {
  if (!message || typeof message !== "object") return false;
  const candidate = message as Partial<ProcessTreeTerminationResponse>;
  const result = candidate.result;
  const validStatus = result?.ok
    ? ["already-exited", "identity-replaced", "terminated"].includes(result.status)
    : [
        "invalid-identity",
        "snapshot-unavailable",
        "identity-unavailable",
        "deadline-exceeded",
        "kill-failed",
        "survivors",
        "unverified",
      ].includes(result?.status ?? "");
  return candidate.type === PROCESS_TREE_TERMINATION_RESULT
    && Number.isSafeInteger(candidate.attempts)
    && (candidate.attempts ?? 0) > 0
    && result?.root?.pid === root.pid
    && result.root.startMarker === root.startMarker
    && typeof result.ok === "boolean"
    && validStatus;
}

/**
 * The first attempt is the existing identity-safe one-shot termination. Only a
 * failed verification seeds another pass over the captured surviving identities.
 */
export async function runProcessTreeTerminationFixpoint(
  root: ProcessIdentity,
  deadline: Deadline,
  dependencies: FixpointDependencies = defaultFixpointDependencies,
): Promise<ProcessTreeTerminationResponse> {
  const tracked = new Map<string, ProcessIdentity>();
  const pending = new Map<string, ProcessIdentity>();
  addIdentity(tracked, root);
  addIdentity(pending, root);
  let attempts = 0;
  let firstResult: ProcessTreeTerminationResult | undefined;
  let lastFailure: ProcessTreeTerminationResult | undefined;
  let uncertainty: string | undefined;

  while (pending.size > 0) {
    if (deadlineExpired(deadline)) {
      return {
        type: PROCESS_TREE_TERMINATION_RESULT,
        attempts,
        result: deadlineFailure(root, tracked, lastFailure),
      };
    }

    const next = pending.entries().next().value as [string, ProcessIdentity] | undefined;
    if (!next) break;
    const [key, identity] = next;
    pending.delete(key);

    const settlement = await settleByDeadline(
      () => dependencies.terminateProcessTree(identity, deadline),
      deadline,
    );
    if (settlement.status === "timed-out") {
      return {
        type: PROCESS_TREE_TERMINATION_RESULT,
        attempts,
        result: deadlineFailure(root, tracked, lastFailure),
      };
    }
    if (settlement.status === "rejected") {
      return {
        type: PROCESS_TREE_TERMINATION_RESULT,
        attempts,
        result: {
          ok: false,
          status: "snapshot-unavailable",
          root,
          snapshot: aggregateSnapshot(root, tracked),
          error: settlement.error instanceof Error
            ? settlement.error.message
            : String(settlement.error),
        },
      };
    }

    attempts += 1;
    const result = settlement.value;
    firstResult ??= result;
    addSnapshot(tracked, result.snapshot);
    if (result.ok) {
      if (result.status !== "terminated" || !result.snapshot) {
        uncertainty ??= `A captured process became ${result.status} before a complete snapshot could be verified.`;
      }
      if (result.snapshot) {
        pending.delete(identityKey(result.snapshot.root));
        for (const descendant of result.snapshot.descendants) {
          pending.delete(identityKey(descendant));
        }
      }
      continue;
    }

    lastFailure = result;
    if (
      result.status === "invalid-identity"
      || result.status === "snapshot-unavailable"
      || result.status === "identity-unavailable"
      || result.status === "deadline-exceeded"
      || result.status === "unverified"
    ) {
      uncertainty ??= result.error
        ?? `Process-tree state became uncertain after ${result.status}.`;
    }
    for (const survivor of result.survivors ?? []) addIdentity(tracked, survivor);
    const retry = result.survivors?.length
      ? result.survivors
      : result.snapshot
        ? [result.snapshot.root, ...result.snapshot.descendants]
        : [identity];
    for (const candidate of retry) {
      addIdentity(tracked, candidate);
      addIdentity(pending, candidate);
    }
    if (!(await dependencies.waitBeforeRetry(25, deadline))) {
      return {
        type: PROCESS_TREE_TERMINATION_RESULT,
        attempts,
        result: deadlineFailure(root, tracked, lastFailure),
      };
    }
  }

  if (uncertainty) {
    return {
      type: PROCESS_TREE_TERMINATION_RESULT,
      attempts,
      result: {
        ok: false,
        status: "unverified",
        root,
        snapshot: aggregateSnapshot(root, tracked),
        error: uncertainty,
      },
    };
  }

  return {
    type: PROCESS_TREE_TERMINATION_RESULT,
    attempts,
    result: attempts === 1 && firstResult?.ok
      ? firstResult
      : {
          ok: true,
          status: "terminated",
          root,
          snapshot: aggregateSnapshot(root, tracked),
        },
  };
}

function helperFailure(
  root: ProcessIdentity,
  status: "snapshot-unavailable" | "deadline-exceeded",
  error: string,
): ProcessTreeTerminationResult {
  return { ok: false, status, root, error };
}

export async function terminateProcessTreeWithExternalFixpoint(
  root: ProcessIdentity,
  deadline: Deadline,
  launch: ProcessTreeTerminationHelperLaunch,
  dependencies: ExternalHelperDependencies = defaultExternalHelperDependencies,
): Promise<ProcessTreeTerminationResult> {
  if (deadlineExpired(deadline)) {
    return helperFailure(root, "deadline-exceeded", "deadline exceeded before external termination helper");
  }

  let child: ChildProcess;
  try {
    child = dependencies.spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      detached: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
    });
  } catch (error) {
    return helperFailure(
      root,
      "snapshot-unavailable",
      `external termination helper could not start: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const response = await settleByDeadline(
    () => new Promise<ProcessTreeTerminationResult>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        reject(new Error(`external termination helper exited before reporting a result (${code ?? signal ?? "unknown"})`));
      };
      const onMessage = (message: unknown) => {
        if (!isProcessTreeTerminationResponse(message, root)) return;
        child.send?.({ type: PROCESS_TREE_TERMINATION_ACK }, (error) => {
          if (error) {
            reject(error);
            return;
          }
          child.off("error", onError);
          child.off("exit", onExit);
          child.off("message", onMessage);
          resolve(message.result);
        });
      };
      child.once("error", onError);
      child.once("exit", onExit);
      child.on("message", onMessage);
      if (typeof child.send !== "function") {
        reject(new Error("external termination helper has no IPC channel"));
        return;
      }
      child.send({
        type: PROCESS_TREE_TERMINATION_REQUEST,
        root,
        deadlineUnixMs: deadline.expiresAtUnixMs,
      } satisfies ProcessTreeTerminationRequest, (error) => {
        if (error) reject(error);
      });
    }),
    deadline,
  );

  if (child.connected) child.disconnect();
  child.unref();

  if (response.status === "fulfilled") {
    if (!response.value.ok) return response.value;
    // Repeated snapshots are observation, not containment. Without assigning
    // the server tree to a Windows Job Object before termination, a child can
    // escape between snapshots, so cleanup success must not authorize restart.
    return {
      ok: false,
      status: "unverified",
      root,
      snapshot: response.value.snapshot,
      error: "External process-tree cleanup did not establish OS containment for descendants created during termination.",
    };
  }
  if (response.status === "timed-out") {
    child.kill();
    return helperFailure(root, "deadline-exceeded", "external termination helper did not report before the deadline");
  }
  return helperFailure(
    root,
    "snapshot-unavailable",
    `external termination helper failed: ${
      response.error instanceof Error ? response.error.message : String(response.error)
    }`,
  );
}
