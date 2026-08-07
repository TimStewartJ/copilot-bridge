import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createReactDomHarness,
  findAllByTag,
  getReactProps,
  type ReactDomHarness,
} from "../test-react-harness";
import { MobileBottomNav } from "./MobileBottomNav";

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

describe("MobileBottomNav attention", () => {
  let harness: ReactDomHarness | null = null;

  afterEach(async () => {
    await harness?.cleanup();
    harness = null;
  });

  it("retains safe-area padding and distinguishes unread from needs-answer badges", async () => {
    harness = await createReactDomHarness();
    await harness.render(
      createElement(MobileBottomNav, {
        activeTab: "tasks",
        onSelectTab: vi.fn(),
        taskAttention: { count: 2, needsUserInputCount: 0 },
        chatAttention: { count: 1, needsUserInputCount: 1 },
      }),
    );

    const nav = findAllByTag(harness.dom.container, "NAV")[0];
    expect(getReactProps(nav)?.style).toEqual({
      paddingBottom: "env(safe-area-inset-bottom)",
    });

    const tasksButton = findButtonByLabel(
      harness.dom.container,
      "Tasks, 2 tasks need attention",
    );
    expect(getReactProps(attentionBadge(tasksButton))?.className).toContain("bg-success");

    const chatsButton = findButtonByLabel(
      harness.dom.container,
      "Chats, 1 chat needs attention; 1 needs an answer",
    );
    expect(getReactProps(attentionBadge(chatsButton))?.className).toContain("bg-warning");
  });
});

