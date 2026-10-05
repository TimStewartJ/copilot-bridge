import { describe, expect, it } from "vitest";

import { API_BASE } from "../api";
import { BROWSER_LIVE_MODIFIERS } from "../../shared/browser-live.js";
import {
  addressToUrl,
  buildBrowserLiveWebSocketUrl,
  chainScroll,
  fitDisplaySize,
  keyDownMessages,
  keyModifiers,
  keyUpMessages,
  namedKeyMessages,
  pointerToViewport,
  routeKey,
  textMessages,
  wheelDelta,
  type LiveKeyEvent,
} from "./live-input";

function key(overrides: Partial<LiveKeyEvent> & Pick<LiveKeyEvent, "key">): LiveKeyEvent {
  return {
    code: "",
    keyCode: 0,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...overrides,
  };
}

describe("buildBrowserLiveWebSocketUrl", () => {
  it("builds a socket address under the API base with the ticket in the query", () => {
    const url = buildBrowserLiveWebSocketUrl(
      { browserSessionId: "bs_ab12cd34", token: "t/k+n" },
      { protocol: "https:", host: "bridge.example:8443" },
    );
    expect(url).toBe(`wss://bridge.example:8443${API_BASE}/api/browser/live/ws?browserSessionId=bs_ab12cd34&token=t%2Fk%2Bn`);
  });

  it("uses an unencrypted socket on an unencrypted page", () => {
    const url = buildBrowserLiveWebSocketUrl(
      { browserSessionId: "bs_1", token: "t" },
      { protocol: "http:", host: "localhost:3000" },
    );
    expect(url.startsWith("ws://localhost:3000")).toBe(true);
  });
});

describe("addressToUrl", () => {
  it.each([
    ["example.com", "https://example.com/"],
    ["  example.com/login?next=1  ", "https://example.com/login?next=1"],
    ["http://x.test/a", "http://x.test/a"],
    // A host on this machine or network is rarely served over https.
    ["localhost:3000", "http://localhost:3000/"],
    ["192.168.1.5/x", "http://192.168.1.5/x"],
  ])("reads %j as %s", (typed, url) => {
    expect(addressToUrl(typed)).toBe(url);
  });

  it.each([
    "",
    "   ",
    "two words",
    "javascript:alert(1)",
    "about:blank",
    // Another kind of address is not a host to put https:// in front of.
    "file:///etc/passwd",
    "file:/etc/passwd",
    "chrome://settings",
    "mailto:someone@example.com",
    "C:\\Users\\me",
  ])("finds no web address in %j", (typed) => {
    expect(addressToUrl(typed)).toBeNull();
  });
});

describe("pointerToViewport", () => {
  const viewport = { width: 945, height: 917 };
  // The JPEG is 742 wide for this page, and here it is drawn 371 wide: neither is the page's size.
  const box = { left: 10, top: 100, width: 371, height: 360 };

  it("scales a position inside the image to the page's CSS pixels", () => {
    expect(pointerToViewport(10 + 371 / 2, 100 + 360 / 2, box, viewport)).toEqual({ x: 473, y: 459 });
    expect(pointerToViewport(10 + 37.1, 100 + 36, box, viewport)).toEqual({ x: 95, y: 92 });
  });

  it("keeps a position outside the image on the page's edge", () => {
    expect(pointerToViewport(0, 0, box, viewport)).toEqual({ x: 0, y: 0 });
    expect(pointerToViewport(5000, 5000, box, viewport)).toEqual({ x: 944, y: 916 });
  });

  it("has no answer while the image has no size", () => {
    expect(pointerToViewport(50, 50, { left: 0, top: 0, width: 0, height: 0 }, viewport)).toBeNull();
  });
});

