import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  advanceTimersByTimeAct,
  createReactDomHarness,
  findAllByTag,
  getReactProps,
  type ReactDomHarness,
} from "../test-react-harness";
import { haptic } from "../lib/haptics";
import useLongPressMenu from "./useLongPressMenu";

vi.mock("../lib/haptics", () => ({ haptic: vi.fn() }));

let resetGuard: (() => void) | null = null;

function LongPressFixture({ onActivate }: { onActivate: () => void }) {
  const { bind, menu, isTarget, resetClickGuard } = useLongPressMenu<string>();
  resetGuard = resetClickGuard;
  return createElement("button", {
    ...bind("message-1", onActivate),
    type: "button",
    "data-menu-open": menu?.id === "message-1" ? "true" : "false",
    "data-menu-at": menu ? `${menu.x},${menu.y},${menu.touch ? "touch" : "pointer"}` : "",
    "data-pressing": isTarget("message-1") ? "true" : "false",
  }, "Message");
}

function findButton(harness: ReactDomHarness): any {
  const button = findAllByTag(harness.dom.container, "BUTTON")[0];
  if (!button) throw new Error("Long-press button not found");
  return button;
}

describe("useLongPressMenu", () => {
  let harness: ReactDomHarness | null = null;

  beforeEach(async () => {
    vi.mocked(haptic).mockClear();
    vi.useFakeTimers();
    harness = await createReactDomHarness();
  });

  afterEach(async () => {
    await harness?.cleanup();
    harness = null;
  });

  it("opens after the hold delay and suppresses the synthesized click", async () => {
    if (!harness) throw new Error("Harness not initialized");
    const onActivate = vi.fn();
    await harness.render(createElement(LongPressFixture, { onActivate }));

    await harness.act(async () => {
      getReactProps(findButton(harness!))?.onTouchStart?.({
        touches: [{ clientX: 20, clientY: 30 }],
      });
    });
    expect(findButton(harness).getAttribute("data-pressing")).toBe("true");

    await advanceTimersByTimeAct(harness.act, 500);
    expect(findButton(harness).getAttribute("data-menu-open")).toBe("true");

    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    await harness.act(async () => {
      getReactProps(findButton(harness!))?.onClick?.({ preventDefault, stopPropagation });
    });

    expect(preventDefault).toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalled();
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("lets the next click through after resetClickGuard, when the pressed row was swapped out", async () => {
    if (!harness) throw new Error("Harness not initialized");
    const onActivate = vi.fn();
    await harness.render(createElement(LongPressFixture, { onActivate }));
    await harness.act(async () => {
      getReactProps(findButton(harness!))?.onTouchStart?.({ touches: [{ clientX: 20, clientY: 30 }] });
    });
    await advanceTimersByTimeAct(harness.act, 500);
    // No click arrived (reorder mode replaced the row); leaving the mode resets the guard.
    await harness.act(async () => resetGuard?.());
    await harness.act(async () => {
      getReactProps(findButton(harness!))?.onClick?.({ preventDefault: vi.fn(), stopPropagation: vi.fn() });
    });
    expect(onActivate).toHaveBeenCalledOnce();
  });

  it("opens a right-click menu at the pointer, and a touch contextmenu once at the press", async () => {
    if (!harness) throw new Error("Harness not initialized");
    const onActivate = vi.fn();
    await harness.render(createElement(LongPressFixture, { onActivate }));
    const contextMenu = (clientX: number, clientY: number, pointerType?: string) => harness!.act(async () => {
      getReactProps(findButton(harness!))?.onContextMenu?.({
        preventDefault: vi.fn(),
        clientX,
        clientY,
        nativeEvent: { pointerType },
      });
    });

    await contextMenu(70, 80);
    expect(findButton(harness).getAttribute("data-menu-at")).toBe("70,80,pointer");

    await harness.act(async () => {
      getReactProps(findButton(harness!))?.onTouchStart?.({ touches: [{ clientX: 20, clientY: 30 }] });
    });
    // Android: contextmenu arrives before the hold timer, then the touch is cancelled.
    await contextMenu(25, 35);
    expect(findButton(harness).getAttribute("data-menu-at")).toBe("20,30,touch");
    await advanceTimersByTimeAct(harness.act, 500);
    await contextMenu(25, 35, "touch");
    expect(findButton(harness).getAttribute("data-menu-at")).toBe("20,30,touch");
    expect(haptic).toHaveBeenCalledOnce();

    await harness.act(async () => {
      const props = getReactProps(findButton(harness!));
      props?.onTouchCancel?.();
      props?.onClick?.({ preventDefault: vi.fn(), stopPropagation: vi.fn() });
    });
    expect(onActivate).toHaveBeenCalledOnce();
  });

  it("cancels when the touch moves beyond the threshold", async () => {
    if (!harness) throw new Error("Harness not initialized");
    await harness.render(createElement(LongPressFixture, { onActivate: vi.fn() }));

    await harness.act(async () => {
      const props = getReactProps(findButton(harness!));
      props?.onTouchStart?.({ touches: [{ clientX: 10, clientY: 10 }] });
      props?.onTouchMove?.({ touches: [{ clientX: 30, clientY: 10 }] });
    });
    await advanceTimersByTimeAct(harness.act, 500);

    expect(findButton(harness).getAttribute("data-pressing")).toBe("false");
    expect(findButton(harness).getAttribute("data-menu-open")).toBe("false");
  });

  it("ignores touch events without an active touch point", async () => {
    if (!harness) throw new Error("Harness not initialized");
    await harness.render(createElement(LongPressFixture, { onActivate: vi.fn() }));

    await harness.act(async () => {
      getReactProps(findButton(harness!))?.onTouchStart?.({ touches: [] });
    });
    await advanceTimersByTimeAct(harness.act, 500);

    expect(findButton(harness).getAttribute("data-pressing")).toBe("false");
    expect(findButton(harness).getAttribute("data-menu-open")).toBe("false");
  });
});
