import { createElement, Fragment, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReactDomHarness } from "../test-react-harness";
import useElementScrollRestoration from "./useElementScrollRestoration";

type TestScrollElement = HTMLElement & {
  dispatchTestEvent: (type: string) => void;
};

interface TestScrollElementOptions {
  scrollHeight?: number;
  clientHeight?: number;
}

interface HookHostProps {
  id: string;
  element: TestScrollElement;
  restorationKey: string;
  restore?: boolean;
  enabled?: boolean;
}

function createScrollElement(
  initialScrollTop = 0,
  { scrollHeight = 1_000, clientHeight = 300 }: TestScrollElementOptions = {},
): TestScrollElement {
  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  let currentScrollTop = initialScrollTop;
  const element = {
    scrollHeight,
    clientHeight,
    children: [],
    addEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
      if (!listener) return;
      const listenersForType = listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>();
      listenersForType.add(listener);
      listeners.set(type, listenersForType);
    },
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
      if (!listener) return;
      listeners.get(type)?.delete(listener);
    },
    dispatchTestEvent(type: string) {
      const event = { type, target: element, currentTarget: element } as unknown as Event;
      for (const listener of listeners.get(type) ?? []) {
        if (typeof listener === "function") {
          listener.call(element, event);
        } else {
          listener.handleEvent(event);
        }
      }
    },
  };
  const clampScrollTop = (scrollTop: number) => Math.max(
    0,
    Math.min(scrollTop, Math.max(0, element.scrollHeight - element.clientHeight)),
  );

  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    enumerable: true,
    get: () => currentScrollTop,
    set: (next: number) => {
      currentScrollTop = clampScrollTop(Number(next));
    },
  });
  currentScrollTop = clampScrollTop(initialScrollTop);

  return element as unknown as TestScrollElement;
}

function setScrollHeight(element: TestScrollElement, scrollHeight: number) {
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    writable: true,
    value: scrollHeight,
  });
}

function HookHost({
  element,
  restorationKey,
  restore = true,
  enabled = true,
}: HookHostProps) {
  const ref = useRef<HTMLElement | null>(element);
  ref.current = element;
  useElementScrollRestoration(ref, { key: restorationKey, restore, enabled });
  return null;
}

function HookHosts({ hosts }: { hosts: HookHostProps[] }) {
  return createElement(
    Fragment,
    null,
    hosts.map((host) => createElement(HookHost, { ...host, key: host.id })),
  );
}

class TestMutationObserver {
  private readonly callback: MutationCallback;
  private connected = false;

  constructor(callback: MutationCallback) {
    this.callback = callback;
  }

  observe() {
    this.connected = true;
  }

  disconnect() {
    this.connected = false;
  }

  trigger() {
    if (!this.connected) return;
    this.callback([{ addedNodes: [] } as unknown as MutationRecord], this as unknown as MutationObserver);
  }
}

function installTestMutationObserver() {
  const originalMutationObserver = globalThis.MutationObserver;
  const mutationObservers: TestMutationObserver[] = [];
  class InstalledTestMutationObserver extends TestMutationObserver {
    constructor(callback: MutationCallback) {
      super(callback);
      mutationObservers.push(this);
    }
  }

  Object.defineProperty(globalThis, "MutationObserver", {
    configurable: true,
    writable: true,
    value: InstalledTestMutationObserver as unknown as typeof MutationObserver,
  });

  return {
    mutationObservers,
    restore() {
      if (originalMutationObserver === undefined) {
        delete (globalThis as { MutationObserver?: typeof MutationObserver }).MutationObserver;
      } else {
        Object.defineProperty(globalThis, "MutationObserver", {
          configurable: true,
          writable: true,
          value: originalMutationObserver,
        });
      }
    },
  };
}

async function createHookRenderer() {
  const harness = await createReactDomHarness();

  return {
    act: harness.act,
    render(hosts: HookHostProps[]) {
      return harness.render(createElement(HookHosts, { hosts }));
    },
    cleanup() {
      return harness.cleanup();
    },
  };
}

type HookRenderer = Awaited<ReturnType<typeof createHookRenderer>>;

async function runPendingTimers(renderer: HookRenderer) {
  await renderer.act(async () => {
    await vi.runOnlyPendingTimersAsync();
  });
}

