import { describe, expect, it } from "vitest";

import type { BrowserLiveMouseMessage } from "../../shared/browser-live.js";
import {
  createMouseSender,
  createTouchMouse,
  MOUSE_MOVE_INTERVAL_MS,
  TOUCH_PRESS_DELAY_MS,
  type LiveTouch,
} from "./mouse-input";
import { createManualTimers } from "./test-live-fakes";

function setup() {
  const clock = createManualTimers();
  const sent: BrowserLiveMouseMessage[] = [];
  const scrolls: Array<{ deltaX: number; deltaY: number; at: { x: number; y: number } }> = [];
  const mouse = createMouseSender((message) => sent.push(message), clock.timers);
  const touch = createTouchMouse(mouse, (deltaX, deltaY, at) => scrolls.push({ deltaX, deltaY, at }), clock.timers);
  const events = () => sent.map((message) => message.eventType);
  return { clock, sent, scrolls, mouse, touch, events };
}

/** A finger whose screen position is half its page position, as on a page drawn at half size. */
function finger(id: number, pageX: number, pageY: number): LiveTouch {
  return { id, clientX: pageX / 2, clientY: pageY / 2, page: { x: pageX, y: pageY } };
}

describe("createMouseSender", () => {
  it("sends the first move at once and holds later ones to about 30 a second", () => {
    const { clock, sent, mouse } = setup();
    mouse.move({ x: 1, y: 1 }, "none");
    mouse.move({ x: 2, y: 2 }, "none");
    mouse.move({ x: 3, y: 3 }, "none");
    expect(sent).toEqual([{ type: "input_mouse", eventType: "mouseMoved", x: 1, y: 1, button: "none" }]);

    clock.advance(MOUSE_MOVE_INTERVAL_MS);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ eventType: "mouseMoved", x: 3, y: 3 });
    expect(clock.pending()).toBe(0);
  });

  it("presses and releases with the button, a click count and the modifiers", () => {
    const { sent, mouse } = setup();
    const clickCount = mouse.press({ x: 10, y: 20 }, "right", 2);
    mouse.release({ x: 10, y: 20 }, "right", clickCount, 2);
    expect(sent).toEqual([
      { type: "input_mouse", eventType: "mousePressed", x: 10, y: 20, button: "right", clickCount: 1, modifiers: 2 },
      { type: "input_mouse", eventType: "mouseReleased", x: 10, y: 20, button: "right", clickCount: 1, modifiers: 2 },
    ]);
  });

  it("counts a quick second press in the same place as a double click", () => {
    const { clock, mouse } = setup();
    expect(mouse.press({ x: 100, y: 100 }, "left")).toBe(1);
    clock.advance(200);
    expect(mouse.press({ x: 102, y: 101 }, "left")).toBe(2);
    clock.advance(200);
    expect(mouse.press({ x: 102, y: 101 }, "left")).toBe(1);
  });

  it("does not count a slow or distant second press as a double click", () => {
    const { clock, mouse } = setup();
    mouse.press({ x: 100, y: 100 }, "left");
    clock.advance(900);
    expect(mouse.press({ x: 100, y: 100 }, "left")).toBe(1);
    clock.advance(100);
    expect(mouse.press({ x: 300, y: 100 }, "left")).toBe(1);
  });

  it("delivers the last step of a drag before the release", () => {
    const { events, sent, mouse } = setup();
    mouse.press({ x: 0, y: 0 }, "left");
    mouse.move({ x: 5, y: 0 }, "left");
    mouse.move({ x: 50, y: 0 }, "left");
    mouse.release({ x: 50, y: 0 }, "left", 1);
    expect(events()).toEqual(["mousePressed", "mouseMoved", "mouseMoved", "mouseReleased"]);
    expect(sent[2]).toMatchObject({ x: 50, button: "left" });
  });

  it("adds up wheel turns between sends", () => {
    const { clock, sent, mouse } = setup();
    mouse.wheel({ x: 5, y: 5 }, 0, 10);
    mouse.wheel({ x: 5, y: 5 }, 0, 20.4);
    mouse.wheel({ x: 6, y: 6 }, -3, 20.4);
    expect(sent).toEqual([{ type: "input_mouse", eventType: "mouseWheel", x: 5, y: 5, deltaX: 0, deltaY: 10 }]);
    clock.advance(MOUSE_MOVE_INTERVAL_MS);
    expect(sent[1]).toEqual({ type: "input_mouse", eventType: "mouseWheel", x: 6, y: 6, deltaX: -3, deltaY: 41 });
  });

  it("keeps the fraction of a pixel a slow scroll leaves over", () => {
    const { clock, sent, mouse } = setup();
    for (let step = 0; step < 100; step += 1) {
      mouse.wheel({ x: 5, y: 5 }, 0, 0.4);
      clock.advance(50);
    }
    const total = sent.reduce((sum, message) => sum + (message.deltaY ?? 0), 0);
    expect(total).toBe(40);
    expect(sent.every((message) => Number.isInteger(message.deltaY) && message.deltaY !== 0)).toBe(true);
  });

  it("drops what is waiting when disposed", () => {
    const { clock, sent, mouse } = setup();
    mouse.move({ x: 1, y: 1 }, "none");
    mouse.move({ x: 2, y: 2 }, "none");
    mouse.wheel({ x: 1, y: 1 }, 0, 10);
    mouse.wheel({ x: 1, y: 1 }, 0, 10);
    mouse.dispose();
    clock.advance(1000);
    expect(sent).toHaveLength(2);
    expect(clock.pending()).toBe(0);
  });
});

