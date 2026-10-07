import { createElement, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session, Task } from "../api";
import { createDialogTestHarness, type DialogTestHarness } from "../test-dialog-harness";
import { advanceTimersByTimeAct, findAllByTag, getReactProps, waitTick, waitUntilAct } from "../test-react-harness";

const api = vi.hoisted(() => ({ fetchTaskOverview: vi.fn() }));
vi.mock("../api", async (importOriginal) => ({ ...(await importOriginal<object>()), ...api }));
vi.mock("./CopilotQuotaMenu", () => ({
  default: () => null,
}));

import TaskRail from "./TaskRail";

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1", title: "Current work", kind: "task", muted: false, deferred: false, status: "active",
    notes: "", priority: 0, order: 0, createdAt: NOW, updatedAt: NOW, activeSessionIds: [], sessionCount: 0, archivedSessionCount: 0, sessionLinksRevision: "rev-0", workItems: [], pullRequests: [],
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

  it("pads the list inside its scroller, so sticky edge controls reach the scroller's edges", async () => {
    await renderRail({ expanded: true, tasks: [createTask()] });
    const className = (node: any): string => getReactProps(node)?.className ?? "";
    const newTask = findAllByTag(harness!.dom.container, "BUTTON").find((node) => node.textContent?.trim() === "New task");
    const content = newTask?.parentNode;
    let scroller = content;
    while (scroller && !/\boverflow-y-auto\b/.test(className(scroller))) scroller = scroller.parentNode;

    // A sticky box stops at its scroller's top and bottom padding, which leaves a strip of rows
    // showing past the unread band or the reorder bar.
    expect(className(scroller)).toMatch(/\boverflow-y-auto\b/);
    expect(className(scroller)).not.toMatch(/(^|[\s:])(p|py|pt|pb)-/);
    expect(content).not.toBe(scroller);
    expect(className(content)).toMatch(/(^|\s)(p|py)-\S/);
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
  it("shows a set-aside task with current work once its revisit date arrives, still marked as set aside", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    try {
      vi.setSystemTime(new Date("2026-08-07T16:00:00.000Z"));
      await renderRail({
        expanded: true,
        tasks: [
          createTask(),
          createTask({ id: "due", title: "Parked idea", deferred: true, order: 1, nextTouchAt: "2026-08-07T15:00:00.000Z" }),
          createTask({ id: "soon", title: "Quiet feed", muted: true, order: 2, nextTouchAt: "2026-08-07T16:00:30.000Z" }),
          createTask({ id: "undated", title: "Someday", deferred: true, order: 3 }),
        ],
      });
      const text = () => harness!.dom.container.textContent ?? "";
      expect(text()).toContain("Parked idea");
      // Whether an hour ago was "today" depends on the host's time zone; the set-aside word does not.
      const badgeTitles = () => findAllByTag(harness!.dom.container, "SPAN").map((node) => String(getReactProps(node)?.title ?? ""));
      expect(badgeTitles().some((title) => title.startsWith("Deferred · "))).toBe(true);
      expect(text()).toContain("Set aside (2)");
      expect(text()).not.toContain("Quiet feed");
      // The date arriving is enough: nothing was saved, and the task without a date stays put.
      await advanceTimersByTimeAct(harness!.act, 60_000);
      expect(text()).toContain("Quiet feed");
      expect(badgeTitles().some((title) => title.startsWith("Muted · "))).toBe(true);
      expect(text()).toContain("Set aside (1)");
      expect(text()).not.toContain("Someday");
    } finally {
      vi.useRealTimers();
    }
  });
  it("keeps a muted task's conversations silent on the icon rail while it is shown for its date", async () => {
    const later = "2026-08-07T17:00:00.000Z";
    await renderRail({
      expanded: false,
      tasks: [
        createTask({ activeSessionIds: ["current-chat"] }),
        createTask({ id: "muted-due", title: "Quiet feed", muted: true, order: 1, nextTouchAt: "2000-01-01T00:00:00.000Z", activeSessionIds: ["feed-chat"] }),
      ],
      sessions: ["current-chat", "feed-chat"].map((sessionId) => createSession({ sessionId, lastVisibleActivityAt: later, modifiedTime: later, needsUserInput: sessionId === "feed-chat" })),
      isUnread: () => true,
    });
    const tile = (title: string) => findAllByTag(harness!.dom.container, "BUTTON").find((node) => String(getReactProps(node)?.title ?? "").startsWith(title));
    const marks = (node: unknown) => findAllByTag(node, "SPAN").map((span) => getReactProps(span)?.["data-status"]).filter(Boolean);
    // Due, so it sits with current work and not behind the Set aside toggle.
    expect(tile("Quiet feed")).toBeDefined();
    expect(marks(tile("Quiet feed"))).toEqual([]);
    expect(marks(tile("Current work"))).toEqual(["unread"]);
    expect(findAllByTag(harness!.dom.container, "BUTTON").some((node) => String(getReactProps(node)?.["aria-label"] ?? "").startsWith("Set aside"))).toBe(false);
  });
  it("says how many set-aside and archived tasks hold unread conversations, and marks their rows", async () => {
    const later = "2026-08-07T17:00:00.000Z";
    await renderRail({
      expanded: true,
      tasks: [
        createTask(),
        createTask({ id: "deferred", title: "Parked idea", deferred: true, order: 1, activeSessionIds: ["parked-chat"] }),
        createTask({ id: "muted", title: "Quiet feed", muted: true, order: 2, activeSessionIds: ["feed-chat"] }),
        createTask({ id: "closed", title: "Closed work", status: "archived", order: 3, activeSessionIds: ["late-chat"] }),
        createTask({ id: "closed-read", title: "Old work", status: "archived", order: 4, activeSessionIds: ["old-chat"] }),
      ],
      sessions: ["parked-chat", "feed-chat", "late-chat"].map((sessionId) => createSession({ sessionId, lastVisibleActivityAt: later, modifiedTime: later }))
        .concat(createSession({ sessionId: "old-chat" })),
      isUnread: (_sessionId, time) => time === later,
    });
    const text = () => harness!.dom.container.textContent ?? "";
    // Mute still silences its task; the deferred and the archived one each count once.
    expect(text()).toContain("Set aside (2)1 unread");
    expect(text()).toContain("Archived (2)1 unread");
    expect(getReactProps(findButtonByLabel(harness!.dom.container, "Tasks, 2 tasks need attention"))).toBeDefined();

    for (const label of ["Set aside (2)", "Archived (2)"]) {
      const toggle = findAllByTag(harness!.dom.container, "BUTTON").find((node) => node.textContent?.includes(label));
      await harness!.act(async () => { getReactProps(toggle)!.onClick(); await waitTick(); });
    }
    const unreadRows = findAllByTag(harness!.dom.container, "BUTTON")
      .map((node) => getReactProps(node)?.["data-unread-task-id"]).filter(Boolean);
    expect(unreadRows).toEqual(["deferred", "closed"]);
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
