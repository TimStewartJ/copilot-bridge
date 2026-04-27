import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { Task, Session } from "../api";
import { installDomShim } from "../test-dom-shim";

const useTaskWorkspaceMock = vi.hoisted(() => vi.fn());
const useSessionWorkspaceQueryMock = vi.hoisted(() => vi.fn());
const sessionListMock = vi.hoisted(() => vi.fn(() => null));

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
  default: (props: unknown) => sessionListMock(props),
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

function createSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: "session-1",
    modifiedTime: "2026-01-01T00:00:00.000Z",
    lastVisibleActivityAt: "2026-01-01T00:00:00.000Z",
    busy: false,
    archived: false,
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

  it("passes every loaded linked session to the compact list without the preview cap", async () => {
    sessionListMock.mockClear();
    const linkedSessions = [
      createSession({ sessionId: "session-1", lastVisibleActivityAt: "2026-01-01T10:00:00.000Z" }),
      createSession({ sessionId: "session-2", lastVisibleActivityAt: "2026-01-01T14:00:00.000Z" }),
      createSession({ sessionId: "session-3", lastVisibleActivityAt: "2026-01-01T12:00:00.000Z" }),
      createSession({ sessionId: "session-4", lastVisibleActivityAt: "2026-01-01T13:00:00.000Z" }),
      createSession({ sessionId: "session-5", archived: true, lastVisibleActivityAt: "2026-01-01T11:00:00.000Z" }),
    ];
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
      linkedSessions,
      taskOwnTags: [],
      inheritedTagIds: new Set(),
      effectiveTags: [],
      relatedDocs: [],
      refresh: async () => {},
    });
    useSessionWorkspaceQueryMock.mockReturnValue({ data: undefined });

    const dom = installDomShim();
    const onRequestArchived = vi.fn();

    try {
      const [{ flushSync }, { createRoot }, { default: TaskPanel }] = await Promise.all([
        import("react-dom"),
        import("react-dom/client"),
        import("./TaskPanel"),
      ]);

      const root = createRoot(dom.container as any);
      flushSync(() => {
        root.render(
          createElement(
            MemoryRouter,
            null,
            createElement(TaskPanel, {
              task: createTask({ sessionIds: linkedSessions.map((session) => session.sessionId) }),
              taskGroups: [],
              sessions: linkedSessions,
              activeSessionId: null,
              onSelectSession: () => {},
              onNewSession: () => {},
              onUpdateTask: () => {},
              onRequestArchived,
              archivedLoaded: true,
            }),
          ),
        );
      });

      const lastCall = sessionListMock.mock.calls[sessionListMock.mock.calls.length - 1];
      if (!lastCall) throw new Error("SessionList was not rendered");
      const props = lastCall[0] as {
        sessions: Session[];
        onRequestArchived?: () => void;
        archivedLoaded?: boolean;
      };
      expect(props.sessions).toHaveLength(linkedSessions.length);
      expect(props.sessions.map((session) => session.sessionId)).toEqual([
        "session-2",
        "session-4",
        "session-3",
        "session-5",
        "session-1",
      ]);
      expect(props.onRequestArchived).toBeUndefined();
      expect(props.archivedLoaded).toBe(true);

      flushSync(() => {
        root.unmount();
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    } finally {
      dom.cleanup();
    }
  });

  it("keeps the archived accordion loading while unloaded linked sessions are being fetched", async () => {
    sessionListMock.mockClear();
    const loadedSessions = [
      createSession({ sessionId: "session-1" }),
    ];
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
      linkedSessions: loadedSessions,
      taskOwnTags: [],
      inheritedTagIds: new Set(),
      effectiveTags: [],
      relatedDocs: [],
      refresh: async () => {},
    });
    useSessionWorkspaceQueryMock.mockReturnValue({ data: undefined });

    const dom = installDomShim();
    const onRequestArchived = vi.fn();

    try {
      const [{ flushSync }, { createRoot }, { default: TaskPanel }] = await Promise.all([
        import("react-dom"),
        import("react-dom/client"),
        import("./TaskPanel"),
      ]);

      const root = createRoot(dom.container as any);
      flushSync(() => {
        root.render(
          createElement(
            MemoryRouter,
            null,
            createElement(TaskPanel, {
              task: createTask({ sessionIds: ["session-1", "archived-session"] }),
              taskGroups: [],
              sessions: loadedSessions,
              activeSessionId: null,
              onSelectSession: () => {},
              onNewSession: () => {},
              onUpdateTask: () => {},
              onRequestArchived,
              archivedLoaded: true,
              archivedLoading: true,
            }),
          ),
        );
      });

      const lastCall = sessionListMock.mock.calls[sessionListMock.mock.calls.length - 1];
      if (!lastCall) throw new Error("SessionList was not rendered");
      const props = lastCall[0] as {
        sessions: Session[];
        onRequestArchived?: () => void;
        archivedLoaded?: boolean;
        archivedLoading?: boolean;
      };
      expect(props.sessions).toHaveLength(loadedSessions.length);
      expect(props.onRequestArchived).toBe(onRequestArchived);
      expect(props.archivedLoaded).toBe(false);
      expect(props.archivedLoading).toBe(true);

      flushSync(() => {
        root.unmount();
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    } finally {
      dom.cleanup();
    }
  });
});
