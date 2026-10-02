import { describe, expect, it } from "vitest";
import { describeAgentBackendLoss, formatAgentBackendLoss } from "./agent-backend-status.js";

describe("agent backend loss wording", () => {
  it("does not call a Bridge-initiated restart a disconnect", () => {
    expect(describeAgentBackendLoss("cleanup-stalled")).toBe("Bridge restarted it because a session did not release in time");
    expect(describeAgentBackendLoss("rpc-timeout")).toBe("it stopped answering");
  });

  it("keeps the reason code and detail after the words", () => {
    expect(formatAgentBackendLoss({ at: "2026-10-01T00:00:00.000Z", reason: "process-exit", detail: "code=1" }))
      .toBe("its process exited (process-exit - code=1)");
    expect(formatAgentBackendLoss({ at: "2026-10-01T00:00:00.000Z", reason: " cleanup-stalled " }))
      .toBe("Bridge restarted it because a session did not release in time (cleanup-stalled)");
  });

  it("shows an unknown reason once", () => {
    expect(formatAgentBackendLoss({ at: "2026-10-01T00:00:00.000Z", reason: "stdio closed", detail: "broken pipe" }))
      .toBe("stdio closed - broken pipe");
    expect(formatAgentBackendLoss({ at: "2026-10-01T00:00:00.000Z", reason: "stdio closed" })).toBe("stdio closed");
  });
});
