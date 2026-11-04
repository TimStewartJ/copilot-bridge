import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EnrichedWorkItem, WorkItemRef } from "../../api";
import {
  createReactDomHarness,
  findAllByTag,
  flushAct,
  getReactProps,
} from "../../test-react-harness";
import type { WorkItemListProps } from "./WorkItemList";
import type { ToastInput } from "../../useToast";

const apiMocks = vi.hoisted(() => ({ unlinkResource: vi.fn(), linkResource: vi.fn() }));
const toastMocks = vi.hoisted(() => ({ showToast: vi.fn(() => "toast-1"), dismissToast: vi.fn() }));
const clipboardMocks = vi.hoisted(() => ({ writeClipboardText: vi.fn() }));

vi.mock("../../api", async () => {
  const actual = await vi.importActual<typeof import("../../api")>("../../api");
  return { ...actual, unlinkResource: apiMocks.unlinkResource, linkResource: apiMocks.linkResource };
});

vi.mock("../../useToast", async () => {
  const actual = await vi.importActual<typeof import("../../useToast")>("../../useToast");
  return { ...actual, useToast: () => ({ ...toastMocks, updateToast: vi.fn() }) };
});

vi.mock("../../lib/clipboard", () => ({
  writeClipboardText: clipboardMocks.writeClipboardText,
}));

type WorkItemHarness = Awaited<ReturnType<typeof createReactDomHarness>>;

// -- Fixtures ---------------------------------------------------------

function makeWI(id: string, url: string): EnrichedWorkItem {
  return { id, provider: "ado", title: `Work item ${id}`, state: "Active", type: "Task", assignedTo: null, areaPath: null, url };
}

const wiA = makeWI("WI-1", "https://dev.azure.com/org/proj/1");
const wiB = makeWI("WI-2", "https://dev.azure.com/org/proj/2");
const wiReal = makeWI("WI-3", "https://dev.azure.com/org/proj/3");
const rawWIOnly: WorkItemRef[] = [{ id: "WI-99", provider: "ado" }];

async function withWorkItemList(
  props: WorkItemListProps,
  run: (harness: WorkItemHarness) => Promise<void> | void,
) {
  const harness = await createReactDomHarness();
  try {
    const { default: WorkItemList } = await import("./WorkItemList");
    await harness.render(createElement(WorkItemList, props));
    await run(harness);
  } finally {
    await harness.cleanup();
  }
}

async function clickFirstSummaryButton(harness: WorkItemHarness) {
  const [button] = findAllByTag(harness.dom.container, "BUTTON");
  if (!button) throw new Error("Summary button was not rendered");
  await harness.act(async () => {
    getReactProps(button)?.onClick?.({ currentTarget: button });
  });
}

function findUnlinkButtons(harness: WorkItemHarness) {
  return findAllByTag(harness.dom.container, "BUTTON")
    .filter((button) => (button.getAttribute("class") ?? "").includes("linked-resource-unlink-button"));
}

function findCopyButtons(harness: WorkItemHarness) {
  return findAllByTag(harness.dom.container, "BUTTON")
    .filter((button) => (button.getAttribute("class") ?? "").includes("linked-resource-copy-button"));
}

/** Latest toast payload passed to showToast. */
function lastToast(): ToastInput | undefined {
  const calls = toastMocks.showToast.mock.calls as unknown as [ToastInput][];
  return calls.length > 0 ? calls[calls.length - 1][0] : undefined;
}

async function clickUnlinkOnce(harness: WorkItemHarness, index = 0) {
  const button = findUnlinkButtons(harness)[index];
  if (!button) throw new Error("Unlink button was not rendered");
  const preventDefault = vi.fn();
  const stopPropagation = vi.fn();
  await harness.act(async () => {
    getReactProps(button)?.onClick?.({ currentTarget: button, preventDefault, stopPropagation });
  });
  await flushAct(harness.act);
  return { button, preventDefault, stopPropagation };
}

async function clickUnlink(harness: WorkItemHarness, index = 0) {
  await clickUnlinkOnce(harness, index);
  await clickUnlinkOnce(harness, index);
}