describe("fitDisplaySize", () => {
  const viewport = { width: 945, height: 917 };

  it("fits the page to a phone's width", () => {
    expect(fitDisplaySize({ width: 390, height: 600 }, viewport, 1)).toEqual({ width: 390, height: 378 });
  });

  it("fits the page to the height when that is the tighter side", () => {
    expect(fitDisplaySize({ width: 1600, height: 458.5 }, viewport, 1)).toEqual({ width: 472, height: 458 });
  });

  it("never draws the page larger than it is at zoom 1", () => {
    expect(fitDisplaySize({ width: 2000, height: 2000 }, viewport, 1)).toEqual({ width: 945, height: 917 });
  });

  it("multiplies the fitted size when zoomed", () => {
    expect(fitDisplaySize({ width: 390, height: 600 }, viewport, 2)).toEqual({ width: 780, height: 756 });
  });

  it("has no answer until the stage has been measured", () => {
    expect(fitDisplaySize({ width: 0, height: 0 }, viewport, 1)).toBeNull();
  });
});

describe("chainScroll", () => {
  it("takes what the local view can scroll and passes the rest on", () => {
    expect(chainScroll(0, 100, 40)).toEqual({ position: 40, rest: 0 });
    expect(chainScroll(80, 100, 40)).toEqual({ position: 100, rest: 20 });
    expect(chainScroll(10, 100, -40)).toEqual({ position: 0, rest: -30 });
  });

  it("passes everything on when the view cannot scroll", () => {
    expect(chainScroll(0, 0, 55)).toEqual({ position: 0, rest: 55 });
    expect(chainScroll(0, -3, -55)).toEqual({ position: 0, rest: -55 });
  });
});

describe("wheelDelta", () => {
  const page = { width: 945, height: 917 };

  it("passes pixel deltas through, rounded", () => {
    expect(wheelDelta({ deltaX: 0, deltaY: 100.4, deltaMode: 0 }, page)).toEqual({ deltaX: 0, deltaY: 100 });
  });

  it("turns lines and pages into pixels", () => {
    expect(wheelDelta({ deltaX: 0, deltaY: 3, deltaMode: 1 }, page)).toEqual({ deltaX: 0, deltaY: 120 });
    expect(wheelDelta({ deltaX: 0, deltaY: -1, deltaMode: 2 }, page)).toEqual({ deltaX: 0, deltaY: -917 });
  });

  it("limits a runaway delta", () => {
    expect(wheelDelta({ deltaX: -99999, deltaY: 99999, deltaMode: 0 }, page)).toEqual({ deltaX: -2000, deltaY: 2000 });
  });
});

