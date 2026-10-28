import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createReactDomHarness,
  findAllByTag,
  getReactProps,
  type ReactDomHarness,
} from "../test-react-harness";
import { MobileBottomNav } from "./MobileBottomNav";

function navLabels(root: any): string[] {
  return findAllByTag(root, "BUTTON").map((button) => getReactProps(button)?.["aria-label"]);
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

describe("MobileBottomNav", () => {
  let harness: ReactDomHarness | null = null;

  afterEach(async () => {
    await harness?.cleanup();
    harness = null;
  });

  it("has five destinations, with Helm's conversation beside Home, tasks and chats under Work, and no quota slot", async () => {
    harness = await createReactDomHarness();
    await harness.render(createElement(MobileBottomNav, { activeTab: "home", onSelectTab: vi.fn() }));

    expect(navLabels(harness.dom.container)).toEqual(["Home", "Helm", "Work", "Docs", "Settings"]);

    const nav = findAllByTag(harness.dom.container, "NAV")[0];
    expect(getReactProps(nav)?.style).toEqual({
      paddingBottom: "env(safe-area-inset-bottom)",
    });
  });

  it("adds task and chat attention into one Work badge that stays neutral until something needs an answer", async () => {
    harness = await createReactDomHarness();
    await harness.render(
      createElement(MobileBottomNav, {
        activeTab: "work",
        onSelectTab: vi.fn(),
        taskAttention: { count: 2, needsUserInputCount: 0 },
        chatAttention: { count: 1, needsUserInputCount: 0 },
      }),
    );

    const unreadOnly = findButtonByLabel(
      harness.dom.container,
      "Work, 2 tasks need attention. 1 chat needs attention",
    );
    expect(getReactProps(unreadOnly)?.["aria-current"]).toBe("page");
    expect(attentionBadge(unreadOnly).textContent).toBe("3");
    expect(getReactProps(attentionBadge(unreadOnly))?.className).toContain("bg-text-primary");

    await harness.render(
      createElement(MobileBottomNav, {
        activeTab: "work",
        onSelectTab: vi.fn(),
        taskAttention: { count: 2, needsUserInputCount: 0 },
        chatAttention: { count: 1, needsUserInputCount: 1 },
      }),
    );

    const needsAnswer = findButtonByLabel(
      harness.dom.container,
      "Work, 2 tasks need attention. 1 chat needs attention; 1 needs an answer",
    );
    expect(attentionBadge(needsAnswer).textContent).toBe("3");
    expect(getReactProps(attentionBadge(needsAnswer))?.className).toContain("bg-accent");
  });

  it("marks a new brief on Home and a new reply on Helm, each with its own label", async () => {
    harness = await createReactDomHarness();
    await harness.render(createElement(MobileBottomNav, {
      activeTab: "work",
      onSelectTab: vi.fn(),
      homeMark: "New brief from Helm",
      helmMark: "Helm replied",
    }));

    expect(navLabels(harness.dom.container)).toEqual(["Home, New brief from Helm", "Helm, Helm replied", "Work", "Docs", "Settings"]);
    expect(findAllByTag(findButtonByLabel(harness.dom.container, "Helm, Helm replied"), "SPAN")
      .some((span) => getReactProps(span)?.["data-status"] === "unread")).toBe(true);
  });
});
