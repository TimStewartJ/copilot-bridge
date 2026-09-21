import { join } from "node:path";
import type { AppContext } from "./app-context.js";
import { isRecord } from "../shared/is-record.js";
import { readPendingRestartSignal } from "./restart-signal.js";
import { readRestartState, RESTART_STATE_FILE_NAME } from "./restart-state.js";

export type RestartStatusPhase = "idle" | "waiting" | "restarting";

export interface RestartStatus {
  phase: RestartStatusPhase;
  /** When the pending restart was first asked for. */
  requestedAt: string | null;
}

/**
 * What the UI shows about a restart. Nothing else reads it, because a pending restart never refuses
 * or delays work: the launcher swaps the server only once the Bridge is idle, and the server
 * confirms that in the same step as it stops (POST /api/shutdown with ifIdle).
 */
export async function readRestartStatus(dataDir: string): Promise<RestartStatus> {
  const [signal, state] = await Promise.all([
    readPendingRestartSignal(dataDir),
    readRestartState(join(dataDir, RESTART_STATE_FILE_NAME)),
  ]);
  return {
    phase: state.phase === "restarting" ? "restarting" : signal ? "waiting" : "idle",
    requestedAt: signal?.requestedAt ?? null,
  };
}

export interface RestartBlockers {
  /** Runs, resumes and session creations in flight. */
  sessions: number;
  /** Queued and running management jobs: previews, deploys, self-update. */
  jobs: number;
  operations?: number;
}

/** Everything a restart waits for. A merged deployment still publishing its request is not idle. */
export function getRestartBlockers(ctx: Pick<AppContext,
  "sessionManager" | "managementJobStore" | "voiceJobManager" | "transcriptionService">): RestartBlockers {
  const publishingDeploys = ctx.managementJobStore?.listDeploysAwaitingActivation()
    .filter((job) => isRecord(job.result) && job.result.restartDeferred === true).length ?? 0;
  const operations = (ctx.voiceJobManager?.getActiveJobCount?.() ?? 0) + (ctx.transcriptionService.getActiveCount?.() ?? 0);
  return {
    sessions: ctx.sessionManager.getLifecycleBlockingSessionCount(),
    jobs: (ctx.managementJobStore?.listActive().length ?? 0) + publishingDeploys,
    ...(operations > 0 ? { operations } : {}),
  };
}
