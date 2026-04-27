import { createElement } from "react";
import { describe, it, expect, vi } from "vitest";
import { installDomShim } from "../../test-dom-shim";
import type { EnrichedWorkItem, WorkItemRef } from "../../api";

// ── DOM helpers ────────────────────────────────────────────────────

function findAllByTag(root: any, tag: string): any[] {
  const results: any[] = [];
  if ((root.tagName ?? "").toUpperCase() === tag.toUpperCase()) results.push(root);
  for (const child of root.childNodes ?? []) {
    results.push(...findAllByTag(child, tag));
  }
  return results;
}

function getReactProps(el: any): Record<string, any> | null {
  if (!el) return null;
  const key = Object.keys(el).find((k) => k.startsWith("__reactProps$"));
  return key ? el[key] : null;
}

async function waitTick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

// ── Fixtures ───────────────────────────────────────────────────────

function makeWI(id: string, url: string): EnrichedWorkItem {
  return { id, provider: "ado", title: `Work item ${id}`, state: "Active", type: "Task", assignedTo: null, areaPath: null, url };
}

const wiA = makeWI("WI-1", "https://dev.azure.com/org/proj/1");
const wiB = makeWI("WI-2", "https://dev.azure.com/org/proj/2");
const wiReal = makeWI("WI-3", "https://dev.azure.com/org/proj/3");
const rawWIOnly: WorkItemRef[] = [{ id: "WI-99", provider: "ado" }];

// ── Tests ──────────────────────────────────────────────────────────

