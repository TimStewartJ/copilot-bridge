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

vi.mock("../../api", async () => {
  const actual = await vi.importActual<typeof import("../../api")>("../../api");
  return { ...actual, unlinkResource: apiMocks.unlinkResource, linkResource: apiMocks.linkResource };
});

vi.mock("../../useToast", async () => {
  const actual = await vi.importActual<typeof import("../../useToast")>("../../useToast");
  return { ...actual, useToast: () => ({ ...toastMocks, updateToast: vi.fn() }) };
});

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
    .filter((button) => (button.getAttribute("aria-label") ?? "").startsWith("Unlink work item"));
}

/** Latest toast payload passed to showToast. */
function lastToast(): ToastInput | undefined {
  const calls = toastMocks.showToast.mock.calls as unknown as [ToastInput][];
  return calls.length > 0 ? calls[calls.length - 1][0] : undefined;
}

async function clickUnlink(harness: WorkItemHarness, index = 0) {
  const button = findUnlinkButtons(harness)[index];
  if (!button) throw new Error("Unlink button was not rendered");
  await harness.act(async () => {
    getReactProps(button)?.onClick?.({ currentTarget: button });
  });
  await flushAct(harness.act);
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

  it("unlinks immediately without a confirmation prompt", async () => {
    const confirmMock = vi.fn(() => false);
    (globalThis.window as unknown as { confirm?: typeof confirmMock }).confirm = confirmMock;
    try {
      await withWorkItemList(
        { enrichedWIs: [wiA], rawWIs: [], variant: "compact", taskId: "task-1" },
        async (harness) => {
          await clickUnlink(harness);

          expect(confirmMock).not.toHaveBeenCalled();
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

  it("forwards unlink props through the summary disclosure", async () => {
    await withWorkItemList(
      { enrichedWIs: [wiA, wiB], rawWIs: [], variant: "summary", taskId: "task-1" },
      async (harness) => {
        expect(findUnlinkButtons(harness)).toHaveLength(0);

        await clickFirstSummaryButton(harness);

        expect(findUnlinkButtons(harness)).toHaveLength(2);
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

  it("does not duplicate the unlink button when a single item expands inline", async () => {
    await withWorkItemList(
      { enrichedWIs: [], rawWIs: rawWIOnly, variant: "summary", taskId: "task-1" },
      async (harness) => {
        expect(findUnlinkButtons(harness)).toHaveLength(0);

        await clickFirstSummaryButton(harness);

        expect(findUnlinkButtons(harness)).toHaveLength(1);
      },
    );
  });
});
