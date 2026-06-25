import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeedKindStats } from "../api";
import FeedKindFilter from "./FeedKindFilter";
import {
  createReactDomHarness,
  findAllByTag,
  getReactProps,
  type ReactDomHarness,
} from "../test-react-harness";

function findByAriaLabel(root: any, label: string): any {
  if (!root) return null;
  if (root.getAttribute?.("aria-label") === label) return root;
  for (const child of root.childNodes ?? []) {
    const result = findByAriaLabel(child, label);
    if (result) return result;
  }
  return null;
}

function findAllByRole(root: any, role: string): any[] {
  const results: any[] = [];
  if (!root) return results;
  if (root.getAttribute?.("role") === role) results.push(root);
  for (const child of root.childNodes ?? []) {
    results.push(...findAllByRole(child, role));
  }
  return results;
}

function findOptionByKind(root: any, kind: string): any {
  return findAllByRole(root, "option").find((option) => option.getAttribute?.("data-kind") === kind) ?? null;
}

function findButtonByText(root: any, text: string): any {
  return findAllByTag(root, "BUTTON").find((button) => button.textContent === text) ?? null;
}

function makeStats(overrides: Partial<FeedKindStats> = {}): FeedKindStats {
  return {
    generatedAt: "2026-06-24T00:00:00.000Z",
    windowDays: 30,
    bucketCount: 4,
    windowStart: "2026-05-25T00:00:00.000Z",
    windowEnd: "2026-06-24T00:00:00.000Z",
    total: 8,
    active: 4,
    buckets: [1, 2, 3, 2],
    kinds: [
      { kind: "status", total: 5, active: 2, done: 2, dismissed: 1, lastActivityAt: "2026-06-23T00:00:00.000Z", buckets: [1, 1, 2, 1] },
      { kind: "note", total: 3, active: 2, done: 1, dismissed: 0, lastActivityAt: "2026-06-22T00:00:00.000Z", buckets: [0, 1, 1, 1] },
    ],
    ...overrides,
  };
}

function makeKind(kind: string, active: number, total: number) {
  return {
    kind,
    total,
    active,
    done: Math.max(total - active, 0),
    dismissed: 0,
    lastActivityAt: "2026-06-22T00:00:00.000Z",
    buckets: [0, 1, 1, 0],
  };
}

function findDisclosure(root: any): any {
  return findAllByTag(root, "BUTTON").find((button) => /inactive/i.test(button.textContent ?? "")) ?? null;
}

