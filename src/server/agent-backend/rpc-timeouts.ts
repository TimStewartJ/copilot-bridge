// Hard upper bounds on every backend RPC the Bridge waits on. A dead JSON-RPC
// connection never answers, so without these the watchdog, abort, graceful
// restart, and every queued send wait forever. Timeouts are deliberately
// generous: they exist to turn a wedged channel into a diagnosable failure
// (and a liveness probe), not to police slow-but-alive runtimes.

export const AGENT_RPC_TIMEOUTS_MS = {
  // Session-scoped
  "session.send": 120_000,
  "session.abort": 30_000,
  "session.setModel": 60_000,
  "session.destroy": 60_000,
  "session.setSendMode": 30_000,
  "session.respondToUserInput": 30_000,
  "session.respondToElicitation": 30_000,
  "session.invokeSlashCommand": 120_000,
  "session.listSlashCommands": 60_000,
  "session.getCurrentModel": 60_000,
  "session.truncateHistory": 60_000,
  "session.listMcpServers": 60_000,
  "session.initializeTools": 5 * 60_000,
  "session.getCurrentToolMetadata": 60_000,
  // The OAuth flow legitimately waits for the user to finish in a browser.
  "session.startMcpOauthLogin": 15 * 60_000,
  "session.getName": 60_000,
  "session.setName": 60_000,
  "session.listTasks": 60_000,
  "session.cancelTask": 60_000,
  "session.removeTask": 60_000,
  // Backend-scoped
  "backend.listModels": 60_000,
  "backend.listSessions": 120_000,
  "backend.deleteSession": 60_000,
  "backend.getSessionMetadata": 60_000,
  "backend.forkSession": 120_000,
  "backend.getAccountQuota": 30_000,
  "backend.getAccountAuth": 30_000,
  "backend.ping": 5_000,
} as const;

export type AgentRpcName = keyof typeof AGENT_RPC_TIMEOUTS_MS;

export class AgentRpcTimeoutError extends Error {
  readonly code = "AGENT_RPC_TIMEOUT" as const;

  constructor(readonly rpc: AgentRpcName, readonly timeoutMs: number) {
    super(`Agent backend RPC ${rpc} timed out after ${timeoutMs}ms`);
    this.name = "AgentRpcTimeoutError";
  }
}

export function isAgentRpcTimeoutError(error: unknown): error is AgentRpcTimeoutError {
  return error instanceof AgentRpcTimeoutError
    || (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "AGENT_RPC_TIMEOUT");
}

export interface BoundRpcOptions {
  /** Called when the RPC does not settle in time, after the timeout error is thrown. */
  onTimeout?: (rpc: AgentRpcName, timeoutMs: number) => void;
  /** Called when the RPC rejects for any other reason. */
  onError?: (rpc: AgentRpcName, error: unknown) => void;
}

/**
 * Race `operation` against its configured hard timeout. The underlying RPC is
 * not cancelled (the SDK exposes no cancellation), so a late settlement is
 * observed and discarded to avoid unhandled rejections.
 */
export async function boundRpc<T>(
  rpc: AgentRpcName,
  operation: () => Promise<T>,
  options: BoundRpcOptions = {},
  timeoutMs: number = AGENT_RPC_TIMEOUTS_MS[rpc],
): Promise<T> {
  let work: Promise<T>;
  try {
    work = Promise.resolve(operation());
  } catch (error) {
    options.onError?.(rpc, error);
    throw error;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new AgentRpcTimeoutError(rpc, timeoutMs));
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } catch (error) {
    if (timedOut) {
      void work.catch(() => undefined);
      options.onTimeout?.(rpc, timeoutMs);
    } else {
      options.onError?.(rpc, error);
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
