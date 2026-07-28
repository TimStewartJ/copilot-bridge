import { describe, expect, it } from "vitest";
import { resolveExternalSessionWorkAction } from "./external-session-work";

const baseContext = {
  sessionId: "session-1",
  previousBusySignal: 1,
  nextBusySignal: 2,
  isStreaming: false,
  pendingOrigin: null,
  isRefreshingHistory: false,
  isLoadingHistory: false,
  isLoadingOlderMessages: false,
  isCreatingSession: false,
} as const;

describe("shouldReconnectForExternalSessionWork", () => {
  it("reconnects, ignores, or defers based on signal and loading state", () => {
    // new external signal on idle session → reconnect
    expect(resolveExternalSessionWorkAction(baseContext)).toBe("reconnect");

    // unchanged signal or missing session → ignore
    expect(resolveExternalSessionWorkAction({ ...baseContext, nextBusySignal: 1 })).toBe("ignore");
    expect(resolveExternalSessionWorkAction({ ...baseContext, sessionId: null })).toBe("ignore");

    // local message already owns the stream → ignore
    expect(resolveExternalSessionWorkAction({ ...baseContext, isStreaming: true, pendingOrigin: "message" })).toBe("ignore");

    // reconnect already in progress → ignore
    expect(resolveExternalSessionWorkAction({ ...baseContext, isStreaming: true, pendingOrigin: "reconnect" })).toBe("ignore");

    // history loading still in progress → defer
    expect(resolveExternalSessionWorkAction({ ...baseContext, isRefreshingHistory: true })).toBe("defer");
    expect(resolveExternalSessionWorkAction({ ...baseContext, isLoadingHistory: true })).toBe("defer");
    expect(resolveExternalSessionWorkAction({ ...baseContext, isLoadingOlderMessages: true })).toBe("defer");
  });
});