describe("FeedKindFilter", () => {
  let harness: ReactDomHarness | null = null;
  let dom: ReactDomHarness["dom"] | null = null;

  function getHarness() {
    if (!harness) throw new Error("FeedKindFilter harness not initialized");
    return harness;
  }

  async function act(callback: () => void | Promise<void>): Promise<void> {
    await getHarness().act(callback);
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    harness = await createReactDomHarness();
    dom = harness.dom;
  });

  afterEach(async () => {
    await harness?.cleanup();
    harness = null;
    dom = null;
  });

  async function render(props: Partial<Parameters<typeof FeedKindFilter>[0]> = {}) {
    const resolved = {
      value: "",
      onChange: vi.fn(),
      fallbackKinds: [] as string[],
      stats: makeStats(),
      statsLoading: false,
      ...props,
    };
    await getHarness().render(createElement(FeedKindFilter, resolved));
    return resolved;
  }

  it("renders a closed trigger with the All kinds label and grand active count", async () => {
    await render();
    const trigger = findByAriaLabel(dom?.container, "Filter feed by kind");
    expect(trigger).toBeTruthy();
    expect(trigger.textContent).toContain("All kinds");
    expect(trigger.textContent).toContain("4");
    expect(findAllByRole(dom?.container, "listbox")).toHaveLength(0);
  });

  it("opens the listbox and shows per-kind active headline and total subcount", async () => {
    await render();
    await act(async () => {
      getReactProps(findByAriaLabel(dom?.container, "Filter feed by kind"))?.onClick?.({});
    });

    const optionKinds = findAllByRole(dom?.container, "option").map((option: any) => option.getAttribute("data-kind"));
    expect(optionKinds).toEqual(["", "status", "note"]);

    const statusOption = findOptionByKind(dom?.container, "status");
    expect(statusOption.textContent).toContain("5 total");
    expect(statusOption.getAttribute("aria-label")).toBe("status, 2 active, 5 total");
  });

  it("selects a kind and calls onChange", async () => {
    const onChange = vi.fn();
    await render({ onChange });
    await act(async () => {
      getReactProps(findByAriaLabel(dom?.container, "Filter feed by kind"))?.onClick?.({});
    });
    await act(async () => {
      getReactProps(findOptionByKind(dom?.container, "note"))?.onClick?.({});
    });
    expect(onChange).toHaveBeenCalledWith("note");
  });

  it("falls back to client kinds without stats", async () => {
    await render({ stats: null, fallbackKinds: ["note", "status"] });
    await act(async () => {
      getReactProps(findByAriaLabel(dom?.container, "Filter feed by kind"))?.onClick?.({});
    });
    const optionKinds = findAllByRole(dom?.container, "option").map((option: any) => option.getAttribute("data-kind"));
    expect(optionKinds).toContain("note");
    expect(optionKinds).toContain("status");
    const noteOption = findOptionByKind(dom?.container, "note");
    expect(noteOption.textContent).toContain("—");
  });

  it("switches the activity visualization mode", async () => {
    await render();
    await act(async () => {
      getReactProps(findByAriaLabel(dom?.container, "Filter feed by kind"))?.onClick?.({});
    });
    const trendButton = findButtonByText(dom?.container, "Trend");
    expect(trendButton.getAttribute("aria-pressed")).toBe("false");
    await act(async () => {
      getReactProps(trendButton)?.onClick?.({});
    });
    expect(findButtonByText(dom?.container, "Trend").getAttribute("aria-pressed")).toBe("true");
    expect(findButtonByText(dom?.container, "Bars").getAttribute("aria-pressed")).toBe("false");
  });

  it("marks the currently selected kind", async () => {
    await render({ value: "status" });
    await act(async () => {
      getReactProps(findByAriaLabel(dom?.container, "Filter feed by kind"))?.onClick?.({});
    });
    expect(findOptionByKind(dom?.container, "status").getAttribute("aria-selected")).toBe("true");
    expect(findOptionByKind(dom?.container, "note").getAttribute("aria-selected")).toBe("false");
  });

  it("supports keyboard selection from the listbox", async () => {
    const onChange = vi.fn();
    await render({ onChange });
    await act(async () => {
      getReactProps(findByAriaLabel(dom?.container, "Filter feed by kind"))?.onKeyDown?.({
        key: "ArrowDown",
        preventDefault: vi.fn(),
      });
    });
    const listbox = findAllByRole(dom?.container, "listbox")[0];
    await act(async () => {
      getReactProps(listbox)?.onKeyDown?.({ key: "ArrowDown", preventDefault: vi.fn() });
    });
    await act(async () => {
      getReactProps(listbox)?.onKeyDown?.({ key: "Enter", preventDefault: vi.fn() });
    });
    expect(onChange).toHaveBeenCalledWith("status");
  });

  it("dims dormant (0-active) types and sorts them below active ones", async () => {
    const stats = makeStats({
      total: 60,
      active: 5,
      kinds: [
        makeKind("status", 5, 12),
        makeKind("note", 0, 40),
        makeKind("decision", 0, 8),
      ],
    });
    await render({ stats });
    await act(async () => {
      getReactProps(findByAriaLabel(dom?.container, "Filter feed by kind"))?.onClick?.({});
    });

    const optionKinds = findAllByRole(dom?.container, "option").map((option: any) => option.getAttribute("data-kind"));
    // "All", then active (status), then dormant (decision, note) sorted by total desc
    expect(optionKinds).toEqual(["", "status", "note", "decision"]);

    const noteOption = findOptionByKind(dom?.container, "note");
    expect(noteOption.getAttribute("data-dormant")).toBe("true");
    expect(findOptionByKind(dom?.container, "status").getAttribute("data-dormant")).toBeNull();
  });

  it("does not collapse a small number of dormant types", async () => {
    const stats = makeStats({
      kinds: [makeKind("status", 3, 6), makeKind("note", 0, 4), makeKind("link", 0, 2)],
    });
    await render({ stats });
    await act(async () => {
      getReactProps(findByAriaLabel(dom?.container, "Filter feed by kind"))?.onClick?.({});
    });
    expect(findDisclosure(dom?.container)).toBeNull();
    expect(findOptionByKind(dom?.container, "note")).toBeTruthy();
  });

  it("collapses dormant types behind a disclosure when there are at least five", async () => {
    const stats = makeStats({
      kinds: [
        makeKind("status", 4, 10),
        makeKind("note", 0, 9),
        makeKind("decision", 0, 8),
        makeKind("artifact", 0, 7),
        makeKind("link", 0, 6),
        makeKind("reminder", 0, 5),
      ],
    });
    await render({ stats });
    await act(async () => {
      getReactProps(findByAriaLabel(dom?.container, "Filter feed by kind"))?.onClick?.({});
    });

    // Active type visible; dormant ones hidden behind the disclosure.
    expect(findOptionByKind(dom?.container, "status")).toBeTruthy();
    expect(findOptionByKind(dom?.container, "note")).toBeNull();

    const disclosure = findDisclosure(dom?.container);
    expect(disclosure).toBeTruthy();
    expect(disclosure.textContent).toContain("5");

    await act(async () => {
      getReactProps(disclosure)?.onClick?.({});
    });
    expect(findOptionByKind(dom?.container, "note")).toBeTruthy();
    expect(findOptionByKind(dom?.container, "reminder")).toBeTruthy();
  });

  it("keeps a selected dormant type visible even when collapsed", async () => {
    const stats = makeStats({
      kinds: [
        makeKind("status", 4, 10),
        makeKind("note", 0, 9),
        makeKind("decision", 0, 8),
        makeKind("artifact", 0, 7),
        makeKind("link", 0, 6),
        makeKind("reminder", 0, 5),
      ],
    });
    await render({ stats, value: "decision" });
    await act(async () => {
      getReactProps(findByAriaLabel(dom?.container, "Filter feed by kind"))?.onClick?.({});
    });

    const decisionOption = findOptionByKind(dom?.container, "decision");
    expect(decisionOption).toBeTruthy();
    expect(decisionOption.getAttribute("aria-selected")).toBe("true");
    // Other dormant types remain collapsed.
    expect(findOptionByKind(dom?.container, "note")).toBeNull();
    const disclosure = findDisclosure(dom?.container);
    expect(disclosure.textContent).toContain("4");
  });
});
