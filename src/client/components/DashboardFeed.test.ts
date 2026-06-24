import { createElement, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeedCard as FeedCardData, Task, TaskGroup } from "../api";
import {
  createReactDomHarness,
  advanceTimersByTimeAct as advanceTimersByTimeWithAct,
  findAllByTag,
  getReactProps,
  waitTick,
  waitUntilAct as waitUntilWithAct,
  type ReactDomHarness,
  type WaitUntilActOptions,
} from "../test-react-harness";
import { installDomShim } from "../test-dom-shim";

function installSelectAwareDomShim() {
  const dom = installDomShim();
  const documentRef = globalThis.document as typeof globalThis.document & { createElement: (tag: string) => any };
  const originalCreateElement = documentRef.createElement.bind(documentRef);
  documentRef.createElement = (tag: string) => {
    const element = originalCreateElement(tag);
    const normalizedTag = tag.toUpperCase();
    if (normalizedTag === "SELECT") {
      Object.defineProperty(element, "options", {
        configurable: true,
        get: () => Array.from(element.childNodes ?? []).filter((child: any) => child.tagName === "OPTION"),
      });
    }
    if (normalizedTag === "OPTION") {
      Object.defineProperty(element, "value", {
        configurable: true,
        get: () => element.getAttribute("value") ?? element.textContent ?? "",
        set: (value) => element.setAttribute("value", String(value)),
      });
      Object.defineProperty(element, "selected", { configurable: true, writable: true, value: false });
    }
    return element;
  };

  return {
    container: dom.container,
    cleanup() {
      documentRef.createElement = originalCreateElement;
      dom.cleanup();
    },
  };
}

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

type OnStartPromptSession = ComponentProps<typeof DashboardFeed>["onStartPromptSession"];

function mockStartPromptSession(sessionId: string) {
  return vi.fn<OnStartPromptSession>(async () => sessionId);
}

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

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Southwest return",
    kind: "task",
    muted: false,
    status: "active",
    notes: "",
    priority: 0,
    order: 0,
    createdAt: "2026-05-13T10:00:00.000Z",
    updatedAt: "2026-05-13T10:00:00.000Z",
    sessionIds: [],
    workItems: [],
    pullRequests: [],
    ...overrides,
  };
}

function makeTaskGroup(overrides: Partial<TaskGroup> = {}): TaskGroup {
  return {
    id: "group-1",
    name: "Travel",
    color: "amber",
    notes: "",
    order: 0,
    collapsed: false,
    createdAt: "2026-05-13T10:00:00.000Z",
    updatedAt: "2026-05-13T10:00:00.000Z",
    ...overrides,
  };
}

function findButtonByLabel(root: any, label: string): any {
  const button = findAllByTag(root, "BUTTON").find((candidate) => candidate.getAttribute?.("aria-label") === label);
  if (!button) throw new Error(`Button not found: ${label}`);
  return button;
}

function findByAriaLabel(root: any, label: string): any {
  if (!root) return null;
  if (root.getAttribute?.("aria-label") === label) return root;
  for (const child of root.childNodes ?? []) {
    const result = findByAriaLabel(child, label);
    if (result) return result;
  }
  return null;
}

function findButtonByText(root: any, text: string): any {
  const button = findAllByTag(root, "BUTTON").find((candidate) => candidate.textContent === text);
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

function findById(root: any, id: string): any {
  if (root.getAttribute?.("id") === id) return root;
  for (const child of root.childNodes ?? []) {
    const result = findById(child, id);
    if (result) return result;
  }
  return null;
}

function clickButton(button: any): unknown {
  return getReactProps(button)?.onClick?.({ currentTarget: button });
}

function findFeedCardElement(root: any, cardId: string): any {
  if (!root) return null;
  if (root.getAttribute?.("data-feed-card-id") === cardId) return root;
  for (const child of root.childNodes ?? []) {
    const result = findFeedCardElement(child, cardId);
    if (result) return result;
  }
  return null;
}

function createRect(top: number, height = 100): DOMRect {
  return {
    x: 0,
    y: top,
    width: 100,
    height,
    top,
    left: 0,
    right: 100,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect;
}

function setElementTopSequence(element: any, tops: number[]) {
  let callIndex = 0;
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => createRect(tops[Math.min(callIndex++, tops.length - 1)]),
  });
}

