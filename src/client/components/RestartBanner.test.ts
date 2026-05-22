import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { createReactDomHarness, type ReactDomHarness } from "../test-react-harness";
import RestartBanner from "./RestartBanner";

describe("RestartBanner", () => {
  let harness: ReactDomHarness | null = null;

  afterEach(async () => {
    await harness?.cleanup();
    harness = null;
  });

  async function renderBanner(props: Parameters<typeof RestartBanner>[0]) {
    harness = await createReactDomHarness();
    await harness.render(createElement(RestartBanner, props));
    return harness.dom.container.textContent ?? "";
  }

  it("does not promise continued use during restart cutover waits", async () => {
    const text = await renderBanner({
      phase: "pending",
      restartPhase: "restarting",
      waitingSessions: 2,
      canAcceptNewWork: false,
    });

    expect(text).toContain("Restart in progress");
    expect(text).toContain("New messages and chats are paused");
    expect(text).not.toContain("you can keep using Bridge");
  });

  it("keeps the continued-use copy for ordinary waiting phases", async () => {
    const text = await renderBanner({
      phase: "pending",
      restartPhase: "waiting-for-sessions",
      waitingSessions: 2,
      canAcceptNewWork: true,
    });

    expect(text).toContain("Restart queued");
    expect(text).toContain("you can keep using Bridge");
  });
});
