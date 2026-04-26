import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { Task } from "../api";
import { installDomShim } from "../test-dom-shim";

const useTaskWorkspaceMock = vi.hoisted(() => vi.fn());
const useSessionWorkspaceQueryMock = vi.hoisted(() => vi.fn());

vi.mock("../hooks/queries/useTags", () => ({
  useTagsQuery: () => ({ data: [] }),
}));

vi.mock("../hooks/useTaskWorkspace", () => ({
  useTaskWorkspace: (...args: unknown[]) => useTaskWorkspaceMock(...args),
}));

vi.mock("../hooks/queries/useSessionWorkspace", () => ({
  useSessionWorkspaceQuery: (...args: unknown[]) => useSessionWorkspaceQueryMock(...args),
}));

vi.mock("./SessionList", () => ({
  default: () => null,
}));

vi.mock("./PullToRefresh", () => ({
  default: ({ children }: { children: unknown }) => children,
}));

vi.mock("./ScheduleDetailSheet", () => ({
  default: () => null,
}));

vi.mock("./NotesSheet", () => ({
  default: () => null,
}));

vi.mock("./TaskGitStatusSummary", () => ({
  default: () => null,
}));

vi.mock("./WorkspaceDetailsSheet", () => ({
  default: () => null,
}));

vi.mock("./TagPicker", () => ({
  default: () => null,
}));

vi.mock("./DocPreviewSheet", () => ({
  default: () => null,
}));

vi.mock("./task-sections", () => ({
  WorkItemList: () => null,
  PullRequestList: () => null,
  TaskChecklistSection: () => null,
  TaskNotesSection: () => null,
  RelatedDocsSection: () => null,
  ScheduleSection: () => null,
}));

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Workspace task",
    kind: "task",
    status: "active",
    notes: "",
    priority: 0,
    order: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    sessionIds: [],
    workItems: [],
    pullRequests: [],
    tags: [],
    ...overrides,
  };
}

describe("TaskPanel", () => {
  it("supports transitioning from no task to a selected task without a hook-order error", async () => {
    useTaskWorkspaceMock.mockReturnValue({
      enrichedWIs: [],
      enrichedPRs: [],
      reloadEnriched: async () => {},
      sched: {
        schedules: [],
        reload: async () => {},
        trigger: async () => {},
        toggle: async () => {},
        remove: async () => {},
      },
      schedDetail: {
        isOpen: false,
        schedule: null,
        mode: "view",
        openForCreate: () => {},
        openSheet: () => {},
        close: () => {},
        switchToEdit: () => {},
        switchToView: () => {},
      },
      notes: {
        openToView: () => {},
        openToEdit: () => {},
        notesSheetOpen: false,
        notesStartEdit: false,
        close: () => {},
      },
      taskGitStatus: null,
      checklistItems: [],
      createChecklistItemMutation: {
        mutateAsync: async () => {},
      },
      onChecklistItemUpdate: () => {},
      onChecklistItemDelete: () => {},
      newChecklistItemText: "",
      setNewChecklistItemText: () => {},
      linkedSessions: [],
      taskOwnTags: [],
      inheritedTagIds: new Set(),
      effectiveTags: [],
      relatedDocs: [],
      refresh: async () => {},
    });
    useSessionWorkspaceQueryMock.mockReturnValue({ data: undefined });

    const dom = installDomShim();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const [{ flushSync }, { createRoot }, { default: TaskPanel }] = await Promise.all([
        import("react-dom"),
        import("react-dom/client"),
        import("./TaskPanel"),
      ]);

      const root = createRoot(dom.container as any);
      const baseProps = {
        taskGroups: [],
        sessions: [],
        activeSessionId: null,
        onSelectSession: () => {},
        onNewSession: () => {},
        onUpdateTask: () => {},
      };

      expect(() => {
        flushSync(() => {
          root.render(
            createElement(
              MemoryRouter,
              null,
              createElement(TaskPanel, {
                ...baseProps,
                task: null,
              }),
            ),
          );
        });
      }).not.toThrow();

      expect(dom.container.textContent).toContain("Select a task");

      expect(() => {
        flushSync(() => {
          root.render(
            createElement(
              MemoryRouter,
              null,
              createElement(TaskPanel, {
                ...baseProps,
                task: createTask(),
              }),
            ),
          );
        });
      }).not.toThrow();

      expect(consoleError.mock.calls.flat().join(" ")).not.toContain("Rendered more hooks than during the previous render");
      expect(dom.container.textContent).toContain("Workspace task");

      flushSync(() => {
        root.unmount();
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    } finally {
      consoleError.mockRestore();
      dom.cleanup();
    }
  });
});
