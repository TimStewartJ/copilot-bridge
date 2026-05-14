import { createElement, type ComponentProps } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeedCard as FeedCardData } from "../api";
import { installDomShim } from "../test-dom-shim";

const apiMocks = vi.hoisted(() => ({
  patchFeedCard: vi.fn(),
  deleteFeedCard: vi.fn(),
}));

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    patchFeedCard: apiMocks.patchFeedCard,
    deleteFeedCard: apiMocks.deleteFeedCard,
  };
});

import DashboardFeed from "./DashboardFeed";

function makeCard(overrides: Partial<FeedCardData> = {}): FeedCardData {
  return {
    id: "card-1",
    dedupeKey: "preview:one",
    title: "Preview ready",
    body: "Open the staging preview.",
    kind: "status",
    priority: "high",
    status: "active",
    taskId: "task-1",
    sessionId: null,
    url: null,
    links: [],
    metadata: {},
    visual: null,
    action: null,
    pinned: false,
    statusChangedAt: "2026-05-13T10:00:00.000Z",
    createdAt: "2026-05-13T10:00:00.000Z",
    updatedAt: "2026-05-13T10:00:00.000Z",
    ...overrides,
  };
}

function findAllByTag(root: any, tag: string): any[] {
  const results: any[] = [];
  if ((root.tagName ?? "").toUpperCase() === tag.toUpperCase()) results.push(root);
  for (const child of root.childNodes ?? []) {
    results.push(...findAllByTag(child, tag));
  }
  return results;
}

function findButtonByLabel(root: any, label: string): any {
  const button = findAllByTag(root, "BUTTON").find((candidate) => candidate.getAttribute?.("aria-label") === label);
  if (!button) throw new Error(`Button not found: ${label}`);
  return button;
}

function getReactProps(el: any): Record<string, any> | null {
  if (!el) return null;
  const key = Object.keys(el).find((candidate) => candidate.startsWith("__reactProps$"));
  return key ? el[key] : null;
}

function waitTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitUntilAct(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await act(async () => {
      await waitTick();
    });
  }
  throw new Error("Timed out waiting for condition");
}

describe("DashboardFeed feed mutations", () => {
  let dom: ReturnType<typeof installDomShim> | null = null;
  let root: Root | null = null;
  let previousActEnvironment: boolean | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.patchFeedCard.mockResolvedValue(makeCard({ status: "done" }));
    apiMocks.deleteFeedCard.mockResolvedValue(undefined);
    previousActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    dom = installDomShim();
    root = createRoot(dom.container as unknown as Element);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
    }
    dom?.cleanup();
    if (previousActEnvironment === undefined) {
      delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    } else {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    }
    root = null;
    dom = null;
  });

  async function renderDashboardFeed(props: Partial<ComponentProps<typeof DashboardFeed>> = {}) {
    const resolvedProps: ComponentProps<typeof DashboardFeed> = {
      active: true,
      feedCards: [makeCard()],
      feedLoading: false,
      showResolvedFeed: false,
      onToggleResolvedFeed: vi.fn(),
      onSelectTask: vi.fn(),
      onSelectSession: vi.fn(),
      onStartPromptSession: vi.fn(async () => "session-new"),
      onRefetchFeed: vi.fn(async () => undefined),
      ...props,
    };

    await act(async () => {
      root?.render(createElement(DashboardFeed, resolvedProps));
    });

    return resolvedProps;
  }

  it("surfaces status update failures and refetches the feed to resync", async () => {
    apiMocks.patchFeedCard.mockRejectedValueOnce(new Error("Patch failed"));
    const onRefetchFeed = vi.fn(async () => undefined);
    await renderDashboardFeed({ onRefetchFeed });

    let clickResult: unknown;
    const markDoneButton = findButtonByLabel(dom?.container, "Mark done");
    await act(async () => {
      clickResult = getReactProps(markDoneButton)?.onClick?.();
      await waitTick();
    });
    await waitUntilAct(() => dom?.container.textContent?.includes("Failed to mark feed card done: Patch failed") ?? false);

    expect(clickResult).toBeUndefined();
    expect(apiMocks.patchFeedCard).toHaveBeenCalledWith("card-1", { status: "done" });
    expect(onRefetchFeed).toHaveBeenCalledTimes(1);
    expect(dom?.container.textContent).toContain("Failed to mark feed card done: Patch failed");
  });

  it("surfaces delete failures and keeps refresh failures visible without rethrowing", async () => {
    apiMocks.deleteFeedCard.mockRejectedValueOnce(new Error("Delete failed"));
    const onRefetchFeed = vi.fn(async () => {
      throw new Error("Refresh failed");
    });
    await renderDashboardFeed({ onRefetchFeed });

    let clickResult: unknown;
    const deleteButton = findButtonByLabel(dom?.container, "Delete");
    await act(async () => {
      clickResult = getReactProps(deleteButton)?.onClick?.();
      await waitTick();
    });
    await waitUntilAct(() => dom?.container.textContent?.includes("Failed to delete feed card: Delete failed") ?? false);

    expect(clickResult).toBeUndefined();
    expect(apiMocks.deleteFeedCard).toHaveBeenCalledWith("card-1");
    expect(onRefetchFeed).toHaveBeenCalledTimes(1);
    expect(dom?.container.textContent).toContain("Failed to delete feed card: Delete failed");
    expect(dom?.container.textContent).toContain("Also failed to refresh feed: Refresh failed");
  });

  it("groups resolved cards after active cards with a divider when both are visible", async () => {
    await renderDashboardFeed({
      showResolvedFeed: true,
      feedCards: [
        makeCard({ id: "resolved-pinned", title: "Pinned resolved", status: "done", pinned: true }),
        makeCard({ id: "active-card", title: "Active card", status: "active" }),
        makeCard({ id: "dismissed-card", title: "Dismissed card", status: "dismissed" }),
      ],
    });

    const text = dom?.container.textContent ?? "";
    expect(text.indexOf("Active card")).toBeLessThan(text.indexOf("Resolved"));
    expect(text.indexOf("Resolved")).toBeLessThan(text.indexOf("Pinned resolved"));
    expect(text.indexOf("Pinned resolved")).toBeLessThan(text.indexOf("Dismissed card"));
  });

  it("does not show a resolved divider for a resolved-only feed", async () => {
    await renderDashboardFeed({
      showResolvedFeed: true,
      feedCards: [
        makeCard({ id: "done-card", title: "Done card", status: "done" }),
      ],
    });

    const text = dom?.container.textContent ?? "";
    expect(text).toContain("Done card");
    expect(text).not.toContain("Resolved");
  });
});
