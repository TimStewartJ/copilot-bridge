import type { BrowserLiveMouseMessage } from "../../shared/browser-live.js";
import type { LivePoint } from "./live-input";

/**
 * Turns pointer activity into the remote page's mouse events. The remote page is a desktop page,
 * so a finger is a mouse too: one finger moves, presses and releases; two fingers scroll.
 */

export type LiveMouseButton = NonNullable<BrowserLiveMouseMessage["button"]>;

export interface LiveTimers {
  now: () => number;
  setTimeout: (callback: () => void, delayMs: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export const systemTimers: LiveTimers = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

/** About 30 a second: enough for a drag to feel direct without flooding the socket. */
export const MOUSE_MOVE_INTERVAL_MS = 33;
const DOUBLE_CLICK_MS = 500;
const DOUBLE_CLICK_DISTANCE = 24;

export interface LiveMouseSender {
  move(point: LivePoint, button: LiveMouseButton, modifiers?: number): void;
  /** Returns the click count sent, so the matching release can repeat it. */
  press(point: LivePoint, button: LiveMouseButton, modifiers?: number): number;
  release(point: LivePoint, button: LiveMouseButton, clickCount: number, modifiers?: number): void;
  /** Distances add up between sends. Whole pixels are sent; the fraction left over is kept for the next send. */
  wheel(point: LivePoint, deltaX: number, deltaY: number, modifiers?: number): void;
  dispose(): void;
}

function withModifiers(message: BrowserLiveMouseMessage, modifiers: number | undefined): BrowserLiveMouseMessage {
  return modifiers ? { ...message, modifiers } : message;
}

/**
 * Sends mouse events, holding moves and wheel turns to a steady rate. The latest position and the
 * summed wheel distance are always delivered; only the steps in between are skipped.
 */
export function createMouseSender(
  send: (message: BrowserLiveMouseMessage) => void,
  timers: LiveTimers = systemTimers,
): LiveMouseSender {
  let lastMoveAt = -Infinity;
  let pendingMove: BrowserLiveMouseMessage | null = null;
  let moveTimer: unknown = null;
  let lastWheelAt = -Infinity;
  let pendingWheel: { point: LivePoint; deltaX: number; deltaY: number; modifiers?: number } | null = null;
  let wheelTimer: unknown = null;
  let lastPress: { at: number; point: LivePoint; button: LiveMouseButton; count: number } | null = null;

  const flushMove = () => {
    if (moveTimer !== null) timers.clearTimeout(moveTimer);
    moveTimer = null;
    if (!pendingMove) return;
    const message = pendingMove;
    pendingMove = null;
    lastMoveAt = timers.now();
    send(message);
  };
  const dropMove = () => {
    if (moveTimer !== null) timers.clearTimeout(moveTimer);
    moveTimer = null;
    pendingMove = null;
  };
  const flushWheel = () => {
    if (wheelTimer !== null) timers.clearTimeout(wheelTimer);
    wheelTimer = null;
    if (!pendingWheel) return;
    const { point, modifiers } = pendingWheel;
    const deltaX = Math.round(pendingWheel.deltaX);
    const deltaY = Math.round(pendingWheel.deltaY);
    // Less than a pixel stays waiting and adds to the next turn, so a slow scroll still moves.
    if (!deltaX && !deltaY) return;
    const restX = pendingWheel.deltaX - deltaX;
    const restY = pendingWheel.deltaY - deltaY;
    pendingWheel = restX || restY ? { point, deltaX: restX, deltaY: restY, modifiers } : null;
    lastWheelAt = timers.now();
    send(withModifiers({ type: "input_mouse", eventType: "mouseWheel", x: point.x, y: point.y, deltaX, deltaY }, modifiers));
  };

  return {
    move(point, button, modifiers) {
      pendingMove = withModifiers({ type: "input_mouse", eventType: "mouseMoved", x: point.x, y: point.y, button }, modifiers);
      const wait = lastMoveAt + MOUSE_MOVE_INTERVAL_MS - timers.now();
      if (wait <= 0) flushMove();
      else if (moveTimer === null) moveTimer = timers.setTimeout(flushMove, wait);
    },
    press(point, button, modifiers) {
      // A press carries its own position, so a move still waiting would only arrive late.
      dropMove();
      const now = timers.now();
      const repeats = lastPress !== null
        && lastPress.button === button
        && lastPress.count < 2
        && now - lastPress.at <= DOUBLE_CLICK_MS
        && Math.hypot(point.x - lastPress.point.x, point.y - lastPress.point.y) <= DOUBLE_CLICK_DISTANCE;
      const clickCount = repeats ? 2 : 1;
      lastPress = { at: now, point, button, count: clickCount };
      send(withModifiers({ type: "input_mouse", eventType: "mousePressed", x: point.x, y: point.y, button, clickCount }, modifiers));
      return clickCount;
    },
    release(point, button, clickCount, modifiers) {
      // The last step of a drag decides where the thing lands, so it goes out before the release.
      flushMove();
      send(withModifiers({ type: "input_mouse", eventType: "mouseReleased", x: point.x, y: point.y, button, clickCount }, modifiers));
    },
    wheel(point, deltaX, deltaY, modifiers) {
      if (!deltaX && !deltaY) return;
      pendingWheel = {
        point,
        deltaX: (pendingWheel?.deltaX ?? 0) + deltaX,
        deltaY: (pendingWheel?.deltaY ?? 0) + deltaY,
        modifiers,
      };
      const wait = lastWheelAt + MOUSE_MOVE_INTERVAL_MS - timers.now();
      if (wait <= 0) flushWheel();
      else if (wheelTimer === null) wheelTimer = timers.setTimeout(flushWheel, wait);
    },
    dispose() {
      dropMove();
      if (wheelTimer !== null) timers.clearTimeout(wheelTimer);
      wheelTimer = null;
      pendingWheel = null;
    },
  };
}

/** A finger on the live image: where it is on screen, and where that is on the remote page. */
export interface LiveTouch {
  id: number;
  clientX: number;
  clientY: number;
  page: LivePoint;
}

/**
 * How long a finger is down before it counts as a press. The wait is what lets a second finger
 * turn the gesture into a scroll without first clicking whatever the first finger landed on, and
 * moving does not shorten it: the first finger of a two-finger swipe is often already moving.
 */
export const TOUCH_PRESS_DELAY_MS = 120;
/** How far a finger moves, in screen pixels, before a touch shorter than the wait is a drag, not a tap. */
export const TOUCH_DRAG_SLOP_PX = 8;

export interface TouchMouse {
  down(touch: LiveTouch): void;
  move(touch: LiveTouch): void;
  up(touch: LiveTouch): void;
  cancel(id: number): void;
  dispose(): void;
}

/**
 * Reads touches as mouse input:
 * - A tap is a click where the finger landed.
 * - A finger that stays down holds the left button, pressed where it landed, until it lifts. That
 *   is what sliders, drag puzzles and press-and-hold checks need.
 * - Two fingers scroll. `onScroll` gets how far they moved on screen and where on the page.
 */
export function createTouchMouse(
  mouse: LiveMouseSender,
  onScroll: (deltaClientX: number, deltaClientY: number, at: LivePoint) => void,
  timers: LiveTimers = systemTimers,
): TouchMouse {
  type Mode = "idle" | "resting" | "pressed" | "scrolling" | "spent";
  const touches = new Map<number, LiveTouch>();
  let mode: Mode = "idle";
  let primaryId: number | null = null;
  let origin: LiveTouch | null = null;
  /** Where the first finger is now, while it waits to become a press. */
  let resting: LiveTouch | null = null;
  let last: LivePoint = { x: 0, y: 0 };
  let clickCount = 1;
  let pressTimer: unknown = null;
  let scrollAnchor: { x: number; y: number } | null = null;

  const clearPressTimer = () => {
    if (pressTimer !== null) timers.clearTimeout(pressTimer);
    pressTimer = null;
  };
  const press = (at: LivePoint) => {
    clearPressTimer();
    clickCount = mouse.press(at, "left");
    last = at;
    mode = "pressed";
  };
  const release = () => {
    mouse.release(last, "left", clickCount);
  };
  /** The wait is over: press where the finger landed, then catch up with where it is now. */
  const pressAfterWait = () => {
    if (!origin) return;
    const from = origin;
    const now = resting ?? from;
    press(from.page);
    if (now.page.x !== from.page.x || now.page.y !== from.page.y) {
      last = now.page;
      mouse.move(now.page, "left");
    }
  };
  const movedPastSlop = (touch: LiveTouch) => origin !== null
    && Math.hypot(touch.clientX - origin.clientX, touch.clientY - origin.clientY) >= TOUCH_DRAG_SLOP_PX;
  const centre = (): { x: number; y: number; page: LivePoint } | null => {
    const [first, second] = [...touches.values()];
    if (!first || !second) return null;
    return {
      x: (first.clientX + second.clientX) / 2,
      y: (first.clientY + second.clientY) / 2,
      page: {
        x: Math.round((first.page.x + second.page.x) / 2),
        y: Math.round((first.page.y + second.page.y) / 2),
      },
    };
  };
  const settle = () => {
    if (touches.size === 0) {
      mode = "idle";
      primaryId = null;
      origin = null;
      resting = null;
      scrollAnchor = null;
    }
  };

  return {
    down(touch) {
      touches.set(touch.id, touch);
      if (touches.size === 1) {
        mode = "resting";
        primaryId = touch.id;
        origin = touch;
        resting = touch;
        last = touch.page;
        mouse.move(touch.page, "none");
        pressTimer = timers.setTimeout(() => {
          pressTimer = null;
          if (mode === "resting") pressAfterWait();
        }, TOUCH_PRESS_DELAY_MS);
        return;
      }
      if (touches.size === 2 && mode !== "spent") {
        clearPressTimer();
        // A press already sent has to end before the scroll starts, or the page keeps dragging.
        if (mode === "pressed") release();
        mode = "scrolling";
        const middle = centre();
        scrollAnchor = middle && { x: middle.x, y: middle.y };
      }
    },
    move(touch) {
      if (!touches.has(touch.id)) return;
      touches.set(touch.id, touch);
      if (mode === "scrolling") {
        const middle = centre();
        if (!middle || !scrollAnchor) return;
        const deltaX = middle.x - scrollAnchor.x;
        const deltaY = middle.y - scrollAnchor.y;
        scrollAnchor = { x: middle.x, y: middle.y };
        if (deltaX || deltaY) onScroll(deltaX, deltaY, middle.page);
        return;
      }
      if (touch.id !== primaryId) return;
      if (mode === "resting") {
        resting = touch;
        return;
      }
      if (mode === "pressed") {
        last = touch.page;
        mouse.move(touch.page, "left");
      }
    },
    up(touch) {
      if (!touches.delete(touch.id)) return;
      if (touch.id === primaryId) {
        if (mode === "resting" && origin) {
          // Lifted before the wait ended: a flick is a short drag, anything else a tap where it landed.
          if (movedPastSlop(touch)) {
            resting = touch;
            pressAfterWait();
          } else {
            press(origin.page);
          }
          release();
        } else if (mode === "pressed") {
          last = touch.page;
          release();
        }
      }
      // A finger left over from a scroll does nothing until every finger has lifted.
      if (touches.size > 0) mode = "spent";
      clearPressTimer();
      settle();
    },
    cancel(id) {
      if (!touches.delete(id)) return;
      clearPressTimer();
      if (id === primaryId && mode === "pressed") release();
      if (touches.size > 0) mode = "spent";
      settle();
    },
    dispose() {
      clearPressTimer();
      if (mode === "pressed") release();
      touches.clear();
      mode = "idle";
      primaryId = null;
      origin = null;
      resting = null;
      scrollAnchor = null;
    },
  };
}
