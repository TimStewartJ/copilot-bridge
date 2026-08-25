import { describe, expect, it } from "vitest";
import type { AgentBackendStatus } from "../../shared/agent-backend-status.js";
import {
  BACKEND_RECOVERY_BANNER_MS,
  createBackendStatusBannerState,
  reduceBackendStatusBannerState,
} from "./backend-status-banner-state";

const baseStatus: AgentBackendStatus = {
  state: "ready",
  connection: "connected",
  pid: 1234,
  createdAt: "2026-08-24T22:00:00.000Z",
  lastDisconnect: null,
  disconnectCount: 0,
  recoveryCount: 0,
  lastRecoveryAt: null,
  lastRecoveryError: null,
  lastInterruptedSessionCount: 0,
  lastAutoResumedSessionCount: 0,
};

function status(overrides: Partial<AgentBackendStatus>): AgentBackendStatus {
  return { ...baseStatus, ...overrides };
}

describe("backend status banner state", () => {
  it("shows reconnecting as a warning", () => {
    const next = reduceBackendStatusBannerState(createBackendStatusBannerState(), {
      type: "backend:status",
      agentBackend: status({
        state: "reconnecting",
        lastDisconnect: { at: "2026-08-24T22:10:00.000Z", reason: "stdio closed" },
        disconnectCount: 1,
      }),
      nowMs: Date.parse("2026-08-24T22:10:01.000Z"),
    });

    expect(next.banner?.variant).toBe("warning");
    expect(next.banner?.status.state).toBe("reconnecting");
  });

  it("shows disconnected as an error", () => {
    const next = reduceBackendStatusBannerState(createBackendStatusBannerState(), {
      type: "backend:status",
      agentBackend: status({
        state: "disconnected",
        lastDisconnect: { at: "2026-08-24T22:10:00.000Z", reason: "connection closed" },
        disconnectCount: 1,
      }),
      nowMs: Date.parse("2026-08-24T22:10:01.000Z"),
    });

    expect(next.banner?.variant).toBe("error");
  });

  it("keeps a recovery banner for about sixty seconds", () => {
    const recoveredAt = "2026-08-24T22:11:00.000Z";
    const shown = reduceBackendStatusBannerState(createBackendStatusBannerState(), {
      type: "backend:status",
      agentBackend: status({
        lastDisconnect: { at: "2026-08-24T22:10:00.000Z", reason: "connection closed" },
        recoveryCount: 1,
        lastRecoveryAt: recoveredAt,
        lastAutoResumedSessionCount: 2,
      }),
      nowMs: Date.parse(recoveredAt) + 5_000,
    });

    expect(shown.banner?.variant).toBe("success");
    expect(shown.recoveryExpiresAt).toBe(Date.parse(recoveredAt) + BACKEND_RECOVERY_BANNER_MS);

    const expired = reduceBackendStatusBannerState(shown, {
      type: "tick",
      nowMs: Date.parse(recoveredAt) + BACKEND_RECOVERY_BANNER_MS,
    });
    expect(expired.banner).toBeNull();
    expect(expired.recoveryExpiresAt).toBeNull();
  });

  it("dismisses the current banner until a new backend status key arrives", () => {
    const reconnecting = status({
      state: "reconnecting",
      lastDisconnect: { at: "2026-08-24T22:10:00.000Z", reason: "stdio closed" },
      disconnectCount: 1,
    });
    const shown = reduceBackendStatusBannerState(createBackendStatusBannerState(), {
      type: "backend:status",
      agentBackend: reconnecting,
      nowMs: Date.parse("2026-08-24T22:10:01.000Z"),
    });
    const dismissed = reduceBackendStatusBannerState(shown, { type: "dismiss" });
    const sameEvent = reduceBackendStatusBannerState(dismissed, {
      type: "backend:status",
      agentBackend: reconnecting,
      nowMs: Date.parse("2026-08-24T22:10:02.000Z"),
    });
    const newEvent = reduceBackendStatusBannerState(sameEvent, {
      type: "backend:status",
      agentBackend: { ...reconnecting, disconnectCount: 2 },
      nowMs: Date.parse("2026-08-24T22:10:03.000Z"),
    });

    expect(sameEvent.banner).toBeNull();
    expect(newEvent.banner).not.toBeNull();
  });
});
