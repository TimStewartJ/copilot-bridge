import { describe, expect, it } from "vitest";
import {
  getRestartStatusQueryOptions,
  IDLE_RESTART_REFETCH_MS,
  PENDING_RESTART_REFETCH_MS,
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
            waitingSessions: 0,
            requestedAt: pending ? "2026-05-20T12:00:00.000Z" : null,
            serverInstanceId: "server-1",
          },
    },
  } as Parameters<typeof refetchInterval>[0]);
}

describe("getRestartStatusQueryOptions", () => {
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
