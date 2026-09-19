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

  it("keeps the bar to five destinations, with tasks and chats under Work and no quota slot", async () => {
    harness = await createReactDomHarness();
    await harness.render(createElement(MobileBottomNav, { activeTab: "home", onSelectTab: vi.fn() }));

    expect(navLabels(harness.dom.container)).toEqual(["Home", "Work", "Helm", "Docs", "Settings"]);

    const nav = findAllByTag(harness.dom.container, "NAV")[0];
    expect(getReactProps(nav)?.style).toEqual({
      paddingBottom: "env(safe-area-inset-bottom)",
    });
  });

  it("adds task and chat attention into one Work badge that stays green until something needs an answer", async () => {
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
    expect(getReactProps(attentionBadge(unreadOnly))?.className).toContain("bg-success");

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
    expect(getReactProps(attentionBadge(needsAnswer))?.className).toContain("bg-warning");
  });

  it("offers Helm as a tab that stays inside the app shell", async () => {
    const onSelectTab = vi.fn();
    harness = await createReactDomHarness();
    await harness.render(createElement(MobileBottomNav, { activeTab: "helm", onSelectTab }));

    const helm = findButtonByLabel(harness.dom.container, "Helm");
    expect(getReactProps(helm)?.["aria-current"]).toBe("page");
    expect(getReactProps(findButtonByLabel(harness.dom.container, "Work"))?.["aria-current"]).toBeUndefined();
    await harness.act(() => getReactProps(helm)!.onClick());
    expect(onSelectTab).toHaveBeenCalledWith("helm");

    await harness.act(() => getReactProps(findButtonByLabel(harness!.dom.container, "Work"))!.onClick());
    expect(onSelectTab).toHaveBeenLastCalledWith("work");
  });
});
