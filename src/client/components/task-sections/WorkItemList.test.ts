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
  it("multiple items are collapsed by default", async () => {
    await withWorkItemList({ enrichedWIs: [wiA, wiB], rawWIs: [], variant: "summary" }, (harness) => {
      expect(findAllByTag(harness.dom.container, "A")).toHaveLength(0);
    });
  });

  it("clicking summary expands and reveals compact linked rows", async () => {
    await withWorkItemList({ enrichedWIs: [wiA, wiB], rawWIs: [], variant: "summary" }, async (harness) => {
      await clickFirstSummaryButton(harness);

      expect(findAllByTag(harness.dom.container, "A")).toHaveLength(2);
    });
  });

  it("clicking summary again collapses", async () => {
    await withWorkItemList({ enrichedWIs: [wiA, wiB], rawWIs: [], variant: "summary" }, async (harness) => {
      await clickFirstSummaryButton(harness);
      expect(findAllByTag(harness.dom.container, "A")).toHaveLength(2);

      await clickFirstSummaryButton(harness);
      expect(findAllByTag(harness.dom.container, "A")).toHaveLength(0);
    });
  });

  it("expanded rows contain external anchor links", async () => {
    await withWorkItemList({ enrichedWIs: [wiA, wiB], rawWIs: [], variant: "summary" }, async (harness) => {
      await clickFirstSummaryButton(harness);

      const anchors = findAllByTag(harness.dom.container, "A");
      expect(anchors).toHaveLength(2);
      for (const anchor of anchors) {
        expect(anchor.getAttribute("target")).toBe("_blank");
        expect(anchor.getAttribute("rel")).toBe("noopener");
        expect(anchor.getAttribute("href")).toMatch(/^https?:\/\//);
      }
    });
  });

  it("single item with a real URL calls window.open", async () => {
    await withWorkItemList({ enrichedWIs: [wiReal], rawWIs: [], variant: "summary" }, async (harness) => {
      const mockOpen = vi.fn();
      (globalThis.window as unknown as { open?: typeof mockOpen }).open = mockOpen;
      try {
        await clickFirstSummaryButton(harness);

        expect(mockOpen).toHaveBeenCalledOnce();
        expect(mockOpen).toHaveBeenCalledWith(wiReal.url, "_blank", "noopener");
      } finally {
        delete (globalThis.window as unknown as { open?: typeof mockOpen }).open;
      }
    });
  });

  it("single item with url '#' (raw fallback) does not navigate", async () => {
    await withWorkItemList({ enrichedWIs: [], rawWIs: rawWIOnly, variant: "summary" }, async (harness) => {
      const mockOpen = vi.fn();
      (globalThis.window as unknown as { open?: typeof mockOpen }).open = mockOpen;
      try {
        await clickFirstSummaryButton(harness);

        expect(mockOpen).not.toHaveBeenCalled();
      } finally {
        delete (globalThis.window as unknown as { open?: typeof mockOpen }).open;
      }
    });
  });

  it("expanded rows with missing URL do not render href='#' anchors", async () => {
    await withWorkItemList({ enrichedWIs: [], rawWIs: rawWIOnly, variant: "summary" }, async (harness) => {
      await clickFirstSummaryButton(harness);

      const anchors = findAllByTag(harness.dom.container, "A");
      for (const anchor of anchors) {
        const href = anchor.getAttribute("href") ?? "";
        expect(href).not.toBe("#");
        expect(href).toMatch(/^https?:\/\//);
      }
    });
  });
});