function setScrollContainerGeometry(
  element: any,
  geometry: { scrollTop: number; scrollHeight: number; clientHeight: number; top: number },
) {
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    writable: true,
    value: geometry.scrollTop,
  });
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    value: geometry.scrollHeight,
  });
  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    value: geometry.clientHeight,
  });
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => createRect(geometry.top, geometry.clientHeight),
  });
  Object.defineProperty(element, "scrollTo", {
    configurable: true,
    value: vi.fn((options: ScrollToOptions) => {
      element.scrollTop = options.top ?? element.scrollTop;
    }),
  });
}

describe("DashboardFeed feed mutations", () => {
  let harness: ReactDomHarness | null = null;
  let dom: ReactDomHarness["dom"] | null = null;

  function getHarness() {
    if (!harness) throw new Error("DashboardFeed harness has not been initialized");
    return harness;
  }

  async function act(callback: () => void | Promise<void>): Promise<void> {
    await getHarness().act(callback);
  }

  async function waitUntilAct(predicate: () => boolean, options?: WaitUntilActOptions): Promise<void> {
    await waitUntilWithAct(getHarness().act, predicate, options);
  }

  let savedMatchMedia: { value: unknown; existed: boolean } | null = null;

  function setPointerType(type: "coarse" | "fine") {
    const win = globalThis.window as unknown as { matchMedia?: unknown };
    if (!savedMatchMedia) {
      savedMatchMedia = { value: win.matchMedia, existed: "matchMedia" in win };
    }
    win.matchMedia = vi.fn((query: string) => ({
      matches: query.includes(`pointer: ${type}`),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }));
  }

  function restorePointerType() {
    if (!savedMatchMedia) return;
    const win = globalThis.window as unknown as { matchMedia?: unknown };
    if (savedMatchMedia.existed) {
      win.matchMedia = savedMatchMedia.value;
    } else {
      delete win.matchMedia;
    }
    savedMatchMedia = null;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    apiMocks.patchFeedCard.mockResolvedValue(makeCard({ status: "done" }));
    apiMocks.deleteFeedCard.mockResolvedValue(undefined);
    harness = await createReactDomHarness({ installDom: installSelectAwareDomShim });
    dom = harness.dom;
  });

  afterEach(async () => {
    restorePointerType();
    await harness?.cleanup();
    harness = null;
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

    await getHarness().render(createElement(DashboardFeed, resolvedProps));

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

  it("optimistically updates status and lets the snackbar undo it", async () => {
    const onRefetchFeed = vi.fn(async () => undefined);
    await renderDashboardFeed({ onRefetchFeed });

    const markDoneButton = findButtonByLabel(dom?.container, "Mark done");
    await act(async () => {
      getReactProps(markDoneButton)?.onClick?.();
      await waitTick();
    });
    await waitUntilAct(() => dom?.container.textContent?.includes('Marked "Preview ready" done.') ?? false);

    expect(apiMocks.patchFeedCard).toHaveBeenCalledWith("card-1", { status: "done" });
    expect(dom?.container.textContent).toContain('Marked "Preview ready" done.');
    expect(dom?.container.textContent).toContain("Undo");

    await act(async () => {
      await getReactProps(findButtonByText(dom?.container, "Undo"))?.onClick?.();
    });
    await waitUntilAct(() => dom?.container.textContent?.includes("Undone.") ?? false);

    expect(apiMocks.patchFeedCard).toHaveBeenCalledWith("card-1", { status: "active" });
    expect(onRefetchFeed).toHaveBeenCalledTimes(2);
  });

  it("anchors the scroll position to the next card when marking a card done", async () => {
    setPointerType("coarse");
    let resolvePatch!: (card: FeedCardData) => void;
    apiMocks.patchFeedCard.mockImplementationOnce(() => new Promise((resolve) => {
      resolvePatch = resolve;
    }));
    await renderDashboardFeed({
      feedCards: [
        makeCard({ id: "card-1", title: "First card" }),
        makeCard({ id: "card-2", title: "Second card" }),
      ],
    });
    const container = dom!.container as any;
    setScrollContainerGeometry(container, {
      scrollTop: 300,
      scrollHeight: 1_200,
      clientHeight: 400,
      top: 100,
    });
    const nextCard = findFeedCardElement(container, "card-2");
    expect(nextCard).toBeTruthy();
    // Anchor card sits at 200 before the resolve and shifts up to 100 after it.
    setElementTopSequence(nextCard, [200, 100]);

    await act(async () => {
      clickButton(findButtonByLabel(container, "Mark done"));
      await waitTick();
    });

    await waitUntilAct(() => container.scrollTop === 200);
    expect(container.scrollTo).toHaveBeenCalledWith({ top: 200, behavior: "auto" });

    await act(async () => {
      resolvePatch(makeCard({ id: "card-1", status: "done" }));
      await waitTick();
    });
  });

  it("anchors the scroll position to the next card when dismissing a card", async () => {
    setPointerType("coarse");
    let resolvePatch!: (card: FeedCardData) => void;
    apiMocks.patchFeedCard.mockImplementationOnce(() => new Promise((resolve) => {
      resolvePatch = resolve;
    }));
    await renderDashboardFeed({
      feedCards: [
        makeCard({ id: "card-1", title: "First card" }),
        makeCard({ id: "card-2", title: "Second card" }),
      ],
    });
    const container = dom!.container as any;
    setScrollContainerGeometry(container, {
      scrollTop: 300,
      scrollHeight: 1_200,
      clientHeight: 400,
      top: 100,
    });
    const nextCard = findFeedCardElement(container, "card-2");
    expect(nextCard).toBeTruthy();
    setElementTopSequence(nextCard, [200, 100]);

    await act(async () => {
      clickButton(findButtonByLabel(container, "Dismiss"));
      await waitTick();
    });

    await waitUntilAct(() => container.scrollTop === 200);
    expect(container.scrollTo).toHaveBeenCalledWith({ top: 200, behavior: "auto" });

    await act(async () => {
      resolvePatch(makeCard({ id: "card-1", status: "dismissed" }));
      await waitTick();
    });
  });

  it("does not adjust the scroll when the anchor card has not moved", async () => {
    setPointerType("coarse");
    let resolvePatch!: (card: FeedCardData) => void;
    apiMocks.patchFeedCard.mockImplementationOnce(() => new Promise((resolve) => {
      resolvePatch = resolve;
    }));
    await renderDashboardFeed({
      feedCards: [
        makeCard({ id: "card-1", title: "First card" }),
        makeCard({ id: "card-2", title: "Second card" }),
      ],
    });
    const container = dom!.container as any;
    setScrollContainerGeometry(container, {
      scrollTop: 300,
      scrollHeight: 1_200,
      clientHeight: 400,
      top: 100,
    });
    const nextCard = findFeedCardElement(container, "card-2");
    expect(nextCard).toBeTruthy();
    setElementTopSequence(nextCard, [150, 150]);

    await act(async () => {
      clickButton(findButtonByLabel(container, "Dismiss"));
      await waitTick();
    });
    await waitUntilAct(() => container.textContent?.includes('Dismissed "First card".') ?? false);

    expect(container.scrollTop).toBe(300);
    expect(container.scrollTo).not.toHaveBeenCalled();

    await act(async () => {
      resolvePatch(makeCard({ id: "card-1", status: "dismissed" }));
      await waitTick();
    });
  });

  it("skips scroll compensation when there is no neighbor card to anchor", async () => {
    setPointerType("coarse");
    let resolvePatch!: (card: FeedCardData) => void;
    apiMocks.patchFeedCard.mockImplementationOnce(() => new Promise((resolve) => {
      resolvePatch = resolve;
    }));
    await renderDashboardFeed({
      feedCards: [makeCard({ id: "card-1", title: "Only card" })],
    });
    const container = dom!.container as any;
    setScrollContainerGeometry(container, {
      scrollTop: 300,
      scrollHeight: 1_200,
      clientHeight: 400,
      top: 100,
    });

    await act(async () => {
      clickButton(findButtonByLabel(container, "Dismiss"));
      await waitTick();
    });
    await waitUntilAct(() => container.textContent?.includes('Dismissed "Only card".') ?? false);

    expect(container.scrollTop).toBe(300);
    expect(container.scrollTo).not.toHaveBeenCalled();

    await act(async () => {
      resolvePatch(makeCard({ id: "card-1", status: "dismissed" }));
      await waitTick();
    });
  });

  it("does not anchor to a neighbor on a fine pointer so the list reflows upward", async () => {
    setPointerType("fine");
    let resolvePatch!: (card: FeedCardData) => void;
    apiMocks.patchFeedCard.mockImplementationOnce(() => new Promise((resolve) => {
      resolvePatch = resolve;
    }));
    await renderDashboardFeed({
      feedCards: [
        makeCard({ id: "card-1", title: "First card" }),
        makeCard({ id: "card-2", title: "Second card" }),
      ],
    });
    const container = dom!.container as any;
    setScrollContainerGeometry(container, {
      scrollTop: 300,
      scrollHeight: 1_200,
      clientHeight: 400,
      top: 100,
    });
    const nextCard = findFeedCardElement(container, "card-2");
    expect(nextCard).toBeTruthy();
    // The neighbor shifts up, but on a fine pointer we must NOT compensate for it.
    setElementTopSequence(nextCard, [200, 100]);

    await act(async () => {
      clickButton(findButtonByLabel(container, "Dismiss"));
      await waitTick();
    });
    await waitUntilAct(() => container.textContent?.includes('Dismissed "First card".') ?? false);

    expect(container.scrollTo).not.toHaveBeenCalled();
    expect(container.scrollTop).toBe(300);

    await act(async () => {
      resolvePatch(makeCard({ id: "card-1", status: "dismissed" }));
      await waitTick();
    });
  });

  it("hides an optimistically resolved card instead of flashing a resolved section when resolved feed is hidden", async () => {
    let resolvePatch!: (card: FeedCardData) => void;
    apiMocks.patchFeedCard.mockImplementationOnce(() => new Promise((resolve) => {
      resolvePatch = resolve;
    }));
    await renderDashboardFeed({
      showResolvedFeed: false,
      feedCards: [
        makeCard({ id: "card-1", title: "First card" }),
        makeCard({ id: "card-2", title: "Second card" }),
      ],
    });
    const container = dom!.container as any;

    await act(async () => {
      clickButton(findButtonByLabel(container, "Dismiss"));
      await waitTick();
    });
    await waitUntilAct(() => findFeedCardElement(container, "card-1") === null);

    expect(findFeedCardElement(container, "card-1")).toBeNull();
    expect(findFeedCardElement(container, "card-2")).toBeTruthy();
    expect(container.textContent).not.toContain("Resolved");

    await act(async () => {
      resolvePatch(makeCard({ id: "card-1", status: "dismissed" }));
      await waitTick();
    });
  });

  it("ignores a repeated resolve click while the first mutation is in flight", async () => {
    let resolvePatch!: (card: FeedCardData) => void;
    apiMocks.patchFeedCard.mockImplementationOnce(() => new Promise((resolve) => {
      resolvePatch = resolve;
    }));
    await renderDashboardFeed({
      feedCards: [
        makeCard({ id: "card-1", title: "First card" }),
        makeCard({ id: "card-2", title: "Second card" }),
      ],
    });
    const container = dom!.container as any;
    const markDoneButton = findButtonByLabel(container, "Mark done");

    await act(async () => {
      clickButton(markDoneButton);
      clickButton(markDoneButton);
      await waitTick();
    });

    expect(apiMocks.patchFeedCard).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolvePatch(makeCard({ id: "card-1", status: "done" }));
      await waitTick();
    });
  });

  it("defers delete so the snackbar can undo before the server request", async () => {
    vi.useFakeTimers();
    try {
      await renderDashboardFeed();

      await act(async () => {
        clickButton(findButtonByLabel(dom?.container, "More actions"));
      });
      await act(async () => {
        clickButton(findButtonByText(dom?.container, "Delete card"));
      });

      expect(dom?.container.textContent).toContain('Deleted "Preview ready".');
      expect(dom?.container.textContent).toContain("Undo");
      expect(apiMocks.deleteFeedCard).not.toHaveBeenCalled();

      await act(async () => {
        getReactProps(findButtonByText(dom?.container, "Undo"))?.onClick?.();
      });
      expect(dom?.container.textContent).toContain('Restored "Preview ready".');
      expect(dom?.container.textContent).toContain("Preview ready");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });

      expect(apiMocks.deleteFeedCard).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces prompt CTAs on the card and moves mobile done into the floating More menu", async () => {
    await renderDashboardFeed({
      feedCards: [
        makeCard({
          action: {
            label: "Launch prompt",
            prompt: "Investigate this from the feed.",
          },
        }),
      ],
    });

    expect(findButtonByText(dom?.container, "Launch prompt")).toBeTruthy();
    expect(findAllByTag(dom?.container, "BUTTON").filter((button) => button.textContent === "Mark done")).toHaveLength(1);

    await act(async () => {
      clickButton(findButtonByLabel(dom?.container, "More actions"));
    });

    const moreMenu = findById(dom?.container, "feed-card-card-1-more-actions");
    expect(moreMenu).toBeTruthy();
    expect(dom?.container.textContent).toContain("Delete card");
    expect(findAllByTag(dom?.container, "BUTTON").filter((button) => button.textContent === "Mark done")).toHaveLength(2);
  });

  it("starts a card-context chat without marking the feed card done", async () => {
    const onStartPromptSession = mockStartPromptSession("session-chat");
    const onSelectSession = vi.fn();
    const onRefetchFeed = vi.fn(async () => undefined);
    await renderDashboardFeed({
      feedCards: [
        makeCard({
          title: "Preview ready",
          body: "Open the staging preview.",
          links: [{ label: "Preview", url: "https://example.test/preview" }],
        }),
      ],
      onStartPromptSession,
      onSelectSession,
      onRefetchFeed,
    });

    await act(async () => {
      getReactProps(findButtonByText(dom?.container, "Chat with card"))?.onClick?.();
      await waitTick();
    });
    expect(dom?.container.textContent).toContain("Feed card chat");
    expect(dom?.container.textContent).toContain("Card context included");
    expect(dom?.container.textContent).toContain("Message to send");
    const messageBox = findAllByTag(dom?.container, "TEXTAREA")[0];
    expect(getReactProps(messageBox)?.value).toBe("");

    await act(async () => {
      getReactProps(messageBox)?.onChange?.({ target: { value: "What should I do next?" } });
      await waitTick();
    });

    await act(async () => {
      await getReactProps(findButtonByText(dom?.container, "Start session"))?.onClick?.();
    });
    await waitUntilAct(() => onSelectSession.mock.calls.length === 1);

    const prompt = onStartPromptSession.mock.calls[0][0];
    expect(prompt).toContain("Use the feed card context below when responding.");
    expect(prompt).toContain("- Title: Preview ready");
    expect(prompt).toContain("Open the staging preview.");
    expect(prompt).toContain("- Preview: https://example.test/preview");
    expect(prompt).toContain("# My message\nWhat should I do next?");
    expect(onStartPromptSession).toHaveBeenCalledWith(prompt, "task-1");
    expect(apiMocks.patchFeedCard).toHaveBeenCalledWith("card-1", { sessionId: "session-chat" });
    expect(apiMocks.patchFeedCard).not.toHaveBeenCalledWith("card-1", { status: "done", sessionId: "session-chat" });
    expect(onRefetchFeed).toHaveBeenCalledTimes(1);
    expect(onSelectSession).toHaveBeenCalledWith("session-chat", "task-1");
    expect(dom?.container.textContent).not.toContain("Feed card chat");
    expect(dom?.container.textContent).toContain("Open session");
  });

  it("does not replace an existing card session link when starting a card chat", async () => {
    const onStartPromptSession = mockStartPromptSession("session-chat");
    const onSelectSession = vi.fn();
    const onRefetchFeed = vi.fn(async () => undefined);
    await renderDashboardFeed({
      feedCards: [
        makeCard({
          sessionId: "session-existing",
        }),
      ],
      onStartPromptSession,
      onSelectSession,
      onRefetchFeed,
    });

    await act(async () => {
      getReactProps(findButtonByText(dom?.container, "Chat with card"))?.onClick?.();
      await waitTick();
    });
    await act(async () => {
      await getReactProps(findButtonByText(dom?.container, "Send in background"))?.onClick?.();
    });

    const prompt = onStartPromptSession.mock.calls[0][0];
    expect(prompt).toContain("# My message\nLet's discuss this feed card.");
    expect(onStartPromptSession).toHaveBeenCalledWith(prompt, "task-1", { navigateOnError: false });
    expect(apiMocks.patchFeedCard).not.toHaveBeenCalled();
    expect(onRefetchFeed).not.toHaveBeenCalled();
    expect(dom?.container.textContent).toContain('Started chat for "Preview ready" in background.');

    await act(async () => {
      getReactProps(findButtonByText(dom?.container, "Open session"))?.onClick?.();
    });
    expect(onSelectSession).toHaveBeenCalledWith("session-existing", "task-1");
  });

  it("shows the linked task name and group dot in the prompt preview", async () => {
    await renderDashboardFeed({
      feedCards: [
        makeCard({
          action: {
            label: "Launch prompt",
            prompt: "Investigate this from the feed.",
          },
        }),
      ],
      tasks: [makeTask({ groupId: "group-1" })],
      taskGroups: [makeTaskGroup()],
    });

    await act(async () => {
      getReactProps(findButtonByText(dom?.container, "Launch prompt"))?.onClick?.();
      await waitTick();
    });

    const groupDot = findByAriaLabel(dom?.container, "Travel group");
    expect(dom?.container.textContent).toContain("Session will be linked to");
    expect(dom?.container.textContent).toContain("Southwest return");
    expect(dom?.container.textContent).not.toContain("Session will be linked to task task-1.");
    expect(groupDot).toBeTruthy();
    expect(groupDot.getAttribute("class")).toContain("bg-amber-500");
  });

  it("surfaces deferred delete failures and keeps refresh failures visible without rethrowing", async () => {
    vi.useFakeTimers();
    apiMocks.deleteFeedCard.mockRejectedValueOnce(new Error("Delete failed"));
    const onRefetchFeed = vi.fn(async () => {
      throw new Error("Refresh failed");
    });
    try {
      await renderDashboardFeed({ onRefetchFeed });

      let clickResult: unknown;
      await act(async () => {
        clickButton(findButtonByLabel(dom?.container, "More actions"));
      });
      const deleteButton = findButtonByText(dom?.container, "Delete card");
      await act(async () => {
        clickResult = clickButton(deleteButton);
      });
      expect(clickResult).toBeUndefined();
      expect(apiMocks.deleteFeedCard).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });

      expect(apiMocks.deleteFeedCard).toHaveBeenCalledWith("card-1");
      expect(onRefetchFeed).toHaveBeenCalledTimes(1);
      expect(dom?.container.textContent).toContain("Failed to delete feed card: Delete failed");
      expect(dom?.container.textContent).toContain("Also failed to refresh feed: Refresh failed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("navigates to a started prompt session when marking the feed card done fails", async () => {
    apiMocks.patchFeedCard.mockRejectedValueOnce(new Error("Patch failed"));
    const onStartPromptSession = vi.fn(async () => "session-new");
    const onSelectSession = vi.fn();
    const onRefetchFeed = vi.fn(async () => undefined);
    await renderDashboardFeed({
      feedCards: [
        makeCard({
          action: {
            label: "Launch prompt",
            prompt: "Investigate this from the feed.",
            taskId: "task-action",
          },
        }),
      ],
      onStartPromptSession,
      onSelectSession,
      onRefetchFeed,
    });

    await act(async () => {
      getReactProps(findButtonByText(dom?.container, "Launch prompt"))?.onClick?.();
      await waitTick();
    });
    expect(dom?.container.textContent).toContain("Feed action preview");

    await act(async () => {
      await getReactProps(findButtonByText(dom?.container, "Start session"))?.onClick?.();
    });
    await waitUntilAct(() => onSelectSession.mock.calls.length === 1);
    await waitUntilAct(() => dom?.container.textContent?.includes("Session started, but failed to mark feed card done: Patch failed") ?? false);

    expect(onStartPromptSession).toHaveBeenCalledTimes(1);
    expect(onStartPromptSession).toHaveBeenCalledWith("Investigate this from the feed.", "task-action");
    expect(apiMocks.patchFeedCard).toHaveBeenCalledWith("card-1", { status: "done", sessionId: "session-new" });
    expect(onRefetchFeed).toHaveBeenCalledTimes(1);
    expect(onSelectSession).toHaveBeenCalledWith("session-new", "task-action");
    expect(dom?.container.textContent).not.toContain("Feed action preview");
    expect(dom?.container.textContent).not.toContain("Start session");
    expect(findAllByTag(dom?.container, "BUTTON").some((button) => button.textContent === "Launch prompt")).toBe(false);
    expect(dom?.container.textContent).toContain("Open session");
  });

  it("can send a prompt CTA in the background without navigating to the new session", async () => {
    const onStartPromptSession = vi.fn(async () => "session-bg");
    const onSelectSession = vi.fn();
    const onRefetchFeed = vi.fn(async () => undefined);
    await renderDashboardFeed({
      feedCards: [
        makeCard({
          action: {
            label: "Launch prompt",
            prompt: "Investigate this from the feed.",
            taskId: "task-action",
          },
        }),
      ],
      onStartPromptSession,
      onSelectSession,
      onRefetchFeed,
    });

    await act(async () => {
      getReactProps(findButtonByText(dom?.container, "Launch prompt"))?.onClick?.();
      await waitTick();
    });
    expect(dom?.container.textContent).toContain("Feed action preview");

    await act(async () => {
      await getReactProps(findButtonByText(dom?.container, "Send in background"))?.onClick?.();
    });
    await waitUntilAct(() => apiMocks.patchFeedCard.mock.calls.length === 1);

    expect(onStartPromptSession).toHaveBeenCalledTimes(1);
    expect(onStartPromptSession).toHaveBeenCalledWith(
      "Investigate this from the feed.",
      "task-action",
      { navigateOnError: false },
    );
    expect(onSelectSession).not.toHaveBeenCalled();
    expect(apiMocks.patchFeedCard).toHaveBeenCalledWith("card-1", { status: "done", sessionId: "session-bg" });
    expect(onRefetchFeed).toHaveBeenCalledTimes(1);
    expect(dom?.container.textContent).not.toContain("Feed action preview");
    expect(dom?.container.textContent).not.toContain("Launch prompt");
    expect(dom?.container.textContent).toContain('Started "Preview ready" in background.');
    expect(dom?.container.textContent).toContain("Open session");
  });

  it("keeps the prompt preview open when background send fails without navigating", async () => {
    const onStartPromptSession = vi.fn(async () => {
      throw new Error("Send failed");
    });
    const onSelectSession = vi.fn();
    await renderDashboardFeed({
      feedCards: [
        makeCard({
          action: {
            label: "Launch prompt",
            prompt: "Investigate this from the feed.",
            taskId: "task-action",
          },
        }),
      ],
      onStartPromptSession,
      onSelectSession,
    });

    await act(async () => {
      getReactProps(findButtonByText(dom?.container, "Launch prompt"))?.onClick?.();
      await waitTick();
    });
    await act(async () => {
      await getReactProps(findButtonByText(dom?.container, "Send in background"))?.onClick?.();
    });
    await waitUntilAct(() => dom?.container.textContent?.includes("Send failed") ?? false);

    expect(onStartPromptSession).toHaveBeenCalledWith(
      "Investigate this from the feed.",
      "task-action",
      { navigateOnError: false },
    );
    expect(onSelectSession).not.toHaveBeenCalled();
    expect(apiMocks.patchFeedCard).not.toHaveBeenCalled();
    expect(dom?.container.textContent).toContain("Feed action preview");
    expect(dom?.container.textContent).toContain("Send failed");
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

  it("exposes load-more controls for paginated feed sections", async () => {
    const onLoadMoreActive = vi.fn();
    const onLoadMoreResolved = vi.fn();
    await renderDashboardFeed({
      showResolvedFeed: true,
      activeHasMore: true,
      resolvedHasMore: true,
      feedCards: [
        makeCard({ id: "active-card", title: "Active card", status: "active" }),
        makeCard({ id: "done-card", title: "Done card", status: "done" }),
      ],
      onLoadMoreActive,
      onLoadMoreResolved,
    });

    await act(async () => {
      clickButton(findButtonByText(dom?.container, "Load more active"));
      clickButton(findButtonByText(dom?.container, "Load more resolved"));
    });

    expect(onLoadMoreActive).toHaveBeenCalledTimes(1);
    expect(onLoadMoreResolved).toHaveBeenCalledTimes(1);
  });
});

