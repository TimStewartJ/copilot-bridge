import { createElement, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../api";
import {
  createReactDomHarness,
  findAllByTag,
  getReactProps,
  type ReactDomHarness,
} from "../test-react-harness";
import TaskRail from "./TaskRail";

const NOW = "2026-08-07T16:00:00.000Z";

function createSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: "session-1",
    modifiedTime: NOW,
    lastVisibleActivityAt: NOW,
    busy: false,
    archived: false,
    diskSizeBytes: 0,
    deferSummary: { count: 0, nextRunAt: null },
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
  let harness: ReactDomHarness | null = null;

  afterEach(async () => {
    await harness?.cleanup();
    harness = null;
  });

  async function renderRail(overrides: Partial<ComponentProps<typeof TaskRail>> = {}) {
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
    harness ??= await createReactDomHarness();
    await harness.render(createElement(TaskRail, props));
    return props;
  }

  it("names collapsed controls and exposes the missing Chats action", async () => {
    const onRailTabChange = vi.fn();
    await renderRail({
      orphanSessions: [createSession({
        busy: true,
        runState: "busy",
        needsUserInput: true,
      })],
      activeSessionId: "session-1",
      onRailTabChange,
    });

    for (const label of [
      "Dashboard",
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
    expect(getReactProps(attentionBadge(chatsButton))?.className).toContain("bg-warning");
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
    expect(getReactProps(attentionBadge(chatsButton))?.className).toContain("bg-success");

    await renderRail({
      expanded: true,
      orphanSessions: [createSession({
        busy: true,
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
    expect(getReactProps(attentionBadge(chatsButton))?.className).toContain("bg-warning");
  });
});

