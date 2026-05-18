import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installDomShim } from "../test-dom-shim";
import { createReactDomHarness } from "../test-react-harness";
import PullToRefresh from "./PullToRefresh";

type TestElement = HTMLElement & {
  dispatchTestEvent: (type: string) => void;
};

function makeEventfulElement(element: HTMLElement): TestElement {
  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  const testElement = element as TestElement;

  Object.defineProperties(testElement, {
    scrollTop: { configurable: true, writable: true, value: 0 },
    scrollHeight: { configurable: true, writable: true, value: 1_000 },
    clientHeight: { configurable: true, writable: true, value: 300 },
  });

  testElement.addEventListener = (type: string, listener: EventListenerOrEventListenerObject | null) => {
    if (!listener) return;
    const listenersForType = listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>();
    listenersForType.add(listener);
    listeners.set(type, listenersForType);
  };
  testElement.removeEventListener = (type: string, listener: EventListenerOrEventListenerObject | null) => {
    if (!listener) return;
    listeners.get(type)?.delete(listener);
  };
  testElement.dispatchTestEvent = (type) => {
    const event = { type, target: testElement, currentTarget: testElement } as unknown as Event;
    for (const listener of listeners.get(type) ?? []) {
      if (typeof listener === "function") {
        listener.call(testElement, event);
      } else {
        listener.handleEvent(event);
      }
    }
  };

  return testElement;
}

function installEventfulDomShim() {
  const dom = installDomShim();
  const originalCreateElement = document.createElement.bind(document);
  const originalCreateElementNS = document.createElementNS.bind(document);

  document.createElement = ((tagName: string) => (
    makeEventfulElement(originalCreateElement(tagName) as unknown as HTMLElement)
  )) as typeof document.createElement;

  document.createElementNS = ((namespaceURI: string, qualifiedName: string) => (
    makeEventfulElement(originalCreateElementNS(namespaceURI, qualifiedName) as unknown as HTMLElement)
  )) as typeof document.createElementNS;

  return dom;
}

describe("PullToRefresh scroll restoration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("does not clobber a saved scroll position on initial mount", async () => {
    const harness = await createReactDomHarness({ installDom: installEventfulDomShim });
    const { dom } = harness;
    const key = "pull-to-refresh-preserves-restoration";
    const renderPullToRefresh = () => {
      return harness.render(createElement(PullToRefresh, {
        onRefresh: async () => {},
        scrollRestoration: { key },
        children: createElement("div", null, "content"),
      }));
    };

    try {
      await renderPullToRefresh();
      await harness.act(async () => {
        await vi.runOnlyPendingTimersAsync();
      });

      const firstContainer = dom.container.firstChild as unknown as TestElement;
      firstContainer.scrollTop = 188;
      firstContainer.dispatchTestEvent("scroll");
      await harness.act(async () => {
        await vi.runOnlyPendingTimersAsync();
      });

      await harness.render(null);

      await renderPullToRefresh();

      const restoredContainer = dom.container.firstChild as unknown as TestElement;
      expect(restoredContainer).not.toBe(firstContainer);
      expect(restoredContainer.scrollTop).toBe(188);
    } finally {
      await harness.cleanup();
    }
  });
});
