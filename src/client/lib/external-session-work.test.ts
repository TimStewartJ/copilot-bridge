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
  it("reconnects when an idle active session receives a new external busy signal", () => {
    expect(resolveExternalSessionWorkAction(baseContext)).toBe("reconnect");
  });

  it("ignores unchanged or missing session signals", () => {
    expect(resolveExternalSessionWorkAction({
      ...baseContext,
      nextBusySignal: 1,
    })).toBe("ignore");

    expect(resolveExternalSessionWorkAction({
      ...baseContext,
      sessionId: null,
    })).toBe("ignore");
  });

  it("ignores local send and fleet work that already own the stream", () => {
    expect(resolveExternalSessionWorkAction({
      ...baseContext,
      isStreaming: true,
      pendingOrigin: "message",
    })).toBe("ignore");

    expect(resolveExternalSessionWorkAction({
      ...baseContext,
      isStreaming: true,
      pendingOrigin: "fleet",
    })).toBe("ignore");
  });

  it("defers reconnects while history loading is still in progress", () => {
    expect(resolveExternalSessionWorkAction({
      ...baseContext,
      isRefreshingHistory: true,
    })).toBe("defer");

    expect(resolveExternalSessionWorkAction({
      ...baseContext,
      isLoadingHistory: true,
    })).toBe("defer");

    expect(resolveExternalSessionWorkAction({
      ...baseContext,
      isLoadingOlderMessages: true,
    })).toBe("defer");
  });

  it("ignores reconnect churn while a reconnect is already in progress", () => {
    expect(resolveExternalSessionWorkAction({
      ...baseContext,
      isStreaming: true,
      pendingOrigin: "reconnect",
    })).toBe("ignore");
  });
});