async function advanceTimers(renderer: HookRenderer, ms: number) {
  await renderer.act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("useElementScrollRestoration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("saves scroll positions from scroll events", async () => {
    const renderer = await createHookRenderer();
    const source = createScrollElement();
    const target = createScrollElement();
    const key = "hook-scroll-event-save";

    try {
      await renderer.render([{ id: "source", element: source, restorationKey: key }]);
      await runPendingTimers(renderer);

      source.scrollTop = 123;
      source.dispatchTestEvent("scroll");
      await runPendingTimers(renderer);

      await renderer.render([
        { id: "source", element: source, restorationKey: key },
        { id: "target", element: target, restorationKey: key },
      ]);

      expect(target.scrollTop).toBe(123);
    } finally {
      await renderer.cleanup();
    }
  });

  it("saves on unmount and restores on remount with the same key", async () => {
    const renderer = await createHookRenderer();
    const source = createScrollElement();
    const target = createScrollElement();
    const key = "hook-unmount-remount";

    try {
      await renderer.render([{ id: "source", element: source, restorationKey: key }]);
      await runPendingTimers(renderer);

      source.scrollTop = 86;
      await renderer.render([]);

      await renderer.render([{ id: "target", element: target, restorationKey: key }]);

      expect(target.scrollTop).toBe(86);
    } finally {
      await renderer.cleanup();
    }
  });

  it("saves the old key and restores the new key when the key changes while mounted", async () => {
    const renderer = await createHookRenderer();
    const seeded = createScrollElement();
    const element = createScrollElement();
    const firstKey = "hook-key-change-first";
    const secondKey = "hook-key-change-second";

    try {
      await renderer.render([{ id: "seed", element: seeded, restorationKey: secondKey }]);
      await runPendingTimers(renderer);
      seeded.scrollTop = 212;
      await renderer.render([]);

      await renderer.render([{ id: "main", element, restorationKey: firstKey }]);
      await runPendingTimers(renderer);

      element.scrollTop = 74;
      await renderer.render([{ id: "main", element, restorationKey: secondKey }]);
      expect(element.scrollTop).toBe(212);

      element.scrollTop = 31;
      await renderer.render([{ id: "main", element, restorationKey: firstKey }]);
      expect(element.scrollTop).toBe(74);
    } finally {
      await renderer.cleanup();
    }
  });

  it("resets to the top for fresh navigation when restore is false", async () => {
    const renderer = await createHookRenderer();
    const source = createScrollElement();
    const fresh = createScrollElement(999);
    const restored = createScrollElement(999);
    const key = "hook-fresh-navigation";

    try {
      await renderer.render([{ id: "source", element: source, restorationKey: key }]);
      await runPendingTimers(renderer);
      source.scrollTop = 168;
      await renderer.render([]);

      await renderer.render([{ id: "fresh", element: fresh, restorationKey: key, restore: false }]);
      expect(fresh.scrollTop).toBe(0);

      await renderer.render([]);
      await renderer.render([{ id: "restored", element: restored, restorationKey: key }]);
      expect(restored.scrollTop).toBe(0);
    } finally {
      await renderer.cleanup();
    }
  });

  it("preserves the saved position when restore times out before content is scrollable", async () => {
    const renderer = await createHookRenderer();
    const source = createScrollElement();
    const blocked = createScrollElement(0, { scrollHeight: 300, clientHeight: 300 });
    const restored = createScrollElement(0, { scrollHeight: 1_200, clientHeight: 300 });
    const key = "hook-failed-restore-preserves";

    try {
      await renderer.render([{ id: "source", element: source, restorationKey: key }]);
      source.scrollTop = 620;
      await renderer.render([]);

      await renderer.render([{ id: "blocked", element: blocked, restorationKey: key }]);
      expect(blocked.scrollTop).toBe(0);
      await advanceTimers(renderer, 1_001);
      blocked.dispatchTestEvent("scroll");
      await renderer.render([]);

      await renderer.render([{ id: "restored", element: restored, restorationKey: key }]);
      expect(restored.scrollTop).toBe(620);
    } finally {
      await renderer.cleanup();
    }
  });

  it("keeps restoring after programmatic scroll events during restoration", async () => {
    const mutationObserver = installTestMutationObserver();
    const renderer = await createHookRenderer();
    const source = createScrollElement();
    const target = createScrollElement(0, { scrollHeight: 300, clientHeight: 300 });
    const key = "hook-programmatic-scroll-during-restore";

    try {
      await renderer.render([{ id: "source", element: source, restorationKey: key }]);
      source.scrollTop = 540;
      await renderer.render([]);

      await renderer.render([{ id: "target", element: target, restorationKey: key }]);
      await advanceTimers(renderer, 0);
      expect(target.scrollTop).toBe(0);

      target.dispatchTestEvent("scroll");
      setScrollHeight(target, 1_000);
      mutationObserver.mutationObservers[0]!.trigger();
      await advanceTimers(renderer, 0);

      expect(target.scrollTop).toBe(540);
    } finally {
      await renderer.cleanup();
      mutationObserver.restore();
    }
  });

  it.each(["wheel", "touchstart", "pointerdown", "keydown"])(
    "cancels restoration on %s input and saves later scroll positions",
    async (eventType) => {
      const renderer = await createHookRenderer();
      const source = createScrollElement();
      const target = createScrollElement(0, { scrollHeight: 300, clientHeight: 300 });
      const restored = createScrollElement(0, { scrollHeight: 1_000, clientHeight: 300 });
      const key = `hook-user-cancel-${eventType}`;

      try {
        await renderer.render([{ id: "source", element: source, restorationKey: key }]);
        source.scrollTop = 620;
        await renderer.render([]);

        await renderer.render([{ id: "target", element: target, restorationKey: key }]);
        expect(target.scrollTop).toBe(0);

        target.dispatchTestEvent(eventType);
        setScrollHeight(target, 1_000);
        target.scrollTop = 97;
        target.dispatchTestEvent("scroll");
        await advanceTimers(renderer, 0);

        await renderer.render([]);
        await renderer.render([{ id: "restored", element: restored, restorationKey: key }]);

        expect(restored.scrollTop).toBe(97);
      } finally {
        await renderer.cleanup();
      }
    },
  );

  it("retries restoration when late content mutations make the element scrollable", async () => {
    const mutationObserver = installTestMutationObserver();
    const renderer = await createHookRenderer();
    const source = createScrollElement();
    const target = createScrollElement(0, { scrollHeight: 300, clientHeight: 300 });
    const key = "hook-late-content-restore";

    try {
      await renderer.render([{ id: "source", element: source, restorationKey: key }]);
      source.scrollTop = 540;
      await renderer.render([]);

      await renderer.render([{ id: "target", element: target, restorationKey: key }]);
      await advanceTimers(renderer, 0);
      expect(target.scrollTop).toBe(0);

      setScrollHeight(target, 1_000);
      mutationObserver.mutationObservers[0]!.trigger();
      await advanceTimers(renderer, 0);

      expect(target.scrollTop).toBe(540);
    } finally {
      await renderer.cleanup();
      mutationObserver.restore();
    }
  });
});