describe("createTouchMouse", () => {
  it("turns a tap into a click where the finger landed", () => {
    const { events, sent, touch, clock } = setup();
    touch.down(finger(1, 200, 300));
    clock.advance(40);
    touch.up(finger(1, 202, 301));
    expect(events()).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
    expect(sent[1]).toMatchObject({ x: 200, y: 300, button: "left", clickCount: 1 });
    expect(sent[2]).toMatchObject({ x: 200, y: 300, button: "left", clickCount: 1 });
    expect(clock.pending()).toBe(0);
  });

  it("holds the button down for a finger that rests, until it lifts", () => {
    const { events, touch, clock } = setup();
    touch.down(finger(1, 200, 300));
    clock.advance(TOUCH_PRESS_DELAY_MS);
    expect(events()).toEqual(["mouseMoved", "mousePressed"]);
    clock.advance(3000);
    expect(events()).toEqual(["mouseMoved", "mousePressed"]);
    touch.up(finger(1, 200, 300));
    expect(events()).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
  });

  it("drags with the left button held, pressed where the finger landed and released where it lifts", () => {
    const { events, sent, touch, clock } = setup();
    touch.down(finger(1, 100, 100));
    clock.advance(60);
    touch.move(finger(1, 160, 100));
    expect(events()).toEqual(["mouseMoved"]);

    clock.advance(TOUCH_PRESS_DELAY_MS - 60);
    expect(events()).toEqual(["mouseMoved", "mousePressed", "mouseMoved"]);
    expect(sent[1]).toMatchObject({ x: 100, y: 100 });
    expect(sent[2]).toMatchObject({ x: 160, button: "left" });

    clock.advance(MOUSE_MOVE_INTERVAL_MS);
    touch.move(finger(1, 300, 100));
    touch.up(finger(1, 400, 100));
    expect(events()).toEqual(["mouseMoved", "mousePressed", "mouseMoved", "mouseMoved", "mouseReleased"]);
    expect(sent[3]).toMatchObject({ x: 300, button: "left" });
    expect(sent[4]).toMatchObject({ x: 400, y: 100 });
  });

  it("turns a quick flick into a short drag", () => {
    const { events, sent, touch, clock } = setup();
    touch.down(finger(1, 100, 100));
    clock.advance(40);
    touch.move(finger(1, 180, 100));
    clock.advance(40);
    touch.up(finger(1, 260, 100));
    expect(events()).toEqual(["mouseMoved", "mousePressed", "mouseMoved", "mouseReleased"]);
    expect(sent[1]).toMatchObject({ x: 100, y: 100 });
    expect(sent[2]).toMatchObject({ x: 260, button: "left" });
    expect(sent[3]).toMatchObject({ x: 260, y: 100 });
    expect(clock.pending()).toBe(0);
  });

  it("does not click when the first finger of a two-finger swipe is already moving", () => {
    const { events, scrolls, touch, clock } = setup();
    touch.down(finger(1, 200, 800));
    clock.advance(16);
    touch.move(finger(1, 200, 770));
    clock.advance(4);
    touch.down(finger(2, 300, 800));
    touch.move(finger(1, 200, 700));
    touch.move(finger(2, 300, 730));
    clock.advance(1000);
    touch.up(finger(1, 200, 700));
    touch.up(finger(2, 300, 730));
    expect(events()).toEqual(["mouseMoved"]);
    expect(scrolls.length).toBeGreaterThan(0);
  });

  it("scrolls with two fingers without clicking anything", () => {
    const { events, scrolls, touch, clock } = setup();
    touch.down(finger(1, 200, 400));
    clock.advance(30);
    touch.down(finger(2, 300, 400));
    touch.move(finger(1, 200, 340));
    touch.move(finger(2, 300, 340));
    clock.advance(1000);
    touch.up(finger(1, 200, 340));
    touch.move(finger(2, 300, 100));
    touch.up(finger(2, 300, 100));

    expect(events()).toEqual(["mouseMoved"]);
    // Screen distance, which is half the page distance in this setup: 15 for each finger's 30.
    expect(scrolls.map((scroll) => scroll.deltaY)).toEqual([-15, -15]);
    expect(scrolls[1].at).toEqual({ x: 250, y: 340 });
    expect(clock.pending()).toBe(0);
  });

  // A second finger that lands after the wait finds the button already down. Letting go of it is
  // the only way to stop the page dragging, even though the page sees that as a click.
  it("ends a press that already started before a second finger scrolls", () => {
    const { events, scrolls, touch, clock } = setup();
    touch.down(finger(1, 200, 400));
    clock.advance(TOUCH_PRESS_DELAY_MS);
    touch.down(finger(2, 300, 400));
    touch.move(finger(2, 300, 300));
    touch.up(finger(2, 300, 300));
    touch.up(finger(1, 200, 400));
    expect(events()).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
    expect(scrolls).toHaveLength(1);
  });

  it("releases a held press when the touch is cancelled or the view goes away", () => {
    const cancelled = setup();
    cancelled.touch.down(finger(1, 10, 10));
    cancelled.clock.advance(TOUCH_PRESS_DELAY_MS);
    cancelled.touch.cancel(1);
    expect(cancelled.events()).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);

    const disposed = setup();
    disposed.touch.down(finger(1, 10, 10));
    disposed.clock.advance(TOUCH_PRESS_DELAY_MS);
    disposed.touch.dispose();
    expect(disposed.events()).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);

    const neverPressed = setup();
    neverPressed.touch.down(finger(1, 10, 10));
    neverPressed.touch.cancel(1);
    neverPressed.clock.advance(1000);
    expect(neverPressed.events()).toEqual(["mouseMoved"]);
  });

  it("counts two quick taps as a double click", () => {
    const { sent, touch, clock } = setup();
    touch.down(finger(1, 200, 300));
    touch.up(finger(1, 200, 300));
    clock.advance(150);
    touch.down(finger(1, 204, 298));
    touch.up(finger(1, 204, 298));
    const presses = sent.filter((message) => message.eventType === "mousePressed");
    const releases = sent.filter((message) => message.eventType === "mouseReleased");
    expect(presses.map((message) => message.clickCount)).toEqual([1, 2]);
    expect(releases.map((message) => message.clickCount)).toEqual([1, 2]);
  });
});
