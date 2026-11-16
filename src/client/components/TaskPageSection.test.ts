import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReactDomHarness, findAllByTag, getReactProps, waitUntilAct, type ReactDomHarness } from "../test-react-harness";

const fetchTaskPageMock = vi.hoisted(() => vi.fn());
vi.mock("../api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../api")>(),
  fetchTaskPage: fetchTaskPageMock,
}));

describe("TaskPageSlot", () => {
  let harness: ReactDomHarness | null = null;
  afterEach(async () => {
    await harness?.cleanup();
    harness = null;
    fetchTaskPageMock.mockReset();
  });

  async function render(onMakePage = vi.fn(async () => {})) {
    const { TaskPageSlot } = await import("./TaskPageSection");
    harness = await createReactDomHarness();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await harness.render(createElement(QueryClientProvider, { client },
      createElement(TaskPageSlot, { taskId: "task-1", taskTitle: "Example trip", onMakePage })));
    return harness.dom.container;
  }

  it("keeps its row while loading, then offers to make a missing page and waits for the chat to start", async () => {
    let answer: (page: null) => void = () => {};
    fetchTaskPageMock.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    let started: () => void = () => {};
    const onMakePage = vi.fn(() => new Promise<void>((resolve) => { started = resolve; }));
    const container = await render(onMakePage);
    const slot = () => findAllByTag(container, "DIV").find((div) => getReactProps(div)?.["aria-label"] === "Page");
    expect(getReactProps(slot())?.className).toContain("h-14");
    expect(getReactProps(slot())?.["aria-busy"]).toBe("true");

    await harness!.act(async () => { answer(null); });
    await waitUntilAct(harness!.act, () => container.textContent?.includes("Make page") ?? false);
    expect(getReactProps(slot())?.className).toContain("h-14");
    const make = () => findAllByTag(container, "BUTTON").find((button) => button.textContent?.includes("Make page") || button.textContent?.includes("Starting"));
    await harness!.act(async () => { getReactProps(make())!.onClick(); });
    expect(onMakePage).toHaveBeenCalledOnce();
    expect(getReactProps(make())?.disabled).toBe(true);
    await harness!.act(async () => { started(); });
    expect(getReactProps(make())?.disabled).toBe(false);
  });

  it("shows the published page in the same row", async () => {
    fetchTaskPageMock.mockResolvedValue({ updatedAt: "2026-01-02T10:00:00.000Z", size: 10 });
    const container = await render();
    await waitUntilAct(harness!.act, () => container.textContent?.includes("Updated") ?? false);
    expect(container.textContent).not.toContain("Make page");
    expect(findAllByTag(container, "IFRAME")).toHaveLength(1);
  });
});