async function clickCopy(harness: WorkItemHarness, index = 0) {
  const button = findCopyButtons(harness)[index];
  if (!button) throw new Error("Copy button was not rendered");
  const preventDefault = vi.fn();
  const stopPropagation = vi.fn();
  await harness.act(async () => {
    getReactProps(button)?.onClick?.({ currentTarget: button, preventDefault, stopPropagation });
  });
  await flushAct(harness.act);
  return { button, preventDefault, stopPropagation };
}

// -- Tests ------------------------------------------------------------

describe("WorkItemList - summary variant", () => {
  it("starts collapsed, expands both linked rows, and collapses on the next click", async () => {
    await withWorkItemList({ enrichedWIs: [wiA, wiB], rawWIs: [], variant: "summary" }, async (harness) => {
      expect(findAllByTag(harness.dom.container, "A")).toHaveLength(0);

      await clickFirstSummaryButton(harness);
      const anchors = findAllByTag(harness.dom.container, "A");
      expect(anchors.map((anchor) => anchor.getAttribute("href"))).toEqual([wiA.url, wiB.url]);
      expect(anchors[0].getAttribute("target")).toBe("_blank");
      expect(anchors[0].getAttribute("rel")).toBe("noopener");

      await clickFirstSummaryButton(harness);
      expect(findAllByTag(harness.dom.container, "A")).toHaveLength(0);
    });
  });

  it("single item with a real URL expands inline to its link instead of navigating", async () => {
    await withWorkItemList({ enrichedWIs: [wiReal], rawWIs: [], variant: "summary" }, async (harness) => {
      const mockOpen = vi.fn();
      (globalThis.window as unknown as { open?: typeof mockOpen }).open = mockOpen;
      try {
        expect(findAllByTag(harness.dom.container, "A")).toHaveLength(0);
        await clickFirstSummaryButton(harness);

        expect(mockOpen).not.toHaveBeenCalled();
        const [anchor] = findAllByTag(harness.dom.container, "A");
        expect(anchor?.getAttribute("href")).toBe(wiReal.url);
      } finally {
        delete (globalThis.window as unknown as { open?: typeof mockOpen }).open;
      }
    });
  });

  it("expanded rows with missing URL do not render href='#' anchors", async () => {
    await withWorkItemList({ enrichedWIs: [], rawWIs: rawWIOnly, variant: "summary" }, async (harness) => {
      await clickFirstSummaryButton(harness);

      expect(findAllByTag(harness.dom.container, "A")).toHaveLength(0);
      expect(findCopyButtons(harness)).toHaveLength(0);
    });
  });
});

describe("WorkItemList - copy affordance", () => {
  beforeEach(() => {
    clipboardMocks.writeClipboardText.mockReset();
    clipboardMocks.writeClipboardText.mockResolvedValue(undefined);
  });

  it("copies the exact work-item URL without following the row link", async () => {
    await withWorkItemList({ enrichedWIs: [wiA, wiB], rawWIs: [], variant: "compact" }, async (harness) => {
      expect(findCopyButtons(harness)).toHaveLength(2);
      expect(findUnlinkButtons(harness)).toHaveLength(0);
      const { button, preventDefault, stopPropagation } = await clickCopy(harness, 1);

      expect(clipboardMocks.writeClipboardText).toHaveBeenCalledWith(wiB.url);
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(stopPropagation).toHaveBeenCalledOnce();
      expect(button.getAttribute("aria-label")).toBe("Copied work item WI-2 URL");
    });
  });

});