describe("WorkItemList - copy affordance", () => {
  beforeEach(() => {
    clipboardMocks.writeClipboardText.mockReset();
    clipboardMocks.writeClipboardText.mockResolvedValue(undefined);
  });

  it("renders a hover copy action for every work item with a real URL", async () => {
    await withWorkItemList({ enrichedWIs: [wiA, wiB], rawWIs: [], variant: "compact" }, (harness) => {
      const buttons = findCopyButtons(harness);
      expect(buttons).toHaveLength(2);
      expect(buttons[0]?.getAttribute("class")).toContain("linked-resource-copy-button");
    });
  });

  it("copies the exact work-item URL without following the row link", async () => {
    await withWorkItemList({ enrichedWIs: [wiA], rawWIs: [], variant: "compact" }, async (harness) => {
      const { button, preventDefault, stopPropagation } = await clickCopy(harness);

      expect(clipboardMocks.writeClipboardText).toHaveBeenCalledWith(wiA.url);
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(stopPropagation).toHaveBeenCalledOnce();
      expect(button.getAttribute("aria-label")).toBe("Copied work item WI-1 URL");
    });
  });

  it("shows the copy action on a single-item summary without opening the work item", async () => {
    await withWorkItemList({ enrichedWIs: [wiReal], rawWIs: [], variant: "summary" }, async (harness) => {
      const mockOpen = vi.fn();
      (globalThis.window as unknown as { open?: typeof mockOpen }).open = mockOpen;
      try {
        await clickCopy(harness);

        expect(clipboardMocks.writeClipboardText).toHaveBeenCalledWith(wiReal.url);
        expect(mockOpen).not.toHaveBeenCalled();
      } finally {
        delete (globalThis.window as unknown as { open?: typeof mockOpen }).open;
      }
    });
  });

  it("does not render a copy action when enrichment has no URL", async () => {
    await withWorkItemList({ enrichedWIs: [], rawWIs: rawWIOnly, variant: "compact" }, (harness) => {
      expect(findCopyButtons(harness)).toHaveLength(0);
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

  it("renders no unlink button when taskId is omitted", async () => {
    await withWorkItemList({ enrichedWIs: [wiA, wiB], rawWIs: [], variant: "compact" }, (harness) => {
      expect(findUnlinkButtons(harness)).toHaveLength(0);
    });
  });

  it("renders one unlink button per row when taskId is provided", async () => {
    await withWorkItemList({ enrichedWIs: [wiA, wiB], rawWIs: [], variant: "compact", taskId: "task-1" }, (harness) => {
      expect(findUnlinkButtons(harness)).toHaveLength(2);
      expect(findAllByTag(harness.dom.container, "A")).toHaveLength(2);
    });
  });

  it("requires an in-place second click without a browser confirmation prompt", async () => {
    const confirmMock = vi.fn(() => false);
    (globalThis.window as unknown as { confirm?: typeof confirmMock }).confirm = confirmMock;
    try {
      await withWorkItemList(
        { enrichedWIs: [wiA], rawWIs: [], variant: "compact", taskId: "task-1" },
        async (harness) => {
          const { button, preventDefault, stopPropagation } = await clickUnlinkOnce(harness);

          expect(confirmMock).not.toHaveBeenCalled();
          expect(apiMocks.unlinkResource).not.toHaveBeenCalled();
          expect(button.getAttribute("aria-label")).toBe("Confirm unlink work item WI-1 from task");
          expect(button.getAttribute("data-unlink-state")).toBe("confirming");
          expect(preventDefault).toHaveBeenCalledOnce();
          expect(stopPropagation).toHaveBeenCalledOnce();

          await clickUnlinkOnce(harness);

          expect(apiMocks.unlinkResource).toHaveBeenCalledOnce();
        },
      );
    } finally {
      delete (globalThis.window as unknown as { confirm?: typeof confirmMock }).confirm;
    }
  });

  it("unlinks with the row provider/id and notifies the parent", async () => {
    const onTasksChanged = vi.fn();
    await withWorkItemList(
      { enrichedWIs: [wiA], rawWIs: [], variant: "compact", taskId: "task-1", onTasksChanged },
      async (harness) => {
        await clickUnlink(harness);

        expect(apiMocks.unlinkResource).toHaveBeenCalledWith("task-1", {
          type: "workItem",
          workItemId: "WI-1",
          provider: "ado",
        });
        expect(onTasksChanged).toHaveBeenCalledOnce();
      },
    );
  });

  it("shows a success toast offering undo", async () => {
    await withWorkItemList(
      { enrichedWIs: [wiA], rawWIs: [], variant: "compact", taskId: "task-1" },
      async (harness) => {
        await clickUnlink(harness);

        const toast = lastToast();
        expect(toast?.tone).toBe("success");
        expect(toast?.title).toBe("Unlinked work item WI-1");
        expect(toast?.action?.label).toBe("Undo");
      },
    );
  });

  it("undo re-links the work item and dismisses its toast", async () => {
    const onTasksChanged = vi.fn();
    await withWorkItemList(
      { enrichedWIs: [wiA], rawWIs: [], variant: "compact", taskId: "task-1", onTasksChanged },
      async (harness) => {
        await clickUnlink(harness);
        onTasksChanged.mockClear();

        await harness.act(async () => {
          await lastToast()?.action?.onAction();
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

  it("exposes an unlink button on a single-item summary row that cannot expand", async () => {
    await withWorkItemList(
      { enrichedWIs: [wiReal], rawWIs: [], variant: "summary", taskId: "task-1" },
      async (harness) => {
        expect(findUnlinkButtons(harness)).toHaveLength(1);

        await clickUnlink(harness);

        expect(apiMocks.unlinkResource).toHaveBeenCalledWith("task-1", {
          type: "workItem",
          workItemId: "WI-3",
          provider: "ado",
        });
      },
    );
  });

});
