import { describe, expect, it } from "vitest";
import {
  describeRestartNotice,
  getRestartStatusQueryOptions,
  IDLE_RESTART_REFETCH_MS,
  PENDING_RESTART_REFETCH_MS,
  UNREACHABLE_RESTART_REFETCH_MS,
} from "./useRestartStatus";

function refetchIntervalForPending(pending?: boolean): number | false | undefined {
  const { refetchInterval } = getRestartStatusQueryOptions();
  if (typeof refetchInterval !== "function") return refetchInterval;
  return refetchInterval({
    state: {
      data: pending === undefined
        ? undefined
        : {
            pending,
            phase: pending ? "restarting" : "idle",
            waitingOn: { sessions: 0, jobs: 0, sessionIds: [] },
            requestedAt: pending ? "2026-05-20T12:00:00.000Z" : null,
            serverInstanceId: "server-1",
          },
    },
  } as Parameters<typeof refetchInterval>[0]);
}

describe("restart notice state", () => {
  const waiting = { pending: true, phase: "waiting" as const, requestedAt: "2026-09-20T17:00:00Z",
    waitingOn: { sessions: 2, jobs: 1, sessionIds: ["a", "b"] }, serverInstanceId: "server-1" };
  it("shows current waiting work and treats reconnects to the same server as still waiting", () => {
    expect(describeRestartNotice(waiting, "server-1", false)).toEqual({ kind: "waiting", ...waiting.waitingOn });
    expect(describeRestartNotice(waiting, "server-1", true)).toEqual({ kind: "restarting" });
    expect(describeRestartNotice(waiting, "server-1", false)).toEqual({ kind: "waiting", ...waiting.waitingOn });
  });
  it("reloads only for a different server, not a cleared request or a first snapshot", () => {
    const idle = { ...waiting, pending: false, phase: "idle" as const, requestedAt: null };
    expect(describeRestartNotice(idle, "server-1", false)).toBeNull();
    expect(describeRestartNotice(waiting, undefined, false)?.kind).toBe("waiting");
    expect(describeRestartNotice({ ...idle, serverInstanceId: "server-2" }, "server-1", false)).toEqual({ kind: "restarted" });
    expect(describeRestartNotice(undefined, "server-1", false)).toBeNull();
  });
});

describe("getRestartStatusQueryOptions", () => {
  it("retries an unanswered status read promptly without hiding it behind query retries", () => {
    const options = getRestartStatusQueryOptions();
    expect(options.retry).toBe(false);
    if (typeof options.refetchInterval !== "function") throw new Error("Expected interval callback");
    expect(options.refetchInterval({ state: { status: "error" } } as Parameters<typeof options.refetchInterval>[0]))
      .toBe(UNREACHABLE_RESTART_REFETCH_MS);
  });
  it("keeps a slow visible-tab polling backstop while restart status is idle", () => {
    expect(refetchIntervalForPending(false)).toBe(IDLE_RESTART_REFETCH_MS);
    expect(refetchIntervalForPending(undefined)).toBe(IDLE_RESTART_REFETCH_MS);

    expect(getRestartStatusQueryOptions()).toMatchObject({
      refetchIntervalInBackground: false,
      refetchOnReconnect: true,
      refetchOnWindowFocus: true,
    });
  });

  it("polls faster after a restart is known to be pending", () => {
    expect(refetchIntervalForPending(true)).toBe(PENDING_RESTART_REFETCH_MS);
  });
});
