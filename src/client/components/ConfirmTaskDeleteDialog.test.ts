import { createElement } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Task, TaskDeletionPreview } from "../api";
import { createReactDomHarness, findAllByTag, getReactProps } from "../test-react-harness";

let ConfirmTaskDeleteDialog: typeof import("./ConfirmTaskDeleteDialog").default;

beforeAll(async () => {
  const harness = await createReactDomHarness();
  try {
    ({ default: ConfirmTaskDeleteDialog } = await import("./ConfirmTaskDeleteDialog"));
  } finally {
    await harness.cleanup();
  }
});

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
  it("shows the linked session count and both dispositions", async () => {
    const harness = await createReactDomHarness();
    try {
      await harness.render(createElement(ConfirmTaskDeleteDialog, {
        task,
        preview: makePreview(),
        onConfirm: vi.fn(),
        onClose: vi.fn(),
      }));

      const text = harness.dom.container.textContent ?? "";
      expect(text).toContain("3 linked sessions");
      expect(text).toContain("1 already archived");
      expect(findButton(harness.dom.container, "Archive sessions & delete task")).toBeDefined();
      expect(findButton(harness.dom.container, "Delete sessions & delete task")).toBeDefined();
    } finally {
      await harness.cleanup();
    }
  });

  it("dispatches the chosen disposition", async () => {
    const harness = await createReactDomHarness();
    const onConfirm = vi.fn();
    try {
      await harness.render(createElement(ConfirmTaskDeleteDialog, {
        task,
        preview: makePreview(),
        onConfirm,
        onClose: vi.fn(),
      }));

      await harness.act(async () => {
        getReactProps(findButton(harness.dom.container, "Archive sessions"))?.onClick();
      });
      expect(onConfirm).toHaveBeenCalledWith("archive");

      await harness.act(async () => {
        getReactProps(findButton(harness.dom.container, "Delete sessions"))?.onClick();
      });
      expect(onConfirm).toHaveBeenCalledWith("delete");
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

  it("mentions sessions shared with another task", async () => {
    const harness = await createReactDomHarness();
    try {
      await harness.render(createElement(ConfirmTaskDeleteDialog, {
        task,
        preview: makePreview({ sharedSessionCount: 2 }),
        onConfirm: vi.fn(),
        onClose: vi.fn(),
      }));

      expect(harness.dom.container.textContent)
        .toContain("2 sessions also belong to another task");
    } finally {
      await harness.cleanup();
    }
  });

  it("disables every action while a disposition is running", async () => {
    const harness = await createReactDomHarness();
    const onClose = vi.fn();
    try {
      await harness.render(createElement(ConfirmTaskDeleteDialog, {
        task,
        preview: makePreview(),
        busy: "delete",
        progressRemaining: 1,
        onConfirm: vi.fn(),
        onClose,
      }));

      for (const button of buttonsOf(harness.dom.container)) {
        expect(isDisabled(button)).toBe(true);
      }
      expect(harness.dom.container.textContent).toContain("2 of 3 done");
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
