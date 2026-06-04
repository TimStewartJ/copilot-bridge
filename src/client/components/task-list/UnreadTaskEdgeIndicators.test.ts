import { createElement, useRef } from "react";
import { describe, expect, it } from "vitest";
import { createReactDomHarness, findAllByTag, flushAct, getReactProps } from "../../test-react-harness";
import { UnreadTaskEdgePill, useUnreadTaskEdges } from "./UnreadTaskEdgeIndicators";

interface TestRow {
  id: string;
  unread?: boolean;
}

function setScrollGeometry(
  element: HTMLElement,
  geometry: { scrollHeight: number; clientHeight: number; scrollTop: number },
) {
  Object.defineProperty(element, "scrollHeight", { configurable: true, value: geometry.scrollHeight });
  Object.defineProperty(element, "clientHeight", { configurable: true, value: geometry.clientHeight });
  Object.defineProperty(element, "scrollTop", { configurable: true, writable: true, value: geometry.scrollTop });
}

function setRect(element: HTMLElement, top: number, height: number) {
  element.getBoundingClientRect = () => ({
    x: 0,
    y: top,
    width: 200,
    height,
    top,
    left: 0,
    right: 200,
    bottom: top + height,
    toJSON: () => ({}),
  }) as DOMRect;
}

function queryByTestId(root: HTMLElement, testId: string): HTMLElement | null {
  return findAllByTag(root, "DIV")
    .concat(findAllByTag(root, "BUTTON"))
    .find((element) => element.getAttribute?.("data-testid") === testId) ?? null;
}

function findByTestId(root: HTMLElement, testId: string): HTMLElement {
  const candidate = queryByTestId(root, testId);
  if (!candidate) throw new Error(`Element not found: ${testId}`);
  return candidate as HTMLElement;
}

function findButtonByText(root: HTMLElement, text: string): HTMLElement {
  const button = findAllByTag(root, "BUTTON").find((element) => element.textContent === text);
  if (!button) throw new Error(`Button not found: ${text}`);
  return button as HTMLElement;
}

function EdgeRows({ rows }: { rows: TestRow[] }) {
  return rows.map((row) => createElement(
    "button",
    {
      key: row.id,
      type: "button",
      "data-testid": `row-${row.id}`,
      "data-unread-task-id": row.unread ? row.id : undefined,
    },
    row.id,
  ));
}