describe("WorkItemList – summary variant", () => {
  it("multiple items are collapsed by default", async () => {
    const dom = installDomShim();
    const [{ createRoot }, { flushSync }] = await Promise.all([
      import("react-dom/client"),
      import("react-dom"),
    ]);
    const { default: WorkItemList } = await import("./WorkItemList");
    const root = createRoot(dom.container as any);
    try {
      flushSync(() => {
        root.render(createElement(WorkItemList, { enrichedWIs: [wiA, wiB], rawWIs: [], variant: "summary" }));
      });
      expect(findAllByTag(dom.container, "A")).toHaveLength(0);
    } finally {
      flushSync(() => root.unmount());
      await waitTick();
      dom.cleanup();
    }
  });

  it("clicking summary expands and reveals compact linked rows", async () => {
    const dom = installDomShim();
    const [{ createRoot }, { flushSync }] = await Promise.all([
      import("react-dom/client"),
      import("react-dom"),
    ]);
    const { default: WorkItemList } = await import("./WorkItemList");
    const root = createRoot(dom.container as any);
    try {
      flushSync(() => {
        root.render(createElement(WorkItemList, { enrichedWIs: [wiA, wiB], rawWIs: [], variant: "summary" }));
      });

      const [button] = findAllByTag(dom.container, "BUTTON");
      flushSync(() => { getReactProps(button)?.onClick?.(); });

      expect(findAllByTag(dom.container, "A")).toHaveLength(2);
    } finally {
      flushSync(() => root.unmount());
      await waitTick();
      dom.cleanup();
    }
  });

  it("clicking summary again collapses", async () => {
    const dom = installDomShim();
    const [{ createRoot }, { flushSync }] = await Promise.all([
      import("react-dom/client"),
      import("react-dom"),
    ]);
    const { default: WorkItemList } = await import("./WorkItemList");
    const root = createRoot(dom.container as any);
    try {
      flushSync(() => {
        root.render(createElement(WorkItemList, { enrichedWIs: [wiA, wiB], rawWIs: [], variant: "summary" }));
      });

      // expand
      let [button] = findAllByTag(dom.container, "BUTTON");
      flushSync(() => { getReactProps(button)?.onClick?.(); });
      expect(findAllByTag(dom.container, "A")).toHaveLength(2);

      // collapse
      [button] = findAllByTag(dom.container, "BUTTON");
      flushSync(() => { getReactProps(button)?.onClick?.(); });
      expect(findAllByTag(dom.container, "A")).toHaveLength(0);
    } finally {
      flushSync(() => root.unmount());
      await waitTick();
      dom.cleanup();
    }
  });

  it("changing resetKey collapses expanded content", async () => {
    const dom = installDomShim();
    const [{ createRoot }, { flushSync }, { act }] = await Promise.all([
      import("react-dom/client"),
      import("react-dom"),
      import("react"),
    ]);
    const { default: WorkItemList } = await import("./WorkItemList");
    const root = createRoot(dom.container as any);
    try {
      const items = [wiA, wiB];

      await act(async () => {
        root.render(createElement(WorkItemList, { enrichedWIs: items, rawWIs: [], variant: "summary", resetKey: "task-1" }));
      });

      const [button] = findAllByTag(dom.container, "BUTTON");
      await act(async () => { getReactProps(button)?.onClick?.(); });

      expect(findAllByTag(dom.container, "A")).toHaveLength(2);

      // change resetKey → useEffect fires → collapsed
      await act(async () => {
        root.render(createElement(WorkItemList, { enrichedWIs: items, rawWIs: [], variant: "summary", resetKey: "task-2" }));
      });

      expect(findAllByTag(dom.container, "A")).toHaveLength(0);
    } finally {
      flushSync(() => root.unmount());
      await waitTick();
      dom.cleanup();
    }
  });

  it("expanded rows contain external anchor links", async () => {
    const dom = installDomShim();
    const [{ createRoot }, { flushSync }] = await Promise.all([
      import("react-dom/client"),
      import("react-dom"),
    ]);
    const { default: WorkItemList } = await import("./WorkItemList");
    const root = createRoot(dom.container as any);
    try {
      flushSync(() => {
        root.render(createElement(WorkItemList, { enrichedWIs: [wiA, wiB], rawWIs: [], variant: "summary" }));
      });

      const [button] = findAllByTag(dom.container, "BUTTON");
      flushSync(() => { getReactProps(button)?.onClick?.(); });

      const anchors = findAllByTag(dom.container, "A");
      expect(anchors).toHaveLength(2);
      for (const a of anchors) {
        expect(a.getAttribute("target")).toBe("_blank");
        expect(a.getAttribute("rel")).toBe("noopener");
        expect(a.getAttribute("href")).toMatch(/^https?:\/\//);
      }
    } finally {
      flushSync(() => root.unmount());
      await waitTick();
      dom.cleanup();
    }
  });

  it("single item with a real URL calls window.open", async () => {
    const dom = installDomShim();
    const mockOpen = vi.fn();
    (globalThis as any).window.open = mockOpen;

    const [{ createRoot }, { flushSync }] = await Promise.all([
      import("react-dom/client"),
      import("react-dom"),
    ]);
    const { default: WorkItemList } = await import("./WorkItemList");
    const root = createRoot(dom.container as any);
    try {
      flushSync(() => {
        root.render(createElement(WorkItemList, { enrichedWIs: [wiReal], rawWIs: [], variant: "summary" }));
      });

      const [button] = findAllByTag(dom.container, "BUTTON");
      flushSync(() => { getReactProps(button)?.onClick?.(); });

      expect(mockOpen).toHaveBeenCalledOnce();
      expect(mockOpen).toHaveBeenCalledWith(wiReal.url, "_blank", "noopener");
    } finally {
      delete (globalThis as any).window.open;
      flushSync(() => root.unmount());
      await waitTick();
      dom.cleanup();
    }
  });

  it("single item with url '#' (raw fallback) does not navigate", async () => {
    const dom = installDomShim();
    const mockOpen = vi.fn();
    (globalThis as any).window.open = mockOpen;

    const [{ createRoot }, { flushSync }] = await Promise.all([
      import("react-dom/client"),
      import("react-dom"),
    ]);
    const { default: WorkItemList } = await import("./WorkItemList");
    const root = createRoot(dom.container as any);
    try {
      flushSync(() => {
        root.render(createElement(WorkItemList, { enrichedWIs: [], rawWIs: rawWIOnly, variant: "summary" }));
      });

      const [button] = findAllByTag(dom.container, "BUTTON");
      flushSync(() => { getReactProps(button)?.onClick?.(); });

      expect(mockOpen).not.toHaveBeenCalled();
    } finally {
      delete (globalThis as any).window.open;
      flushSync(() => root.unmount());
      await waitTick();
      dom.cleanup();
    }
  });

  it("single item with missing URL expands inline on click", async () => {
    const dom = installDomShim();
    const [{ createRoot }, { flushSync }] = await Promise.all([
      import("react-dom/client"),
      import("react-dom"),
    ]);
    const { default: WorkItemList } = await import("./WorkItemList");
    const root = createRoot(dom.container as any);
    try {
      flushSync(() => {
        root.render(createElement(WorkItemList, { enrichedWIs: [], rawWIs: rawWIOnly, variant: "summary" }));
      });

      // collapsed by default – no child rows
      expect(findAllByTag(dom.container, "A")).toHaveLength(0);

      const [button] = findAllByTag(dom.container, "BUTTON");
      flushSync(() => { getReactProps(button)?.onClick?.(); });

      // after clicking, the disclosure panel should be visible (contains at least one child DIV row)
      const divs = findAllByTag(dom.container, "DIV");
      expect(divs.length).toBeGreaterThan(0);
    } finally {
      flushSync(() => root.unmount());
      await waitTick();
      dom.cleanup();
    }
  });

  it("expanded rows with missing URL do not render href='#' anchors", async () => {
    const dom = installDomShim();
    const [{ createRoot }, { flushSync }] = await Promise.all([
      import("react-dom/client"),
      import("react-dom"),
    ]);
    const { default: WorkItemList } = await import("./WorkItemList");
    const root = createRoot(dom.container as any);
    try {
      flushSync(() => {
        root.render(createElement(WorkItemList, { enrichedWIs: [], rawWIs: rawWIOnly, variant: "summary" }));
      });

      const [button] = findAllByTag(dom.container, "BUTTON");
      flushSync(() => { getReactProps(button)?.onClick?.(); });

      const anchors = findAllByTag(dom.container, "A");
      for (const a of anchors) {
        const href = a.getAttribute("href") ?? "";
        expect(href).not.toBe("#");
        expect(href).toMatch(/^https?:\/\//);
      }
    } finally {
      flushSync(() => root.unmount());
      await waitTick();
      dom.cleanup();
    }
  });
});
