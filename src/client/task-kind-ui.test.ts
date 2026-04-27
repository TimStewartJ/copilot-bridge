import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "./api";
import { useTagsQuery } from "./hooks/queries/useTags";
import { useTaskWorkspace } from "./hooks/useTaskWorkspace";
import TaskDashboard from "./components/TaskDashboard";
import TaskKindBadge from "./components/TaskKindBadge";
import TaskMomentumFields from "./components/TaskMomentumFields";
import TaskContextMenu from "./components/task-list/TaskContextMenu";

vi.mock("./hooks/queries/useTags", () => ({
  useTagsQuery: vi.fn(),
}));

vi.mock("./hooks/useTaskWorkspace", () => ({
  useTaskWorkspace: vi.fn(),
}));

vi.mock("./components/PullToRefresh", () => ({
  default: ({ children }: any) => children,
}));

vi.mock("./components/SessionList", () => ({
  default: () => null,
}));

vi.mock("./components/shared/EmptyState", () => ({
  default: () => null,
}));

vi.mock("./components/NotesSheet", () => ({
  default: () => null,
}));

vi.mock("./components/ScheduleDetailSheet", () => ({
  default: () => null,
}));

vi.mock("./components/TagPill", () => ({
  TagPillList: () => null,
}));

vi.mock("./components/TagPicker", () => ({
  default: () => null,
}));

vi.mock("./components/task-sections", () => ({
  WorkItemList: () => null,
  PullRequestList: () => null,
  TaskChecklistSection: () => null,
  TaskNotesSection: () => null,
  RelatedDocsSection: () => null,
  ScheduleSection: () => null,
}));

const NOW = "2026-05-01T12:00:00.000Z";

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Kind test",
    kind: "task",
    status: "active",
    notes: "",
    priority: 0,
    order: 0,
    createdAt: NOW,
    updatedAt: NOW,
    sessionIds: [],
    workItems: [],
    pullRequests: [],
    ...overrides,
  };
}

function createWorkspace(overrides: Record<string, unknown> = {}) {
  return {
    enrichedWIs: [],
    enrichedPRs: [],
    sched: {
      schedules: [],
      trigger: vi.fn(),
      toggle: vi.fn(),
      remove: vi.fn(),
      reload: vi.fn(),
    },
    schedDetail: {
      openForCreate: vi.fn(),
      openSheet: vi.fn(),
      close: vi.fn(),
      switchToEdit: vi.fn(),
      switchToView: vi.fn(),
      isOpen: false,
      schedule: null,
      mode: "view",
    },
    notes: {
      openToEdit: vi.fn(),
      openToView: vi.fn(),
      close: vi.fn(),
      notesSheetOpen: false,
      notesStartEdit: false,
    },
    checklistItems: [],
    createChecklistItemMutation: {
      mutateAsync: vi.fn(),
    },
    onChecklistItemUpdate: vi.fn(),
    onChecklistItemDelete: vi.fn(),
    newChecklistItemText: "",
    setNewChecklistItemText: vi.fn(),
    linkedSessions: [],
    taskOwnTags: [],
    taskGroup: undefined,
    inheritedTagIds: [],
    effectiveTags: [],
    relatedDocs: [],
    refresh: vi.fn(),
    ...overrides,
  };
}

function renderTaskDashboard(task: Task): string {
  vi.mocked(useTaskWorkspace).mockReturnValue(createWorkspace() as any);
  return renderToStaticMarkup(createElement(MemoryRouter, null,
    createElement(TaskDashboard, {
      task,
      taskGroups: [],
      sessions: [],
      onSelectSession: vi.fn(),
      onNewSession: vi.fn(),
      onUpdateTask: vi.fn(),
    }),
  ));
}

function renderTaskContextMenu(task: Task): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: queryClient },
    createElement(TaskContextMenu, {
      task,
      position: { x: 32, y: 48 },
      taskGroups: [],
      sessionMap: new Map(),
      actions: { onUpdateTask: vi.fn() },
      onClose: vi.fn(),
    }),
  ));
}

beforeEach(() => {
  vi.mocked(useTagsQuery).mockReturnValue({ data: [] } as any);
  vi.mocked(useTaskWorkspace).mockReturnValue(createWorkspace() as any);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("kind-aware task UI", () => {
  it("TaskMomentumFields hides doneWhen for ongoing items", () => {
    const html = renderToStaticMarkup(createElement(TaskMomentumFields, {
      task: createTask({ kind: "ongoing", doneWhen: "Ship it" }),
    }));

    expect(html).not.toContain("Done when");
    expect(html).toContain("Add next action");
    expect(html).toContain("Add blocker");
    expect(html).toContain("Set follow-up");
  });

  it("TaskContextMenu suppresses Mark done for ongoing items", () => {
    const html = renderTaskContextMenu(createTask({ kind: "ongoing" }));

    expect(html).not.toContain("Mark done");
    expect(html).not.toContain("Complete &amp; archive");
    expect(html).toContain("Follow up tomorrow");
  });

  it("TaskContextMenu has no manual pin action for normal tasks", () => {
    const html = renderTaskContextMenu(createTask({ kind: "task" }));

    expect(html).not.toContain("lucide-pin");
  });

  it("TaskDashboard renders the pin icon marker for ongoing items", () => {
    const html = renderTaskDashboard(createTask({ kind: "ongoing" }));

    expect(html).toContain("lucide-pin");
  });

  it("can render ongoing markers as icon-only badges", () => {
    const html = renderToStaticMarkup(createElement(TaskKindBadge, {
      kind: "ongoing",
      iconOnly: true,
    }));

    expect(html).toContain("lucide-pin");
    expect(html).toContain("sr-only");
    expect(html).toContain(">Ongoing</span>");
    expect(html).not.toContain(">ongoing<");
  });

  it("TaskDashboard suppresses Candidate to close for ongoing items", () => {
    const html = renderTaskDashboard(createTask({ kind: "ongoing" }));

    expect(html).toContain("Needs decision");
    expect(html).not.toContain("Candidate to close");
  });

  it("TaskDashboard still shows Candidate to close for one-off tasks", () => {
    const html = renderTaskDashboard(createTask({ kind: "task" }));

    expect(html).toContain("Needs decision");
    expect(html).toContain("Candidate to close");
  });
});