describe("keyboard mapping", () => {
  it("combines modifier bits as the protocol defines them", () => {
    expect(keyModifiers({ altKey: true, ctrlKey: true, metaKey: true, shiftKey: true })).toBe(15);
    expect(keyModifiers({ altKey: false, ctrlKey: true, metaKey: false, shiftKey: true }))
      .toBe(BROWSER_LIVE_MODIFIERS.ctrl | BROWSER_LIVE_MODIFIERS.shift);
  });

  it("sends a letter as a key press that types it", () => {
    const event = key({ key: "a", code: "KeyA", keyCode: 65 });
    expect(keyDownMessages(event)).toEqual([
      { type: "input_keyboard", eventType: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, text: "a" },
    ]);
    expect(keyUpMessages(event)).toEqual([
      { type: "input_keyboard", eventType: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65 },
    ]);
  });

  it("keeps Shift on a capital letter", () => {
    expect(keyDownMessages(key({ key: "A", code: "KeyA", keyCode: 65, shiftKey: true }))).toEqual([
      { type: "input_keyboard", eventType: "keyDown", key: "A", code: "KeyA", windowsVirtualKeyCode: 65, text: "A", modifiers: 8 },
    ]);
  });

  it("sends Backspace and arrows with their key code and no text", () => {
    expect(keyDownMessages(key({ key: "Backspace", code: "Backspace", keyCode: 8 }))).toEqual([
      { type: "input_keyboard", eventType: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
    ]);
    expect(keyDownMessages(key({ key: "ArrowLeft", code: "ArrowLeft", keyCode: 37, shiftKey: true }))).toEqual([
      { type: "input_keyboard", eventType: "keyDown", key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37, modifiers: 8 },
    ]);
  });

  it("sends Enter with a carriage return so forms submit", () => {
    expect(keyDownMessages(key({ key: "Enter", code: "Enter", keyCode: 13 }))[0]).toMatchObject({
      eventType: "keyDown",
      windowsVirtualKeyCode: 13,
      text: "\r",
    });
  });

  it("sends a shortcut as a key press with its modifiers and no text", () => {
    expect(keyDownMessages(key({ key: "a", code: "KeyA", keyCode: 65, ctrlKey: true }))).toEqual([
      { type: "input_keyboard", eventType: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 },
    ]);
    expect(keyDownMessages(key({ key: "f", code: "KeyF", keyCode: 70, altKey: true }))).toEqual([
      { type: "input_keyboard", eventType: "keyDown", key: "f", code: "KeyF", windowsVirtualKeyCode: 70, modifiers: 1 },
    ]);
  });

  it("types the character AltGr or Option selects, without the keys that selected it", () => {
    expect(keyDownMessages(key({ key: "@", code: "KeyQ", keyCode: 81, ctrlKey: true, altKey: true, altGraph: true }))).toEqual([
      { type: "input_keyboard", eventType: "keyDown", key: "@", code: "KeyQ", windowsVirtualKeyCode: 81, text: "@" },
    ]);
    expect(keyDownMessages(key({ key: "å", code: "KeyA", keyCode: 65, altKey: true }))[0]).toMatchObject({ text: "å" });
    expect(keyDownMessages(key({ key: "å", code: "KeyA", keyCode: 65, altKey: true }))[0]).not.toHaveProperty("modifiers");
  });

  it("sends a character that arrives without a key code as text", () => {
    const event = key({ key: "é" });
    expect(routeKey(event)).toBe("forward");
    expect(keyDownMessages(event)).toEqual([{ type: "input_keyboard", eventType: "char", text: "é" }]);
    expect(keyUpMessages(event)).toEqual([]);
  });

  it("sends nothing while an input method is composing", () => {
    for (const event of [
      key({ key: "a", code: "KeyA", keyCode: 65, isComposing: true }),
      key({ key: "Process", keyCode: 229 }),
      key({ key: "Dead", code: "BracketLeft", keyCode: 219 }),
      key({ key: "Unidentified" }),
    ]) {
      expect(routeKey(event)).toBe("ignore");
      expect(keyDownMessages(event)).toEqual([]);
      expect(keyUpMessages(event)).toEqual([]);
    }
  });

  it("keeps Escape and the paste shortcut for the Bridge page", () => {
    for (const event of [
      key({ key: "Escape", code: "Escape", keyCode: 27 }),
      key({ key: "v", code: "KeyV", keyCode: 86, ctrlKey: true }),
      key({ key: "V", code: "KeyV", keyCode: 86, metaKey: true, shiftKey: true }),
    ]) {
      expect(routeKey(event)).toBe("local");
      expect(keyDownMessages(event)).toEqual([]);
    }
  });

  it("forwards a modifier key pressed alone", () => {
    expect(keyDownMessages(key({ key: "Shift", code: "ShiftLeft", keyCode: 16, shiftKey: true }))).toEqual([
      { type: "input_keyboard", eventType: "keyDown", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: 8 },
    ]);
  });

  it("sends typed or pasted text as one char message, emoji included", () => {
    expect(textMessages("héllo 👋")).toEqual([{ type: "input_keyboard", eventType: "char", text: "héllo 👋" }]);
    expect(textMessages("")).toEqual([]);
  });

  it("presses a named key down and up with its key code", () => {
    expect(namedKeyMessages("Backspace")).toEqual([
      { type: "input_keyboard", eventType: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
      { type: "input_keyboard", eventType: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
    ]);
    expect(namedKeyMessages("Enter")[0]).toMatchObject({ eventType: "keyDown", windowsVirtualKeyCode: 13, text: "\r" });
    expect(namedKeyMessages("Tab").map((message) => message.windowsVirtualKeyCode)).toEqual([9, 9]);
    expect(namedKeyMessages("Escape").map((message) => message.eventType)).toEqual(["keyDown", "keyUp"]);
  });
});
