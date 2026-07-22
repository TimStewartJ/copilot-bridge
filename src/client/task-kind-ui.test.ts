import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CopilotUsageCostEstimate, CopilotUsageSummary, Task } from "./api";
import { useCopilotUsageQuery } from "./hooks/queries/useCopilotUsage";
import { useTaskSessionStorageQuery } from "./hooks/queries/useTaskSessionStorage";
import { useTagsQuery } from "./hooks/queries/useTags";
import { useTaskWorkspace } from "./hooks/useTaskWorkspace";
import TaskDashboard from "./components/TaskDashboard";
import TaskKindBadge from "./components/TaskKindBadge";
import TaskMomentumFields from "./components/TaskMomentumFields";
import TaskContextMenu from "./components/task-list/TaskContextMenu";

const pullToRefreshMock = vi.hoisted(() => vi.fn(({ children }: { children: unknown }) => children));

vi.mock("./hooks/queries/useTags", () => ({
  useTagsQuery: vi.fn(),
}));

vi.mock("./hooks/queries/useCopilotUsage", () => ({
  useCopilotUsageQuery: vi.fn(),
}));

vi.mock("./hooks/queries/useTaskSessionStorage", () => ({
  useTaskSessionStorageQuery: vi.fn(),
}));

vi.mock("./hooks/useTaskWorkspace", () => ({
  useTaskWorkspace: vi.fn(),
}));

