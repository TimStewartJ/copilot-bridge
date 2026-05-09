import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { Task, Session } from "../api";
import { installDomShim } from "../test-dom-shim";

const useTaskWorkspaceMock = vi.hoisted(() => vi.fn());
const useSessionWorkspaceQueryMock = vi.hoisted(() => vi.fn());
const sessionListMock = vi.hoisted(() => vi.fn(() => null));
const pullToRefreshMock = vi.hoisted(() => vi.fn(({ children }: { children: unknown }) => children));
const taskPanelSummaryRowMock = vi.hoisted(() => vi.fn(() => null));
const fetchTaskGitStatusMock = vi.hoisted(() => vi.fn());
const patchTaskMock = vi.hoisted(() => vi.fn());
const queryClientMock = vi.hoisted(() => ({
  fetchQuery: vi.fn(),
  invalidateQueries: vi.fn(),
}));

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQueryClient: () => queryClientMock,
  };
});

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    fetchTaskGitStatus: fetchTaskGitStatusMock,
    patchTask: patchTaskMock,
  };
});

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
  default: (props: { children: unknown }) => pullToRefreshMock(props),
}));

vi.mock("./TaskPanelSummaryRow", () => ({
  default: (props: unknown) => taskPanelSummaryRowMock(props),
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
    deferSummary: { count: 0, nextRunAt: null },
    ...overrides,
  };
}

function createWorkspace(overrides: Record<string, unknown> = {}) {
  return {
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
    checklistItemsReady: true,
    checklistLoaded: true,
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
    ...overrides,
  };
}

beforeEach(() => {
  taskPanelSummaryRowMock.mockClear();
  queryClientMock.fetchQuery.mockReset();
  queryClientMock.fetchQuery.mockResolvedValue(null);
  queryClientMock.invalidateQueries.mockReset();
  queryClientMock.invalidateQueries.mockResolvedValue(undefined);
  fetchTaskGitStatusMock.mockReset();
  fetchTaskGitStatusMock.mockResolvedValue(null);
  patchTaskMock.mockReset();
  patchTaskMock.mockResolvedValue(null);
});

async function renderTaskPanelHtml(task: Task, workspaceOverrides: Record<string, unknown> = {}) {
  useTaskWorkspaceMock.mockReturnValue(createWorkspace(workspaceOverrides));
  useSessionWorkspaceQueryMock.mockReturnValue({ data: undefined });
  const { default: TaskPanel } = await import("./TaskPanel");
  return renderToStaticMarkup(createElement(
    MemoryRouter,
    null,
    createElement(TaskPanel, {
      task,
      taskGroups: [],
      sessions: [],
      activeSessionId: null,
      onSelectSession: () => {},
      onNewSession: () => {},
      onUpdateTask: async () => null,
    }),
  ));
}

describe("TaskPanel", () => {
  it("supports transitioning from no task to a selected task without a hook-order error", async () => {
    useTaskWorkspaceMock.mockReturnValue(createWorkspace());
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
    useTaskWorkspaceMock.mockReturnValue(createWorkspace({ linkedSessions }));
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
    useTaskWorkspaceMock.mockReturnValue(createWorkspace({ linkedSessions: loadedSessions }));
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

  it("passes scroll restoration to the scroll container", async () => {
    pullToRefreshMock.mockClear();
    useTaskWorkspaceMock.mockReturnValue(createWorkspace());
    useSessionWorkspaceQueryMock.mockReturnValue({ data: undefined });
    const scrollRestoration = {
      key: "mobile:task-cockpit:task-1",
      restore: true,
    };

    const { default: TaskPanel } = await import("./TaskPanel");
    const html = renderToStaticMarkup(createElement(
      MemoryRouter,
      null,
      createElement(TaskPanel, {
        task: createTask(),
        taskGroups: [],
        sessions: [],
        activeSessionId: null,
        onSelectSession: () => {},
        onNewSession: () => {},
        onUpdateTask: async () => null,
        scrollRestoration,
      }),
    ));

    const scrollContainerCall = pullToRefreshMock.mock.calls.find(([props]) => {
      const className = (props as { className?: string }).className;
      return className?.includes("h-full overflow-x-hidden");
    });
    if (!scrollContainerCall) throw new Error("TaskPanel PullToRefresh was not rendered");
    expect((scrollContainerCall[0] as { scrollRestoration?: typeof scrollRestoration }).scrollRestoration).toBe(scrollRestoration);
    expect(html).toContain("md:sticky");
  });

  it("force-refreshes git status when opening workspace details", async () => {
    const linkedSession = createSession();
    useTaskWorkspaceMock.mockReturnValue(createWorkspace({ linkedSessions: [linkedSession] }));
    useSessionWorkspaceQueryMock.mockReturnValue({ data: undefined });

    const dom = installDomShim();

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
              task: createTask({ cwd: "/workspace/copilot-bridge", sessionIds: [linkedSession.sessionId] }),
              taskGroups: [],
              sessions: [linkedSession],
              activeSessionId: linkedSession.sessionId,
              onSelectSession: () => {},
              onNewSession: () => {},
              onUpdateTask: () => {},
            }),
          ),
        );
      });

      const workspaceRowCall = taskPanelSummaryRowMock.mock.calls.find(([props]) =>
        (props as { label?: string }).label === "Workspace");
      if (!workspaceRowCall) throw new Error("Workspace row was not rendered");

      (workspaceRowCall[0] as { onClick: () => void }).onClick();

      expect(queryClientMock.fetchQuery).toHaveBeenCalledWith(expect.objectContaining({
        queryKey: ["task", "task-1", "git-status"],
        staleTime: 0,
      }));
      expect(queryClientMock.invalidateQueries).toHaveBeenCalledWith({
        queryKey: ["session-workspace", linkedSession.sessionId, "task-1"],
      });

      const fetchOptions = queryClientMock.fetchQuery.mock.calls[0]?.[0] as {
        queryFn: (context: { signal: AbortSignal }) => Promise<unknown>;
      };
      const controller = new AbortController();
      await fetchOptions.queryFn({ signal: controller.signal });
      expect(fetchTaskGitStatusMock).toHaveBeenCalledWith("task-1", {
        signal: controller.signal,
        refresh: true,
      });

      flushSync(() => {
        root.unmount();
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    } finally {
      dom.cleanup();
    }
  });

  it("omits lifecycle status labels from the header", async () => {
    await expect(renderTaskPanelHtml(createTask())).resolves.not.toContain(">Active</span>");
    await expect(renderTaskPanelHtml(createTask({
      status: "archived",
      completedAt: "2026-04-27T20:00:00.000Z",
    }))).resolves.not.toContain(">Completed</span>");
  });

  it("shows the TaskPanel completion button only when completion or reopen is actionable", async () => {
    await expect(renderTaskPanelHtml(createTask())).resolves.toContain("Complete task");
    await expect(renderTaskPanelHtml(createTask({
      status: "archived",
      completedAt: "2026-04-27T20:00:00.000Z",
    }))).resolves.toContain("Reopen task");

    await expect(renderTaskPanelHtml(createTask(), {
      checklistItems: [{ id: "item-1", taskId: "task-1", text: "Open item", done: false }],
    })).resolves.not.toContain("Complete task");
    await expect(renderTaskPanelHtml(createTask({ kind: "ongoing" }))).resolves.not.toContain("Complete task");
    await expect(renderTaskPanelHtml(createTask({ status: "archived" }))).resolves.not.toContain("Archived</button>");
  });

  it("hides completion metadata for manually archived tasks", async () => {
    const html = await renderTaskPanelHtml(createTask({
      status: "archived",
      doneWhen: "QA signs off",
    }));

    expect(html).not.toContain("Complete task");
    expect(html).not.toContain("Reopen task");
    expect(html).not.toContain("Archived tasks cannot be completed");
    expect(html).not.toContain("Done when");
    expect(html).not.toContain("QA signs off");
  });

  it("does not render the redundant checklist open/done summary row", async () => {
    const html = await renderTaskPanelHtml(createTask({ kind: "ongoing" }), {
      checklistItems: [
        { id: "open-1", taskId: "task-1", text: "Open item 1", done: false, order: 0, createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "open-2", taskId: "task-1", text: "Open item 2", done: false, order: 1, createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "done-1", taskId: "task-1", text: "Done item", done: true, order: 2, createdAt: "2026-01-01T00:00:00.000Z" },
      ],
    });

    expect(html).toContain("Checklist");
    expect(html).toContain("(1/3)");
    expect(html).not.toContain("2 open");
    expect(html).not.toContain("1 done");
  });
});
