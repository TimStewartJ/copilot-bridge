import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskHistoryEntry } from "../api";
import { createReactDomHarness, findAllByTag, getReactProps, waitUntilAct, type ReactDomHarness } from "../test-react-harness";
import TaskHistorySheet, { describeHistoryActor } from "./TaskHistorySheet";

const fetchTaskHistoryMock = vi.hoisted(() => vi.fn());
const addTaskHistoryEntryMock = vi.hoisted(() => vi.fn());
const deleteTaskHistoryEntryMock = vi.hoisted(() => vi.fn());
vi.mock("../api", () => ({
  fetchTaskHistory: fetchTaskHistoryMock,
  addTaskHistoryEntry: addTaskHistoryEntryMock,
  deleteTaskHistoryEntry: deleteTaskHistoryEntryMock,
}));

const ENTRIES: TaskHistoryEntry[] = [
  { id: 3, taskId: "task-1", at: "2026-09-26T10:00:00.000Z", source: "agent", sessionId: "session-9", scheduleName: "Daily rental search", text: "Toured 2040 Main\nLandlord wants a 12-month lease." },
  { id: 2, taskId: "task-1", at: "2026-09-25T10:00:00.000Z", source: "user", text: "Dropped the Elm St listing" },
];

describe("TaskHistorySheet", () => {
  let harness: ReactDomHarness | null = null;

  afterEach(async () => {
    await harness?.cleanup();
    harness = null;
    fetchTaskHistoryMock.mockReset();
    addTaskHistoryEntryMock.mockReset();
    deleteTaskHistoryEntryMock.mockReset();
  });

  async function render(props: { onSelectSession?: (id: string) => void } = {}) {
    harness = await createReactDomHarness();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    await harness.render(createElement(QueryClientProvider, { client },
      createElement(TaskHistorySheet, { taskId: "task-1", onClose: () => {}, ...props })));
    return harness;
  }

  function buttonByText(container: any, text: string) {
    return findAllByTag(container, "BUTTON").find((button) => button.textContent === text);
  }

  it("names who wrote an entry", () => {
    expect(describeHistoryActor({ source: "user" })).toBe("You");
    expect(describeHistoryActor({ source: "system" })).toBe("Bridge");
    expect(describeHistoryActor({ source: "agent", scheduleName: "Hourly scout", sessionId: "s" })).toBe("Hourly scout");
    expect(describeHistoryActor({ source: "agent", sessionId: "s" })).toBe("Agent session");
    expect(describeHistoryActor({ source: "agent" })).toBe("Agent");
  });

  it("lists entries newest first with their authors and opens the session that wrote one", async () => {
    fetchTaskHistoryMock.mockResolvedValue({ entries: ENTRIES, total: 2 });
    const onSelectSession = vi.fn();
    const { dom, act } = await render({ onSelectSession });
    const container = dom.container as any;
    await waitUntilAct(act, () => (container.textContent ?? "").includes("Toured 2040 Main"));

    expect(fetchTaskHistoryMock).toHaveBeenCalledWith("task-1", expect.objectContaining({ limit: 50 }));
    const text = container.textContent ?? "";
    expect(text.indexOf("Toured 2040 Main")).toBeLessThan(text.indexOf("Dropped the Elm St listing"));
    expect(text).toContain("Daily rental search");
    expect(text).toContain("You");
    expect(buttonByText(container, "Show older entries")).toBeUndefined();

    await act(async () => { getReactProps(buttonByText(container, "Open session"))?.onClick(); });
    expect(onSelectSession).toHaveBeenCalledWith("session-9");
  });

  it("adds an entry and asks before deleting one", async () => {
    fetchTaskHistoryMock.mockResolvedValue({ entries: ENTRIES, total: 2 });
    addTaskHistoryEntryMock.mockResolvedValue({ ...ENTRIES[1], id: 4, text: "Signed" });
    deleteTaskHistoryEntryMock.mockResolvedValue(undefined);
    const { dom, act } = await render();
    const container = dom.container as any;
    await waitUntilAct(act, () => (container.textContent ?? "").includes("Toured 2040 Main"));

    const addButton = buttonByText(container, "Add entry");
    expect(getReactProps(addButton)?.disabled).toBe(true);
    const textarea = findAllByTag(container, "TEXTAREA")[0];
    await act(async () => { getReactProps(textarea)?.onChange({ target: { value: "  Signed  " } }); });
    const form = findAllByTag(container, "FORM")[0];
    await act(async () => { getReactProps(form)?.onSubmit({ preventDefault: () => {} }); });
    await waitUntilAct(act, () => addTaskHistoryEntryMock.mock.calls.length > 0);
    expect(addTaskHistoryEntryMock).toHaveBeenCalledWith("task-1", "Signed");

    const trash = findAllByTag(container, "BUTTON").filter((button) => getReactProps(button)?.["aria-label"] === "Delete entry");
    expect(trash).toHaveLength(2);
    await act(async () => { getReactProps(trash[1])?.onClick(); });
    expect(deleteTaskHistoryEntryMock).not.toHaveBeenCalled();
    await act(async () => { getReactProps(buttonByText(container, "Delete"))?.onClick(); });
    await waitUntilAct(act, () => deleteTaskHistoryEntryMock.mock.calls.length > 0);
    expect(deleteTaskHistoryEntryMock).toHaveBeenCalledWith("task-1", 2);
  });

  it("pages older entries by id so every entry stays reachable", async () => {
    const page = (from: number, count: number) => Array.from({ length: count }, (_, index) => ({
      id: from - index, taskId: "task-1", at: "2026-09-26T10:00:00.000Z", source: "user" as const, text: `Entry ${from - index}`,
    }));
    fetchTaskHistoryMock.mockImplementation(async (_taskId: string, options: { before?: number }) => (
      options.before === undefined
        ? { entries: page(260, 50), total: 260 }
        : { entries: page(options.before - 1, 10), total: 260 }
    ));
    const { dom, act } = await render();
    const container = dom.container as any;
    await waitUntilAct(act, () => (container.textContent ?? "").includes("Entry 260"));
    await act(async () => { getReactProps(buttonByText(container, "Show older entries"))?.onClick(); });
    await waitUntilAct(act, () => (container.textContent ?? "").includes("Entry 201"));
    expect(fetchTaskHistoryMock).toHaveBeenLastCalledWith("task-1", expect.objectContaining({ before: 211, limit: 50 }));
    // A short page means the oldest entry is loaded.
    expect(buttonByText(container, "Show older entries")).toBeUndefined();
  });
});
