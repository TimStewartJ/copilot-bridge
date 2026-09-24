import { createElement, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session, Task } from "../api";
import { createDialogTestHarness, type DialogTestHarness } from "../test-dialog-harness";
import { findAllByTag, getReactProps, waitTick, waitUntilAct } from "../test-react-harness";

const api = vi.hoisted(() => ({ fetchTaskOverview: vi.fn() }));
vi.mock("../api", async (importOriginal) => ({ ...(await importOriginal<object>()), ...api }));
vi.mock("./CopilotQuotaMenu", () => ({
  default: () => null,
}));

import TaskRail from "./TaskRail";

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1", title: "Current work", kind: "task", muted: false, deferred: false, status: "active",
    notes: "", priority: 0, order: 0, createdAt: NOW, updatedAt: NOW, sessionIds: [], workItems: [], pullRequests: [],
    ...overrides,
  };
}

const NOW = "2026-08-07T16:00:00.000Z";

function createSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: "session-1",
    modifiedTime: NOW,
    lastVisibleActivityAt: NOW,
    archived: false,
    diskSizeBytes: 0,
    deferSummary: { count: 0, runningCount: 0, nextRunAt: null },
    ...overrides,
  };
}

function findButtonByLabel(root: any, label: string): any {
  const button = findAllByTag(root, "BUTTON").find(
    (candidate) => getReactProps(candidate)?.["aria-label"] === label,
  );
  if (!button) throw new Error(`Button not found: ${label}`);
  return button;
}

function attentionBadge(button: any): any {
  const badge = findAllByTag(button, "SPAN").find(
    (candidate) => getReactProps(candidate)?.["aria-hidden"] === "true"
      || getReactProps(candidate)?.["aria-hidden"] === true,
  );
  if (!badge) throw new Error("Attention badge not found");
  return badge;
}

describe("TaskRail navigation attention", () => {
  let harness: DialogTestHarness | null = null;

  afterEach(async () => {
    await harness?.cleanup();
    harness = null;
  });

  async function renderRail(overrides: Partial<ComponentProps<typeof TaskRail>> = {}, overviewTasks: unknown[] = []) {
    const props: ComponentProps<typeof TaskRail> = {
      tasks: [],
      activeTaskId: null,
      onSelectTask: vi.fn(),
      onNewTask: vi.fn(),
      isQuickChatsActive: false,
      onGoHome: vi.fn(),
      onOpenSettings: vi.fn(),
      onOpenDocs: vi.fn(),
      isDocsActive: false,
      isDashboardActive: false,
      expanded: false,
      onToggleExpanded: vi.fn(),
      ...overrides,
    };
    api.fetchTaskOverview.mockResolvedValue({ generatedAt: NOW, sessionsComplete: true, counts: {}, sourceErrors: [], tasks: overviewTasks });
    harness ??= await createDialogTestHarness();
    await harness.render(createElement(TaskRail, props));
    return props;
  }

  it("names collapsed controls and exposes the missing Chats action", async () => {
    const onRailTabChange = vi.fn();
    await renderRail({
      orphanSessions: [createSession({
        runState: "busy",
        needsUserInput: true,
      })],
      activeSessionId: "session-1",
      onRailTabChange,
    });

    for (const label of [
      "Home",
      "Chats, 1 chat needs attention; 1 needs an answer",
      "Docs",
      "New Task",
      "Expand task list",
      "Settings",
    ]) {
      expect(getReactProps(findButtonByLabel(harness!.dom.container, label))?.type).toBe("button");
    }

    const chatsButton = findButtonByLabel(
      harness!.dom.container,
      "Chats, 1 chat needs attention; 1 needs an answer",
    );
    expect(getReactProps(attentionBadge(chatsButton))?.className).toContain("bg-accent");
    await harness!.act(async () => {
      getReactProps(chatsButton)?.onClick?.();
    });
    expect(onRailTabChange).toHaveBeenCalledWith("chats");
  });

  it("uses ordinary and needs-answer badge tones with accessible counts", async () => {
    await renderRail({
      expanded: true,
      orphanSessions: [createSession()],
      isUnread: () => true,
    });

    let chatsButton = findButtonByLabel(
      harness!.dom.container,
      "Chats, 1 chat needs attention",
    );
    expect(getReactProps(attentionBadge(chatsButton))?.className).toContain("bg-text-primary");

    await renderRail({
      expanded: true,
      orphanSessions: [createSession({
        runState: "busy",
        needsUserInput: true,
      })],
      activeSessionId: "session-1",
      isUnread: () => true,
    });

    chatsButton = findButtonByLabel(
      harness!.dom.container,
      "Chats, 1 chat needs attention; 1 needs an answer",
    );
    expect(getReactProps(attentionBadge(chatsButton))?.className).toContain("bg-accent");
  });

  it("offers All tasks as navigation and keeps set-aside tasks out of the working list", async () => {
    const onOpenAllTasks = vi.fn();
    await renderRail({
      expanded: true,
      onOpenAllTasks,
      tasks: [
        createTask(),
        createTask({ id: "deferred", title: "Parked idea", deferred: true, order: 1 }),
        createTask({ id: "muted", title: "Quiet feed", muted: true, order: 2 }),
      ],
    });
    const text = () => harness!.dom.container.textContent ?? "";
    expect(text()).toContain("Current work");
    expect(text()).not.toContain("Parked idea");
    expect(text()).toContain("Set aside (2)");

    const allTasks = findAllByTag(harness!.dom.container, "BUTTON").find((node) => node.textContent?.trim() === "All tasks");
    expect(allTasks).toBeDefined();
    await harness!.act(async () => { getReactProps(allTasks)!.onClick(); });
    expect(onOpenAllTasks).toHaveBeenCalledOnce();

    const toggle = findAllByTag(harness!.dom.container, "BUTTON").find((node) => node.textContent?.includes("Set aside (2)"));
    await harness!.act(async () => { getReactProps(toggle)!.onClick(); await waitTick(); });
    expect(text()).toContain("Parked idea");
    expect(text()).toContain("Deferred");
    expect(text()).toContain("Muted");
  });
  it("flags a set-aside task that needs you without opening the section", async () => {
    await renderRail({ expanded: true, tasks: [createTask(), createTask({ id: "deferred", title: "Parked idea", deferred: true, order: 1 })] }, [
      { id: "deferred", title: "Parked idea", kind: "task", muted: false, deferred: true, state: "needs_you", reasons: ["question"], staleWait: false,
        idleDays: 40, busyCount: 0, stalledCount: 0, inputCount: 1, automationCount: 0, order: 1 },
    ]);
    const text = () => harness!.dom.container.textContent ?? "";
    await waitUntilAct(harness!.act, () => text().includes("1 needs you"), { label: "set-aside attention" });
    expect(text()).toContain("Set aside (1)1 needs you");
    expect(text()).not.toContain("Parked idea");
    const toggle = findAllByTag(harness!.dom.container, "BUTTON").find((node) => node.textContent?.includes("Set aside (1)"));
    await harness!.act(async () => { getReactProps(toggle)!.onClick(); await waitTick(); });
    expect(text()).toContain("Answer needed");
    expect(text()).toContain("Deferred");
  });
});
