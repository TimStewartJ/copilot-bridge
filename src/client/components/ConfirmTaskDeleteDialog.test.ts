import { createElement } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Task, TaskDeletionPreview } from "../api";
import {
  COMPONENT_IMPORT_WARMUP_TIMEOUT_MS,
  createReactDomHarness,
  findAllByTag,
  getReactProps,
} from "../test-react-harness";

let ConfirmTaskDeleteDialog: typeof import("./ConfirmTaskDeleteDialog").default;

beforeAll(async () => {
  const harness = await createReactDomHarness();
  try {
    ({ default: ConfirmTaskDeleteDialog } = await import("./ConfirmTaskDeleteDialog"));
  } finally {
    await harness.cleanup();
  }
}, COMPONENT_IMPORT_WARMUP_TIMEOUT_MS);

const task = {
  id: "task-1",
  title: "Ship the thing",
  kind: "task",
  muted: false,
  status: "active",
  notes: "",
  priority: 0,
  order: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  sessionIds: [],
  workItems: [],
  pullRequests: [],
} as unknown as Task;

function makePreview(overrides: Partial<TaskDeletionPreview> = {}): TaskDeletionPreview {
  return {
    sessionCount: 3,
    archivedCount: 1,
    unarchivedCount: 2,
    sharedSessionCount: 0,
    busySessionIds: [],
    scheduleCount: 0,
    fingerprint: "abc",
    ...overrides,
  };
}

function buttonsOf(container: any): any[] {
  return findAllByTag(container, "BUTTON");
}

function findButton(container: any, text: string): any {
  return buttonsOf(container).find((b) => (b.textContent ?? "").includes(text));
}

/** The DOM shim does not reflect `disabled` as a property, so read the React prop. */
function isDisabled(el: any): boolean {
  return getReactProps(el)?.disabled === true;
}

describe("ConfirmTaskDeleteDialog", () => {
  it("explains linked and shared sessions, dispatches the disposition and disables actions while it runs", async () => {
    const harness = await createReactDomHarness();
    const onConfirm = vi.fn();
    const props = { task, preview: makePreview({ sharedSessionCount: 2 }), onConfirm, onClose: vi.fn() };
    try {
      await harness.render(createElement(ConfirmTaskDeleteDialog, props));

      const text = harness.dom.container.textContent ?? "";
      expect(text).toContain("3 linked sessions");
      expect(text).toContain("1 already archived");
      expect(text).toContain("2 sessions also belong to another task");
      await harness.act(async () => {
        getReactProps(findButton(harness.dom.container, "Archive sessions"))?.onClick();
      });
      expect(onConfirm).toHaveBeenCalledWith("archive");

      await harness.act(async () => {
        getReactProps(findButton(harness.dom.container, "Delete sessions"))?.onClick();
      });
      expect(onConfirm).toHaveBeenCalledWith("delete");

      await harness.render(createElement(ConfirmTaskDeleteDialog, {
        ...props, busy: onConfirm.mock.lastCall![0], progressRemaining: 1,
      }));
      for (const button of buttonsOf(harness.dom.container)) {
        expect(isDisabled(button)).toBe(true);
      }
      expect(harness.dom.container.textContent).toContain("2 of 3 done");
    } finally {
      await harness.cleanup();
    }
  });

  it("blocks deletion while sessions are busy but still allows archiving", async () => {
    const harness = await createReactDomHarness();
    try {
      await harness.render(createElement(ConfirmTaskDeleteDialog, {
        task,
        preview: makePreview({ busySessionIds: ["s1"] }),
        onConfirm: vi.fn(),
        onClose: vi.fn(),
      }));

      expect(isDisabled(findButton(harness.dom.container, "Delete sessions"))).toBe(true);
      expect(isDisabled(findButton(harness.dom.container, "Archive sessions"))).toBe(false);
      expect(harness.dom.container.textContent).toContain("1 session still running");
    } finally {
      await harness.cleanup();
    }
  });

  it("warns about slow deletes without blocking them", async () => {
    const harness = await createReactDomHarness();
    try {
      await harness.render(createElement(ConfirmTaskDeleteDialog, {
        task,
        preview: makePreview({ sessionCount: 5871, archivedCount: 0, unarchivedCount: 5871 }),
        onConfirm: vi.fn(),
        onClose: vi.fn(),
      }));

      expect(harness.dom.container.textContent).toContain("can take several minutes");
      expect(isDisabled(findButton(harness.dom.container, "Delete sessions"))).toBe(false);
    } finally {
      await harness.cleanup();
    }
  });

  it("collapses to a plain confirm when nothing is linked", async () => {
    const harness = await createReactDomHarness();
    try {
      await harness.render(createElement(ConfirmTaskDeleteDialog, {
        task,
        preview: makePreview({ sessionCount: 0, archivedCount: 0, unarchivedCount: 0 }),
        onConfirm: vi.fn(),
        onClose: vi.fn(),
      }));

      expect(harness.dom.container.textContent).toContain("No sessions are linked");
      expect(findButton(harness.dom.container, "Delete task")).toBeDefined();
      expect(findButton(harness.dom.container, "Delete sessions & delete task")).toBeUndefined();
    } finally {
      await harness.cleanup();
    }
  });

  it("surfaces an action error so the user can retry", async () => {
    const harness = await createReactDomHarness();
    try {
      await harness.render(createElement(ConfirmTaskDeleteDialog, {
        task,
        preview: makePreview(),
        actionError: "Some sessions could not be deleted; the task was kept so you can retry.",
        onConfirm: vi.fn(),
        onClose: vi.fn(),
      }));

      expect(harness.dom.container.textContent).toContain("the task was kept so you can retry");
      expect(isDisabled(findButton(harness.dom.container, "Archive sessions"))).toBe(false);
    } finally {
      await harness.cleanup();
    }
  });
});
