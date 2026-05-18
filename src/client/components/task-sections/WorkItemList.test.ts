import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { EnrichedWorkItem, WorkItemRef } from "../../api";
import {
  createReactDomHarness,
  findAllByTag,
  getReactProps,
} from "../../test-react-harness";
import type { WorkItemListProps } from "./WorkItemList";

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

  it("changing resetKey collapses expanded content", async () => {
    await withWorkItemList({
      enrichedWIs: [wiA, wiB],
      rawWIs: [],
      variant: "summary",
      resetKey: "task-1",
    }, async (harness) => {
      const { default: WorkItemList } = await import("./WorkItemList");
      const items = [wiA, wiB];

      await clickFirstSummaryButton(harness);
      expect(findAllByTag(harness.dom.container, "A")).toHaveLength(2);

      await harness.render(createElement(WorkItemList, {
        enrichedWIs: items,
        rawWIs: [],
        variant: "summary",
        resetKey: "task-2",
      }));

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

  it("single item with missing URL expands inline on click", async () => {
    await withWorkItemList({ enrichedWIs: [], rawWIs: rawWIOnly, variant: "summary" }, async (harness) => {
      expect(findAllByTag(harness.dom.container, "A")).toHaveLength(0);

      await clickFirstSummaryButton(harness);

      const divs = findAllByTag(harness.dom.container, "DIV");
      expect(divs.length).toBeGreaterThan(0);
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
