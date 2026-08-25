import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentBackendStatus } from "../../shared/agent-backend-status.js";
import { createReactDomHarness, findAllByTag, getReactProps, type ReactDomHarness } from "../test-react-harness";
import BackendStatusBanner from "./BackendStatusBanner";
import type { BackendStatusBannerView } from "../lib/backend-status-banner-state";

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

describe("BackendStatusBanner", () => {
  let harness: ReactDomHarness | null = null;

  afterEach(async () => {
    await harness?.cleanup();
    harness = null;
  });

  async function renderBanner(banner: BackendStatusBannerView, onDismiss = vi.fn()) {
    harness = await createReactDomHarness();
    await harness.render(createElement(BackendStatusBanner, { banner, onDismiss }));
    return { text: harness.dom.container.textContent ?? "", onDismiss };
  }

  it("describes reconnecting with interrupted turn copy", async () => {
    const { text } = await renderBanner({
      key: "reconnect",
      variant: "warning",
      status: {
        ...baseStatus,
        state: "reconnecting",
        lastDisconnect: { at: "2026-08-24T22:10:00.000Z", reason: "stdio closed", detail: "broken pipe" },
      },
    });

    expect(text).toContain("Agent backend reconnecting...");
    expect(text).toContain("In-flight turns were interrupted");
    expect(text).toContain("stdio closed - broken pipe");
  });

  it("dismisses through the close button", async () => {
    const { onDismiss } = await renderBanner({ key: "disconnect", variant: "error", status: { ...baseStatus, state: "disconnected" } });
    const button = findAllByTag(harness!.dom.container, "BUTTON")
      .find((candidate) => getReactProps(candidate)?.["aria-label"] === "Dismiss agent backend status");
    expect(button).toBeTruthy();

    await harness!.act(async () => {
      getReactProps(button)?.onClick?.();
    });

    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
