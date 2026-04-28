import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ChecklistItem } from "../../api";
import { installDomShim } from "../../test-dom-shim";

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

function findButtonByText(root: any, text: string): any {
  const button = findAllByTag(root, "BUTTON").find((candidate) => (
    candidate.textContent?.includes(text)
  ));
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

function findInputByPlaceholder(root: any, placeholder: string): any {
  const input = findAllByTag(root, "INPUT").find((candidate) => (
    getReactProps(candidate)?.placeholder === placeholder
  ));
  if (!input) throw new Error(`Input not found: ${placeholder}`);
  return input;
}

async function waitTick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function createChecklistItem(overrides: Partial<ChecklistItem> = {}): ChecklistItem {
  return {
    id: "item-1",
    taskId: "task-1",
    text: "Open item",
    done: false,
    order: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const baseProps = {
  taskId: "task-1",
  newChecklistItemText: "",
  onNewChecklistItemTextChange: vi.fn(),
  onCreateChecklistItem: vi.fn(async () => {}),
  onChecklistItemUpdate: vi.fn(),
  onChecklistItemDelete: vi.fn(),
};

describe("TaskChecklistSection panel expansion", () => {
  it("expands all open items in place without revealing done items", async () => {
    const dom = installDomShim();
    const [{ createRoot }, { flushSync }] = await Promise.all([
      import("react-dom/client"),
      import("react-dom"),
    ]);
    const { default: TaskChecklistSection } = await import("./TaskChecklistSection");
    const root = createRoot(dom.container as any);
    const checklistItems = [
      createChecklistItem({ id: "open-1", text: "Open one", order: 0 }),
      createChecklistItem({ id: "open-2", text: "Open two", order: 1 }),
      createChecklistItem({ id: "open-3", text: "Open three", order: 2 }),
      createChecklistItem({ id: "open-4", text: "Open four", order: 3 }),
      createChecklistItem({ id: "done-1", text: "Done one", done: true, order: 4 }),
      createChecklistItem({ id: "done-2", text: "Done two", done: true, order: 5 }),
    ];

    try {
      flushSync(() => {
        root.render(createElement(TaskChecklistSection, {
          ...baseProps,
          checklistItems,
          variant: "panel",
        }));
      });

      expect(dom.container.textContent).toContain("Open one");
      expect(dom.container.textContent).toContain("Open two");
      expect(dom.container.textContent).toContain("Open three");
      expect(dom.container.textContent).not.toContain("Open four");
      expect(dom.container.textContent).not.toContain("Done one");
      expect(dom.container.textContent).toContain("View full checklist");
      expect(dom.container.textContent).toContain("1 more open");
      expect(dom.container.textContent).toContain("2 done");

      flushSync(() => {
        getReactProps(findButtonByText(dom.container, "View full checklist"))?.onClick?.();
      });

      expect(dom.container.textContent).toContain("Open four");
      expect(dom.container.textContent).toContain("Show fewer open items");
      expect(dom.container.textContent).not.toContain("Done one");
      expect(dom.container.textContent).not.toContain("Done two");
    } finally {
      flushSync(() => root.unmount());
      await waitTick();
      dom.cleanup();
    }
  });

  it("reveals completed items only through the separate done expansion", async () => {
    const dom = installDomShim();
    const [{ createRoot }, { flushSync }] = await Promise.all([
      import("react-dom/client"),
      import("react-dom"),
    ]);
    const { default: TaskChecklistSection } = await import("./TaskChecklistSection");
    const root = createRoot(dom.container as any);
    const checklistItems = [
      createChecklistItem({ id: "open-1", text: "Open one", order: 0 }),
      createChecklistItem({ id: "done-1", text: "Done one", done: true, order: 1 }),
    ];

    try {
      flushSync(() => {
        root.render(createElement(TaskChecklistSection, {
          ...baseProps,
          checklistItems,
          variant: "panel",
        }));
      });

      expect(dom.container.textContent).toContain("1 done");
      expect(dom.container.textContent).not.toContain("Done one");

      flushSync(() => {
        getReactProps(findButtonByText(dom.container, "1 done"))?.onClick?.();
      });

      expect(dom.container.textContent).toContain("Done one");
    } finally {
      flushSync(() => root.unmount());
      await waitTick();
      dom.cleanup();
    }
  });

  it("expands the open checklist after adding an item", async () => {
    const dom = installDomShim();
    const [{ createRoot }, { flushSync }] = await Promise.all([
      import("react-dom/client"),
      import("react-dom"),
    ]);
    const { default: TaskChecklistSection } = await import("./TaskChecklistSection");
    const root = createRoot(dom.container as any);
    const onCreateChecklistItem = vi.fn(async () => {});
    const checklistItems = [
      createChecklistItem({ id: "open-1", text: "Open one", order: 0 }),
      createChecklistItem({ id: "open-2", text: "Open two", order: 1 }),
      createChecklistItem({ id: "open-3", text: "Open three", order: 2 }),
      createChecklistItem({ id: "open-4", text: "Open four", order: 3 }),
    ];

    try {
      flushSync(() => {
        root.render(createElement(TaskChecklistSection, {
          ...baseProps,
          checklistItems,
          newChecklistItemText: "New item",
          onCreateChecklistItem,
          variant: "panel",
        }));
      });

      expect(dom.container.textContent).not.toContain("Open four");

      const input = findInputByPlaceholder(dom.container, "+ Add item…");
      await getReactProps(input)?.onKeyDown?.({ key: "Enter" });
      await waitTick();

      expect(onCreateChecklistItem).toHaveBeenCalledWith("New item");
      expect(dom.container.textContent).toContain("Open four");
      expect(dom.container.textContent).toContain("Show fewer open items");
    } finally {
      flushSync(() => root.unmount());
      await waitTick();
      dom.cleanup();
    }
  });
});
