import { describe, expect, it } from "vitest";
import {
  selectLiveExternalSessionIds,
  type SessionLockObservation,
} from "../external-session-use.js";

describe("external session use", () => {
  it("keeps only locks owned by another process that predates the lock file", () => {
    const observations: SessionLockObservation[] = [
      { sessionId: "bridge-only", pid: 100, createdAtMs: 20_000 },
      { sessionId: "external", pid: 200, createdAtMs: 20_000 },
      { sessionId: "pid-reused", pid: 300, createdAtMs: 20_000 },
      { sessionId: "dead-owner", pid: 400, createdAtMs: 20_000 },
      { sessionId: "shared", pid: 100, createdAtMs: 20_000 },
      { sessionId: "shared", pid: 200, createdAtMs: 20_000 },
    ];
    const processStartTimes = new Map([
      [100, 10_000],
      [200, 15_000],
      [300, 30_000],
    ]);

    expect(selectLiveExternalSessionIds(observations, processStartTimes, 100))
      .toEqual(new Set(["external", "shared"]));
  });

  it("allows small timestamp precision differences when validating a lock", () => {
    expect(selectLiveExternalSessionIds(
      [{ sessionId: "session-1", pid: 200, createdAtMs: 20_000 }],
      new Map([[200, 24_000]]),
      100,
    )).toEqual(new Set(["session-1"]));
  });
});
