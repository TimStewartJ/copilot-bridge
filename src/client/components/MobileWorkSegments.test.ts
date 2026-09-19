import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createReactDomHarness,
  findAllByTag,
  getReactProps,
  type ReactDomHarness,
} from "../test-react-harness";
import { MobileWorkSegments } from "./MobileWorkSegments";

function findTabByLabel(root: any, label: string): any {
  const tab = findAllByTag(root, "BUTTON").find(
    (candidate) => getReactProps(candidate)?.["aria-label"] === label,
  );
  if (!tab) throw new Error(`Tab not found: ${label}`);
  return tab;
}

function badge(tab: any): any {
  return findAllByTag(tab, "SPAN").find(
    (candidate) => getReactProps(candidate)?.["aria-hidden"] === "true",
  );
}

describe("MobileWorkSegments", () => {
  let harness: ReactDomHarness | null = null;

  afterEach(async () => {
    await harness?.cleanup();
    harness = null;
  });

  it("marks the list that is showing and switches to the other one", async () => {
    const onSelectSegment = vi.fn();
    harness = await createReactDomHarness();
    await harness.render(createElement(MobileWorkSegments, { activeSegment: "tasks", onSelectSegment }));

    expect(findAllByTag(harness.dom.container, "DIV").some(
      (candidate) => getReactProps(candidate)?.role === "tablist",
    )).toBe(true);

    const tasks = findTabByLabel(harness.dom.container, "Tasks");
    const chats = findTabByLabel(harness.dom.container, "Chats");
    expect(getReactProps(tasks)?.["aria-selected"]).toBe(true);
    expect(getReactProps(chats)?.["aria-selected"]).toBe(false);
    expect(badge(tasks)).toBeUndefined();

    await harness.act(() => getReactProps(chats)!.onClick());
    expect(onSelectSegment).toHaveBeenCalledWith("chats");
  });

  it("keeps a separate attention badge on each list", async () => {
    harness = await createReactDomHarness();
    await harness.render(
      createElement(MobileWorkSegments, {
        activeSegment: "chats",
        onSelectSegment: vi.fn(),
        taskAttention: { count: 2, needsUserInputCount: 0 },
        chatAttention: { count: 1, needsUserInputCount: 1 },
      }),
    );

    const tasks = findTabByLabel(harness.dom.container, "Tasks, 2 tasks need attention");
    expect(badge(tasks).textContent).toBe("2");
    expect(getReactProps(badge(tasks))?.className).toContain("bg-success");

    const chats = findTabByLabel(harness.dom.container, "Chats, 1 chat needs attention; 1 needs an answer");
    expect(getReactProps(chats)?.["aria-selected"]).toBe(true);
    expect(badge(chats).textContent).toBe("1");
    expect(getReactProps(badge(chats))?.className).toContain("bg-warning");
  });
});