vi.mock("./components/PullToRefresh", () => ({
  default: (props: { children: unknown }) => pullToRefreshMock(props),
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
    muted: false,
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

function createUsageTotals(overrides: Partial<CopilotUsageSummary["totals"]["unpricedTokens"]> = {}) {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    ...overrides,
  };
}

function createZeroCostEstimate(overrides: Partial<CopilotUsageCostEstimate> = {}) {
  const base = {
    estimatedCostUsd: 0,
    estimatedAiCredits: 0,
    costBreakdownUsd: {
      input: 0,
      cachedInput: 0,
      cacheWrite: 0,
      output: 0,
      reasoning: 0,
      total: 0,
    },
    billableOutputTokens: 0,
    reasoningPricingAssumption: "reasoning_tokens_priced_at_output_rate" as const,
  };
  return {
    ...base,
    ...overrides,
    costBreakdownUsd: {
      ...base.costBreakdownUsd,
      ...overrides.costBreakdownUsd,
    },
  };
}

function createPricedModelMetadata(model: string) {
  return {
    pricingKey: model,
    pricedAs: model,
    pricingStatus: "exact" as const,
    pricingSource: "exact" as const,
    normalizedPricingModel: model,
  };
}

function createUnpricedModelMetadata() {
  return {
    pricingKey: null,
    pricedAs: null,
    pricingStatus: "unpriced" as const,
    pricingSource: "unpriced" as const,
    normalizedPricingModel: null,
  };
}

function createUsageSummary(overrides: Partial<CopilotUsageSummary> = {}): CopilotUsageSummary {
  return {
    generatedAt: NOW,
    index: {
      state: "idle",
      startedAt: NOW,
      completedAt: NOW,
      sessionsTotal: 0,
      sessionsProcessed: 0,
      sessionsUpdated: 0,
      sessionsFailed: 0,
      cachedSessions: 0,
      warning: null,
      error: null,
    },
    totals: {
      ...createUsageTotals(),
      ...createZeroCostEstimate(),
      unpricedModelCount: 0,
      unpricedTokens: createUsageTotals(),
    },
    coverage: {
      sessionsSeen: 0,
      sessionsWithEvents: 0,
      sessionsIncluded: 0,
      sessionsSkipped: 0,
      skippedByReason: {
        no_events: 0,
        no_shutdown: 0,
        empty_model_metrics: 0,
        parse_error: 0,
      },
      earliestIncludedAt: null,
      latestIncludedAt: null,
      earliestSkippedAt: null,
      latestSkippedAt: null,
    },
    models: [],
    sessions: [],
    unpricedModels: [],
    ...overrides,
  };
}

function renderTaskDashboard(task: Task, workspaceOverrides: Record<string, unknown> = {}): string {
  vi.mocked(useTaskWorkspace).mockReturnValue(createWorkspace(workspaceOverrides) as any);
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
  vi.mocked(useCopilotUsageQuery).mockReturnValue({ data: createUsageSummary() } as any);
  vi.mocked(useTaskSessionStorageQuery).mockReturnValue({ data: { taskId: "task-1", totalDiskSizeBytes: 0, sessions: [] } } as any);
  vi.mocked(useTaskWorkspace).mockReturnValue(createWorkspace() as any);
  pullToRefreshMock.mockClear();
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
    expect(html).not.toContain("Complete task");
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

  it("TaskDashboard explains ongoing items instead of showing close-candidate copy", () => {
    const html = renderTaskDashboard(createTask({ kind: "ongoing" }));

    expect(html).toContain("Ongoing work");
    expect(html).toContain("Ongoing items stay active");
    expect(html).not.toContain("Candidate to close");
  });

  it("TaskDashboard surfaces readiness intelligence for one-off tasks", () => {
    const html = renderTaskDashboard(createTask({ kind: "task" }));

    expect(html).toContain("Readiness intelligence");
    expect(html).toContain("Ready with a missing finish line");
    expect(html).toContain("Finish line");
    expect(html).not.toContain("Candidate to close");
  });
});

describe("TaskDashboard unique overview", () => {
  it("renders the three dashboard-exclusive sections without cockpit chat controls", () => {
    const html = renderTaskDashboard(createTask({ sessionIds: [] }));

    expect(html).toContain("Task brief");
    expect(html).toContain("Readiness intelligence");
    expect(html).toContain("Session usage");
    expect(html).not.toContain("Start a chat");
    expect(html).not.toContain(" New</button>");
    expect(html).not.toContain("Complete task");
  });

  it("uses the brief for read-only context instead of edit surfaces", () => {
    const html = renderTaskDashboard(createTask({
      notes: "## Context\nShip the mobile cockpit split.",
      doneWhen: "Preview approved",
      nextAction: "Review dashboard",
      waitingOn: "Design feedback",
      cwd: "/repo",
      sessionIds: ["session-1"],
      workItems: [{ provider: "github", id: "123" }],
      pullRequests: [{ provider: "github", repoId: "repo", repoName: "bridge", prId: 42 }],
    }), {
      checklistLoaded: true,
      checklistItems: [
        { id: "c1", taskId: "task-1", text: "Open", done: false, order: 0, createdAt: NOW },
      ],
      sched: {
        schedules: [
          { id: "schedule-1", taskId: "task-1", name: "Daily check", prompt: "", type: "cron", cron: "0 8 * * *", enabled: true, createdAt: NOW, updatedAt: NOW, runCount: 0 },
        ],
        trigger: vi.fn(),
        toggle: vi.fn(),
        remove: vi.fn(),
        reload: vi.fn(),
      },
      relatedDocs: [{ path: "docs/task", title: "Task doc" }],
    });

    expect(html).toContain("Ship the mobile cockpit split.");
    expect(html).toContain("Preview approved");
    expect(html).toContain("Review dashboard");
    expect(html).toContain("Design feedback");
    expect(html).toContain("/repo");
    expect(html).toContain("Sessions");
    expect(html).toContain("Work items");
    expect(html).toContain("Schedules");
    expect(html).not.toContain("Set follow-up");
    expect(html).not.toContain("Add blocker");
    expect(html).not.toContain("Add notes");
  });

  it("shows readiness blockers without rendering a completion action", () => {
    const html = renderTaskDashboard(createTask(), {
      checklistLoaded: true,
      checklistItems: [
        { id: "c1", taskId: "task-1", text: "Open", done: false, order: 0, createdAt: NOW },
        { id: "c2", taskId: "task-1", text: "Done", done: true, order: 1, createdAt: NOW, completedAt: NOW },
      ],
    });

    expect(html).toContain("Not ready");
    expect(html).toContain("Open checklist");
    expect(html).toContain("1 checklist item remains");
    expect(html).toContain("Blocking");
    expect(html).not.toContain("Complete task");
  });

  it("treats waiting-on text as an explicit readiness blocker", () => {
    const html = renderTaskDashboard(createTask({
      doneWhen: "Preview approved",
      waitingOn: "Design feedback",
    }), {
      checklistLoaded: true,
    });

    expect(html).toContain("Not ready");
    expect(html).toContain("Explicit blocker");
    expect(html).toContain("Design feedback");
    expect(html).toContain("Blocking");
    expect(html).not.toContain("Ready to complete");
  });

  it("refreshes usage analytics when the overview is refreshed", async () => {
    const workspaceRefresh = vi.fn(async () => {});
    const usageRefresh = vi.fn(async () => createUsageSummary());
    const parentRefresh = vi.fn(async () => {});
    vi.mocked(useTaskWorkspace).mockReturnValue(createWorkspace({
      refresh: workspaceRefresh,
    }) as any);
    vi.mocked(useCopilotUsageQuery).mockReturnValue({
      data: createUsageSummary(),
      refresh: usageRefresh,
    } as any);

    renderToStaticMarkup(createElement(MemoryRouter, null,
      createElement(TaskDashboard, {
        task: createTask(),
        taskGroups: [],
        sessions: [],
        onSelectSession: vi.fn(),
        onNewSession: vi.fn(),
        onUpdateTask: vi.fn(),
        onRefresh: parentRefresh,
      }),
    ));

    const pullToRefreshProps = pullToRefreshMock.mock.calls.at(-1)?.[0] as { onRefresh?: () => Promise<void> } | undefined;
    await pullToRefreshProps?.onRefresh?.();

    expect(workspaceRefresh).toHaveBeenCalledOnce();
    expect(usageRefresh).toHaveBeenCalledOnce();
    expect(parentRefresh).toHaveBeenCalledOnce();
  });

  it("builds session token analytics from linked session usage", () => {
    vi.mocked(useCopilotUsageQuery).mockReturnValue({ data: createUsageSummary({
      totals: {
        ...createUsageTotals({
          requests: 6,
          inputTokens: 1_800,
          outputTokens: 1_000,
          cacheReadTokens: 500,
          cacheWriteTokens: 200,
          reasoningTokens: 500,
          totalTokens: 4_000,
        }),
        ...createZeroCostEstimate({
          estimatedCostUsd: 0.20,
          estimatedAiCredits: 20,
          costBreakdownUsd: {
            input: 0.06,
            cachedInput: 0.01,
            cacheWrite: 0.01,
            output: 0.09,
            reasoning: 0.03,
            total: 0.20,
          },
          billableOutputTokens: 1_500,
        }),
        unpricedModelCount: 1,
        unpricedTokens: createUsageTotals({
          requests: 1,
          inputTokens: 300,
          outputTokens: 200,
          totalTokens: 500,
        }),
      },
      unpricedModels: [
        {
          model: "mystery-model",
          sessions: 1,
          ...createUsageTotals({
            requests: 1,
            inputTokens: 300,
            outputTokens: 200,
            totalTokens: 500,
          }),
          ...createUnpricedModelMetadata(),
        },
      ],
      sessions: [
        {
          sessionId: "session-1",
          shutdownAt: "2026-05-01T14:00:00.000Z",
          requests: 3,
          inputTokens: 1_000,
          outputTokens: 500,
          cacheReadTokens: 300,
          cacheWriteTokens: 100,
          reasoningTokens: 100,
          totalTokens: 2_000,
          ...createZeroCostEstimate({
            estimatedCostUsd: 0.12,
            estimatedAiCredits: 12,
            costBreakdownUsd: {
              input: 0.04,
              cachedInput: 0.01,
              cacheWrite: 0.01,
              output: 0.05,
              reasoning: 0.01,
              total: 0.12,
            },
            billableOutputTokens: 600,
          }),
          models: [
            {
              model: "gpt-5.5",
              sessions: 1,
              requests: 3,
              inputTokens: 1_000,
              outputTokens: 500,
              cacheReadTokens: 300,
              cacheWriteTokens: 100,
              reasoningTokens: 100,
              totalTokens: 2_000,
              ...createZeroCostEstimate({
                estimatedCostUsd: 0.12,
                estimatedAiCredits: 12,
                costBreakdownUsd: {
                  input: 0.04,
                  cachedInput: 0.01,
                  cacheWrite: 0.01,
                  output: 0.05,
                  reasoning: 0.01,
                  total: 0.12,
                },
                billableOutputTokens: 600,
              }),
              ...createPricedModelMetadata("gpt-5.5"),
            },
          ],
          unpricedModels: [],
        },
        {
          sessionId: "session-2",
          shutdownAt: "2026-05-02T10:00:00.000Z",
          requests: 3,
          inputTokens: 800,
          outputTokens: 500,
          cacheReadTokens: 200,
          cacheWriteTokens: 100,
          reasoningTokens: 400,
          totalTokens: 2_000,
          ...createZeroCostEstimate({
            estimatedCostUsd: 0.08,
            estimatedAiCredits: 8,
            costBreakdownUsd: {
              input: 0.02,
              cachedInput: 0,
              cacheWrite: 0,
              output: 0.04,
              reasoning: 0.02,
              total: 0.08,
            },
            billableOutputTokens: 900,
          }),
          models: [
            {
              model: "claude-opus-4.7",
              sessions: 1,
              requests: 2,
              inputTokens: 500,
              outputTokens: 300,
              cacheReadTokens: 200,
              cacheWriteTokens: 100,
              reasoningTokens: 400,
              totalTokens: 1_500,
              ...createZeroCostEstimate({
                estimatedCostUsd: 0.08,
                estimatedAiCredits: 8,
                costBreakdownUsd: {
                  input: 0.02,
                  cachedInput: 0,
                  cacheWrite: 0,
                  output: 0.04,
                  reasoning: 0.02,
                  total: 0.08,
                },
                billableOutputTokens: 700,
              }),
              ...createPricedModelMetadata("claude-opus-4.7"),
            },
            {
              model: "mystery-model",
              sessions: 1,
              requests: 1,
              inputTokens: 300,
              outputTokens: 200,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              reasoningTokens: 0,
              totalTokens: 500,
              ...createZeroCostEstimate({ billableOutputTokens: 200 }),
              ...createUnpricedModelMetadata(),
            },
          ],
          unpricedModels: [
            {
              model: "mystery-model",
              sessions: 1,
              requests: 1,
              inputTokens: 300,
              outputTokens: 200,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              reasoningTokens: 0,
              totalTokens: 500,
              ...createUnpricedModelMetadata(),
            },
          ],
        },
      ],
    }) } as any);

    const html = renderTaskDashboard(createTask({
      sessionIds: ["session-1", "session-2", "session-pending"],
    }), {
      linkedSessions: [
        { sessionId: "session-1", summary: "Build dashboard overview", modifiedTime: "2026-05-01T13:00:00.000Z", busy: false, archived: false },
        { sessionId: "session-2", summary: "Review usage metrics", modifiedTime: "2026-05-02T10:00:00.000Z", busy: true, archived: false, runState: "busy" },
        { sessionId: "session-pending", summary: "Running session", modifiedTime: "2026-05-02T11:00:00.000Z", busy: false, archived: false },
      ],
    });

    expect(html).toContain("Session usage");
    expect(html).toContain("Tokens by day");
    expect(html).toContain("Heaviest sessions");
    expect(html).toContain("Models used");
    expect(html).toContain("4,000");
    expect(html).toContain("Pending");
    expect(html).toContain("1");
    expect(html).toContain("Build dashboard overview");
    expect(html).toContain("Review usage metrics");
    expect(html).toContain("gpt-5.5");
    expect(html).toContain("claude-opus-4.7");
    expect(html).toContain("Est. cost");
    expect(html).toContain("$0.20");
    expect(html).toContain("20 credits");
    expect(html).toContain("mystery-model");
    expect(html).toContain("Estimated cost excludes");
    expect(html).toContain("500 tokens");
    expect(html).not.toContain("Activity timeline");
  });

  it("shows a skeleton while session usage is loading from the backend", () => {
    vi.mocked(useCopilotUsageQuery).mockReturnValue({
      data: undefined,
      isLoading: true,
      refresh: vi.fn(),
    } as any);

    const html = renderTaskDashboard(createTask({
      sessionIds: ["session-1"],
    }), {
      linkedSessions: [
        { sessionId: "session-1", summary: "Loading usage", modifiedTime: "2026-05-01T13:00:00.000Z", busy: false, archived: false },
      ],
    });

    expect(html).toContain("Loading session usage");
    expect(html).not.toContain("0/1 tokenized");
    expect(html).not.toContain("Model breakdown will appear after session usage is available.");
    expect(html).not.toContain("Linked sessions do not have token summaries yet.");
  });
});
