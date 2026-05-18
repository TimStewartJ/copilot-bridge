import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ChecklistItem } from "../../api";
import {
  createReactDomHarness,
  findAllByTag,
  getReactProps,
} from "../../test-react-harness";
import type { TaskChecklistSectionProps } from "./TaskChecklistSection";

type ChecklistHarness = Awaited<ReturnType<typeof createReactDomHarness>>;

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

function createBaseProps(overrides: Partial<TaskChecklistSectionProps> = {}): TaskChecklistSectionProps {
  return {
    taskId: "task-1",
    checklistItems: [],
    newChecklistItemText: "",
    onNewChecklistItemTextChange: vi.fn(),
    onCreateChecklistItem: vi.fn(async () => {}),
    onChecklistItemUpdate: vi.fn(),
    onChecklistItemDelete: vi.fn(),
    ...overrides,
  };
}

async function withChecklistSection(
  props: TaskChecklistSectionProps,
  run: (harness: ChecklistHarness) => Promise<void> | void,
) {
  const harness = await createReactDomHarness();
  try {
    const { default: TaskChecklistSection } = await import("./TaskChecklistSection");
    await harness.render(createElement(TaskChecklistSection, props));
    await run(harness);
  } finally {
    await harness.cleanup();
  }
}

async function clickButton(harness: ChecklistHarness, text: string) {
  const button = findButtonByText(harness.dom.container, text);
  await harness.act(async () => {
    getReactProps(button)?.onClick?.({ currentTarget: button });
  });
}

describe("TaskChecklistSection panel expansion", () => {
  it("expands all open items in place without revealing done items", async () => {
    const checklistItems = [
      createChecklistItem({ id: "open-1", text: "Open one", order: 0 }),
      createChecklistItem({ id: "open-2", text: "Open two", order: 1 }),
      createChecklistItem({ id: "open-3", text: "Open three", order: 2 }),
      createChecklistItem({ id: "open-4", text: "Open four", order: 3 }),
      createChecklistItem({ id: "done-1", text: "Done one", done: true, order: 4 }),
      createChecklistItem({ id: "done-2", text: "Done two", done: true, order: 5 }),
    ];

    await withChecklistSection(createBaseProps({
      checklistItems,
      variant: "panel",
    }), async (harness) => {
      expect(harness.dom.container.textContent).toContain("Open one");
      expect(harness.dom.container.textContent).toContain("Open two");
      expect(harness.dom.container.textContent).toContain("Open three");
      expect(harness.dom.container.textContent).not.toContain("Open four");
      expect(harness.dom.container.textContent).not.toContain("Done one");
      expect(harness.dom.container.textContent).toContain("View full checklist");
      expect(harness.dom.container.textContent).toContain("1 more open");
      expect(harness.dom.container.textContent).toContain("2 done");

      await clickButton(harness, "View full checklist");

      expect(harness.dom.container.textContent).toContain("Open four");
      expect(harness.dom.container.textContent).toContain("Show fewer open items");
      expect(harness.dom.container.textContent).not.toContain("Done one");
      expect(harness.dom.container.textContent).not.toContain("Done two");
    });
  });

  it("reveals completed items only through the separate done expansion", async () => {
    const checklistItems = [
      createChecklistItem({ id: "open-1", text: "Open one", order: 0 }),
      createChecklistItem({ id: "done-1", text: "Done one", done: true, order: 1 }),
    ];

    await withChecklistSection(createBaseProps({
      checklistItems,
      variant: "panel",
    }), async (harness) => {
      expect(harness.dom.container.textContent).toContain("1 done");
      expect(harness.dom.container.textContent).not.toContain("Done one");

      await clickButton(harness, "1 done");

      expect(harness.dom.container.textContent).toContain("Done one");
    });
  });

  it("expands the open checklist after adding an item", async () => {
    const onCreateChecklistItem = vi.fn(async () => {});
    const checklistItems = [
      createChecklistItem({ id: "open-1", text: "Open one", order: 0 }),
      createChecklistItem({ id: "open-2", text: "Open two", order: 1 }),
      createChecklistItem({ id: "open-3", text: "Open three", order: 2 }),
      createChecklistItem({ id: "open-4", text: "Open four", order: 3 }),
    ];

    await withChecklistSection(createBaseProps({
      checklistItems,
      newChecklistItemText: "New item",
      onCreateChecklistItem,
      variant: "panel",
    }), async (harness) => {
      expect(harness.dom.container.textContent).not.toContain("Open four");

      const input = findInputByPlaceholder(harness.dom.container, "+ Add item…");
      await harness.act(async () => {
        await getReactProps(input)?.onKeyDown?.({ key: "Enter" });
      });

      expect(onCreateChecklistItem).toHaveBeenCalledWith("New item");
      expect(harness.dom.container.textContent).toContain("Open four");
      expect(harness.dom.container.textContent).toContain("Show fewer open items");
    });
  });
});
