import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  createReactDomHarness,
  findAllByTag,
  getReactProps,
  waitTick,
  waitUntilAct,
  type ReactDomHarness,
} from "../test-react-harness";
import type { BackgroundAgentsSummary, SessionAgentsResponse } from "../api";
import SessionAgentsBar from "./SessionAgentsBar";

const fetchSessionAgents = vi.fn<(sessionId: string) => Promise<SessionAgentsResponse>>();
const cancelSessionAgent = vi.fn<(sessionId: string, agentId: string) => Promise<{ cancelled: boolean }>>();

vi.mock("../api", () => ({
  fetchSessionAgents: (sessionId: string) => fetchSessionAgents(sessionId),
  cancelSessionAgent: (sessionId: string, agentId: string) => cancelSessionAgent(sessionId, agentId),
}));

function liveSummary(partial: Partial<BackgroundAgentsSummary> = {}): BackgroundAgentsSummary {
  return { running: 1, idle: 0, failed: 0, total: 1, source: "live", ...partial };
}

async function mount(props: Parameters<typeof SessionAgentsBar>[0]): Promise<ReactDomHarness> {
  const harness = await createReactDomHarness();
  await harness.render(createElement(SessionAgentsBar, props));
  return harness;
}

async function clickButton(act: ReactDomHarness["act"], button: any): Promise<void> {
  await act(async () => {
    getReactProps(button)?.onClick?.({
      currentTarget: button,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });
    await waitTick();
  });
}

describe("SessionAgentsBar", () => {
  it("renders nothing when background agents are only last-seen (stale)", async () => {
    const stale = await mount({
      sessionId: "s1",
      backgroundAgents: { running: 2, idle: 0, failed: 0, total: 2, source: "lastSeen" },
    });
    expect(stale.dom.container.textContent ?? "").not.toContain("background agent");
  });

  it("renders nothing when there is no summary", async () => {
    const none = await mount({ sessionId: "s1", backgroundAgents: undefined });
    expect(none.dom.container.textContent ?? "").toBe("");
  });

  it("renders nothing when there is no session", async () => {
    const noSession = await mount({ sessionId: null, backgroundAgents: liveSummary() });
    expect(noSession.dom.container.textContent ?? "").toBe("");
  });

  it("shows the banner with a count when live background agents are present", async () => {
    const harness = await mount({
      sessionId: "s1",
      backgroundAgents: liveSummary({ running: 2, idle: 1, total: 3 }),
    });
    const text = harness.dom.container.textContent ?? "";
    expect(text).toContain("3 background agents");
    expect(text).toContain("2 running");
    expect(text).toContain("1 idle");
    // Not expanded yet -> no fetch
    expect(fetchSessionAgents).not.toHaveBeenCalled();
  });

  it("fetches and lists agents on expand", async () => {
    fetchSessionAgents.mockResolvedValueOnce({
      tasks: [
        {
          id: "explore-docs",
          status: "running",
          executionMode: "background",
          agentType: "explore",
          description: "Explore the docs",
        },
        {
          id: "sync-child",
          status: "running",
          executionMode: "sync",
          agentType: "task",
          description: "inline child",
        },
      ],
      source: "live",
      backgroundAgents: liveSummary(),
    });

    const harness = await mount({ sessionId: "s1", backgroundAgents: liveSummary() });
    const toggle = findAllByTag(harness.dom.container, "BUTTON").find((b) =>
      b.textContent?.includes("background agent"),
    );
    expect(toggle).toBeTruthy();
    await clickButton(harness.act, toggle);
    await waitUntilAct(harness.act, () =>
      (harness.dom.container.textContent ?? "").includes("Explore the docs"),
    );

    expect(fetchSessionAgents).toHaveBeenCalledWith("s1");
    const text = harness.dom.container.textContent ?? "";
    expect(text).toContain("explore");
    expect(text).toContain("Explore the docs");
    expect(text).toContain("Running");
    // sync child agents are excluded from the background bar list
    expect(text).not.toContain("inline child");
  });

  it("cancels a non-terminal agent", async () => {
    fetchSessionAgents.mockResolvedValue({
      tasks: [
        { id: "explore-docs", status: "running", executionMode: "background", agentType: "explore", description: "Explore the docs" },
      ],
      source: "live",
      backgroundAgents: liveSummary(),
    });
    cancelSessionAgent.mockResolvedValueOnce({ cancelled: true });

    const harness = await mount({ sessionId: "s1", backgroundAgents: liveSummary() });
    const toggle = findAllByTag(harness.dom.container, "BUTTON").find((b) =>
      b.textContent?.includes("background agent"),
    );
    await clickButton(harness.act, toggle);
    await waitUntilAct(harness.act, () =>
      (harness.dom.container.textContent ?? "").includes("Explore the docs"),
    );

    const cancelButton = findAllByTag(harness.dom.container, "BUTTON").find((b) =>
      b.textContent?.trim() === "Cancel",
    );
    expect(cancelButton).toBeTruthy();
    await clickButton(harness.act, cancelButton);
    await waitUntilAct(harness.act, () => cancelSessionAgent.mock.calls.length > 0);
    expect(cancelSessionAgent).toHaveBeenCalledWith("s1", "explore-docs");
  });
});