function EdgeList({
  rows,
  disabled = false,
  nested = false,
  explicitScrollRef = false,
  version = 0,
}: {
  rows: TestRow[];
  disabled?: boolean;
  nested?: boolean;
  explicitScrollRef?: boolean;
  version?: number;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const scopeRef = useRef<HTMLDivElement>(null);
  const effectiveScopeRef = nested ? scopeRef : scrollRef;
  const edges = useUnreadTaskEdges({
    scopeRef: effectiveScopeRef,
    scrollContainerRef: explicitScrollRef ? scrollRef : undefined,
    disabled,
    refreshKey: `${version}|${rows.map((row) => `${row.id}:${row.unread ? "1" : "0"}`).join("|")}`,
  });

  const content = [
    createElement(UnreadTaskEdgePill, { key: "__above", edge: edges.above, direction: "above", onJump: edges.jumpToTask }),
    ...EdgeRows({ rows }),
    createElement(UnreadTaskEdgePill, { key: "__below", edge: edges.below, direction: "below", onJump: edges.jumpToTask }),
  ];

  if (nested) {
    return createElement(
      "div",
      { ref: scrollRef, "data-testid": "edge-scroll", className: "overflow-y-auto" },
      createElement("div", { ref: scopeRef, "data-testid": "edge-scope" }, ...content),
    );
  }

  return createElement(
    "div",
    { ref: scrollRef, "data-testid": "edge-scroll", className: "overflow-y-auto" },
    ...content,
  );
}

async function renderMeasuredList(
  rows: TestRow[],
  rowRects: Record<string, { top: number; height: number }>,
  options: {
    disabled?: boolean;
    explicitScrollRef?: boolean;
    nested?: boolean;
    scrollHeight?: number;
    clientHeight?: number;
    scrollTop?: number;
  } = {},
) {
  const harness = await createReactDomHarness();
  const renderList = (version: number) => harness.render(createElement(EdgeList, {
    rows,
    disabled: options.disabled,
    nested: options.nested,
    explicitScrollRef: options.explicitScrollRef,
    version,
  }));

  await renderList(0);
  const container = findByTestId(harness.dom.container as unknown as HTMLElement, "edge-scroll");
  setScrollGeometry(container, {
    scrollHeight: options.scrollHeight ?? 500,
    clientHeight: options.clientHeight ?? 100,
    scrollTop: options.scrollTop ?? 50,
  });
  setRect(container, 0, options.clientHeight ?? 100);
  for (const row of rows) {
    const rect = rowRects[row.id];
    if (!rect) continue;
    setRect(findByTestId(harness.dom.container as unknown as HTMLElement, `row-${row.id}`), rect.top, rect.height);
  }

  await renderList(1);
  await flushAct(harness.act);
  return { harness, container };
}

describe("UnreadTaskEdgeIndicators", () => {
  it("shows unread counts above and below and scrolls to the nearest unread row", async () => {
    const { harness, container } = await renderMeasuredList(
      [
        { id: "above-1", unread: true },
        { id: "above-2", unread: true },
        { id: "visible", unread: true },
        { id: "below-1", unread: true },
        { id: "below-2", unread: true },
      ],
      {
        "above-1": { top: -80, height: 20 },
        "above-2": { top: -30, height: 20 },
        visible: { top: 30, height: 20 },
        "below-1": { top: 120, height: 20 },
        "below-2": { top: 170, height: 20 },
      },
    );

    expect(harness.dom.container.textContent).toContain("↑ 2 unread above");
    expect(harness.dom.container.textContent).toContain("2 unread below ↓");

    const jumpBelow = findButtonByText(harness.dom.container as unknown as HTMLElement, "2 unread below ↓");
    await harness.act(async () => {
      getReactProps(jumpBelow)?.onClick();
    });
    await flushAct(harness.act);

    expect(container.scrollTop).toBe(130);
  });

  it("does not count visible, partially visible, non-unread, or non-overflowing rows", async () => {
    const { harness } = await renderMeasuredList(
      [
        { id: "partial-above", unread: true },
        { id: "visible", unread: true },
        { id: "below-not-unread", unread: false },
        { id: "partial-below", unread: true },
      ],
      {
        "partial-above": { top: -10, height: 30 },
        visible: { top: 30, height: 20 },
        "below-not-unread": { top: 130, height: 20 },
        "partial-below": { top: 90, height: 30 },
      },
    );

    expect(queryByTestId(harness.dom.container as unknown as HTMLElement, "unread-tasks-above")).toBeNull();
    expect(queryByTestId(harness.dom.container as unknown as HTMLElement, "unread-tasks-below")).toBeNull();

    await harness.cleanup();

    const shortList = await renderMeasuredList(
      [{ id: "below", unread: true }],
      { below: { top: 130, height: 20 } },
      { scrollHeight: 90, clientHeight: 100 },
    );
    expect(queryByTestId(shortList.harness.dom.container as unknown as HTMLElement, "unread-tasks-below")).toBeNull();
  });

  it("hides indicators when measurement is disabled", async () => {
    const { harness } = await renderMeasuredList(
      [{ id: "below", unread: true }],
      { below: { top: 130, height: 20 } },
      { disabled: true },
    );

    expect(harness.dom.container.textContent).not.toContain("1 unread below ↓");
  });

  it("finds a scrollable ancestor when the task-list scope is not the scroll container", async () => {
    const { harness } = await renderMeasuredList(
      [{ id: "below", unread: true }],
      { below: { top: 130, height: 20 } },
      { nested: true },
    );

    expect(harness.dom.container.textContent).toContain("1 unread below ↓");
  });

  it("uses an explicit scroll container ref when provided", async () => {
    const { harness } = await renderMeasuredList(
      [{ id: "above", unread: true }],
      { above: { top: -40, height: 20 } },
      { explicitScrollRef: true, nested: true },
    );

    expect(harness.dom.container.textContent).toContain("↑ 1 unread above");
  });
});
