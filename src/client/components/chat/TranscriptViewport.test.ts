import { createElement, createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReactDomHarness } from "../../test-react-harness";
import { ViewportKeeper } from "./TranscriptViewport";

/** Stands in for the browser's ResizeObserver. `notify(element)` reports that the element changed size. */
function stubResizeObserver() {
  const observers: Array<{ callback: () => void; elements: unknown[] }> = [];
  vi.stubGlobal("ResizeObserver", class {
    private readonly observer: { callback: () => void; elements: unknown[] };
    constructor(callback: () => void) {
      this.observer = { callback, elements: [] };
      observers.push(this.observer);
    }
    observe(element: unknown) { this.observer.elements.push(element); }
    disconnect() { this.observer.elements.length = 0; }
  });
  return {
    observed: () => observers.flatMap((observer) => observer.elements),
    notify: (element: unknown) => {
      for (const observer of observers) {
        if (observer.elements.includes(element)) observer.callback();
      }
    },
  };
}

/** A rect whose top follows the scroller, so tests can move content by changing its layout top. */
function placeInScroller(element: any, scroller: any, layoutTop: () => number, height: number) {
  element.getBoundingClientRect = () => {
    const top = layoutTop() - scroller.scrollTop;
    return { x: 0, y: top, width: 0, height, top, left: 0, right: 0, bottom: top + height, toJSON: () => ({}) };
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ViewportKeeper with content above the reader that changes height long after it rendered", () => {
  /**
   * Six rows of 150px, the reader at the top of the fifth, in a browser that does not anchor
   * scrolling. `grow` makes one row taller, as an image in it finishing loading would, which
   * pushes the rows after it down.
   */
  async function renderSixRows({ growingRow = 2, anchoring = false } = {}) {
    if (anchoring) vi.stubGlobal("CSS", { supports: () => true });
    const resizes = stubResizeObserver();
    const harness = await createReactDomHarness();
    const scrollerRef = createRef<HTMLDivElement>();
    const keeperRef = createRef<ViewportKeeper>();
    let atRest = true;
    const shift = vi.fn((scroller: HTMLElement, delta: number) => { scroller.scrollTop += delta; });
    const render = () => harness.render(createElement(
      "div",
      { ref: scrollerRef },
      createElement(ViewportKeeper, {
        ref: keeperRef,
        scrollerRef,
        shouldKeep: () => false,
        atRest: () => atRest,
        shift,
        children: [1, 2, 3, 4, 5, 6].map((index) => createElement("div", { key: index })),
      }),
    ));
    await render();

    const scroller = scrollerRef.current as any;
    Object.defineProperty(scroller, "scrollTop", { configurable: true, writable: true, value: 600 });
    const rows = scroller.childNodes[0];
    let grown = 0;
    rows.children.forEach((row: unknown, offset: number) => {
      const index = offset + 1;
      placeInScroller(row, scroller, () => (index - 1) * 150 + (index > growingRow ? grown : 0), 150);
    });

    return {
      scroller,
      rows,
      resizes,
      shift,
      cleanup: harness.cleanup,
      /** Rendering settles the view, as opening a chat does. */
      render,
      setAtRest: (value: boolean) => { atRest = value; },
      /** The row is taller, and the browser has not said so yet. */
      grow: (by: number) => { grown += by; },
      /** The browser reports that the rows changed size. */
      reportResize: () => harness.act(async () => resizes.notify(rows)),
      /** A scroll event arrives for where the view is now. */
      scrollEvent: () => harness.act(async () => keeperRef.current!.moved()),
    };
  }

  it("holds the row the reader is on when an image above it finishes loading", async () => {
    const view = await renderSixRows();

    try {
      await view.render();
      view.grow(463);
      await view.reportResize();
      expect(view.scroller.scrollTop).toBe(1063);

      // A second image, measured from where the first one left the view.
      view.grow(100);
      await view.reportResize();
      expect(view.scroller.scrollTop).toBe(1163);
    } finally {
      await view.cleanup();
    }
  });

  it("is not thrown off by a scroll event that did not move the view", async () => {
    const view = await renderSixRows();

    try {
      await view.render();
      view.grow(463);
      // The event for a move made from code arrives a frame late: this time after the image.
      await view.scrollEvent();
      await view.reportResize();
      expect(view.scroller.scrollTop).toBe(1063);
    } finally {
      await view.cleanup();
    }
  });

  it("does not take a move of the view for a change in height", async () => {
    const view = await renderSixRows();

    try {
      await view.render();
      // Following live output scrolls from code, and the scroll event for it is still on its way.
      view.scroller.scrollTop = 900;
      await view.reportResize();
      expect(view.scroller.scrollTop).toBe(900);
      expect(view.shift).not.toHaveBeenCalled();
    } finally {
      await view.cleanup();
    }
  });

  it("moves nothing while the reader is scrolling, and does not make up for it later", async () => {
    const view = await renderSixRows();

    try {
      await view.render();
      view.setAtRest(false);
      view.grow(463);
      await view.reportResize();
      expect(view.scroller.scrollTop).toBe(600);

      // They have seen the jump by now; moving the view again would be a second one.
      view.setAtRest(true);
      await view.reportResize();
      expect(view.scroller.scrollTop).toBe(600);
    } finally {
      await view.cleanup();
    }
  });

  it("holds it when the transcript renders again before the browser has reported the change", async () => {
    const view = await renderSixRows();

    try {
      await view.render();
      view.grow(463);
      // A streamed chunk, say. Settling after it would take the image's shift for granted.
      await view.render();
      expect(view.scroller.scrollTop).toBe(1063);
    } finally {
      await view.cleanup();
    }
  });

  it("does not follow something that grows in view", async () => {
    // The fifth row is the one at the top of the view: opening something in it pushes the sixth down.
    const view = await renderSixRows({ growingRow: 5 });

    try {
      await view.render();
      view.grow(300);
      await view.reportResize();
      expect(view.scroller.scrollTop).toBe(600);
    } finally {
      await view.cleanup();
    }
  });

  it("leaves it to a browser that anchors scrolling itself", async () => {
    const view = await renderSixRows({ anchoring: true });

    try {
      await view.render();
      expect(view.resizes.observed()).not.toContain(view.rows);
      view.grow(463);
      await view.reportResize();
      expect(view.scroller.scrollTop).toBe(600);
    } finally {
      await view.cleanup();
    }
  });
});
