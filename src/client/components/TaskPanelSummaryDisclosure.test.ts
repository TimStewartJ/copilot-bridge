import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createReactDomHarness,
  findAllByTag,
  getReactProps,
} from "../test-react-harness";
import { TASK_PANEL_DISCLOSURE_STORAGE_KEY } from "../task-panel-disclosure-state";
import type { TaskPanelSummaryDisclosureProps } from "./TaskPanelSummaryDisclosure";

function stubLocalStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const storage: Storage = {
    get length() {
      return store.size;
    },
    clear: vi.fn(() => store.clear()),
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    key: vi.fn((index: number) => Array.from(store.keys())[index] ?? null),
    removeItem: vi.fn((key: string) => {
      store.delete(key);
    }),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, String(value));
    }),
  };
  vi.stubGlobal("localStorage", storage);
  return storage;
}

async function renderDisclosure(
  harness: Awaited<ReturnType<typeof createReactDomHarness>>,
  props: Pick<TaskPanelSummaryDisclosureProps, "taskId" | "disclosureId">,
) {
  const { default: TaskPanelSummaryDisclosure } = await import("./TaskPanelSummaryDisclosure");
  await harness.render(createElement(
    TaskPanelSummaryDisclosure,
    {
      ...props,
      label: "Work items",
      icon: createElement("span"),
      title: "2 linked work items",
      itemCount: 2,
      children: createElement("div", null, "Expanded content"),
    },
  ));
}

async function clickDisclosure(harness: Awaited<ReturnType<typeof createReactDomHarness>>) {
  const [button] = findAllByTag(harness.dom.container, "BUTTON");
  if (!button) throw new Error("Disclosure button was not rendered");
  await harness.act(async () => {
    getReactProps(button)?.onClick?.({ currentTarget: button });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TaskPanelSummaryDisclosure persistence", () => {
  it("saves expansion independently for each task and restores it when switching back", async () => {
    const storage = stubLocalStorage();
    const harness = await createReactDomHarness();
    try {
      await renderDisclosure(harness, { taskId: "task-1", disclosureId: "work-items" });
      expect(harness.dom.container.textContent).not.toContain("Expanded content");

      await clickDisclosure(harness);
      expect(harness.dom.container.textContent).toContain("Expanded content");

      await renderDisclosure(harness, { taskId: "task-2", disclosureId: "work-items" });
      expect(harness.dom.container.textContent).not.toContain("Expanded content");

      await renderDisclosure(harness, { taskId: "task-1", disclosureId: "work-items" });
      expect(harness.dom.container.textContent).toContain("Expanded content");
      expect(JSON.parse(storage.getItem(TASK_PANEL_DISCLOSURE_STORAGE_KEY) ?? "{}")).toEqual({
        "task-1": { "work-items": true },
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("restores saved expansion in a fresh component mount", async () => {
    stubLocalStorage({
      [TASK_PANEL_DISCLOSURE_STORAGE_KEY]: JSON.stringify({
        "task-1": { docs: true },
      }),
    });
    const harness = await createReactDomHarness();
    try {
      await renderDisclosure(harness, { taskId: "task-1", disclosureId: "docs" });
      expect(harness.dom.container.textContent).toContain("Expanded content");
    } finally {
      await harness.cleanup();
    }
  });

  it("collapsing removes only that task section from saved state", async () => {
    const storage = stubLocalStorage({
      [TASK_PANEL_DISCLOSURE_STORAGE_KEY]: JSON.stringify({
        "task-1": { "work-items": true, docs: true },
        "task-2": { schedules: true },
      }),
    });
    const harness = await createReactDomHarness();
    try {
      await renderDisclosure(harness, { taskId: "task-1", disclosureId: "work-items" });
      await clickDisclosure(harness);

      expect(harness.dom.container.textContent).not.toContain("Expanded content");
      expect(JSON.parse(storage.getItem(TASK_PANEL_DISCLOSURE_STORAGE_KEY) ?? "{}")).toEqual({
        "task-1": { docs: true },
        "task-2": { schedules: true },
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("falls back to collapsed state when saved data is malformed", async () => {
    stubLocalStorage({ [TASK_PANEL_DISCLOSURE_STORAGE_KEY]: "{invalid" });
    const harness = await createReactDomHarness();
    try {
      await renderDisclosure(harness, { taskId: "task-1", disclosureId: "pull-requests" });
      expect(harness.dom.container.textContent).not.toContain("Expanded content");
    } finally {
      await harness.cleanup();
    }
  });
});
