import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskMomentumEvent } from "../api";
import { createReactDomHarness, findAllByTag, flushAct, getReactProps, waitUntilAct, type ReactDomHarness } from "../test-react-harness";
import TaskMomentumHistory, { describeMomentumActor, describeMomentumChange } from "./TaskMomentumHistory";

const fetchTaskMomentumEventsMock = vi.hoisted(() => vi.fn());
vi.mock("../api", () => ({ fetchTaskMomentumEvents: fetchTaskMomentumEventsMock }));

const EVENTS: TaskMomentumEvent[] = [
  {
    id: 2, taskId: "task-1", at: "2026-09-22T20:00:00.000Z", source: "agent", sessionId: "session-9",
    scheduleName: "Daily rental search",
    changes: [
      { field: "nextAction", before: "Old step", after: "Verify 2040 Main #120" },
      { field: "waitingOn", before: "Landlord reply", after: null },
    ],
  },
  { id: 1, taskId: "task-1", at: "2026-09-21T20:00:00.000Z", source: "user", changes: [{ field: "deferred", before: false, after: true }] },
];

describe("TaskMomentumHistory", () => {
  let harness: ReactDomHarness | null = null;

  afterEach(async () => {
    await harness?.cleanup();
    harness = null;
    fetchTaskMomentumEventsMock.mockReset();
  });

  async function render(props: { standalone?: boolean; onSelectSession?: (id: string) => void } = {}) {
    harness = await createReactDomHarness();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    await harness.render(createElement(QueryClientProvider, { client },
      createElement(TaskMomentumHistory, { taskId: "task-1", ...props })));
    return harness;
  }

  it("names who changed what", () => {
    expect(describeMomentumActor({ source: "user" })).toBe("You");
    expect(describeMomentumActor({ source: "system" })).toBe("Bridge");
    expect(describeMomentumActor({ source: "agent", scheduleName: "Hourly scout", sessionId: "s" })).toBe("Hourly scout");
    expect(describeMomentumActor({ source: "agent", sessionId: "s" })).toBe("Agent session");
    expect(describeMomentumChange({ field: "nextAction", before: null, after: "x".repeat(10), afterLength: 900 }))
      .toEqual({ label: "Next step", value: "x".repeat(10), note: "Preview of 900 characters" });
    expect(describeMomentumChange({ field: "nextAction", before: "Old", after: "New" }))
      .toEqual({ label: "Next step", value: "New", previous: "Old" });
    expect(describeMomentumChange({ field: "waitingOn", before: "Reply", after: null }))
      .toEqual({ label: "Waiting for", value: "Cleared", previous: "Reply" });
    expect(describeMomentumChange({ field: "deferred", before: true, after: false })).toEqual({ label: "Deferral", value: "Resumed" });
  });

  it("summarizes the latest change on one closed line and opens to the history with session links", async () => {
    fetchTaskMomentumEventsMock.mockResolvedValue(EVENTS);
    const onSelectSession = vi.fn();
    const { dom, act } = await render({ onSelectSession });
    const container = dom.container as any;
    await waitUntilAct(act, () => (container.textContent ?? "").includes("by Daily rental search"));

    expect(fetchTaskMomentumEventsMock).toHaveBeenCalledWith("task-1", expect.objectContaining({ limit: 30 }));
    const toggle = findAllByTag(container, "BUTTON")[0];
    expect(getReactProps(toggle)?.["aria-expanded"]).toBe(false);
    expect(container.textContent).toContain("2 updates");
    expect(container.textContent).not.toContain("Verify 2040 Main #120");

    await act(async () => { getReactProps(toggle)?.onClick(); });
    expect(container.textContent).toContain("Verify 2040 Main #120");
    expect(container.textContent).toContain("Cleared");
    expect(container.textContent).toContain("Was: Landlord reply");
    expect(container.textContent).toContain("Was: Old step");
    expect(container.textContent).toContain("Deferred");
    expect(container.textContent).toContain("You");

    const openSession = findAllByTag(container, "BUTTON").find((button) => button.textContent === "Open session");
    expect(openSession).toBeTruthy();
    await act(async () => { getReactProps(openSession)?.onClick(); });
    expect(onSelectSession).toHaveBeenCalledWith("session-9");
  });

  it("says quietly when nothing is recorded, and renders nothing standalone", async () => {
    fetchTaskMomentumEventsMock.mockResolvedValue([]);
    const inline = await render();
    await waitUntilAct(inline.act, () => ((inline.dom.container as any).textContent ?? "").includes("No recorded changes yet."));
    await inline.cleanup();

    const standalone = await render({ standalone: true });
    await waitUntilAct(standalone.act, () => fetchTaskMomentumEventsMock.mock.calls.length === 2);
    await flushAct(standalone.act, 3);
    expect((standalone.dom.container as any).textContent ?? "").toBe("");
  });

  it("keeps a failed load visible for archived tasks", async () => {
    fetchTaskMomentumEventsMock.mockRejectedValue(new Error("boom"));
    const { dom, act } = await render({ standalone: true });
    await waitUntilAct(act, () => ((dom.container as any).textContent ?? "").includes("could not be loaded"));
    expect((dom.container as any).textContent).toContain("Where things stood");
  });

  it("wraps archived-task history in its own group", async () => {
    fetchTaskMomentumEventsMock.mockResolvedValue(EVENTS);
    const { dom, act } = await render({ standalone: true });
    await waitUntilAct(act, () => ((dom.container as any).textContent ?? "").includes("Where things stood"));
    expect((dom.container as any).textContent).toContain("Changed");
  });
});