describe("DashboardFeed feed filter", () => {
  let harness: ReactDomHarness | null = null;
  let dom: ReactDomHarness["dom"] | null = null;

  function getHarness() {
    if (!harness) throw new Error("DashboardFeed harness has not been initialized");
    return harness;
  }

  async function act(callback: () => void | Promise<void>): Promise<void> {
    await getHarness().act(callback);
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    harness = await createReactDomHarness({ installDom: installSelectAwareDomShim });
    dom = harness.dom;
  });

  afterEach(async () => {
    await harness?.cleanup();
    harness = null;
    dom = null;
    vi.useRealTimers();
  });

  async function renderFeed(props: Partial<ComponentProps<typeof DashboardFeed>> = {}) {
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
    await getHarness().render(createElement(DashboardFeed, resolvedProps));
    return resolvedProps;
  }

  it("commits a kind selection immediately and lists kinds from loaded cards", async () => {
    const onFeedFilterChange = vi.fn();
    await renderFeed({
      feedCards: [
        makeCard({ id: "c1", kind: "status" }),
        makeCard({ id: "c2", kind: "note", dedupeKey: "docs-maintenance:audit:1" }),
      ],
      feedFilter: { kind: "", keyPrefix: "" },
      onFeedFilterChange,
    });

    const select = findByAriaLabel(dom?.container, "Filter feed by kind");
    expect(select).toBeTruthy();
    const optionValues = findAllByTag(select, "OPTION").map((option: any) => option.getAttribute("value"));
    expect(optionValues).toContain("note");
    expect(optionValues).toContain("status");

    await act(async () => {
      getReactProps(select)?.onChange?.({ target: { value: "note" } });
    });

    expect(onFeedFilterChange).toHaveBeenCalledWith({ kind: "note" });
  });

  it("debounces the key prefix input before committing", async () => {
    vi.useFakeTimers();
    const onFeedFilterChange = vi.fn();
    await renderFeed({ feedFilter: { kind: "", keyPrefix: "" }, onFeedFilterChange });

    const input = findByAriaLabel(dom?.container, "Filter feed by key prefix");
    expect(input).toBeTruthy();

    await act(async () => {
      getReactProps(input)?.onChange?.({ target: { value: "docs-maintenance:" } });
    });
    expect(onFeedFilterChange).not.toHaveBeenCalled();

    await advanceTimersByTimeWithAct(getHarness().act, 250);
    expect(onFeedFilterChange).toHaveBeenCalledWith({ keyPrefix: "docs-maintenance:" });
  });

  it("commits the key prefix immediately on Enter and trims whitespace", async () => {
    const onFeedFilterChange = vi.fn();
    await renderFeed({ feedFilter: { kind: "", keyPrefix: "" }, onFeedFilterChange });

    const input = findByAriaLabel(dom?.container, "Filter feed by key prefix");
    await act(async () => {
      getReactProps(input)?.onChange?.({ target: { value: "  docs-maintenance:  " } });
    });
    await act(async () => {
      getReactProps(input)?.onKeyDown?.({ key: "Enter", preventDefault: vi.fn() });
    });

    expect(onFeedFilterChange).toHaveBeenCalledWith({ keyPrefix: "docs-maintenance:" });
  });

  it("clears active filters", async () => {
    const onFeedFilterChange = vi.fn();
    await renderFeed({
      feedCards: [makeCard({ kind: "note" })],
      feedFilter: { kind: "note", keyPrefix: "docs:" },
      onFeedFilterChange,
    });

    await act(async () => {
      clickButton(findButtonByText(dom?.container, "Clear"));
    });

    expect(onFeedFilterChange).toHaveBeenCalledWith({ kind: "", keyPrefix: "" });
  });

  it("shows a filtered empty state when no cards match", async () => {
    await renderFeed({
      feedCards: [],
      feedFilter: { kind: "", keyPrefix: "docs-maintenance:" },
      onFeedFilterChange: vi.fn(),
    });

    expect(dom?.container.textContent).toContain("No feed cards match this filter");
    expect(findByAriaLabel(dom?.container, "Filter feed by key prefix")).toBeTruthy();
  });

  it("keeps previously seen kinds selectable after the loaded set narrows", async () => {
    const onFeedFilterChange = vi.fn();
    await renderFeed({
      feedCards: [
        makeCard({ id: "c1", kind: "status" }),
        makeCard({ id: "c2", kind: "note" }),
      ],
      feedFilter: { kind: "", keyPrefix: "" },
      onFeedFilterChange,
    });

    await renderFeed({
      feedCards: [makeCard({ id: "c1", kind: "status" })],
      feedFilter: { kind: "status", keyPrefix: "" },
      onFeedFilterChange,
    });

    const select = findByAriaLabel(dom?.container, "Filter feed by kind");
    const optionValues = findAllByTag(select, "OPTION").map((option: any) => option.getAttribute("value"));
    expect(optionValues).toContain("note");
    expect(optionValues).toContain("status");
  });
});
