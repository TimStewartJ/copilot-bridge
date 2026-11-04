import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findDialogElements, resolveAccessibleName } from "../test-modal-dialog-dom";
import type { TaskHistoryEntry } from "../api";
import { createReactDomHarness, findAllByTag, getReactProps, waitUntilAct, type ReactDomHarness } from "../test-react-harness";
import TaskHistorySheet from "./TaskHistorySheet";

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

  it("names the authors in the paged history and opens the session for its newest entry", async () => {
    const page = (from: number, count: number) => Array.from({ length: count }, (_, index) => ({
      id: from - index, taskId: "task-1", at: "2026-09-26T10:00:00.000Z", source: "user" as const, text: `Entry ${from - index}`,
    }));
    fetchTaskHistoryMock.mockImplementation(async (_taskId: string, options: { before?: number }) => (
      options.before === undefined
        ? { entries: [
            { ...ENTRIES[0], id: 260 }, { ...ENTRIES[1], id: 259 },
            { ...ENTRIES[1], id: 258, source: "system", text: "Task created" },
            { ...ENTRIES[1], id: 257, source: "agent", sessionId: "session-8", text: "Updated notes" },
            { ...ENTRIES[1], id: 256, source: "agent", text: "Saved locally" },
            ...page(255, 45),
          ], total: 260 }
        : { entries: page(options.before - 1, 10), total: 260 }
    ));
    const onSelectSession = vi.fn();
    const { dom, act } = await render({ onSelectSession });
    const container = dom.container as any;
    await waitUntilAct(act, () => (container.textContent ?? "").includes("Toured 2040 Main"));
    expect(fetchTaskHistoryMock).toHaveBeenCalledWith("task-1", expect.objectContaining({ limit: 50 }));
    expect(findDialogElements(container).map((dialog) => [
      dialog.getAttribute("aria-modal"), resolveAccessibleName(container, dialog),
    ])).toEqual([["true", expect.stringMatching(/^History/)]]);
    const text = container.textContent ?? "";
    expect(text.indexOf("Toured 2040 Main")).toBeLessThan(text.indexOf("Dropped the Elm St listing"));
    const authors = findAllByTag(container, "LI").slice(0, 5)
      .map((row) => findAllByTag(row, "SPAN").find((span) => getReactProps(span)?.className === "text-text-secondary")?.textContent);
    expect(authors).toEqual(["Daily rental search", "You", "Bridge", "Agent session", "Agent"]);

    await act(async () => { getReactProps(buttonByText(container, "Show older entries"))?.onClick(); });
    await waitUntilAct(act, () => (container.textContent ?? "").includes("Entry 201"));
    expect(fetchTaskHistoryMock).toHaveBeenLastCalledWith("task-1", expect.objectContaining({ before: 211, limit: 50 }));
    // A short page means the oldest entry is loaded.
    expect(buttonByText(container, "Show older entries")).toBeUndefined();

    await act(async () => { getReactProps(buttonByText(container, "Open session"))?.onClick(); });
    expect(onSelectSession).toHaveBeenCalledWith("session-9");
  });
});
