import { createElement, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session, Task } from "../api";
import { createDialogTestHarness, type DialogTestHarness } from "../test-dialog-harness";
import { findAllByTag, getReactProps, waitTick } from "../test-react-harness";
import { createTaskActivity } from "../../test-support/task-attention";

const api = vi.hoisted(() => ({ fetchTaskOverview: vi.fn() }));
vi.mock("../api", async (importOriginal) => ({ ...(await importOriginal<object>()), ...api }));

import TaskList from "./TaskList";

const NOW = "2026-08-07T16:00:00.000Z";
const LATER = "2026-08-07T17:00:00.000Z";

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1", title: "Current work", kind: "task", muted: false, deferred: false, status: "active",
    notes: "", priority: 0, order: 0, createdAt: NOW, updatedAt: NOW, activeSessionIds: [], sessionCount: 0, archivedSessionCount: 0, sessionLinksRevision: "rev-0", workItems: [], pullRequests: [],
    ...overrides,
  };
}

function createSession(sessionId: string, at = NOW): Session {
  return { sessionId, modifiedTime: at, lastVisibleActivityAt: at, archived: false, runState: "idle", diskSizeBytes: 0, deferSummary: { count: 0, runningCount: 0, nextRunAt: null } };
}

describe("phone task list sections", () => {
  let harness: DialogTestHarness | null = null;
  afterEach(async () => { await harness?.cleanup(); harness = null; });

  async function renderList(overrides: Partial<ComponentProps<typeof TaskList>>, overviewTasks: unknown[] = []) {
    api.fetchTaskOverview.mockResolvedValue({ generatedAt: NOW, sessionsComplete: true, counts: {}, sourceErrors: [], tasks: overviewTasks });
    harness = await createDialogTestHarness();
    await harness.render(createElement(TaskList, { tasks: [], activeTaskId: null, onSelectTask: vi.fn(), onNewTask: vi.fn(), ...overrides }));
  }
  const text = () => harness!.dom.container.textContent ?? "";

  it("keeps a set-aside task with current work once its revisit date has arrived, and the rest collapsed", async () => {
    await renderList({ tasks: [
      createTask(),
      createTask({ id: "due", title: "Parked idea", deferred: true, order: 1, nextTouchAt: "2000-01-01T00:00:00.000Z" }),
      createTask({ id: "ahead", title: "Next year", deferred: true, order: 2, nextTouchAt: "9999-01-01T00:00:00.000Z" }),
      createTask({ id: "muted", title: "Quiet feed", muted: true, order: 3 }),
    ] });
    expect(text()).toContain("Active (2)");
    expect(text()).toContain("Parked idea");
    expect(findAllByTag(harness!.dom.container, "SPAN").map((node) => getReactProps(node)?.title)).toContain("Deferred · ready to revisit");
    expect(text()).toContain("Set aside (2)");
    expect(text()).not.toContain("Next year");
    expect(text()).not.toContain("Quiet feed");
  });

  it("says how many collapsed tasks hold unread conversations, leaving muted ones out", async () => {
    await renderList({
      tasks: [
        createTask(),
        createTask({ id: "deferred", title: "Parked idea", deferred: true, order: 1, activeSessionIds: ["parked-chat"] }),
        createTask({ id: "muted", title: "Quiet feed", muted: true, order: 2, activeSessionIds: ["feed-chat"] }),
        createTask({ id: "closed", title: "Closed work", status: "archived", order: 3, activeSessionIds: ["late-chat"] }),
        createTask({ id: "closed-read", title: "Old work", status: "archived", order: 4, activeSessionIds: ["old-chat"] }),
      ],
      sessions: [createSession("parked-chat", LATER), createSession("feed-chat", LATER), createSession("late-chat", LATER), createSession("old-chat")],
      isUnread: (_sessionId, time) => time === LATER,
    });
    expect(text()).toContain("Set aside (2)1 unread");
    expect(text()).toContain("Closed (2)1 unread");

    for (const label of ["Set aside (2)", "Closed (2)"]) {
      const toggle = findAllByTag(harness!.dom.container, "BUTTON").find((node) => node.textContent?.includes(label));
      await harness!.act(async () => { getReactProps(toggle)!.onClick(); await waitTick(); });
    }
    const unreadRows = findAllByTag(harness!.dom.container, "BUTTON")
      .map((node) => getReactProps(node)?.["data-unread-task-id"]).filter(Boolean);
    expect(unreadRows).toEqual(["deferred", "closed"]);
  });

  it("uses one source notice on the phone without changing task order", async () => {
    const tasks = ["one", "two"].map((id, order) => createTask({ id, title: `Copied ${id}`, order }));
    await renderList({ tasks }, tasks.map(task => ({
      ...task, activity: createTaskActivity({
        known: false, sessionIndexKnown: false,
        unavailable: { scope: "source", reason: "Preview conversations are isolated." },
      }),
    })));
    expect(findAllByTag(harness!.dom.container, "DIV").filter(node => getReactProps(node)?.["data-task-attention-notice"])).toHaveLength(1);
    const rows = findAllByTag(harness!.dom.container, "BUTTON").filter(node => getReactProps(node)?.["data-task-id"]);
    expect(rows.map(node => getReactProps(node)?.["data-task-id"])).toEqual(["one", "two"]);
    expect(rows.every(node => !getReactProps(node)?.["data-task-attention"])).toBe(true);
  });
});