describe("WorkItemList - unlink affordance", () => {
  beforeEach(() => {
    apiMocks.unlinkResource.mockReset();
    apiMocks.unlinkResource.mockResolvedValue({});
    apiMocks.linkResource.mockReset();
    apiMocks.linkResource.mockResolvedValue({});
    toastMocks.showToast.mockClear();
    toastMocks.dismissToast.mockClear();
  });

  it("unlinks with the row provider/id and notifies the parent", async () => {
    const onTasksChanged = vi.fn();
    await withWorkItemList(
      { enrichedWIs: [wiA, wiB], rawWIs: [], variant: "compact", taskId: "task-1", onTasksChanged },
      async (harness) => {
        expect(findUnlinkButtons(harness)).toHaveLength(2);
        await clickUnlink(harness, 1);

        expect(apiMocks.unlinkResource).toHaveBeenCalledWith("task-1", {
          type: "workItem",
          workItemId: "WI-2",
          provider: "ado",
        });
        expect(onTasksChanged).toHaveBeenCalledOnce();
      },
    );
  });

  it("undo re-links the work item and dismisses its toast", async () => {
    const onTasksChanged = vi.fn();
    await withWorkItemList(
      { enrichedWIs: [wiA], rawWIs: [], variant: "compact", taskId: "task-1", onTasksChanged },
      async (harness) => {
        await clickUnlink(harness);
        const toast = lastToast();
        expect(toast?.tone).toBe("success");
        expect(toast?.action?.label).toBe("Undo");
        onTasksChanged.mockClear();

        await harness.act(async () => {
          await toast?.action?.onAction();
        });
        await flushAct(harness.act);

        expect(apiMocks.linkResource).toHaveBeenCalledWith("task-1", {
          type: "workItem",
          workItemId: "WI-1",
          provider: "ado",
        });
        expect(onTasksChanged).toHaveBeenCalledOnce();
        expect(toastMocks.dismissToast).toHaveBeenCalledWith("toast-1");
      },
    );
  });

  it("reports a failed undo through an error toast", async () => {
    apiMocks.linkResource.mockRejectedValueOnce(new Error("Task not found"));
    await withWorkItemList(
      { enrichedWIs: [wiA], rawWIs: [], variant: "compact", taskId: "task-1" },
      async (harness) => {
        await clickUnlink(harness);

        const undo = lastToast()?.action?.onAction;
        await harness.act(async () => { await undo?.(); });
        await flushAct(harness.act);

        const toast = lastToast();
        expect(toast?.tone).toBe("error");
        expect(toast?.title).toBe("Could not restore work item WI-1");
        expect(toastMocks.dismissToast).not.toHaveBeenCalled();
      },
    );
  });

  it("unlinks raw fallback rows that have no enriched URL", async () => {
    await withWorkItemList(
      { enrichedWIs: [], rawWIs: rawWIOnly, variant: "compact", taskId: "task-1" },
      async (harness) => {
        await clickUnlink(harness);

        expect(apiMocks.unlinkResource).toHaveBeenCalledWith("task-1", {
          type: "workItem",
          workItemId: "WI-99",
          provider: "ado",
        });
      },
    );
  });

  it("surfaces an error toast and skips the parent refresh when unlink fails", async () => {
    const onTasksChanged = vi.fn();
    apiMocks.unlinkResource.mockRejectedValueOnce(new Error("Task not found"));
    await withWorkItemList(
      { enrichedWIs: [wiA], rawWIs: [], variant: "compact", taskId: "task-1", onTasksChanged },
      async (harness) => {
        await clickUnlink(harness);

        const toast = lastToast();
        expect(toast?.tone).toBe("error");
        expect(toast?.description).toContain("Task not found");
        expect(toast?.action).toBeUndefined();
        expect(onTasksChanged).not.toHaveBeenCalled();
      },
    );
  });

  it("keeps unlink in the opened row of a single-item summary", async () => {
    await withWorkItemList(
      { enrichedWIs: [wiReal], rawWIs: [], variant: "summary", taskId: "task-single-summary" },
      async (harness) => {
        expect(findUnlinkButtons(harness)).toHaveLength(0);
        await clickFirstSummaryButton(harness);
        expect(findUnlinkButtons(harness)).toHaveLength(1);

        await clickUnlink(harness);

        expect(apiMocks.unlinkResource).toHaveBeenCalledWith("task-single-summary", {
          type: "workItem",
          workItemId: "WI-3",
          provider: "ado",
        });
      },
    );
  });

});
