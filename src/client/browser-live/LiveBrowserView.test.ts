import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { installSelectAwareDomShim } from "../test-dom-shim";
import {
  createReactDomHarness,
  findAllByTag,
  getReactProps,
  waitUntilAct,
  type ReactDomHarness,
} from "../test-react-harness";
import type { BrowserLiveTicket } from "../../shared/browser-live.js";
import { LiveBrowserView } from "./LiveBrowserView";
import { createFakeLiveNetwork } from "./test-live-fakes";

function findButton(root: any, text: string): any {
  const button = findAllByTag(root, "BUTTON").find((candidate) => (
    candidate.textContent?.trim() === text || getReactProps(candidate)?.["aria-label"] === text
  ));
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

function findField(root: any, tag: string, label: string): any {
  const field = findAllByTag(root, tag).find((candidate) => getReactProps(candidate)?.["aria-label"] === label);
  if (!field) throw new Error(`Field not found: ${label}`);
  return field;
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

  async function mount(props: { requestTicket?: () => Promise<BrowserLiveTicket> } = {}) {
    const network = createFakeLiveNetwork();
    // The tab list is a <select>.
    const mounted = await createReactDomHarness({ installDom: installSelectAwareDomShim });
    harness = mounted;
    await mounted.render(createElement(LiveBrowserView, {
      browserSessionId: "bs_ab12cd34",
      deps: network.deps,
      ...props,
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
      textRow: () => findField(container, "INPUT", "Text to type in the page"),
      address: () => findField(container, "INPUT", "Page address"),
      /** What the address field shows. */
      shownAddress: () => getReactProps(findField(container, "INPUT", "Page address"))!.value as string,
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
    expect(view.shownAddress()).toBe("");

    await view.goLive();
    expect(view.text()).toContain("Live");
    expect(view.shownAddress()).toBe("https://accounts.example.com/signin");

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

  it("gets its ticket from the request it was given instead of asking for the session's", async () => {
    const view = await mount({
      requestTicket: async () => ({ browserSessionId: "bs_signedin", token: "own-ticket", expiresAt: "2026-01-01T00:01:00.000Z" }),
    });

    expect(view.network.ticketRequests).toEqual([]);
    expect(view.network.latestSocket().url).toContain("browserSessionId=bs_signedin&token=own-ticket");
  });

  it("goes back, forward and reloads from the toolbar once the view is live", async () => {
    const view = await mount();
    for (const label of ["Back", "Forward", "Reload"]) expect(getReactProps(findButton(view.container, label))!.disabled).toBe(true);

    await view.goLive();
    await view.harness.act(async () => {
      for (const label of ["Back", "Forward", "Reload"]) getReactProps(findButton(view.container, label))!.onClick();
    });

    expect(view.network.latestSocket().sent).toEqual([
      { type: "history", direction: "back" },
      { type: "history", direction: "forward" },
      { type: "reload" },
    ]);
  });

  /** Puts the keyboard in the address field and types into it. */
  async function typeAddress(view: Awaited<ReturnType<typeof mount>>, typed: string): Promise<void> {
    await view.harness.act(async () => {
      getReactProps(view.address())!.onFocus({ currentTarget: { select: vi.fn() } });
    });
    await view.harness.act(async () => {
      getReactProps(view.address())!.onChange({ target: { value: typed } });
    });
  }

  async function pressInAddress(view: Awaited<ReturnType<typeof mount>>, key: string) {
    const event = keyEvent({ key });
    await view.harness.act(async () => {
      getReactProps(view.address())!.onKeyDown(event);
    });
    return event;
  }

  it("opens the address typed into the address field on Enter and gives the keyboard to the page", async () => {
    const view = await mount();
    await view.goLive();

    await typeAddress(view, " example.com/login ");
    await pressInAddress(view, "Enter");

    expect(view.network.latestSocket().sent).toEqual([{ type: "navigate", url: "https://example.com/login" }]);
    expect(document.activeElement).toBe(view.surface);
  });

  it("marks what is not a web address as invalid and sends nothing", async () => {
    const view = await mount();
    await view.goLive();

    await typeAddress(view, "not an address");
    await pressInAddress(view, "Enter");
    expect(getReactProps(view.address())!["aria-invalid"]).toBe(true);
    expect(view.network.latestSocket().sent).toEqual([]);

    // The mark is about what was entered, and goes when that changes.
    await typeAddress(view, "example.com");
    expect(getReactProps(view.address())!["aria-invalid"]).toBeUndefined();
  });

  it("keeps what is being typed when the page moves on, and shows the page's address once the field is left", async () => {
    const view = await mount();
    await view.goLive();

    await typeAddress(view, "exam");
    await view.harness.act(async () => {
      view.network.latestSocket().receive({ type: "url", url: "https://accounts.example.com/done" });
    });
    expect(view.shownAddress()).toBe("exam");

    await view.harness.act(async () => {
      getReactProps(view.address())!.onBlur();
    });
    expect(view.shownAddress()).toBe("https://accounts.example.com/done");
  });

  it("puts the page's address back on Escape when it was edited, and leaves a second Escape to whatever holds the view", async () => {
    const view = await mount();
    await view.goLive();
    await typeAddress(view, "exam");

    const first = await pressInAddress(view, "Escape");
    expect(view.shownAddress()).toBe("https://accounts.example.com/signin");
    expect(first.preventDefault).toHaveBeenCalled();
    expect(first.stopPropagation).toHaveBeenCalled();

    const second = await pressInAddress(view, "Escape");
    expect(second.preventDefault).not.toHaveBeenCalled();
    expect(second.stopPropagation).not.toHaveBeenCalled();
    expect(view.network.latestSocket().sent).toEqual([]);
  });

  it("offers the browser's tabs once there is more than one: showing another, and closing the one on show", async () => {
    const view = await mount();
    await view.goLive();
    const first = { id: "t1", title: "Sign in", url: "https://accounts.example.com/signin", active: true };
    const tabsControls = () => [
      ...findAllByTag(view.container, "SELECT"),
      ...findAllByTag(view.container, "BUTTON").filter((button) => button.textContent?.trim() === "Close tab"),
    ];

    await view.harness.act(async () => {
      view.network.latestSocket().receive({ type: "tabs", tabs: [first] });
    });
    expect(tabsControls()).toEqual([]);

    await view.harness.act(async () => {
      view.network.latestSocket().receive({
        type: "tabs",
        tabs: [first, { id: "t7", title: "", url: "https://example.org/popup", active: false }],
      });
    });
    const select = findField(view.container, "SELECT", "Tab");
    expect(getReactProps(select)!.value).toBe("t1");
    const options = findAllByTag(select, "OPTION").map((option) => option.textContent);
    expect(options[0]).toContain("Sign in");
    // A tab without a title goes by its address.
    expect(options[1]).toContain("https://example.org/popup");

    await view.harness.act(async () => {
      getReactProps(select)!.onChange({ target: { value: "t7" } });
      getReactProps(findButton(view.container, "Close tab"))!.onClick();
    });
    expect(view.network.latestSocket().sent).toEqual([
      { type: "tab", action: "select", tabId: "t7" },
      { type: "tab", action: "close", tabId: "t1" },
    ]);
  });

  it("asks for the files a page wants with the device's own picker, and sends what was picked", async () => {
    const view = await mount();
    await view.goLive();
    const picker = () => findAllByTag(view.container, "INPUT").find((input) => getReactProps(input)?.type === "file");
    expect(picker()).toBeUndefined();

    await view.harness.act(async () => {
      view.network.latestSocket().receive({ type: "file_chooser", id: "c1", multiple: true, accept: "image/*" });
    });
    expect(view.text()).toContain("The page asks for files");
    expect(getReactProps(picker())).toMatchObject({ multiple: true, accept: "image/*" });
    // The button opens the picker inside the reader's own tap, which a phone requires.
    const opened = vi.fn();
    picker().click = opened;
    await view.harness.act(async () => {
      getReactProps(findButton(view.container, "Choose files"))!.onClick();
    });
    expect(opened).toHaveBeenCalledTimes(1);

    view.network.setFileSender(() => Promise.reject(new Error("The connection was lost.")));
    const target = { files: [new File(["a"], "a.jpg")], value: "C:\\fakepath\\a.jpg" };
    await view.harness.act(async () => {
      getReactProps(picker())!.onChange({ target });
    });
    // The same file can be picked again.
    expect(target.value).toBe("");
    expect(view.text()).toContain("The connection was lost.");

    view.network.setFileSender(async () => {});
    await view.harness.act(async () => {
      getReactProps(picker())!.onChange({ target: { files: [new File(["a"], "a.jpg")], value: "" } });
    });
    expect(view.network.sentFiles).toEqual([{ chooserId: "c1", names: ["a.jpg"] }, { chooserId: "c1", names: ["a.jpg"] }]);
    expect(view.text()).not.toContain("The page asks for");
  });

  it("offers to save a sign-in the reader typed, and to sign in with a saved one, as a password manager does", async () => {
    const view = await mount();
    await view.goLive();
    const receive = (message: Record<string, unknown>) => view.harness.act(async () => {
      view.network.latestSocket().receive({ type: "login", ...message } as never);
    });
    const press = (label: string) => view.harness.act(async () => {
      getReactProps(findButton(view.container, label))!.onClick();
    });
    const answers = () => view.network.latestSocket().sentOfType("login").map((message) => message.action);
    expect(view.text()).not.toContain("login");

    await receive({ state: "save", host: "example.com", username: "tim@example.com" });
    expect(view.text()).toContain("Save this login for agents?");
    expect(view.text()).toContain("tim@example.com on example.com");
    await press("Save");
    expect(view.text()).toContain("Saving…");

    await receive({ state: "saved", host: "example.com", username: "tim@example.com" });
    expect(view.text()).toContain("Login saved");
    await press("OK");
    expect(view.text()).not.toContain("Login saved");

    await receive({ state: "save", host: "example.com", username: "tim@example.com", replaces: true, failed: true });
    expect(view.text()).toContain("Update the saved login?");
    expect(view.text()).toContain("It could not be saved");
    await press("Not now");
    expect(view.text()).not.toContain("Update the saved login?");

    await receive({ state: "fill", host: "example.com", username: "tim@example.com" });
    expect(view.text()).toContain("A login is saved for this site");
    await press("Sign in");
    expect(answers()).toEqual(["save", "dismiss", "dismiss", "fill"]);

    await receive({ state: "none" });
    expect(view.text()).not.toContain("A login is saved");
  });

  it("offers no more picking for a request the page gave up on", async () => {
    const view = await mount();
    await view.goLive();
    await view.harness.act(async () => {
      view.network.latestSocket().receive({ type: "file_chooser", id: "c1", multiple: false });
    });
    view.network.setFileSender(() => Promise.reject(Object.assign(new Error("The page is no longer asking for a file. Use its button again."), { status: 409 })));
    const picker = findAllByTag(view.container, "INPUT").find((input) => getReactProps(input)?.type === "file");
    await view.harness.act(async () => {
      getReactProps(picker)!.onChange({ target: { files: [new File(["a"], "a.jpg")], value: "" } });
    });

    expect(view.text()).toContain("The file did not reach the page");
    expect(view.text()).toContain("Use its button again.");
    expect(view.text()).not.toContain("The page asks for");
    const buttons = findAllByTag(view.container, "BUTTON").map((button) => button.textContent?.trim());
    expect(buttons).toContain("Close");
    expect(buttons).not.toContain("Choose file");
  });

  it("puts the page's request for a file away when the reader declines", async () => {
    const view = await mount();
    await view.goLive();
    await view.harness.act(async () => {
      view.network.latestSocket().receive({ type: "file_chooser", id: "c1", multiple: false });
    });
    expect(view.text()).toContain("The page asks for a file");

    await view.harness.act(async () => {
      getReactProps(findButton(view.container, "Cancel"))!.onClick();
    });
    expect(view.text()).not.toContain("The page asks for a file");
    expect(view.network.sentFiles).toEqual([]);
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
