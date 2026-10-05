import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createReactDomHarness,
  findAllByTag,
  getReactProps,
  waitUntilAct,
  type ReactDomHarness,
} from "../test-react-harness";
import { LiveBrowserView } from "./LiveBrowserView";
import { createFakeLiveNetwork } from "./test-live-fakes";

function findButton(root: any, text: string): any {
  const button = findAllByTag(root, "BUTTON").find((candidate) => (
    candidate.textContent?.trim() === text || getReactProps(candidate)?.["aria-label"] === text
  ));
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

function keyEvent(overrides: Record<string, unknown>) {
  return {
    key: "",
    code: "",
    keyCode: 0,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    nativeEvent: { isComposing: false },
    getModifierState: () => false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...overrides,
  };
}

function pointerEvent(overrides: Record<string, unknown>) {
  return {
    pointerType: "mouse",
    pointerId: 1,
    button: 0,
    clientX: 0,
    clientY: 0,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault: vi.fn(),
    currentTarget: { setPointerCapture: vi.fn() },
    ...overrides,
  };
}

describe("LiveBrowserView", () => {
  let harness: ReactDomHarness | null = null;

  afterEach(async () => {
    await harness?.cleanup();
    harness = null;
  });

  async function mount() {
    const network = createFakeLiveNetwork();
    const mounted = await createReactDomHarness();
    harness = mounted;
    await mounted.render(createElement(LiveBrowserView, {
      browserSessionId: "bs_ab12cd34",
      deps: network.deps,
    }));
    await waitUntilAct(mounted.act, () => network.sockets.length === 1, { label: "first socket" });
    const container = mounted.dom.container;
    const canvas = findAllByTag(container, "CANVAS")[0];
    // The page is drawn at 40% of its size, 20px from the left and 100px from the top.
    canvas.getBoundingClientRect = () => ({ left: 20, top: 100, width: 378, height: 366.8 });
    return {
      network,
      harness: mounted,
      container,
      surface: canvas.parentNode,
      textRow: () => findAllByTag(container, "INPUT")[0],
      text: () => container.textContent ?? "",
      goLive: async () => {
        await mounted.act(async () => {
          network.latestSocket().open();
          network.latestSocket().receive({ type: "viewport", width: 945, height: 917 });
          network.latestSocket().receive({ type: "url", url: "https://accounts.example.com/signin" });
        });
      },
    };
  }

  it("shows the connection state and the page address", async () => {
    const view = await mount();
    expect(view.text()).toContain("Connecting…");
    expect(view.text()).toContain("Waiting for the page…");
    expect(view.text()).toContain("No address yet");

    await view.goLive();
    expect(view.text()).toContain("Live");
    expect(view.text()).toContain("https://accounts.example.com/signin");

    await view.harness.act(async () => {
      view.network.latestSocket().receive({ type: "frame", seq: 1, data: "AAAA" });
    });
    expect(view.text()).not.toContain("Waiting for the page…");

    await view.harness.act(async () => {
      view.network.latestSocket().drop();
    });
    expect(view.text()).toContain("Reconnecting…");
  });

  it("sends a click at the page position under the pointer", async () => {
    const view = await mount();
    await view.goLive();
    const surface = getReactProps(view.surface)!;
    const down = pointerEvent({ clientX: 20 + 200, clientY: 100 + 40 });

    await view.harness.act(async () => {
      surface.onPointerDown(down);
      surface.onPointerUp(pointerEvent({ clientX: 20 + 200, clientY: 100 + 40 }));
    });

    expect(down.preventDefault).toHaveBeenCalled();
    expect(view.network.latestSocket().sentOfType("input_mouse")).toEqual([
      { type: "input_mouse", eventType: "mousePressed", x: 500, y: 100, button: "left", clickCount: 1 },
      { type: "input_mouse", eventType: "mouseReleased", x: 500, y: 100, button: "left", clickCount: 1 },
    ]);
  });

  it("sends no pointer input before the page's size is known", async () => {
    const view = await mount();
    await view.harness.act(async () => {
      view.network.latestSocket().open();
    });
    const surface = getReactProps(view.surface)!;
    await view.harness.act(async () => {
      surface.onPointerDown(pointerEvent({ clientX: 100, clientY: 200 }));
      surface.onPointerMove(pointerEvent({ clientX: 110, clientY: 200 }));
      surface.onPointerUp(pointerEvent({ clientX: 110, clientY: 200 }));
    });
    expect(view.network.latestSocket().sent).toEqual([]);
  });

  it("treats a tap as a mouse click", async () => {
    const view = await mount();
    await view.goLive();
    const surface = getReactProps(view.surface)!;
    const at = { pointerType: "touch", pointerId: 7, clientX: 20 + 40, clientY: 100 + 80 };
    await view.harness.act(async () => {
      surface.onPointerDown(pointerEvent(at));
      surface.onPointerUp(pointerEvent(at));
    });
    expect(view.network.latestSocket().sentOfType("input_mouse").map((message) => [message.eventType, message.x, message.y])).toEqual([
      ["mouseMoved", 100, 200],
      ["mousePressed", 100, 200],
      ["mouseReleased", 100, 200],
    ]);
    expect(view.network.latestSocket().sent.map((message) => message.type)).toEqual(["input_mouse", "input_mouse", "input_mouse"]);
  });

  it("forwards keys pressed on the page and keeps them from the Bridge page", async () => {
    const view = await mount();
    await view.goLive();
    const surface = getReactProps(view.surface)!;
    const down = keyEvent({ key: "a", code: "KeyA", keyCode: 65 });
    const up = keyEvent({ key: "a", code: "KeyA", keyCode: 65 });
    await view.harness.act(async () => {
      surface.onKeyDown(down);
      surface.onKeyUp(up);
    });
    expect(down.preventDefault).toHaveBeenCalled();
    expect(down.stopPropagation).toHaveBeenCalled();
    expect(view.network.latestSocket().sentOfType("input_keyboard")).toEqual([
      { type: "input_keyboard", eventType: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, text: "a" },
      { type: "input_keyboard", eventType: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65 },
    ]);
  });

  it("lets go of keys still held when the page loses the keyboard", async () => {
    const view = await mount();
    await view.goLive();
    const surface = getReactProps(view.surface)!;
    await view.harness.act(async () => {
      surface.onFocus();
      surface.onKeyDown(keyEvent({ key: "Shift", code: "ShiftLeft", keyCode: 16, shiftKey: true }));
      surface.onBlur();
    });
    expect(view.network.latestSocket().sentOfType("input_keyboard").map((message) => [message.eventType, message.key])).toEqual([
      ["keyDown", "Shift"],
      ["keyUp", "Shift"],
    ]);
  });

  it("hands the keyboard back on Escape instead of sending it", async () => {
    const view = await mount();
    await view.goLive();
    const escape = keyEvent({ key: "Escape", code: "Escape", keyCode: 27 });
    await view.harness.act(async () => {
      view.surface.focus();
      getReactProps(view.surface)!.onKeyDown(escape);
    });
    expect(document.activeElement).toBe(view.textRow());
    expect(escape.preventDefault).toHaveBeenCalled();
    expect(escape.stopPropagation).toHaveBeenCalled();
    expect(view.network.latestSocket().sentOfType("input_keyboard")).toEqual([]);
  });

  it("sends pasted text and leaves the paste shortcut to the browser", async () => {
    const view = await mount();
    await view.goLive();
    const surface = getReactProps(view.surface)!;
    const shortcut = keyEvent({ key: "v", code: "KeyV", keyCode: 86, ctrlKey: true });
    await view.harness.act(async () => {
      surface.onKeyDown(shortcut);
      surface.onPaste({ preventDefault: vi.fn(), clipboardData: { getData: () => "p@ss word" } });
    });
    expect(shortcut.preventDefault).not.toHaveBeenCalled();
    expect(view.network.latestSocket().sentOfType("input_keyboard")).toEqual([
      { type: "input_keyboard", eventType: "char", text: "p@ss word" },
    ]);
  });

  it("sends text typed in the text row at once", async () => {
    const view = await mount();
    await view.goLive();
    await view.harness.act(async () => {
      getReactProps(view.textRow())!.onChange({ target: { value: "hello 👋" } });
    });
    expect(view.network.latestSocket().sentOfType("input_keyboard")).toEqual([
      { type: "input_keyboard", eventType: "char", text: "hello 👋" },
    ]);
  });

  it("waits for an input method to finish before sending its text", async () => {
    const view = await mount();
    await view.goLive();
    await view.harness.act(async () => {
      getReactProps(view.textRow())!.onCompositionStart();
      getReactProps(view.textRow())!.onChange({ target: { value: "ni" } });
    });
    expect(view.network.latestSocket().sentOfType("input_keyboard")).toEqual([]);
    expect(getReactProps(view.textRow())!.value).toBe("ni");

    await view.harness.act(async () => {
      getReactProps(view.textRow())!.onCompositionEnd({ currentTarget: { value: "你" } });
    });
    expect(view.network.latestSocket().sentOfType("input_keyboard")).toEqual([
      { type: "input_keyboard", eventType: "char", text: "你" },
    ]);
    expect(getReactProps(view.textRow())!.value).toBe("");
  });

  it("presses Enter, Backspace, Tab and Esc from the key buttons and the text row", async () => {
    const view = await mount();
    await view.goLive();
    for (const label of ["Press Enter", "Press Backspace", "Press Tab", "Press Esc"]) {
      const button = findButton(view.container, label);
      const mouseDown = { preventDefault: vi.fn() };
      await view.harness.act(async () => {
        getReactProps(button)!.onMouseDown(mouseDown);
        getReactProps(button)!.onClick();
      });
      // Keeping focus in the text row is what keeps a phone's keyboard open.
      expect(mouseDown.preventDefault).toHaveBeenCalled();
    }
    const backspace = keyEvent({ key: "Backspace", code: "Backspace", keyCode: 8 });
    const letter = keyEvent({ key: "a", code: "KeyA", keyCode: 65 });
    await view.harness.act(async () => {
      getReactProps(view.textRow())!.onKeyDown(backspace);
      getReactProps(view.textRow())!.onKeyDown(letter);
    });
    expect(backspace.preventDefault).toHaveBeenCalled();
    expect(letter.preventDefault).not.toHaveBeenCalled();

    expect(view.network.latestSocket().sentOfType("input_keyboard").map((message) => [message.eventType, message.windowsVirtualKeyCode])).toEqual([
      ["keyDown", 13], ["keyUp", 13],
      ["keyDown", 8], ["keyUp", 8],
      ["keyDown", 9], ["keyUp", 9],
      ["keyDown", 27], ["keyUp", 27],
      ["keyDown", 8], ["keyUp", 8],
    ]);
  });

  it("shows why the view ended and tries again on request", async () => {
    const view = await mount();
    await view.goLive();
    await view.harness.act(async () => {
      view.network.latestSocket().receive({ type: "closed", reason: "stream_ended", message: "The page stream stopped." });
    });
    expect(view.text()).toContain("Ended");
    expect(view.text()).toContain("The page stream stopped.");

    await view.harness.act(async () => {
      getReactProps(findButton(view.container, "Try again"))!.onClick();
    });
    await waitUntilAct(view.harness.act, () => view.network.sockets.length === 2, { label: "socket after retry" });
    expect(view.network.ticketRequests).toHaveLength(2);
    expect(view.text()).not.toContain("The page stream stopped.");
  });

  it("offers no retry once the browser session itself is over", async () => {
    const view = await mount();
    await view.goLive();
    await view.harness.act(async () => {
      view.network.latestSocket().receive({ type: "closed", reason: "session_ended", message: "The browser session was closed." });
    });
    expect(view.text()).toContain("The browser session was closed.");
    expect(findAllByTag(view.container, "BUTTON").some((button) => button.textContent?.trim() === "Try again")).toBe(false);
  });
});
