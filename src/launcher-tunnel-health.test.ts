import { describe, expect, it } from "vitest";
import { evaluateTunnelHealthPoll } from "./launcher-tunnel-health.js";

describe("evaluateTunnelHealthPoll", () => {
  it("records a failed public probe without recycling immediately", () => {
    expect(evaluateTunnelHealthPoll({
      healthy: false,
      consecutiveFailures: 0,
      failureThreshold: 3,
      failureDetail: "timed out after 10000ms",
    })).toEqual({
      nextFailures: 1,
      logMessage: "Public tunnel health check failed (1/3): timed out after 10000ms",
      recycle: false,
    });
  });

  it("recycles after the configured number of consecutive failures", () => {
    expect(evaluateTunnelHealthPoll({
      healthy: false,
      consecutiveFailures: 2,
      failureThreshold: 3,
      failureDetail: "HTTP 503",
    })).toEqual({
      nextFailures: 3,
      logMessage: "Public tunnel health check failed (3/3): HTTP 503",
      recycle: true,
    });
  });

  it("resets the failure count after a successful probe", () => {
    expect(evaluateTunnelHealthPoll({
      healthy: true,
      consecutiveFailures: 2,
      failureThreshold: 3,
    })).toEqual({
      nextFailures: 0,
      recycle: false,
    });
  });
});
